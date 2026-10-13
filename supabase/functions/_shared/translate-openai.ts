import type { SupabaseClient } from "@supabase/supabase-js";

import {
  describeOpenAIResponse,
  extractOpenAIOutputText,
  OPENAI_MODEL,
  OPENAI_RESPONSES_URL,
  parseOpenAIError,
} from "./openai-responses.ts";

/**
 * Display translation for stored Ask Prana chat history (OpenAI only).
 *
 * - Cache-first: every result is stored in `translation_cache` keyed by the
 *   sha256 of the trimmed source, so identical text is translated once per
 *   language for every user and device.
 * - No `reasoning` is sent: translation is a direct transformation and
 *   reasoning only adds latency. If the configured model insists on it, the
 *   lowest effort it accepts is remembered for the rest of the isolate.
 * - Text already in the target language is returned unchanged without a call.
 */

export type TranslationLang = "en" | "hi" | "te";

export const TRANSLATION_LANGS: TranslationLang[] = ["en", "hi", "te"];

const LANGUAGE_LABEL: Record<TranslationLang, string> = {
  en: "English",
  hi: "Hindi",
  te: "Telugu",
};
const LANGUAGE_SCRIPT: Record<TranslationLang, string> = {
  en: "English",
  hi: "Devanagari",
  te: "Telugu script",
};

/** A single message is split only above this size. */
const SEGMENT_MAX_CHARS = 6_000;
const BATCH_MAX_ITEMS = 10;
const BATCH_MAX_CHARS = 9_000;
const MAX_CONCURRENT_BATCHES = 2;
const REQUEST_TIMEOUT_MS = 40_000;
const MAX_RATE_LIMIT_WAIT_MS = 8_000;

export function translationLang(value: unknown): TranslationLang | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "en" || raw === "english") return "en";
  if (raw === "hi" || raw === "hindi") return "hi";
  if (raw === "te" || raw === "telugu") return "te";
  return null;
}

// ---------------------------------------------------------------------------
// Language detection (ported from web/src/lib/ask-prana-display-translation.ts)
// ---------------------------------------------------------------------------

// Technical terms that may legitimately stay in Latin script in any language.
const TECHNICAL_TERMS =
  /\b(pH|DO|FCR|ABW|ADG|DOC|MQTT|RS485|RS-485|Modbus|IoT|TAN|ORP|TDS|NH3|NH4|NO2|NO3|PL|AquaPrana|Ask\s*Prana|Prana|PDF|DOCX|XLSX|CSV|HTTP|API|OTP|SMS|GPS|mg\/L|ppm|ppt|kg|gm|cm|mm|ml)\b/gi;
const URLS = /https?:\/\/\S+|\S+@\S+\.\S+/g;
const TELUGU = /[ఀ-౿]/g;
const DEVANAGARI = /[ऀ-ॿ]/g;
const LATIN_WORD = /[A-Za-z]{2,}/g;

const countMatches = (text: string, re: RegExp) => (text.match(re) || []).length;

function countScriptWords(line: string, re: RegExp) {
  return line.split(/\s+/).filter((word) => countMatches(word, re) > 0).length;
}

/** True when the text needs no translation to be shown in `language`. */
export function isTextInLanguage(text: string, language: TranslationLang) {
  const cleaned = text.replace(URLS, " ").replace(TECHNICAL_TERMS, " ");
  const telugu = countMatches(cleaned, TELUGU);
  const devanagari = countMatches(cleaned, DEVANAGARI);

  if (language === "en") return telugu === 0 && devanagari === 0;

  const ownScript = language === "hi" ? DEVANAGARI : TELUGU;
  const otherIndic = language === "hi" ? telugu : devanagari;
  if (otherIndic > 0) return false;

  for (const line of cleaned.split(/\n+/)) {
    const latinWords = countMatches(line, LATIN_WORD);
    if (latinWords === 0) continue;
    const ownWords = countScriptWords(line, ownScript);
    // An English bullet/sentence, or a line that is mostly English words.
    if (ownWords === 0 || (latinWords >= 3 && latinWords > ownWords)) return false;
  }
  return true;
}

/** Languages a stored text must be translated into to be displayable everywhere. */
export function missingLanguages(text: string): TranslationLang[] {
  if (!text.trim()) return [];
  return TRANSLATION_LANGS.filter((lang) => !isTextInLanguage(text, lang));
}

/** Same rule as the client: an empty or still-English reply is not a Hindi/Telugu translation. */
export function acceptTranslation(source: string, translated: string, language: TranslationLang) {
  const value = translated.trim();
  if (!value) return false;
  const telugu = countMatches(value, TELUGU);
  const devanagari = countMatches(value, DEVANAGARI);
  if (language === "en") return telugu + devanagari === 0;
  const own = language === "hi" ? devanagari : telugu;
  const other = language === "hi" ? telugu : devanagari;
  if (other > 0) return false;
  const sourceHasWords = /[A-Za-z]{3,}/.test(
    source.replace(/\b(pH|DO|FCR|DOC|Vannamei|biomass|salinity|ppm|ppt)\b/gi, " "),
  );
  return own > 0 || !sourceHasWords;
}

