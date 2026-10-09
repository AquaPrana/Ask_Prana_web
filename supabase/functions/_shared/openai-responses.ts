export const OPENAI_MODEL = "gpt-5.6-sol";
export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

type OpenAIErrorBody = {
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
};

export function extractOpenAIOutputText(data: Record<string, unknown>): string {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const output = data.output;
  if (!Array.isArray(output)) {
    return "";
  }

  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type === "reasoning") continue;
    if (
      (record.type === "output_text" || record.type === "text") &&
      typeof record.text === "string"
    ) {
      parts.push(record.text);
    }
    if (!Array.isArray(record.content)) continue;

    for (const block of record.content) {
      if (!block || typeof block !== "object") continue;
      const content = block as Record<string, unknown>;
      if (
        (content.type === "output_text" || content.type === "text") &&
        typeof content.text === "string"
      ) {
        parts.push(content.text);
      }
    }
  }

  return parts.join("\n").trim();
}

export function describeOpenAIResponse(data: Record<string, unknown>) {
  const output = Array.isArray(data.output) ? data.output : [];
  const types = output
    .map((item) =>
      item && typeof item === "object"
        ? String((item as { type?: unknown }).type ?? "unknown")
        : "unknown",
    )
    .slice(0, 12);
  const text = extractOpenAIOutputText(data);
  const incomplete =
    data.incomplete_details && typeof data.incomplete_details === "object"
      ? (data.incomplete_details as Record<string, unknown>)
      : null;
  return {
    status: typeof data.status === "string" ? data.status : null,
    incompleteReason:
      typeof incomplete?.reason === "string" ? incomplete.reason : null,
    outputTypes: types,
    textLength: text.length,
    preview: text.slice(0, 400),
  };
}

export function parseOpenAIError(
  status: number,
  data: unknown,
): { message: string; httpStatus: number } {
  const body = (data ?? {}) as OpenAIErrorBody;
  const message =
    typeof body.error?.message === "string" && body.error.message.trim()
      ? body.error.message.trim()
      : typeof data === "string"
      ? data
      : "OpenAI API request failed.";

  if (status === 401) {
    return { message: "OpenAI API authentication failed.", httpStatus: 502 };
  }

  if (status === 429 && /insufficient_quota/i.test(`${body.error?.code ?? ""} ${body.error?.type ?? ""}`)) {
    // No credits left on the OpenAI account: retrying cannot help.
    return {
      message: "The OpenAI account has run out of credits. Add credits at platform.openai.com to continue.",
      httpStatus: 402,
    };
  }

  if (status === 429) {
    return {
      message: "OpenAI rate limit reached. Please try again shortly.",
      httpStatus: 429,
    };
  }

  if (status >= 500) {
    return { message: "OpenAI service is temporarily unavailable.", httpStatus: 502 };
  }

  return {
    message,
    httpStatus: status >= 400 ? status : 502,
  };
}
