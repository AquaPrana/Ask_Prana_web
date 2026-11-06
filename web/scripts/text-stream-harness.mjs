// Focused checks for typed-chat streaming: first text before completion,
// cancellation, and one bubble per answer.
import { createServer } from "vite";

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const server = await createServer({
  root: process.cwd(),
  configFile: false,
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
});

try {
  const {
    emptyAskPranaStreamDraft,
    reduceAskPranaStreamEvent,
    stopAskPranaStream,
    takeAskPranaSseEvents,
    upsertStreamMessage,
  } = await server.ssrLoadModule("/src/lib/ask-prana-text-stream.ts");

  const sse = [
    'data: {"type":"text"}\n\n',
    'data: {"type":"delta","text":"Aquaculture is"}\n\n',
    'data: {"type":"delta","text":" farming fish."}\n\n',
    'data: {"type":"done","answer":"Aquaculture is farming fish."}\n\n',
  ].join("");
  let pending = "";
  let draft = emptyAskPranaStreamDraft();
  let firstText = "";
  let messages = [];
  const id = "assistant-1";
  pending += sse;
  const parsed = takeAskPranaSseEvents(pending);
  assert(parsed.rest === "", "a complete stream left a leftover block");
  for (const event of parsed.events) {
    draft = reduceAskPranaStreamEvent(draft, event);
    if (draft.sawText && !firstText) firstText = draft.text;
    if (draft.text) {
      messages = upsertStreamMessage(messages, { id, text: draft.text, streaming: draft.status === "streaming" });
    }
  }
  assert(firstText === "Aquaculture is", "first text was not available before the answer finished");
  assert(draft.status === "completed", "the stream did not complete");
  assert(draft.text === "Aquaculture is farming fish.", "the completed answer was not kept");
  assert(messages.length === 1, "streaming created more than one assistant message");
  assert(messages[0].id === id, "the assistant message id changed");
  assert(messages[0].streaming === false, "a completed answer stayed marked as streaming");

  const cancelled = stopAskPranaStream(reduceAskPranaStreamEvent(emptyAskPranaStreamDraft(), {
    type: "delta",
    text: "Partial answer",
  }));
  const afterCancel = reduceAskPranaStreamEvent(cancelled, { type: "delta", text: " late" });
  assert(afterCancel.status === "stopped", "a stopped answer did not stay stopped");
  assert(afterCancel.text === "Partial answer", "a cancelled request appended a late chunk");
  const stoppedMessages = upsertStreamMessage(
    upsertStreamMessage([], { id: "assistant-2", text: "Partial answer" }),
    { id: "assistant-2", text: afterCancel.text },
  );
  assert(stoppedMessages.length === 1, "stop created a duplicate message");

  let failed = reduceAskPranaStreamEvent(emptyAskPranaStreamDraft(), { type: "delta", text: "Kept" });
  failed = reduceAskPranaStreamEvent(failed, { type: "error", error: "unavailable" });
  const afterFailure = reduceAskPranaStreamEvent(failed, { type: "delta", text: " more" });
  assert(afterFailure.status === "failed", "a failed stream was not marked failed");
  assert(afterFailure.text === "Kept", "a failed stream accepted a later chunk");

  console.log("Text stream harness passed: first text before completion, cancellation, failure, and one message per answer.");
} finally {
  await server.close();
}
