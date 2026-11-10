/**
 * Realtime voice chat (OpenAI Realtime API over WebRTC).
 *
 * One live connection replaces the classic voice pipeline (record → upload →
 * transcribe → answer → text-to-speech). The browser streams the microphone to
 * the model and plays its voice as it is generated. The model detects the end
 * of the farmer's turn and stops speaking when interrupted.
 *
 * The OpenAI key never reaches the browser: `ask-prana-voice-session` checks
 * the Ask Prana login and returns a short-lived client secret.
 */
import { ensureValidSession, getSupabasePublicConfig } from "./supabase";

export const ASK_PRANA_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

export type RealtimeVoiceLanguage = "auto" | "te" | "hi" | "en";

export type RealtimeVoiceStatus =
  | "connecting"
  | "listening"
  | "hearing"
  | "thinking"
  | "speaking"
  | "ended";

export type RealtimeVoiceHandlers = {
  onStatus: (status: RealtimeVoiceStatus) => void;
  /** What the farmer said (or typed), in conversation order. */
  onUserText: (text: string) => void;
  /** What Ask Prana said, in conversation order. */
  onAssistantText: (text: string) => void;
  /** A problem the farmer should see. `fatal` means the call has ended. */
  onError: (message: string, fatal: boolean) => void;
  /** Any activity from the farmer (speech or typing); used for the idle timer. */
  onActivity?: () => void;
};

export type RealtimeVoiceHistoryItem = { role: "user" | "assistant"; text: string };

export type RealtimeVoiceController = {
  setMuted: (muted: boolean) => void;
  /** Sends a typed question into the live conversation. */
  sendText: (text: string) => boolean;
  /** Stops Ask Prana mid-answer (tap on the orb). */
  interrupt: () => void;
  /** 0..1 loudness of the farmer (mic) and of Ask Prana (speaker). */
  levels: () => { mic: number; speaker: number };
  stop: () => void;
};

/** Injectable browser pieces, so the flow can be exercised without a real call. */
export type RealtimeVoiceDeps = {
  fetch: typeof fetch;
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createPeerConnection: () => RTCPeerConnection;
  createAudioElement: () => HTMLAudioElement;
  createAudioContext: () => AudioContext | null;
  getAccessToken: () => Promise<string | null>;
  supabaseUrl: () => string;
  anonKey: () => string;
};

function defaultDeps(): RealtimeVoiceDeps {
  return {
    fetch: (...args) => fetch(...args),
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    createPeerConnection: () => new RTCPeerConnection(),
    createAudioElement: () => {
      const element = document.createElement("audio");
      element.autoplay = true;
      element.setAttribute("playsinline", "");
      return element;
    },
    createAudioContext: () => {
      const Context = window.AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      try {
        return Context ? new Context() : null;
      } catch {
        return null;
      }
    },
    getAccessToken: async () => (await ensureValidSession())?.access_token ?? null,
    supabaseUrl: () => getSupabasePublicConfig().url,
    anonKey: () => (process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "").trim(),
  };
}

