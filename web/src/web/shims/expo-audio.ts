/**
 * Web replacement for the parts of `expo-audio` the app uses, ported from
 * expo-audio's own web implementation (MediaRecorder + HTMLAudioElement), so
 * voice notes, voice mode and read-aloud behave exactly like the Expo web build.
 */
import { useEffect, useMemo } from "react";

export type RecordingOptions = {
  extension?: string;
  sampleRate?: number;
  numberOfChannels?: number;
  bitRate?: number;
  isMeteringEnabled?: boolean;
  android?: Record<string, unknown>;
  ios?: Record<string, unknown>;
  web?: { mimeType?: string; bitsPerSecond?: number };
};

type WebRecordingOptions = {
  extension?: string;
  sampleRate?: number;
  numberOfChannels?: number;
  bitRate?: number;
  isMeteringEnabled?: boolean;
  mimeType?: string;
  bitsPerSecond?: number;
};

export type PermissionResponse = {
  status: "granted" | "denied" | "undetermined";
  expires: "never";
  canAskAgain: boolean;
  granted: boolean;
};

export const RecordingPresets = {
  HIGH_QUALITY: {
    extension: ".m4a",
    sampleRate: 44100,
    numberOfChannels: 2,
    bitRate: 128000,
    android: { outputFormat: "mpeg4", audioEncoder: "aac" },
    ios: {
      outputFormat: "aac ",
      audioQuality: 127,
      linearPCMBitDepth: 16,
      linearPCMIsBigEndian: false,
      linearPCMIsFloat: false,
    },
    web: { mimeType: "audio/webm", bitsPerSecond: 128000 },
  } as RecordingOptions,
  LOW_QUALITY: {
    extension: ".m4a",
    sampleRate: 44100,
    numberOfChannels: 2,
    bitRate: 64000,
    android: { extension: ".3gp", outputFormat: "3gp", audioEncoder: "amr_nb" },
    ios: { audioQuality: 0, outputFormat: "aac ", linearPCMBitDepth: 16, linearPCMIsBigEndian: false, linearPCMIsFloat: false },
    web: { mimeType: "audio/webm", bitsPerSecond: 128000 },
  } as RecordingOptions,
};

let idSeed = 0;
const nextId = () => `${Date.now()}-${++idSeed}`;

let audioContext: AudioContext | null = null;
function getAudioContext(): AudioContext {
  if (!audioContext) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    audioContext = new Ctor();
  }
  return audioContext;
}

function getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
  if (navigator.mediaDevices?.getUserMedia) {
    return navigator.mediaDevices.getUserMedia(constraints);
  }
  return Promise.reject(new Error("Permission denied: getUserMedia is not supported in this browser."));
}

function createRecordingOptions(options: RecordingOptions): WebRecordingOptions {
  return {
    extension: options.extension,
    sampleRate: options.sampleRate,
    numberOfChannels: options.numberOfChannels,
    bitRate: options.bitRate,
    isMeteringEnabled: options.isMeteringEnabled ?? false,
    ...(options.web ?? {}),
  };
}

type Listener = (payload: unknown) => void;

class Emitter {
  private listeners = new Map<string, Set<Listener>>();
  addListener(event: string, listener: Listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
    return { remove: () => this.listeners.get(event)?.delete(listener) };
  }
  emit(event: string, payload: unknown) {
    this.listeners.get(event)?.forEach((l) => l(payload));
  }
}

import { downsamplePcm, encodeWavPcm } from "../../lib/ask-prana-transcription-language";
import {
  createRecordingId,
  decideRecordingQuality,
  isUsableQuietDictation,
  describeAppliedMicrophoneSettings,
  logRecordingCapture,
  microphoneCaptureConstraints,
  MICROPHONE_NOT_READY_MESSAGE,
  MICROPHONE_UNAVAILABLE_MESSAGE,
  summarizeRecordingSignal,
  type AppliedMicrophoneSettings,
  type RecordingCaptureReport,
} from "../../lib/ask-prana-recording-capture";

const RECORDING_STATUS_UPDATE = "recordingStatusUpdate";
const PLAYBACK_STATUS_UPDATE = "playbackStatusUpdate";

