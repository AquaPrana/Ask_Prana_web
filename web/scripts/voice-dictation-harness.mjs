// Dependency-free regression harness for the browser SpeechRecognition wrapper.
// Run with: node scripts/voice-dictation-harness.mjs
// It uses Vite's installed TypeScript loader; no test framework is required.
import { readFileSync } from "node:fs";
import { createServer } from "vite";

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
    isRejectedAudioContainerError,
    isStaleVoiceCapture,
    mapRequestedSttLanguage,
    planCloudTranscriptionAttempts,
    acceptSpokenQuestion,
    recognitionModeFrom,
    recognizedTranscriptionContainer,
    resolveSpokenReplyLanguage,
    shouldUseFallbackModel,
    suggestsTeluguMisread,
  } = await server.ssrLoadModule("/src/lib/ask-prana-transcription-language.ts");

  for (const language of ["te", "hi", "en"]) {
    const attempts = planCloudTranscriptionAttempts(language);
    assert(attempts.length === 2, `${language} should have two whisper attempts`);
    assert(
      attempts.every((attempt) => attempt.model === "whisper-1" && attempt.language === language),
      `${language} must stay on whisper-1 for both attempts`,
    );
  }
  const automatic = planCloudTranscriptionAttempts(null);
  assert(
    automatic.every((attempt) => attempt.model === "whisper-1" && attempt.language === null),
    "automatic detection stays automatic on every whisper attempt",
  );
  assert(
    shouldUseFallbackModel([
      { ok: true, transcript: "" },
      { ok: true, transcript: "" },
    ]) === false,
    "an empty whisper transcript does not call the fallback model",
  );
  assert(
    shouldUseFallbackModel([{ ok: false, transcript: "" }]) === false,
    "the fallback model waits until whisper-1 has been tried twice",
  );
  assert(
    shouldUseFallbackModel([
      { ok: false, transcript: "" },
      { ok: false, transcript: "" },
    ]) === true,
    "a whisper API failure may use the fallback model once",
  );
  assert(recognizedTranscriptionContainer("webm") === true, "Brave WebM is an accepted recording");
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
  assert(MAX_PROVIDER_CALLS_PER_RECORDING === 3, "one recording may use at most three provider calls");

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
  assert(resolveSpokenReplyLanguage({ mode: "auto", detected: null, transcript: teluguQuestion }) === "te", "a Telugu transcript is accepted when Whisper omits the language");
  assert(resolveSpokenReplyLanguage({ mode: "auto", detected: null, transcript: "मेरे तालाब में ऑक्सीजन कम है। मुझे क्या करना चाहिए?" }) === "hi", "a Hindi transcript is accepted when Whisper omits the language");
  assert(resolveSpokenReplyLanguage({ mode: "auto", detected: null, transcript: "The oxygen in my pond is low. What should I do?" }) === "en", "an English transcript is accepted when Whisper omits the language");
  const acceptedTelugu = acceptSpokenQuestion({ mode: "auto", transcript: teluguQuestion, detected: null });
  const acceptedHindi = acceptSpokenQuestion({ mode: "auto", transcript: "मेरे तालाब में ऑक्सीजन कम है।", detected: null });
  const acceptedEnglish = acceptSpokenQuestion({ mode: "auto", transcript: "The oxygen in my pond is low. What should I do?", detected: null });
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

  const edge = readFileSync(new URL("../../supabase/functions/ask-prana-transcribe/index.ts", import.meta.url), "utf8");
  assert(!edge.includes("language: null"), "the transcribe function must not drop an explicit language");
  assert(edge.includes("language: attempt.language"), "each whisper call uses the resolved language");
  assert(edge.includes("language: sttLanguage"), "the fallback model uses the resolved language");
  assert(edge.includes("if (!result.ok) whisperApiFailure = true"), "an empty whisper transcript is not an API failure");
  assert(edge.includes("if (transcript || !whisperApiFailure)"), "an empty whisper result returns without the fallback model");
  assert(edge.includes("containerWasAccepted(actualContainer, normalized.extension)"), "an accepted container does not become a format error");
  assert(edge.includes('input.language ? "json" : "verbose_json"'), "Auto transcription asks Whisper for the detected audio language");
  assert(edge.includes('value.startsWith("te-")'), "te-IN stays Telugu in the edge function");
  assert(edge.includes('value.startsWith("hi-")'), "hi-IN stays Hindi in the edge function");
  assert(edge.includes('value.startsWith("en-")'), "en-IN stays English in the edge function");

  console.log("Voice dictation harness passed: final transcript, missing-speechend fallback, late-final preservation, pause cancellation, five consecutive sessions, transcript checks, playback events, and transcription language.");
} finally {
  await server.close();
}