export function isRealtimeVoiceSupported() {
  return (
    typeof window !== "undefined" &&
    typeof RTCPeerConnection !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

class RealtimeVoiceError extends Error {}

function microphoneErrorMessage(error: unknown) {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access is blocked. Allow the microphone for this site and try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No microphone was found. Connect a microphone and try again.";
  }
  if (name === "NotReadableError") {
    return "The microphone is being used by another app. Close it and try again.";
  }
  return "The microphone could not be started. Please try again.";
}

/** Joins farmer and assistant transcripts in the order the turns happened. */
export function createRealtimeTurnOrder(emit: {
  user: (text: string) => void;
  assistant: (text: string) => void;
}, flushAfterMs = 5000) {
  const awaitingUser = new Set<string>();
  const heldAssistant: string[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    while (heldAssistant.length) emit.assistant(heldAssistant.shift()!);
  };

  return {
    /** The farmer finished a spoken turn; its transcript is on the way. */
    userAudioCommitted(itemId: string) {
      if (itemId) awaitingUser.add(itemId);
    },
    userTranscript(itemId: string, text: string) {
      awaitingUser.delete(itemId);
      if (text.trim()) emit.user(text.trim());
      if (!awaitingUser.size) flush();
    },
    userTranscriptFailed(itemId: string) {
      awaitingUser.delete(itemId);
      if (!awaitingUser.size) flush();
    },
    userTyped(text: string) {
      if (text.trim()) emit.user(text.trim());
    },
    assistantTranscript(text: string) {
      if (!text.trim()) return;
      if (!awaitingUser.size) {
        emit.assistant(text.trim());
        return;
      }
      // The answer arrived before the question's transcript. Hold it briefly
      // so the chat shows the question first; never hold it forever.
      heldAssistant.push(text.trim());
      if (!flushTimer) {
        flushTimer = setTimeout(() => {
          awaitingUser.clear();
          flush();
        }, flushAfterMs);
      }
    },
    dispose() {
      awaitingUser.clear();
      flush();
    },
  };
}

type ServerEvent = {
  type?: string;
  item_id?: string;
  transcript?: string;
  error?: { message?: string; code?: string };
};

export async function startAskPranaRealtimeVoice(options: {
  language: RealtimeVoiceLanguage;
  history?: RealtimeVoiceHistoryItem[];
  handlers: RealtimeVoiceHandlers;
  deps?: Partial<RealtimeVoiceDeps>;
}): Promise<RealtimeVoiceController> {
  const deps = { ...defaultDeps(), ...options.deps };
  const { handlers } = options;
  let stopped = false;
  let pc: RTCPeerConnection | null = null;
  let channel: RTCDataChannel | null = null;
  let mic: MediaStream | null = null;
  let player: HTMLAudioElement | null = null;
  let audioContext: AudioContext | null = null;
  let micAnalyser: AnalyserNode | null = null;
  let speakerAnalyser: AnalyserNode | null = null;
  let speaking = false;

  const order = createRealtimeTurnOrder({
    user: (text) => !stopped && handlers.onUserText(text),
    assistant: (text) => !stopped && handlers.onAssistantText(text),
  });

  const setStatus = (status: RealtimeVoiceStatus) => {
    if (!stopped || status === "ended") handlers.onStatus(status);
  };

  const release = () => {
    order.dispose();
    try { channel?.close(); } catch { /* already closed */ }
    try { pc?.getSenders().forEach((sender) => sender.track?.stop()); } catch { /* ignore */ }
    try { pc?.close(); } catch { /* already closed */ }
    mic?.getTracks().forEach((track) => track.stop());
    if (player) {
      try { player.pause(); } catch { /* ignore */ }
      player.srcObject = null;
      player.remove();
    }
    void audioContext?.close().catch(() => undefined);
    channel = null;
    pc = null;
    mic = null;
    player = null;
    audioContext = null;
    micAnalyser = null;
    speakerAnalyser = null;
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    release();
    handlers.onStatus("ended");
  };

  const fail = (message: string) => {
    if (stopped) return;
    handlers.onError(message, true);
    stop();
  };

  const levelOf = (analyser: AnalyserNode | null) => {
    if (!analyser) return 0;
    const samples = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(samples);
    let energy = 0;
    for (const sample of samples) {
      const value = (sample - 128) / 128;
      energy += value * value;
    }
    return Math.min(1, Math.sqrt(energy / samples.length) * 4);
  };

  const attachAnalyser = (stream: MediaStream) => {
    if (!audioContext) return null;
    try {
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      audioContext.createMediaStreamSource(stream).connect(analyser);
      return analyser;
    } catch {
      return null;
    }
  };

  const handleEvent = (event: ServerEvent) => {
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        handlers.onActivity?.();
        setStatus("hearing");
        break;
      case "input_audio_buffer.speech_stopped":
        setStatus("thinking");
        break;
      case "input_audio_buffer.committed":
        order.userAudioCommitted(event.item_id ?? "");
        break;
      case "conversation.item.input_audio_transcription.completed":
        order.userTranscript(event.item_id ?? "", event.transcript ?? "");
        break;
      case "conversation.item.input_audio_transcription.failed":
        order.userTranscriptFailed(event.item_id ?? "");
        break;
      case "output_audio_buffer.started":
        speaking = true;
        setStatus("speaking");
        break;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        speaking = false;
        setStatus("listening");
        break;
      case "response.output_audio_transcript.done":
        order.assistantTranscript(event.transcript ?? "");
        break;
      case "response.done":
        if (!speaking) setStatus("listening");
        break;
      case "error": {
        const code = event.error?.code ?? "";
        console.warn("[AskPranaRealtime] server error", code, event.error?.message ?? "");
        // Cancelling a response that already finished is harmless.
        if (code === "response_cancel_not_active") break;
        handlers.onError("Ask Prana had a problem with that turn. Please say it again.", false);
        setStatus("listening");
        break;
      }
      default:
        break;
    }
  };

  setStatus("connecting");
  try {
    // 1. Short-lived client secret from our own backend.
    const accessToken = await deps.getAccessToken();
    if (!accessToken) throw new RealtimeVoiceError("Your session has expired. Please log in again.");
    const supabaseUrl = deps.supabaseUrl();
    const anonKey = deps.anonKey();
    if (!supabaseUrl || !anonKey) throw new RealtimeVoiceError("Voice chat is not configured.");
    const sessionResponse = await deps.fetch(`${supabaseUrl}/functions/v1/ask-prana-voice-session`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: anonKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ language: options.language, history: options.history ?? [] }),
    });
    const sessionBody = await sessionResponse.json().catch(() => null) as
      | { clientSecret?: string; error?: string }
      | null;
    if (!sessionResponse.ok || !sessionBody?.clientSecret) {
      throw new RealtimeVoiceError(sessionBody?.error || "Voice chat is unavailable right now. Please try again.");
    }
    if (stopped) return { setMuted() {}, sendText: () => false, interrupt() {}, levels: () => ({ mic: 0, speaker: 0 }), stop };

    // 2. Microphone.
    try {
      mic = await deps.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (error) {
      throw new RealtimeVoiceError(microphoneErrorMessage(error));
    }
    if (stopped) {
      release();
      return { setMuted() {}, sendText: () => false, interrupt() {}, levels: () => ({ mic: 0, speaker: 0 }), stop };
    }

    // 3. Peer connection: mic up, model voice down, events on a data channel.
    audioContext = deps.createAudioContext();
    void audioContext?.resume().catch(() => undefined);
    micAnalyser = attachAnalyser(mic);
    pc = deps.createPeerConnection();
    player = deps.createAudioElement();
    if (typeof document !== "undefined" && player && !player.isConnected) {
      player.style.display = "none";
      document.body.appendChild(player);
    }
    pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (!stream || !player) return;
      player.srcObject = stream;
      void player.play().catch(() => {
        handlers.onError("Tap the circle to turn on Ask Prana's voice.", false);
      });
      speakerAnalyser = attachAnalyser(stream);
    };
    pc.onconnectionstatechange = () => {
      const state = pc?.connectionState;
      if (state === "failed" || state === "disconnected") {
        fail("The voice connection was lost. Check your internet and try again.");
      }
    };
    mic.getAudioTracks().forEach((track) => pc!.addTrack(track, mic!));
    channel = pc.createDataChannel("oai-events");
    channel.onopen = () => setStatus("listening");
    channel.onmessage = (message) => {
      try {
        handleEvent(JSON.parse(String(message.data)) as ServerEvent);
      } catch {
        // Ignore a malformed event; the next one keeps the call going.
      }
    };

    // 4. Connect to OpenAI with the client secret.
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const answerResponse = await deps.fetch(ASK_PRANA_REALTIME_CALLS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sessionBody.clientSecret}`,
        "Content-Type": "application/sdp",
      },
      body: offer.sdp,
    });
    if (!answerResponse.ok) {
      console.warn("[AskPranaRealtime] call setup failed", answerResponse.status);
      throw new RealtimeVoiceError("Could not connect to voice chat. Please try again.");
    }
    const answerSdp = await answerResponse.text();
    if (stopped) {
      release();
      return { setMuted() {}, sendText: () => false, interrupt() {}, levels: () => ({ mic: 0, speaker: 0 }), stop };
    }
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
  } catch (error) {
    const message = error instanceof RealtimeVoiceError
      ? error.message
      : "Could not connect to voice chat. Please try again.";
    if (!(error instanceof RealtimeVoiceError)) console.warn("[AskPranaRealtime] start failed", error);
    fail(message);
    return { setMuted() {}, sendText: () => false, interrupt() {}, levels: () => ({ mic: 0, speaker: 0 }), stop };
  }

  return {
    setMuted(muted) {
      mic?.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
    },
    sendText(text) {
      const question = text.trim();
      if (!question || stopped || channel?.readyState !== "open") return false;
      handlers.onActivity?.();
      order.userTyped(question);
      channel.send(JSON.stringify({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: question }] },
      }));
      channel.send(JSON.stringify({ type: "response.create" }));
      setStatus("thinking");
      return true;
    },
    interrupt() {
      if (stopped || channel?.readyState !== "open") return;
      channel.send(JSON.stringify({ type: "response.cancel" }));
      // WebRTC only: drop audio that was already sent to the speaker.
      channel.send(JSON.stringify({ type: "output_audio_buffer.clear" }));
    },
    levels: () => ({ mic: levelOf(micAnalyser), speaker: levelOf(speakerAnalyser) }),
    stop,
  };
}