export class AudioRecorder extends Emitter {
  id = nextId();
  currentTime = 0;
  uri: string | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private uptimeOfLastStartResume = 0;
  private mediaRecorderIsRecording = false;
  private timeoutIds: ReturnType<typeof setTimeout>[] = [];
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserBuffer: Float32Array<ArrayBuffer> | null = null;
  private analyserSource: MediaStreamAudioSourceNode | null = null;
  private meteringEnabled = false;
  /** Installed at recorder creation so no final or early dataavailable chunk is lost. */
  private recordingChunks: BlobPart[] = [];
  private stopping: Promise<void> | null = null;
  /** Microphone PCM collected during the take. WebM from MediaRecorder is not decoded. */
  private pcmChunks: Float32Array[] = [];
  private frozenSamples: Float32Array = new Float32Array(0);
  private pcmSampleRate = 48000;
  private capturingPcm = false;
  private pcmProcessor: ScriptProcessorNode | null = null;
  private pcmGain: GainNode | null = null;
  private recordingId = "";
  private appliedSettings: AppliedMicrophoneSettings | null = null;
  private trackMuted = false;
  private trackEnded = false;
  private tailHoldUntil = 0;
  private tailFrozen = false;
  private lastReport: RecordingCaptureReport | null = null;
  /** Sample rate of the uploaded WAV; null keeps the microphone's own rate. */
  private wavSampleRate: number | null = null;

  constructor(private options: WebRecordingOptions) {
    super();
  }

  get isRecording() {
    return this.mediaRecorder?.state === "recording";
  }

  /**
   * Chooses the sample rate of the next recording's WAV. Composer dictation
   * uses 16 kHz (a third of the 48 kHz upload); null keeps the full rate.
   */
  setWavSampleRate(rate: number | null) {
    this.wavSampleRate = rate && rate > 0 ? rate : null;
  }

  async prepareToRecordAsync(_options?: RecordingOptions) {
    this.mediaRecorder = await this.createMediaRecorder(this.options);
  }

  record(options?: { forDuration?: number; atTime?: number }) {
    if (this.mediaRecorder === null) {
      throw new Error(
        "Cannot start an audio recording without initializing a MediaRecorder. Run prepareToRecordAsync() before attempting to start an audio recording.",
      );
    }
    this.clearTimeouts();
    // A recorder instance represents one capture. Clear only before its first
    // start, never while final dataavailable events can still arrive.
    if (this.mediaRecorder.state === "inactive") {
      this.recordingChunks = [];
      this.pcmChunks = [];
      this.frozenSamples = new Float32Array(0);
      this.tailHoldUntil = 0;
      this.tailFrozen = false;
      this.lastReport = null;
    }
    const context = getAudioContext();
    if (context.state !== "running") {
      this.stream?.getTracks().forEach((audioTrack) => audioTrack.stop());
      this.stream = null;
      throw new Error(MICROPHONE_NOT_READY_MESSAGE);
    }
    const track = this.stream?.getAudioTracks()[0];
    if (!track || track.readyState === "ended" || track.muted || this.trackEnded) {
      this.stream?.getTracks().forEach((audioTrack) => audioTrack.stop());
      this.stream = null;
      throw new Error(MICROPHONE_UNAVAILABLE_MESSAGE);
    }
    // Capture from this instant. The start event must not discard these samples.
    this.capturingPcm = true;
    if (this.mediaRecorder.state === "paused") this.mediaRecorder.resume();
    else this.mediaRecorder.start();
    if (options?.forDuration !== undefined) {
      this.timeoutIds.push(setTimeout(() => void this.stop(), options.forDuration * 1000));
    }
  }

  pause() {
    if (this.mediaRecorder === null) {
      throw new Error(
        "Cannot start an audio recording without initializing a MediaRecorder. Run prepareToRecordAsync() before attempting to start an audio recording.",
      );
    }
    this.mediaRecorder.pause();
  }