export async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// OpenAI call
// ---------------------------------------------------------------------------

export class TranslationError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Only set if the model rejects requests without `reasoning`. */
let requiredReasoningEffort: "minimal" | "low" | null = null;
// Matches the previous translate-history behaviour: a plain JSON array parsed
// permissively, without structured-output overhead.
let structuredOutput = false;

function translationModel() {
  return Deno.env.get("ASK_PRANA_TRANSLATION_MODEL") || OPENAI_MODEL;
}

function parseItems(outputText: string): unknown[] | null {
  const cleaned = outputText.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const record = parsed as { items?: unknown; translations?: unknown };
    if (Array.isArray(record.items)) return record.items;
    if (Array.isArray(record.translations)) return record.translations;
  }
  return null;
}

async function callOpenAI(texts: string[], target: TranslationLang): Promise<string[]> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new TranslationError("LLM API key is missing.", 500);

  const model = translationModel();
  const sourceChars = texts.reduce((total, text) => total + text.length, 0);
  const startedAt = performance.now();
  let rateLimitRetried = false;
  let reasoningRetries = 0;

  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    let data: Record<string, unknown>;
    try {
      response = await fetch(OPENAI_RESPONSES_URL, {
        method: "POST",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          instructions:
            `Translate every item fully into ${LANGUAGE_LABEL[target]} (${LANGUAGE_SCRIPT[target]}). ` +
            "Preserve meaning, numbers, markdown, line breaks, and order. " +
            "Keep pH, DO, FCR, DOC, ABW, Vannamei, biomass, salinity, mg/L, and ppm in Latin script. " +
            `Return a JSON array of exactly ${texts.length} strings.`,
          input: JSON.stringify(texts),
          ...(requiredReasoningEffort ? { reasoning: { effort: requiredReasoningEffort } } : {}),
          max_output_tokens: Math.min(8_000, Math.max(400, Math.ceil(sourceChars * 2))),
          ...(structuredOutput
            ? {
              text: {
                format: {
                  type: "json_schema",
                  name: "ask_prana_translations",
                  strict: true,
                  schema: {
                    type: "object",
                    additionalProperties: false,
                    properties: { items: { type: "array", items: { type: "string" } } },
                    required: ["items"],
                  },
                },
              },
            }
            : {}),
        }),
      });
      data = await response.json() as Record<string, unknown>;
    } catch (error) {
      if (controller.signal.aborted) throw new TranslationError("Translation timed out.", 504);
      throw new TranslationError(error instanceof Error ? error.message : String(error), 502);
    } finally {
      clearTimeout(timer);
    }

    console.log("[translate-openai] call", {
      items: texts.length,
      chars: sourceChars,
      ms: Math.round(performance.now() - startedAt),
      model,
      status: response.status,
    });

    if (response.status === 400) {
      const described = JSON.stringify(data);
      if (structuredOutput && /schema|text\.format|json_schema/i.test(described)) {
        structuredOutput = false;
        continue;
      }
      if (/reasoning|effort/i.test(described) && reasoningRetries < 2) {
        // This model requires reasoning: use the lowest effort it accepts.
        requiredReasoningEffort = requiredReasoningEffort === "minimal" ? "low" : "minimal";
        reasoningRetries += 1;
        continue;
      }
    }

    if (response.status === 429 && !rateLimitRetried) {
      const code = String(
        (data as { error?: { code?: unknown; type?: unknown } }).error?.code ??
          (data as { error?: { type?: unknown } }).error?.type ?? "",
      );
      if (!/insufficient_quota/i.test(code)) {
        rateLimitRetried = true;
        const headerMs = Number(response.headers.get("retry-after-ms")) ||
          Number(response.headers.get("retry-after")) * 1000 || 1_000;
        await new Promise((resolve) => setTimeout(resolve, Math.min(headerMs, MAX_RATE_LIMIT_WAIT_MS)));
        continue;
      }
    }

    if (!response.ok) {
      const parsed = parseOpenAIError(response.status, data);
      throw new TranslationError(parsed.message, parsed.httpStatus);
    }

    const items = parseItems(extractOpenAIOutputText(data));
    if (!items || items.length !== texts.length || !items.every((item) => typeof item === "string")) {
      console.error("[translate-openai] incomplete response", describeOpenAIResponse(data));
      throw new TranslationError("Translation response was incomplete.", 502);
    }
    return items as string[];
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Splits only very long text, at paragraph/line boundaries, remembering the separators. */
function splitLong(text: string): { parts: string[]; separators: string[] } {
  if (text.length <= SEGMENT_MAX_CHARS) return { parts: [text], separators: [] };
  const parts: string[] = [];
  const separators: string[] = [];
  let remaining = text;
  while (remaining.length > SEGMENT_MAX_CHARS) {
    const window = remaining.slice(0, SEGMENT_MAX_CHARS + 1);
    const minCut = Math.floor(SEGMENT_MAX_CHARS * 0.4);
    let cut = window.lastIndexOf("\n\n");
    let separator = "\n\n";
    if (cut < minCut) {
      cut = window.lastIndexOf("\n");
      separator = "\n";
    }
    if (cut < minCut) {
      cut = window.lastIndexOf(" ");
      separator = " ";
    }
    if (cut < minCut) {
      cut = SEGMENT_MAX_CHARS;
      separator = "";
    }
    parts.push(remaining.slice(0, cut).trim());
    separators.push(separator);
    remaining = remaining.slice(cut + separator.length).trim();
  }
  if (remaining) parts.push(remaining);
  return { parts, separators };
}

