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
  void (async () => {
    const message = new SpeechSynthesisUtterance();
    if (typeof options.rate === "number") message.rate = options.rate;
    if (typeof options.pitch === "number") message.pitch = options.pitch;
    if (typeof options.language === "string") message.lang = options.language;
    if (typeof options.volume === "number") message.volume = options.volume;
    if (typeof options.voice === "string") {
      const voices = await getVoices();
      const voice = voices[Math.max(0, voices.findIndex((v) => v.voiceURI === options.voice))];
      if (voice) message.voice = voice;
    }
    if (options.onResume) message.onresume = options.onResume;
    if (options.onMark) message.onmark = options.onMark;
    if (options.onBoundary) message.onboundary = options.onBoundary;
    message.onstart = (e) => options.onStart?.(e);
    message.onend = (e) => options.onDone?.(e);
    message.onpause = (e) => options.onStopped?.(e);
    // Same mapping as expo-speech's web module: every synthesis error goes to onError.
    message.onerror = (e) => options.onError?.(new Error(String(e.error ?? "speech error")));
    message.text = text;
    s.speak(message);
  })();
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
  synth()?.cancel();
}

export async function pause(): Promise<void> {
  synth()?.pause();
}

export async function resume(): Promise<void> {
  synth()?.resume();
}