  /** Drop a prepared or live microphone without waiting for a recording file. */
  releaseMicrophone() {
    this.capturingPcm = false;
    this.tailFrozen = true;
    this.clearTimeouts();
    try {
      this.pcmProcessor?.disconnect();
      this.pcmGain?.disconnect();
      this.analyser?.disconnect();
      this.analyserSource?.disconnect();
    } catch {
      // The graph may already be disconnected.
    }
    this.pcmProcessor = null;
    this.pcmGain = null;
    this.analyser = null;
    this.analyserSource = null;
    this.analyserBuffer = null;
    const recorder = this.mediaRecorder;
    this.mediaRecorder = null;
    this.stopping = null;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // The browser can already have stopped it.
      }
    }
    this.stream?.getTracks().forEach((audioTrack) => audioTrack.stop());
    this.stream = null;
    this.mediaRecorderIsRecording = false;
  }

  async stop() {
    if (this.mediaRecorder === null) {
      throw new Error(
        "Cannot start an audio recording without initializing a MediaRecorder. Run prepareToRecordAsync() before attempting to start an audio recording.",
      );
    }
    if (this.stopping) return this.stopping;
    const recorder = this.mediaRecorder;
    this.stopping = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        recorder.removeEventListener("stop", onStop);
        recorder.removeEventListener("error", onError);
      };
      const onStop = () => {
        // Keep the processor connected for one more buffer so the last words
        // are not cut off when the recorder stops.
        const tailMs = Math.ceil((4096 / (this.pcmSampleRate || 48000)) * 1000) + 40;
        const now = typeof performance !== "undefined" ? performance.now() : Date.now();
        this.tailHoldUntil = now + tailMs;
        this.capturingPcm = false;
        setTimeout(() => {
          cleanup();
          this.finishTail();
          const data = this.wavFromCapturedSamples();
          const url = data ? URL.createObjectURL(data) : null;
          this.uri = url;
          this.mediaRecorder = null;
          this.stopping = null;
          this.emit(RECORDING_STATUS_UPDATE, { id: this.id, isFinished: true, hasError: false, error: null, url });
          resolve();
        }, tailMs + 80);
      };
      const onError = () => {
        cleanup();
        this.stopping = null;
        reject(new Error("The browser could not finalize the audio recording."));
      };
      recorder.addEventListener("stop", onStop);
      recorder.addEventListener("error", onError);
      try {
        // Flush before stopping; the persistent listener above collects both
        // this chunk and the terminal chunk without a listener-registration race.
        if (recorder.state === "recording") recorder.requestData();
        recorder.stop();
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
    return this.stopping;
  }

  getStatus() {
    const status: Record<string, unknown> = {
      canRecord: this.mediaRecorder?.state === "recording" || this.mediaRecorder?.state === "inactive",
      isRecording: this.mediaRecorder?.state === "recording",
      durationMillis: this.getDurationMillis(),
      mediaServicesDidReset: false,
      url: this.uri,
    };
    if (this.meteringEnabled && this.mediaRecorderIsRecording) status.metering = this.getMeteringLevel();
    return status;
  }

  clearTimeouts() {
    this.timeoutIds.forEach((id) => clearTimeout(id));
    this.timeoutIds = [];
  }

  private async createMediaRecorder(options: WebRecordingOptions) {
    if (typeof navigator !== "undefined" && !navigator.mediaDevices) {
      throw new Error("No media devices available");
    }
    this.uptimeOfLastStartResume = 0;
    this.currentTime = 0;
    this.recordingId = createRecordingId();
    this.trackMuted = false;
    this.trackEnded = false;
    this.lastReport = null;
    const stream = await getUserMedia({ audio: microphoneCaptureConstraints() });
    this.stream = stream;
    const track = stream.getAudioTracks()[0] ?? null;
    this.appliedSettings = describeAppliedMicrophoneSettings(track);
    track?.addEventListener("mute", () => {
      this.trackMuted = true;
    });
    track?.addEventListener("ended", () => {
      this.trackEnded = true;
      this.capturingPcm = false;
    });
    logRecordingCapture({
      recordingId: this.recordingId,
      stage: "microphone-opened",
      settings: this.appliedSettings,
      contextState: getAudioContext().state,
    });

    if (options.isMeteringEnabled) {
      const ctx = getAudioContext();
      if (ctx.state === "suspended") void ctx.resume();
      this.analyserSource = ctx.createMediaStreamSource(stream);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyserSource.connect(this.analyser);
      this.analyserBuffer = new Float32Array(this.analyser.frequencyBinCount);
      this.meteringEnabled = true;
    }

    const recorderOptions: MediaRecorderOptions = {};
    const preferredMimeTypes = [
      options.mimeType,
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
    ].filter((value): value is string => Boolean(value));
    const mimeType = preferredMimeTypes.find((value) => MediaRecorder.isTypeSupported(value));
    if (mimeType) recorderOptions.mimeType = mimeType;
    if (options.bitsPerSecond) recorderOptions.bitsPerSecond = options.bitsPerSecond;
    else if (options.bitRate) recorderOptions.audioBitsPerSecond = options.bitRate;
    else recorderOptions.bitsPerSecond = 128000;

    const mediaRecorder = new MediaRecorder(stream, recorderOptions);
    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data?.size > 0) this.recordingChunks.push(event.data);
    });
    try {
      await this.startPcmCapture(stream);
    } catch (error) {
      stream.getTracks().forEach((audioTrack) => audioTrack.stop());
      this.stream = null;
      throw error;
    }
    mediaRecorder.addEventListener("pause", () => {
      this.capturingPcm = false;
      this.currentTime = this.getDurationMillis();
      this.mediaRecorderIsRecording = false;
    });
    mediaRecorder.addEventListener("resume", () => {
      this.capturingPcm = true;
      this.uptimeOfLastStartResume = Date.now();
      this.mediaRecorderIsRecording = true;
    });
    mediaRecorder.addEventListener("start", () => {
      this.capturingPcm = true;
      this.uptimeOfLastStartResume = Date.now();
      this.currentTime = 0;
      this.mediaRecorderIsRecording = true;
      logRecordingCapture({
        recordingId: this.recordingId,
        stage: "capture-running",
        sampleRate: this.pcmSampleRate,
        contextState: getAudioContext().state,
        settings: this.appliedSettings ?? undefined,
      });
    });
    mediaRecorder.addEventListener("stop", () => {
      this.currentTime = 0;
      this.mediaRecorderIsRecording = false;
    });
    return mediaRecorder;
  }

  private async startPcmCapture(stream: MediaStream) {
    const context = getAudioContext();
    if (context.state === "suspended") {
      try {
        await context.resume();
      } catch {
        // The state check below reports that capture is not running.
      }
    }
    if (context.state !== "running") {
      throw new Error(MICROPHONE_NOT_READY_MESSAGE);
    }
    this.pcmSampleRate = context.sampleRate || 48000;
    this.pcmChunks = [];
    this.frozenSamples = new Float32Array(0);
    const source = this.analyserSource ?? context.createMediaStreamSource(stream);
    if (!this.analyserSource) this.analyserSource = source;
    const processor = context.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => {
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      const keep = this.capturingPcm || (this.tailHoldUntil > 0 && !this.tailFrozen && now < this.tailHoldUntil + 80);
      if (keep) {
        const input = event.inputBuffer.getChannelData(0);
        if (input.length) this.pcmChunks.push(new Float32Array(input));
      }
      if (this.tailHoldUntil && now >= this.tailHoldUntil) this.finishTail();
    };
    const gain = context.createGain();
    gain.gain.value = 0;
    source.connect(processor);
    processor.connect(gain);
    gain.connect(context.destination);
    this.pcmProcessor = processor;
    this.pcmGain = gain;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(MICROPHONE_NOT_READY_MESSAGE)), 700);
      const deliver = processor.onaudioprocess;
      processor.onaudioprocess = (event) => {
        clearTimeout(timeout);
        processor.onaudioprocess = deliver;
        deliver?.call(processor, event);
        resolve();
      };
    });
    const track = stream.getAudioTracks()[0];
    this.appliedSettings = describeAppliedMicrophoneSettings(track);
    if (!track || track.readyState === "ended" || track.muted) {
      throw new Error(MICROPHONE_UNAVAILABLE_MESSAGE);
    }
    logRecordingCapture({
      recordingId: this.recordingId,
      stage: "capture-ready",
      sampleRate: this.pcmSampleRate,
      contextState: context.state,
      settings: this.appliedSettings,
      decision: "graph-running",
    });
  }

  takeCaptureReport(): RecordingCaptureReport | null {
    return this.lastReport;
  }

  get activeRecordingId() {
    return this.recordingId;
  }

  private finishTail() {
    if (this.tailFrozen) return;
    this.tailFrozen = true;
    this.capturingPcm = false;
    this.freezeCapturedSamples();
    this.stream?.getTracks().forEach((audioTrack) => audioTrack.stop());
    this.stream = null;
  }

  private freezeCapturedSamples() {
    this.capturingPcm = false;
    const chunks = this.pcmChunks;
    this.pcmChunks = [];
    let length = 0;
    for (const chunk of chunks) length += chunk.length;
    const mixed = new Float32Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      mixed.set(chunk, offset);
      offset += chunk.length;
    }
    this.frozenSamples = mixed;
    this.pcmProcessor?.disconnect();
    this.pcmGain?.disconnect();
    this.pcmProcessor = null;
    this.pcmGain = null;
  }

  private wavFromCapturedSamples(): Blob | null {
    const samples = this.frozenSamples;
    this.frozenSamples = new Float32Array(0);
    const sampleRate = this.pcmSampleRate || 48000;
    const quality = decideRecordingQuality(summarizeRecordingSignal(samples, sampleRate), {
      muted: this.trackMuted,
      ended: this.trackEnded,
    });
    this.lastReport = {
      recordingId: this.recordingId,
      sampleRate,
      contextState: getAudioContext().state,
      settings: this.appliedSettings ?? describeAppliedMicrophoneSettings(null),
      quality,
    };
    logRecordingCapture({
      recordingId: this.recordingId,
      stage: "capture-finalized",
      durationMs: quality.summary.durationMs,
      sampleRate,
      rms: quality.summary.rms,
      peak: quality.summary.peak,
      clippedRatio: quality.summary.clippedRatio,
      voicedMs: quality.summary.voicedMs,
      decision: quality.reason,
      contextState: this.lastReport.contextState,
      settings: this.lastReport.settings,
    });
    // Quiet but real speech is still encoded: chat-box dictation may send it
    // (see isUsableQuietDictation). Voice Chat still rejects it from the report.
    const keepQuietSpeech =
      quality.action === "reject" &&
      (quality.reason === "too-quiet" || quality.reason === "insufficient-speech") &&
      isUsableQuietDictation(quality.summary);
    if (samples.length < 160 || (quality.action === "reject" && !keepQuietSpeech)) return null;
    const targetRate = this.wavSampleRate && this.wavSampleRate < sampleRate
      ? this.wavSampleRate
      : sampleRate;
    const wav = encodeWavPcm(
      targetRate === sampleRate ? samples : downsamplePcm(samples, sampleRate, targetRate),
      targetRate,
    );
    const bytes = new ArrayBuffer(wav.byteLength);
    new Uint8Array(bytes).set(wav);
    return new Blob([bytes], { type: "audio/wav" });
  }

  private getMeteringLevel() {
    if (!this.analyser || !this.analyserBuffer) return -160;
    this.analyser.getFloatTimeDomainData(this.analyserBuffer);
    let sum = 0;
    for (const sample of this.analyserBuffer) sum += sample * sample;
    const rms = Math.sqrt(sum / this.analyserBuffer.length);
    return rms === 0 ? -160 : 20 * Math.log10(rms);
  }

  private getDurationMillis() {
    let duration = this.currentTime;
    if (this.mediaRecorderIsRecording && this.uptimeOfLastStartResume > 0) {
      duration += Date.now() - this.uptimeOfLastStartResume;
    }
    return duration;
  }
}

