// Dependency-free regression harness for the browser SpeechRecognition wrapper.
// Run with: node scripts/voice-dictation-harness.mjs
// It uses Vite's installed TypeScript loader; no test framework is required.
import { readFileSync } from "node:fs";
import { createServer } from "vite";
import { parseProviderTranscription } from "../../supabase/functions/ask-prana-transcribe/parse-provider-transcription.mjs";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

class MockRecognition {
  static instances = [];
  constructor() {
    this.lang = "";
    this.continuous = false;
    this.interimResults = false;
    this.maxAlternatives = 0;
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
    this.onspeechstart = null;
    this.onspeechend = null;
    this.onsoundstart = null;
    this.onsoundend = null;
    this.startCount = 0;
    MockRecognition.instances.push(this);
  }
  start() { this.startCount += 1; }
  stop() { this.onend?.(); }
  abort() { this.onend?.(); }
  result(transcript, isFinal = false, index = 0) {
    const results = [];
    results[index] = { isFinal, 0: { transcript } };
    this.onresult?.({ resultIndex: index, results });
  }
}

globalThis.window = {
  SpeechRecognition: MockRecognition,
  setTimeout,
  clearTimeout,
};
globalThis.performance ??= { now: () => Date.now() };

const server = await createServer({
  root: process.cwd(),
  configFile: false,
  plugins: [{
    name: "voice-harness-react-native-web",
    enforce: "pre",
    resolveId(id) {
      return id === "react-native" ? "\0voice-harness-react-native" : null;
    },
    load(id) {
      return id === "\0voice-harness-react-native"
        ? 'export const Platform = { OS: "web" };'
        : null;
    },
  }],
  ssr: { noExternal: ["react-native"] },
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
});
try {
  const { startWebDictation } = await server.ssrLoadModule("/src/lib/ask-prana-dictation.ts");

  // Finalized segments survive, interim corrections replace the same slot, and
  // stopping resolves exactly one complete transcript.
  const partials = [];
  const normal = startWebDictation("en", {
    onPartial: (text) => partials.push(text), onError: () => {},
  });
  const first = MockRecognition.instances.at(-1);
  first.result("Tell me about", false);
  first.result("Tell me about shrimp farming", true);
  const normalText = await normal.stop();
  assert(normalText === "Tell me about shrimp farming", "final transcript was not preserved");
  assert(partials.at(-1) === normalText, "interim correction was not rendered in place");

  // With no onspeechend event, the bounded fallback still finalizes one turn.
  let fallbackCount = 0;
  const fallback = startWebDictation("en", {
    onPartial: () => {}, onError: () => {}, onUtteranceEnd: () => { fallbackCount += 1; },
  });
  MockRecognition.instances.at(-1).result("second question", true);
  // Two words count as unfinished, so the no-speech-end fallback waits
  // 2400 ms plus the 1400 ms unfinished extension.
  await sleep(4_000);
  assert(fallbackCount === 1, "missing-speechend fallback did not finalize exactly once");
  await fallback.stop();

  // Chrome may emit onend before its final result. The wrapper must retain
  // that result during the bounded finalization grace period.
  const lateFinal = startWebDictation("en", { onPartial: () => {}, onError: () => {} });
  const lateRecognition = MockRecognition.instances.at(-1);
  lateRecognition.result("late", false);
  lateRecognition.onend?.();
  const lateStop = lateFinal.stop();
  await sleep(100);
  lateRecognition.result("late final words", true);
  assert(await lateStop === "late final words", "late final result was discarded after recognition end");

  // A new speech event cancels a pending confirmed-silence finalization.
  let pauseCount = 0;
  const pause = startWebDictation("en", {
    onPartial: () => {}, onError: () => {}, onUtteranceEnd: () => { pauseCount += 1; },
  });
  const pausing = MockRecognition.instances.at(-1);
  pausing.result("long question", true);
  pausing.onspeechend?.();
  await sleep(120);
  pausing.onspeechstart?.();
  await sleep(1_050);
  assert(pauseCount === 0, "new speech did not cancel the pending silence timer");
  await pause.stop();

  // Five consecutive browser-recognition sessions model the handoff used
  // after each completed assistant reply. No transcript or session may leak.
  for (let turn = 1; turn <= 5; turn += 1) {
    const session = startWebDictation("en", { onPartial: () => {}, onError: () => {} });
    MockRecognition.instances.at(-1).result(`turn ${turn}`, true);
    const text = await session.stop();
    assert(text === `turn ${turn}`, `consecutive turn ${turn} did not resolve cleanly`);
  }

  const { isAssistantEchoTranscript, isUnclearVoiceTranscript } = await server.ssrLoadModule(
    "/src/lib/ask-prana-voice-transcript.ts",
  );
  assert(isUnclearVoiceTranscript("  ") === true, "blank recognition should be unclear");
  assert(isUnclearVoiceTranscript("Thanks for watching!") === true, "non-speech hallucination should be unclear");
  assert(isUnclearVoiceTranscript("Хай вам спавно! Хавані!") === false, "an unexpected script is not discarded by itself");
  assert(isUnclearVoiceTranscript("How much feed for my pond?") === false, "a real question should be kept");
  assert(
    isAssistantEchoTranscript("oxygen stays low in the pond", "Oxygen stays low in the pond today.") === true,
    "assistant audio should match as echo",
  );
  assert(
    isAssistantEchoTranscript("what about salinity", "Oxygen stays low in the pond today.") === false,
    "a different interruption should not match as echo",
  );

  class MockUtterance {
    constructor() {
      this.text = "";
      this.lang = "";
      this.onstart = null;
      this.onend = null;
      this.onerror = null;
      this.onpause = null;
    }
  }
  globalThis.SpeechSynthesisUtterance = MockUtterance;
  const synth = {
    speaking: false,
    pending: false,
    speak() {
      this.speaking = true;
    },
    cancel() {
      this.speaking = false;
      this.pending = false;
    },
    resume() {},
    getVoices() { return []; },
  };
  globalThis.window.speechSynthesis = synth;
  const { speak, stop } = await server.ssrLoadModule("/src/web/shims/expo-speech.ts");
  const events = [];
  speak("The pond is ready.", {
    language: "en-IN",
    onStart: () => events.push("start"),
    onDone: () => events.push("done"),
    onStopped: () => events.push("stopped"),
  });
  await sleep(120);
  assert(events[0] === "start", "playback start should be detected without an onstart event");
  synth.speaking = false;
  await sleep(500);
  assert(events[1] === "done", "playback end should be detected without an onend event");

  const cancelled = [];
  synth.speaking = false;
  speak("Another sentence.", {
    onStart: () => cancelled.push("start"),
    onDone: () => cancelled.push("done"),
    onStopped: () => cancelled.push("stopped"),
  });
  await sleep(80);
  await stop();
  synth.speaking = false;
  await sleep(500);
  assert(cancelled.includes("start"), "the cancelled sentence had started");
  assert(cancelled.includes("stopped"), "stop should settle the active sentence");
  assert(!cancelled.includes("done"), "a cancelled sentence must not also report completion");

  const {
    MAX_PROVIDER_CALLS_PER_RECORDING,
    browserRecognitionLanguage,
    cloudTranscriptionLanguage,
    decideVoiceTranscript,
    documentedUploadForRecording,
    encodeWavPcm,
    isRejectedAudioContainerError,
    isStaleVoiceCapture,
    mapRequestedSttLanguage,
    planCloudTranscriptionAttempts,
    providerAudioFileCode,
    acceptSpokenQuestion,
    recognitionModeFrom,
    recognizedTranscriptionContainer,
    resolveSpokenReplyLanguage,
    shouldUseFallbackModel,
    suggestsTeluguMisread,
  } = await server.ssrLoadModule("/src/lib/ask-prana-transcription-language.ts");

  for (const language of ["te", "hi", "en"]) {
    const attempts = planCloudTranscriptionAttempts(language);
    assert(attempts.length === 1, `${language} should have one bounded provider attempt`);
    assert(
      attempts.every((attempt) => attempt.model === "gpt-transcribe" && attempt.language === language),
      `${language} must stay explicit on gpt-transcribe`,
    );
  }
  const automatic = planCloudTranscriptionAttempts(null);
  assert(
    automatic.every((attempt) => attempt.model === "gpt-transcribe" && attempt.language === null),
    "automatic detection stays automatic on its provider request",
  );
  assert(shouldUseFallbackModel([{ ok: false, transcript: "" }]) === false, "provider failures do not create a hidden fallback request");
  assert(recognizedTranscriptionContainer("webm") === true, "Brave WebM is an accepted recording");
  const webmUpload = documentedUploadForRecording("audio/webm;codecs=opus");
  assert(
    webmUpload.container === "wav" && webmUpload.mimeType === "audio/wav" && webmUpload.fileName === "askprana-recording.wav",
    "browser WebM/Opus is uploaded as documented WAV",
  );
  assert(documentedUploadForRecording("audio/wav").container === "original", "an existing WAV recording is not remuxed again");
  assert(documentedUploadForRecording("audio/mp4").container === "original", "an MPEG-4 recording stays in its container");
  const wavBytes = encodeWavPcm(new Float32Array([0, 0.5, -0.5]), 16000);
  assert(
    String.fromCharCode(...wavBytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...wavBytes.slice(8, 12)) === "WAVE",
    "the remux writes a RIFF WAV header",
  );
  assert(
    providerAudioFileCode({
      recognizedContainer: "webm",
      uploadedContainer: "webm",
      providerParam: "file",
      providerMessage: "Audio file might be corrupted or unsupported",
    }) === null,
    "a recognized WebM recording is not returned as PROVIDER_AUDIO_FILE",
  );
  assert(
    providerAudioFileCode({
      recognizedContainer: "unknown",
      uploadedContainer: "unknown",
      providerParam: "file",
      providerMessage: "Audio file might be corrupted or unsupported",
    }) === "PROVIDER_AUDIO_FILE",
    "a real corrupted file is still PROVIDER_AUDIO_FILE",
  );
  assert(
    isRejectedAudioContainerError("That voice recording format isn't supported. Please try again.") === true,
    "a rejected container is a format error",
  );
  assert(
    isRejectedAudioContainerError("Invalid file format. Supported formats: ['webm']") === false,
    "a fallback format failure for recognized WebM does not become VOICE_FORMAT",
  );
  assert(
    isRejectedAudioContainerError("The model does not support this format for language te") === false,
    "a model or language failure is not a format alert",
  );
  assert(mapRequestedSttLanguage("te-IN") === "te", "te-IN is Telugu");
  assert(mapRequestedSttLanguage("hi-IN") === "hi", "hi-IN is Hindi");
  assert(mapRequestedSttLanguage("en-IN") === "en", "en-IN is English");
  assert(mapRequestedSttLanguage("auto") === null && mapRequestedSttLanguage("") === null, "only an automatic request omits the language");
  assert(mapRequestedSttLanguage("ta-IN") === null, "an unknown language is not silently replaced with English");
  assert(browserRecognitionLanguage("te") === "te-IN", "Telugu browser recognition uses te-IN");
  assert(browserRecognitionLanguage("hi") === "hi-IN", "Hindi browser recognition uses hi-IN");
  assert(browserRecognitionLanguage("en") === "en-IN", "English browser recognition uses en-IN");
  assert(cloudTranscriptionLanguage("te") === "te", "Telugu cloud transcription uses te");
  assert(cloudTranscriptionLanguage("hi") === "hi", "Hindi cloud transcription uses hi");
  assert(cloudTranscriptionLanguage("en") === "en", "English cloud transcription uses en");
  assert(MAX_PROVIDER_CALLS_PER_RECORDING === 1, "one recording may use at most one provider call");

  const teluguQuestion = "నా చెరువులో ఆక్సిజన్ తగ్గింది. ఏం చేయాలి?";
  const teluguFeed = "రొయ్యలు మేత తినడం లేదు. కారణం ఏమిటి?";
  const teluguPh = "నా చెరువులో pH ఎక్కువగా ఉంది.";
  const devanagariMisread = "ननि की गला तीस् कोळसन जागरतिलो तिलिय जियव लिनो.";
  assert(suggestsTeluguMisread("te", teluguQuestion) === false, "a Telugu question is not a misread");
  assert(suggestsTeluguMisread("te", teluguFeed) === false, "a Telugu feed question is not a misread");
  assert(suggestsTeluguMisread("te", teluguPh) === false, "Telugu with pH is not a misread");
  assert(suggestsTeluguMisread("te", "oxygen level is low in my pond") === false, "an English aquaculture sentence is kept");
  assert(suggestsTeluguMisread("hi", devanagariMisread) === false, "Hindi speech in Devanagari is kept");
  assert(suggestsTeluguMisread("te", devanagariMisread) === true, "Telugu requested as Devanagari is a misread signal");

  const accepted = decideVoiceTranscript({ language: "te", first: teluguPh });
  assert(accepted.action === "accept" && accepted.retryCount === 0 && accepted.text === teluguPh, "mixed Telugu and pH is accepted once");
  const retryStillWrong = decideVoiceTranscript({
    language: "te",
    first: devanagariMisread,
    retry: devanagariMisread,
  });
  assert(
    retryStillWrong.action === "accept" && retryStillWrong.text === devanagariMisread,
    "a Devanagari question is submitted instead of being discarded",
  );
  const keptFirst = decideVoiceTranscript({
    language: "te",
    first: teluguQuestion,
    retry: "",
  });
  assert(
    keptFirst.action === "accept" && keptFirst.text === teluguQuestion,
    "an empty retry keeps the original Telugu question",
  );
  const retryRecovered = decideVoiceTranscript({
    language: "te",
    first: devanagariMisread,
    retry: teluguQuestion,
  });
  assert(
    retryRecovered.action === "accept" && retryRecovered.retryCount === 1 && retryRecovered.text === teluguQuestion,
    "the explicit Telugu retry replaces the mismatched text",
  );
  const hindi = decideVoiceTranscript({ language: "hi", first: "झींगा खाना नहीं खा रहा है" });
  assert(hindi.action === "accept" && hindi.text.startsWith("झींगा"), "Hindi is accepted without a script retry");
  assert(recognitionModeFrom("auto") === "auto" && recognitionModeFrom("te-IN") === "te", "Auto stays Auto and te-IN is explicit Telugu");
  assert(resolveSpokenReplyLanguage({ mode: "te", detected: "hi" }) === "te", "explicit Telugu is not replaced by a Hindi detection");
  assert(resolveSpokenReplyLanguage({ mode: "auto", detected: "telugu" }) === "te", "Auto uses Whisper's Telugu audio language");
  assert(resolveSpokenReplyLanguage({ mode: "auto", detected: "hindi" }) === "hi", "Auto uses Whisper's Hindi audio language");
  assert(resolveSpokenReplyLanguage({ mode: "auto", detected: "english" }) === "en", "Auto uses Whisper's English audio language");
  assert(resolveSpokenReplyLanguage({ mode: "auto", detected: "tamil" }) === null, "Auto does not accept an unsupported language when the transcript is missing");
  assert(resolveSpokenReplyLanguage({ mode: "auto", detected: null }) === null, "Auto does not guess from the website language when no transcript is present");
  assert(resolveSpokenReplyLanguage({ mode: "auto", detected: null, transcript: teluguQuestion }) === null, "Auto without audio detection does not infer Telugu from script");
  assert(resolveSpokenReplyLanguage({ mode: "auto", detected: null, transcript: "मेरे तालाब में ऑक्सीजन कम है। मुझे क्या करना चाहिए?" }) === null, "Auto + Devanagari transcript does not select Hindi");
  assert(resolveSpokenReplyLanguage({ mode: "auto", detected: null, transcript: "The oxygen in my pond is low. What should I do?" }) === null, "Auto + Latin transcript does not select English");
  const acceptedTelugu = acceptSpokenQuestion({ mode: "auto", transcript: teluguQuestion, detected: "te" });
  const acceptedHindi = acceptSpokenQuestion({ mode: "auto", transcript: "मेरे तालाब में ऑक्सीजन कम है।", detected: "hi" });
  const acceptedEnglish = acceptSpokenQuestion({ mode: "auto", transcript: "The oxygen in my pond is low. What should I do?", detected: "en" });
  const emptyQuestion = acceptSpokenQuestion({ mode: "auto", transcript: "   ", detected: "telugu" });
  const explicitTelugu = acceptSpokenQuestion({ mode: "te", transcript: devanagariMisread, detected: "hi" });
  assert(acceptedTelugu.action === "accept" && acceptedTelugu.language === "te" && acceptedTelugu.text === teluguQuestion, "a Telugu question is sent to Ask Prana");
  assert(acceptedHindi.action === "accept" && acceptedHindi.language === "hi", "a Hindi question is sent to Ask Prana");
  assert(acceptedEnglish.action === "accept" && acceptedEnglish.language === "en", "an English question is sent to Ask Prana");
  assert(emptyQuestion.action === "repeat", "an empty recording still asks the user to repeat");
  assert(explicitTelugu.action === "accept" && explicitTelugu.language === "te" && explicitTelugu.text === devanagariMisread, "explicit Telugu is not changed to Auto and the original words are kept");

  const capture = { epoch: 3, turnId: "voice-3", language: "te", provider: "cloud-recorder" };
  assert(isStaleVoiceCapture(capture, 3) === false, "the recording that just started is current");
  assert(isStaleVoiceCapture(capture, 4) === true, "a language change invalidates the in-flight recording");
  assert(isStaleVoiceCapture(null, 3) === true, "a missing capture cannot be transcribed");

  const client = readFileSync(new URL("../src/services/ask-prana.ts", import.meta.url), "utf8");
  const recorder = readFileSync(new URL("../src/web/shims/expo-audio.ts", import.meta.url), "utf8");
  assert(!client.includes("decodeAudioData"), "WebM is not decoded before upload");
  assert(recorder.includes("capturingPcm"), "the browser recording keeps microphone PCM samples");
  assert(recorder.includes("encodeWavPcm"), "those samples are uploaded as 16-bit WAV");
  assert(recorder.includes('type: "audio/wav"'), "the recording blob is WAV");
  const completed = parseProviderTranscription(
    'data: {"type":"transcript.text.delta","delta":"Hello"}\n\ndata: {"type":"transcript.text.done","text":"Hello pond","languages":[{"code":"en"}]}\n\n',
    "text/event-stream",
  );
  assert(completed.ok && completed.transcript === "Hello pond" && completed.languageCodes[0] === "en", "a completed stream keeps the transcript and English detection");
  const withTerminal = parseProviderTranscription(
    'data: {"type":"transcript.text.done","text":"నమస్కారం","languages":[{"code":"te"}]}\n\ndata: [DONE]\n\n',
    "text/event-stream",
  );
  assert(withTerminal.ok && withTerminal.transcript === "నమస్కారం" && withTerminal.sawTerminal && withTerminal.languageCodes[0] === "te", "a completion followed by [DONE] stays a Telugu transcript");
  const crlf = parseProviderTranscription(
    'data: {"type":"transcript.text.delta","delta":"मेरे"}\r\n\r\ndata: {"type":"transcript.text.done","text":"मेरे तालाब","languages":[{"code":"hi"}]}\r\n\r\n',
    "text/event-stream",
  );
  assert(crlf.ok && crlf.transcript === "मेरे तालाब" && crlf.languageCodes[0] === "hi", "CRLF framing keeps a Hindi completion");
  const commented = parseProviderTranscription(
    ': keep-alive\n\ndata: {"type":"transcript.text.done","text":"oxygen","languages":[{"code":"en"}]}\n\n',
    "text/event-stream",
  );
  assert(commented.ok && commented.transcript === "oxygen", "SSE comments and empty blocks are ignored");
  const providerError = parseProviderTranscription(
    'data: {"type":"error","error":{"message":"upstream"}}\n\n',
    "text/event-stream",
  );
  assert(!providerError.ok && providerError.reason === "provider-error", "a provider error event is not a transcript");
  const missing = parseProviderTranscription(
    'data: {"type":"transcript.text.delta","delta":"only partial"}\n\ndata: [DONE]\n\n',
    "text/event-stream",
  );
  assert(!missing.ok && missing.reason === "missing-completion", "deltas without completion stay a stream failure");
  const malformed = parseProviderTranscription('data: {not-json}\n\n', "text/event-stream");
  assert(!malformed.ok && malformed.reason === "malformed-event", "a malformed event is not empty speech");
  const silent = parseProviderTranscription(
    'data: {"type":"transcript.text.done","text":"","languages":[]}\n\ndata: [DONE]\n\n',
    "text/event-stream",
  );
  assert(silent.ok && silent.transcript === "" && silent.languageCodes.length === 0, "a completed empty transcript is silent speech");
  const jsonBody = parseProviderTranscription(
    '{"text":"The oxygen is low","languages":[{"code":"en"}]}',
    "application/json",
  );
  assert(jsonBody.ok && jsonBody.transcript === "The oxygen is low", "a non-streaming JSON body uses the JSON completion path");
  const edge = readFileSync(new URL("../../supabase/functions/ask-prana-transcribe/index.ts", import.meta.url), "utf8");
  assert(edge.includes('const OPENAI_TRANSCRIBE_MODEL = "gpt-transcribe"'), "recorded audio uses the current transcription model");
  assert(edge.includes('openAIForm.append("stream", "true")'), "Auto receives the provider final detection event");
  assert(edge.includes("SUPPORTED_AUDIO_LANGUAGES"), "Auto detection is bounded to Telugu, Hindi, and English");
  assert(edge.includes("const detectedLanguage = input.language ? null : providerDetected"), "an explicit hint is not reported as independent detection");
  assert(edge.includes("parseProviderTranscription"), "the function uses the shared transcription parser");
  assert(edge.includes('if (!openaiResponse.ok)'), "provider HTTP failure is checked before stream consumption");
  assert(edge.includes('"PROVIDER_QUOTA"'), "quota failures have a stable error code");
  assert(edge.includes('"PROVIDER_RATE_LIMIT"'), "rate limits have a stable error code");
  assert(edge.includes('"PROVIDER_AUTH"'), "provider authentication has a stable error code");
  assert(edge.includes('"APP_SESSION_INVALID"'), "invalid app sessions have a stable error code");
  assert(!edge.includes("containerWasAccepted"), "accepted WebM bytes cannot convert a provider failure into success");
  assert(edge.includes('value.startsWith("te-")'), "te-IN stays Telugu in the edge function");
  assert(edge.includes('value.startsWith("hi-")'), "hi-IN stays Hindi in the edge function");
  assert(edge.includes('value.startsWith("en-")'), "en-IN stays English in the edge function");

  console.log("Voice dictation harness passed: final transcript, missing-speechend fallback, late-final preservation, pause cancellation, five consecutive sessions, transcript checks, playback events, and transcription language.");
} finally {
  await server.close();
}
