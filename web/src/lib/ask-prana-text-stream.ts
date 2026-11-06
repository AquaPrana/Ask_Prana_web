/**
 * Typed-chat stream reducer. Voice Chat does not use this.
 * Events after a stop, completion, or failure are ignored so a cancelled
 * request cannot append a second answer.
 */

export type AskPranaStreamEvent = {
  type?: string;
  text?: string;
  answer?: string;
  error?: string;
};

export type AskPranaStreamStatus = "idle" | "streaming" | "completed" | "stopped" | "failed";

export type AskPranaStreamDraft = {
  status: AskPranaStreamStatus;
  text: string;
  sawText: boolean;
};

export function emptyAskPranaStreamDraft(): AskPranaStreamDraft {
  return { status: "idle", text: "", sawText: false };
}

export function reduceAskPranaStreamEvent(
  draft: AskPranaStreamDraft,
  event: AskPranaStreamEvent,
): AskPranaStreamDraft {
  if (draft.status === "stopped" || draft.status === "completed" || draft.status === "failed") {
    return draft;
  }
  if (event.type === "delta" && typeof event.text === "string" && event.text) {
    const text = draft.text + event.text;
    return { status: "streaming", text, sawText: draft.sawText || Boolean(event.text.trim()) };
  }
  if (event.type === "replace" && typeof event.text === "string") {
    return {
      status: "streaming",
      text: event.text,
      sawText: draft.sawText || Boolean(event.text.trim()),
    };
  }
  if (event.type === "done") {
    const text = (typeof event.answer === "string" && event.answer.trim()) || draft.text.trim();
    return { status: "completed", text, sawText: draft.sawText || Boolean(text) };
  }
  if (event.type === "error") {
    return { status: "failed", text: draft.text, sawText: draft.sawText };
  }
  return draft;
}

export function stopAskPranaStream(draft: AskPranaStreamDraft): AskPranaStreamDraft {
  if (draft.status === "completed" || draft.status === "failed") return draft;
  return { ...draft, status: "stopped" };
}

/** One assistant id is updated in place. A later chunk never inserts a second row. */
export function upsertStreamMessage<T extends { id: string }>(messages: T[], message: T): T[] {
  const index = messages.findIndex((item) => item.id === message.id);
  if (index < 0) return [...messages, message];
  const next = messages.slice();
  next[index] = { ...messages[index], ...message };
  return next;
}

/** Pulls complete SSE blocks out of a growing response body. */
export function takeAskPranaSseEvents(buffer: string): {
  events: AskPranaStreamEvent[];
  rest: string;
} {
  const blocks = buffer.split("\n\n");
  const rest = blocks.pop() ?? "";
  const events: AskPranaStreamEvent[] = [];
  for (const block of blocks) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data) as AskPranaStreamEvent);
    } catch {
      // Ignore a malformed block. The next event can still complete the answer.
    }
  }
  return { events, rest };
}
