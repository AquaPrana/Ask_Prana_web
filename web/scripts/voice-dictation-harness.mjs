// Dependency-free regression harness for the browser SpeechRecognition wrapper.
// Run with: node scripts/voice-dictation-harness.mjs
// It uses Vite's installed TypeScript loader; no test framework is required.
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
  await sleep(1_650);
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

  console.log("Voice dictation harness passed: final transcript, missing-speechend fallback, late-final preservation, pause cancellation, and five consecutive sessions.");
} finally {
  await server.close();
}