export function useAudioRecorder(options: RecordingOptions, statusListener?: (status: unknown) => void) {
  const platformOptions = createRecordingOptions(options);
  const key = JSON.stringify(platformOptions);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const recorder = useMemo(() => new AudioRecorder(platformOptions), [key]);
  useEffect(() => {
    const sub = recorder.addListener(RECORDING_STATUS_UPDATE, (status) => statusListener?.(status));
    return () => {
      recorder.clearTimeouts();
      sub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder.id]);
  return recorder;
}

async function queryMicrophonePermission(): Promise<"granted" | "denied" | "undetermined" | null> {
  if (!navigator?.permissions?.query) return null;
  try {
    const { state } = await navigator.permissions.query({ name: "microphone" as PermissionName });
    if (state === "granted") return "granted";
    if (state === "denied") return "denied";
    return "undetermined";
  } catch {
    return "undetermined";
  }
}

export async function requestRecordingPermissionsAsync(): Promise<PermissionResponse> {
  try {
    const stream = await getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    return { status: "granted", expires: "never", canAskAgain: true, granted: true };
  } catch {
    return { status: "denied", expires: "never", canAskAgain: true, granted: false };
  }
}

export async function getRecordingPermissionsAsync(): Promise<PermissionResponse> {
  const status = await queryMicrophonePermission();
  if (status === "granted") return { status: "granted", expires: "never", canAskAgain: true, granted: true };
  if (status === "denied") return { status: "denied", expires: "never", canAskAgain: true, granted: false };
  return requestRecordingPermissionsAsync();
}

export async function setAudioModeAsync(_mode: Record<string, unknown>): Promise<void> {}

let isAudioActive = true;
const activePlayers = new Set<AudioPlayer>();

export async function setIsAudioActiveAsync(active: boolean) {
  isAudioActive = active;
  if (!active) activePlayers.forEach((p) => p.playing && p.pause());
}

type AudioSource = string | { uri?: string } | null;

function resolveUri(source: AudioSource): string | null {
  if (!source) return null;
  if (typeof source === "string") return source;
  return source.uri ?? null;
}

export class AudioPlayer extends Emitter {
  id = nextId();
  private media: HTMLAudioElement;
  private isPlaying = false;
  private loaded = false;

  constructor(source: AudioSource) {
    super();
    this.media = this.createMediaElement(resolveUri(source));
    activePlayers.add(this);
  }

  get playing() {
    return this.isPlaying;
  }
  get isLoaded() {
    return this.loaded;
  }
  get duration() {
    return Number.isFinite(this.media.duration) ? this.media.duration : 0;
  }
  get currentTime() {
    return this.media.currentTime;
  }
  get volume() {
    return this.media.volume;
  }
  set volume(v: number) {
    this.media.volume = v;
  }
  get muted() {
    return this.media.muted;
  }
  set muted(v: boolean) {
    this.media.muted = v;
  }
  get loop() {
    return this.media.loop;
  }
  set loop(v: boolean) {
    this.media.loop = v;
  }

  get currentStatus() {
    return this.statusFromMedia();
  }

  private statusFromMedia() {
    const m = this.media;
    // readyState often stays at HAVE_CURRENT_DATA (2) on Android Chrome/Brave
    // while audio is already audible. currentTime is the playback signal.
    const playing = !m.paused && !m.ended && m.currentTime > 0;
    return {
      id: this.id,
      isLoaded: true,
      duration: Number.isFinite(m.duration) ? m.duration : 0,
      currentTime: m.currentTime,
      playbackState: "",
      timeControlStatus: playing ? "playing" : "paused",
      reasonForWaitingToPlay: "",
      playing,
      didJustFinish: m.ended,
      isBuffering: false,
      playbackRate: m.playbackRate,
      shouldCorrectPitch: true,
      mute: m.muted,
      loop: m.loop,
      isLive: m.duration === Infinity,
      currentOffsetFromLive: null,
      error: null,
    };
  }

  play() {
    if (!isAudioActive) return;
    void this.media.play().catch(() => undefined);
    this.isPlaying = true;
  }

  pause() {
    this.media.pause();
    this.isPlaying = false;
  }

  async seekTo(seconds: number) {
    this.media.currentTime = seconds;
  }

  replace(source: AudioSource) {
    const wasPlaying = this.isPlaying;
    this.remove();
    this.isPlaying = false;
    this.loaded = false;
    this.media = this.createMediaElement(resolveUri(source));
    activePlayers.add(this);
    if (wasPlaying) this.play();
  }

  remove() {
    this.media.pause();
    this.media.ontimeupdate = null;
    this.media.onplay = null;
    this.media.onpause = null;
    this.media.onseeked = null;
    this.media.onended = null;
    this.media.onloadeddata = null;
    this.media.onerror = null;
    this.media.removeAttribute("src");
    this.media.load();
    activePlayers.delete(this);
  }

  release() {
    this.remove();
  }

  private createMediaElement(uri: string | null) {
    const media = new Audio(uri ?? undefined);
    media.ontimeupdate = () => this.emit(PLAYBACK_STATUS_UPDATE, this.statusFromMedia());
    media.onplay = () => {
      this.isPlaying = true;
      this.emit(PLAYBACK_STATUS_UPDATE, { ...this.statusFromMedia(), playing: true });
    };
    media.onpause = () => {
      this.isPlaying = false;
      this.emit(PLAYBACK_STATUS_UPDATE, { ...this.statusFromMedia(), playing: false });
    };
    media.onended = () => {
      this.isPlaying = false;
      this.emit(PLAYBACK_STATUS_UPDATE, { ...this.statusFromMedia(), didJustFinish: true });
    };
    media.onloadeddata = () => {
      this.loaded = true;
      this.emit(PLAYBACK_STATUS_UPDATE, { ...this.statusFromMedia(), isLoaded: true });
    };
    media.onerror = () => {
      this.isPlaying = false;
      this.emit(PLAYBACK_STATUS_UPDATE, { ...this.statusFromMedia(), error: "Failed to load audio" });
    };
    return media;
  }
}

export function createAudioPlayer(source: AudioSource = null, _options: Record<string, unknown> = {}) {
  return new AudioPlayer(source);
}

export function useAudioPlayer(source: AudioSource = null) {
  const uri = resolveUri(source);
  const player = useMemo(() => new AudioPlayer(uri), [uri]);
  useEffect(() => () => player.remove(), [player]);
  return player;
}

export const AudioModule = {
  requestRecordingPermissionsAsync,
  getRecordingPermissionsAsync,
  setAudioModeAsync,
  setIsAudioActiveAsync,
};
