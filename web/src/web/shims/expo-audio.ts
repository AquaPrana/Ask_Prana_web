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

  constructor(private options: WebRecordingOptions) {
    super();
  }

  get isRecording() {
    return this.mediaRecorder?.state === "recording";
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

  async stop() {
    if (this.mediaRecorder === null) {
      throw new Error(
        "Cannot start an audio recording without initializing a MediaRecorder. Run prepareToRecordAsync() before attempting to start an audio recording.",
      );
    }
    const recorder = this.mediaRecorder;
    const data = await new Promise<Blob>((resolve, reject) => {
      const chunks: BlobPart[] = [];
      const cleanup = () => {
        recorder.removeEventListener("dataavailable", onData);
        recorder.removeEventListener("stop", onStop);
        recorder.removeEventListener("error", onError);
      };
      const onData = (event: BlobEvent) => {
        if (event.data?.size > 0) chunks.push(event.data);
      };
      const onStop = () => {
        cleanup();
        resolve(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
      };
      const onError = () => {
        cleanup();
        reject(new Error("The browser could not finalize the audio recording."));
      };
      recorder.addEventListener("dataavailable", onData);
      recorder.addEventListener("stop", onStop);
      recorder.addEventListener("error", onError);
      try {
        // Ask Chromium to flush the final chunk before ending the stream.
        recorder.requestData();
        recorder.stop();
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
    this.mediaRecorder = null;
    if (data.size === 0) {
      throw new Error("The browser returned an empty audio recording.");
    }
    const url = URL.createObjectURL(data);
    this.uri = url;
    this.emit(RECORDING_STATUS_UPDATE, { id: this.id, isFinished: true, hasError: false, error: null, url });
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
    const stream = await getUserMedia({ audio: true });
    this.stream = stream;

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
    mediaRecorder.addEventListener("pause", () => {
      this.currentTime = this.getDurationMillis();
      this.mediaRecorderIsRecording = false;
    });
    mediaRecorder.addEventListener("resume", () => {
      this.uptimeOfLastStartResume = Date.now();
      this.mediaRecorderIsRecording = true;
    });
    mediaRecorder.addEventListener("start", () => {
      this.uptimeOfLastStartResume = Date.now();
      this.currentTime = 0;
      this.mediaRecorderIsRecording = true;
    });
    mediaRecorder.addEventListener("stop", () => {
      this.currentTime = 0;
      this.mediaRecorderIsRecording = false;
      this.stream = null;
      this.analyserSource?.disconnect();
      this.analyserSource = null;
      this.analyser?.disconnect();
      this.analyser = null;
      this.analyserBuffer = null;
      // Clears the recording indicator in the browser tab.
      stream.getTracks().forEach((track) => track.stop());
    });
    return mediaRecorder;
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
    const playing = !!(m.currentTime > 0 && !m.paused && !m.ended && m.readyState > 2);
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
