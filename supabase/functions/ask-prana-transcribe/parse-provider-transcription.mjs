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

function languageEvidenceFrom(value) {
  if (!Array.isArray(value)) return [];
  const evidence = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const code = typeof entry.code === "string" ? entry.code.trim() : "";
    if (!code) continue;
    const raw = entry.confidence ?? entry.probability;
    const confidence = typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 1
      ? raw
      : null;
    evidence.push({ code, confidence });
  }
  return evidence;
}

function languageCodesFrom(value) {
  return languageEvidenceFrom(value).map((entry) => entry.code);
}

function mapProviderLanguageCode(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "te" || value.startsWith("te-") || value.includes("telugu")) return "te";
  if (value === "hi" || value.startsWith("hi-") || value.includes("hindi")) return "hi";
  if (value === "en" || value.startsWith("en-") || value.includes("english")) return "en";
  return null;
}

/**
 * One supported language is detection. Several languages, or one language
 * whose own confidence is below 0.6, are uncertain. Missing confidence is
 * not invented and does not by itself reject a single detected language.
 */
export function resolveProviderLanguage(evidence) {
  const supported = [];
  for (const item of evidence ?? []) {
    const code = mapProviderLanguageCode(item?.code);
    if (!code) continue;
    const confidence = typeof item?.confidence === "number" ? item.confidence : null;
    supported.push({ code, confidence });
  }
  const distinct = [];
  for (const item of supported) {
    if (!distinct.includes(item.code)) distinct.push(item.code);
  }
  if (distinct.length === 0) {
    return { detectedLanguage: null, languageUncertain: true, languageConfidence: null };
  }
  if (distinct.length > 1) {
    const scored = supported.filter((item) => typeof item.confidence === "number");
    if (scored.length === supported.length) {
      const best = scored.reduce((top, item) => (item.confidence > top.confidence ? item : top));
      const others = scored.filter((item) => item.code !== best.code);
      if (best.confidence >= 0.6 && others.every((item) => item.confidence < 0.35)) {
        return {
          detectedLanguage: best.code,
          languageUncertain: false,
          languageConfidence: best.confidence,
        };
      }
    }
    return { detectedLanguage: null, languageUncertain: true, languageConfidence: null };
  }
  const only = supported.find((item) => item.code === distinct[0]);
  if (typeof only.confidence === "number" && only.confidence < 0.6) {
    return { detectedLanguage: null, languageUncertain: true, languageConfidence: only.confidence };
  }
  return {
    detectedLanguage: only.code,
    languageUncertain: false,
    languageConfidence: typeof only.confidence === "number" ? only.confidence : null,
  };
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
  const languageEvidence = languageEvidenceFrom(parsed.languages);
  return {
    ok: true,
    transcript: parsed.text.trim(),
    languageCodes: languageEvidence.map((entry) => entry.code),
    languageEvidence,
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
  const languageEvidence = languageEvidenceFrom(done.languages);
  return {
    ok: true,
    transcript: done.text.trim(),
    languageCodes: languageEvidence.map((entry) => entry.code),
    languageEvidence,
    doneCount: 1,
    sawTerminal,
  };
}
