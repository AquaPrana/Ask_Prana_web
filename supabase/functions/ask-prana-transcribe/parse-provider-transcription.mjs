/**
 * Parses one gpt-transcribe HTTP body.
 *
 * Streaming responses are server-sent events. The completion is
 * `transcript.text.done`. OpenAI-compatible streams then send `data: [DONE]`.
 * That marker is not JSON. A non-streaming `application/json` body is
 * `{ text, languages }` and is accepted only on that explicit path.
 * Deltas, a missing completion, a provider error event, and malformed JSON
 * are failures. An empty `text` on a real completion is silent speech, not
 * a parser failure.
 */

function languageCodesFrom(value) {
  if (!Array.isArray(value)) return [];
  const codes = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const code = entry.code;
    if (typeof code === "string" && code.trim()) codes.push(code.trim());
  }
  return codes;
}

function jsonCompletion(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: "invalid-json", doneCount: 0, sawTerminal: false };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "invalid-json", doneCount: 0, sawTerminal: false };
  }
  if (parsed.error != null) {
    return { ok: false, reason: "provider-error", doneCount: 0, sawTerminal: false };
  }
  if (typeof parsed.text !== "string") {
    return { ok: false, reason: "missing-completion", doneCount: 0, sawTerminal: false };
  }
  return {
    ok: true,
    transcript: parsed.text.trim(),
    languageCodes: languageCodesFrom(parsed.languages),
    doneCount: 1,
    sawTerminal: false,
  };
}

function dataPayload(block) {
  const lines = block.split(/\r?\n/);
  const dataLines = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (!dataLines.length) return null;
  return dataLines.join("\n").trim();
}

export function parseProviderTranscription(body, contentType = "") {
  const text = String(body ?? "");
  const type = String(contentType ?? "").toLowerCase();
  const trimmed = text.trim();
  const eventStream = type.includes("text/event-stream") || /(^|\r?\n)data:/i.test(text);
  if (!eventStream && (type.includes("application/json") || trimmed.startsWith("{"))) {
    return jsonCompletion(trimmed);
  }

  const events = [];
  let sawTerminal = false;
  const blocks = text.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const payload = dataPayload(block);
    if (payload == null || payload === "") continue;
    if (payload === "[DONE]") {
      sawTerminal = true;
      continue;
    }
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      return { ok: false, reason: "malformed-event", doneCount: 0, sawTerminal };
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      return { ok: false, reason: "malformed-event", doneCount: 0, sawTerminal };
    }
    if (event.type === "error" || event.error != null) {
      return { ok: false, reason: "provider-error", doneCount: 0, sawTerminal };
    }
    events.push(event);
  }

  const doneEvents = events.filter((event) => event.type === "transcript.text.done");
  if (doneEvents.length !== 1) {
    return {
      ok: false,
      reason: doneEvents.length === 0 ? "missing-completion" : "duplicate-completion",
      doneCount: doneEvents.length,
      sawTerminal,
    };
  }
  const done = doneEvents[0];
  if (typeof done.text !== "string") {
    return { ok: false, reason: "invalid-completion", doneCount: 1, sawTerminal };
  }
  return {
    ok: true,
    transcript: done.text.trim(),
    languageCodes: languageCodesFrom(done.languages),
    doneCount: 1,
    sawTerminal,
  };
}