async function runBatches(units: string[], target: TranslationLang): Promise<(string | null)[]> {
  const batches: number[][] = [];
  let current: number[] = [];
  let chars = 0;
  units.forEach((unit, index) => {
    if (current.length && (current.length >= BATCH_MAX_ITEMS || chars + unit.length > BATCH_MAX_CHARS)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(index);
    chars += unit.length;
  });
  if (current.length) batches.push(current);

  const results: (string | null)[] = units.map(() => null);
  let firstError: unknown = null;
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      try {
        const translated = await callOpenAI(batch.map((index) => units[index]), target);
        batch.forEach((index, position) => {
          const value = translated[position]?.trim() ?? "";
          results[index] = acceptTranslation(units[index], value, target) ? value : null;
        });
      } catch (error) {
        firstError ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_BATCHES, batches.length) }, worker));
  if (firstError && results.every((value) => value === null)) throw firstError;
  return results;
}

/**
 * Translates `texts` into `target`. Returns one entry per input: the
 * translation, the input itself when it is already in `target`, or null when
 * that item could not be translated. Throws only if nothing could be done.
 */
export async function translateMany(
  supabase: SupabaseClient,
  texts: string[],
  target: TranslationLang,
): Promise<(string | null)[]> {
  const results: (string | null)[] = texts.map(() => null);
  const pending: { index: number; source: string; hash: string }[] = [];

  for (let index = 0; index < texts.length; index += 1) {
    const source = (texts[index] ?? "").trim();
    if (!source || isTextInLanguage(source, target)) {
      results[index] = texts[index] ?? "";
      continue;
    }
    pending.push({ index, source, hash: await sha256Hex(source) });
  }
  if (!pending.length) return results;

  const hashes = [...new Set(pending.map((item) => item.hash))];
  const { data: cached, error: cacheError } = await supabase
    .from("translation_cache")
    .select("text_hash, content")
    .eq("lang", target)
    .in("text_hash", hashes);
  if (cacheError) console.warn("[translate-openai] cache read failed", cacheError.code ?? cacheError.message);
  const cachedByHash = new Map((cached ?? []).map((row) => [String(row.text_hash), String(row.content)]));

  const misses: { source: string; hash: string }[] = [];
  const seenMisses = new Set<string>();
  for (const item of pending) {
    const hit = cachedByHash.get(item.hash);
    if (hit) {
      results[item.index] = hit;
    } else if (!seenMisses.has(item.hash)) {
      seenMisses.add(item.hash);
      misses.push(item);
    }
  }
  if (!misses.length) return results;

  // Long messages become several units; everything else is one unit each.
  const units: string[] = [];
  const plans = misses.map((miss) => {
    const { parts, separators } = splitLong(miss.source);
    const start = units.length;
    units.push(...parts);
    return { ...miss, start, count: parts.length, separators };
  });

  const translatedUnits = await runBatches(units, target);
  const fresh = new Map<string, string>();
  for (const plan of plans) {
    const pieces = translatedUnits.slice(plan.start, plan.start + plan.count);
    if (pieces.some((piece) => piece === null)) continue;
    const joined = pieces.reduce<string>(
      (text, piece, index) => (index === 0 ? piece! : `${text}${plan.separators[index - 1] ?? "\n\n"}${piece}`),
      "",
    );
    fresh.set(plan.hash, joined);
  }

  if (fresh.size) {
    const { error } = await supabase
      .from("translation_cache")
      .upsert([...fresh].map(([text_hash, content]) => ({ text_hash, lang: target, content })));
    if (error) console.warn("[translate-openai] cache write failed", error.code ?? error.message);
  }
  for (const item of pending) {
    const value = fresh.get(item.hash);
    if (value) results[item.index] = value;
  }
  return results;
}
