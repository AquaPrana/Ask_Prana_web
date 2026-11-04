/** Web replacement for expo-speech, ported from its web module (SpeechSynthesis API). */
export type Voice = {
  identifier: string;
  name: string;
  quality: string;
  language: string;
  isDefault?: boolean;
  localService?: boolean;
  voiceURI?: string;
};

export type SpeechOptions = {
  language?: string;
  pitch?: number;
  rate?: number;
  volume?: number;
  voice?: string;
  onStart?: (event?: unknown) => void;
  onDone?: (event?: unknown) => void;
  onStopped?: (event?: unknown) => void;
  onError?: (error: Error) => void;
  onBoundary?: (event: unknown) => void;
  onMark?: (event: unknown) => void;
  onPause?: (event: unknown) => void;
  onResume?: (event: unknown) => void;
};

export const maxSpeechInputLength = 32767;

function synth(): SpeechSynthesis | null {
  return typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
}

async function getVoices(): Promise<SpeechSynthesisVoice[]> {
  const s = synth();
  if (!s) return [];
  const voices = s.getVoices();
  if (voices.length > 0) return voices;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(s.getVoices()), 1500);
    s.onvoiceschanged = () => {
      clearTimeout(timer);
      resolve(s.getVoices());
    };
  });
}

type ActiveSpeech = {
  settled: boolean;
  started: boolean;
  sawSilence: boolean;
  silentTicks: number;
  startedAt: number;
  lastResume: number;
  poll: ReturnType<typeof setInterval> | null;
  onStart?: SpeechOptions["onStart"];
  onDone?: SpeechOptions["onDone"];
  onStopped?: SpeechOptions["onStopped"];
  onError?: SpeechOptions["onError"];
};

let activeSpeech: ActiveSpeech | null = null;

function engineBusy(s: SpeechSynthesis) {
  return Boolean(s.speaking || s.pending);
}

function settleSpeech(record: ActiveSpeech, kind: "done" | "stopped" | "error", error?: Error) {
  if (record.settled) return;
  record.settled = true;
  if (record.poll) {
    clearInterval(record.poll);
    record.poll = null;
  }
  if (activeSpeech === record) activeSpeech = null;
  if (kind === "done") record.onDone?.();
  else if (kind === "stopped") record.onStopped?.();
  else record.onError?.(error ?? new Error("speech error"));
}

/**
 * Android Chrome and Brave often play speechSynthesis audio without ever
 * firing utterance onstart or onend. Watch the engine itself so playback
 * status follows the sound, including across queued sentences.
 */
function watchSpeech(s: SpeechSynthesis, record: ActiveSpeech) {
  if (record.settled) return;
  const active = engineBusy(s);
  if (!record.started) {
    if (!active) record.sawSilence = true;
    const waited = Date.now() - record.startedAt;
    if (active && (record.sawSilence || waited >= 150)) {
      record.started = true;
      record.silentTicks = 0;
      record.onStart?.();
    }
    return;
  }
  if (active) {
    record.silentTicks = 0;
    // Long Android utterances pause themselves unless synthesis is resumed.
    const now = Date.now();
    if (now - record.lastResume > 10_000) {
      record.lastResume = now;
      try { s.resume(); } catch { /* ignore */ }
    }
    return;
  }
  record.silentTicks += 1;
  if (record.silentTicks >= 8) settleSpeech(record, "done");
}

function beginSpeech(s: SpeechSynthesis, message: SpeechSynthesisUtterance, record: ActiveSpeech) {
  if (record.settled) return;
  message.onstart = () => {
    if (record.settled || record.started) return;
    record.started = true;
    record.silentTicks = 0;
    record.onStart?.();
  };
  message.onend = () => settleSpeech(record, "done");
  message.onpause = () => settleSpeech(record, "stopped");
  message.onerror = (event) =>
    settleSpeech(record, "error", new Error(String(event.error ?? "speech error")));
  s.speak(message);
  try { s.resume(); } catch { /* ignore */ }
  record.poll = setInterval(() => watchSpeech(s, record), 50);
}

export function speak(text: string, options: SpeechOptions = {}): void {
  const s = synth();
  if (!s) {
    options.onError?.(new Error("Speech synthesis is not available in this browser."));
    return;
  }
  if (text.length > maxSpeechInputLength) {
    options.onError?.(new Error(`Speech input text is too long! Limit of input length is: ${maxSpeechInputLength}`));
    return;
  }
  if (activeSpeech && !activeSpeech.settled) settleSpeech(activeSpeech, "stopped");
  const message = new SpeechSynthesisUtterance();
  if (typeof options.rate === "number") message.rate = options.rate;
  if (typeof options.pitch === "number") message.pitch = options.pitch;
  if (typeof options.language === "string") message.lang = options.language;
  if (typeof options.volume === "number") message.volume = options.volume;
  if (options.onResume) message.onresume = options.onResume;
  if (options.onMark) message.onmark = options.onMark;
  if (options.onBoundary) message.onboundary = options.onBoundary;
  const record: ActiveSpeech = {
    settled: false,
    started: false,
    sawSilence: !engineBusy(s),
    silentTicks: 0,
    startedAt: Date.now(),
    lastResume: Date.now(),
    poll: null,
    onStart: options.onStart,
    onDone: options.onDone,
    onStopped: options.onStopped,
    onError: options.onError,
  };
  activeSpeech = record;
  message.text = text;
  if (typeof options.voice === "string") {
    void getVoices().then((voices) => {
      if (record.settled) return;
      const voice = voices.find((item) => item.voiceURI === options.voice);
      if (voice) message.voice = voice;
      beginSpeech(s, message, record);
    });
    return;
  }
  beginSpeech(s, message, record);
}

export async function getAvailableVoicesAsync(): Promise<Voice[]> {
  const voices = await getVoices();
  return voices.map((voice) => ({
    identifier: voice.voiceURI,
    quality: "Default",
    isDefault: voice.default,
    language: voice.lang,
    localService: voice.localService,
    name: voice.name,
    voiceURI: voice.voiceURI,
  }));
}

export async function isSpeakingAsync(): Promise<boolean> {
  return Boolean(synth()?.speaking);
}

export async function stop(): Promise<void> {
  if (activeSpeech && !activeSpeech.settled) settleSpeech(activeSpeech, "stopped");
  synth()?.cancel();
}

export async function pause(): Promise<void> {
  synth()?.pause();
}

export async function resume(): Promise<void> {
  synth()?.resume();
}
