export type ReplyLanguageCode = "en" | "hi" | "te";

/** Explicit English, Hindi, or Telugu. Empty and Auto stay unset so detection can run. */
export function explicitReplyLanguageCode(value: string | null | undefined): ReplyLanguageCode | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw === "auto") return null;
  if (raw === "te" || raw.includes("telugu") || raw.includes("తెలుగు")) return "te";
  if (raw === "hi" || raw.includes("hindi") || raw.includes("हिन्दी") || raw.includes("हिंदी")) return "hi";
  if (raw === "en" || raw.includes("english")) return "en";
  return null;
}

export function explicitReplyLanguageLabel(value: string | null | undefined): "English" | "Hindi" | "Telugu" | null {
  const code = explicitReplyLanguageCode(value);
  if (code === "te") return "Telugu";
  if (code === "hi") return "Hindi";
  if (code === "en") return "English";
  return null;
}

/** Labels can switch now. The chat body is shown only when every visible string is ready. */
export function planLanguageSelection(input: { cached: boolean; failed: boolean }) {
  return {
    applyLabelsNow: true,
    requestMissing: !input.cached,
    revealContent: input.cached && !input.failed,
  };
}

/** Keep the previous language on screen until the whole visible set can change together. */
export function textUntilSetReady(original: string, translated: string | null, reveal: boolean) {
  return reveal && translated ? translated : original;
}

/** Cached and in-flight text is not requested again. A failed batch is sent only for an explicit retry. */
export function shouldSendTranslation(
  status: "ready" | "loading" | "error" | "not_loaded" | undefined,
  retryable: boolean,
) {
  if (status === "ready" || status === "loading") return false;
  if (status === "error") return retryable;
  return true;
}

export function isStaleTranslation(requestLanguage: string, activeLanguage: string) {
  return requestLanguage !== activeLanguage;
}

/** A timeout, HTTP error, or short batch is a failure. It must not be stored as a translation. */
export function translationResponseSucceeded(input: {
  timedOut: boolean;
  httpOk: boolean;
  lengthMatches: boolean;
}) {
  return input.httpOk && !input.timedOut && input.lengthMatches;
}

export function canRevealTranslatedSet(statuses: readonly ("ready" | "loading" | "error" | "not_loaded")[]) {
  return statuses.every((status) => status === "ready");
}

const TELUGU_CHARS = /[ఀ-౿]/g;
const DEVANAGARI_CHARS = /[ऀ-ॿ]/g;

/** Latin units may remain. An empty or unchanged English reply is not a Telugu or Hindi translation. */
export function acceptDisplayTranslation(input: {
  language: ReplyLanguageCode;
  source: string;
  translated: string;
}) {
  const translated = input.translated.trim();
  if (!translated) return false;
  const telugu = (translated.match(TELUGU_CHARS) || []).length;
  const devanagari = (translated.match(DEVANAGARI_CHARS) || []).length;
  if (input.language === "en") return telugu + devanagari === 0;
  const own = input.language === "hi" ? devanagari : telugu;
  const other = input.language === "hi" ? telugu : devanagari;
  if (other > 0) return false;
  const sourceHasWords = /[A-Za-z]{3,}/.test(
    input.source.replace(/\b(pH|DO|FCR|DOC|Vannamei|biomass|salinity|ppm|ppt)\b/gi, " "),
  );
  return own > 0 || !sourceHasWords;
}
