import { useCallback, useEffect, useId, useSyncExternalStore } from "react";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { translateAskPranaHistory } from "../services/ask-prana";
import { type AskPranaSpeechLanguageCode } from "./ask-prana-language";
import { acceptDisplayTranslation, isStaleTranslation, shouldSendTranslation } from "./ask-prana-translation-policy";

/**
 * Display-only translation store shared by the Ask Prana sidebar and chat.
 *
 * - Cached per (target language, source paragraph). Identical text in any
 *   message/session is translated once per language, and a Hindi result can
 *   never be read while Telugu is selected.
 * - Persisted per language on the device, so reopening Ask Prana or switching
 *   back to a language reuses earlier translations without new API calls.
 * - The open chat and visible sidebar share one request. Each message, title,
 *   and preview is one cache entry. The painted language changes only when
 *   that whole visible set is ready, so the screen does not stay in English
 *   one paragraph at a time.
 * - Stored translations come from the database with the history (and on a
 *   language switch, by id), so a chat opened before switches without any
 *   OpenAI call. Live translate-history is only a fallback for text the
 *   server has not stored yet.
 * - Until a translation arrives the original text is shown, so the chat never
 *   goes blank. Stored messages are never modified.
 */

type Language = AskPranaSpeechLanguageCode;

export type AskPranaTranslationStatus = "not_loaded" | "loading" | "ready" | "error";
export type AskPranaTranslationPriority = "visible" | "background" | "prefetch";

type Entry = {
  status: Exclude<AskPranaTranslationStatus, "not_loaded">;
  value?: string;
  failedAt?: number;
  attempts?: number;
  /** Loading because the server is translating it in the background. */
  serverPending?: boolean;
};

type Job = { language: Language; priority: AskPranaTranslationPriority; texts: string[] };

// Stored translations now come from the database with the history itself, so
// live translate-history calls are only a fallback for text the server has not
// stored yet. Fewer, larger batches avoid paying the Edge Function start-up
// and auth lookup for every two or three messages.
const BATCH_LIMITS: Record<AskPranaTranslationPriority, { items: number; chars: number }> = {
  visible: { items: 8, chars: 12_000 },
  background: { items: 8, chars: 12_000 },
  prefetch: { items: 8, chars: 12_000 },
};
const MAX_CONCURRENT_REQUESTS = 2;
/** Caps per lower priority so the visible chat always has free request slots. */
const MAX_CONCURRENT_BY_PRIORITY: Record<AskPranaTranslationPriority, number> = {
  visible: MAX_CONCURRENT_REQUESTS,
  background: 1,
  prefetch: 1,
};
/**
 * When the server reports stored translations missing it starts translating
 * them itself. Re-read the database at these delays before falling back to a
 * live request, so the same text is not sent to OpenAI twice.
 */
const SERVER_FILL_RECHECK_MS = [3_000, 7_000];
/** A language switch waits at most this long for stored translations. */
const SERVER_LOAD_TIMEOUT_MS = 2_500;
/** After an OpenAI rate limit: retry the screen quickly, keep low-priority work paused longer. */
const RATE_LIMIT_RETRY_MS = 1_500;
const RATE_LIMIT_MAX_RETRIES = 4;
const PREFETCH_PAUSE_AFTER_RATE_LIMIT_MS = 60_000;
const RETRY_AFTER_MS = 5_000;
const MAX_ATTEMPTS = 2;
const STORAGE_PREFIX = "ask-prana:display-translations:v1:";
const MAX_PERSISTED_PER_LANGUAGE = 2_000;
const PERSIST_DEBOUNCE_MS = 800;
const LANGUAGES: Language[] = ["en", "hi", "te"];
// Only very long text is split for live translation (matches the server), so
// a normal message is one cache entry that can be stored against its id.
// Splitting is display-only; original message data is untouched.
const TRANSLATION_SEGMENT_MAX_CHARS = 6_000;

const store: Record<Language, Map<string, Entry>> = {
  en: new Map(),
  hi: new Map(),
  te: new Map(),
};
const PRIORITY_ORDER: AskPranaTranslationPriority[] = ["visible", "background", "prefetch"];
const queues: Record<AskPranaTranslationPriority, Job[]> = { visible: [], background: [], prefetch: [] };
const inFlightByPriority: Record<AskPranaTranslationPriority, number> = {
  visible: 0,
  background: 0,
  prefetch: 0,
};
const listeners = new Set<() => void>();
let version = 0;
/** Language the picker selected. */
let activeLanguage: Language = "en";
/** Language currently painted. It changes only when the whole visible set is ready. */
let paintedLanguage: Language = "en";
/** Bumped on clear (sign-out) so late responses from the previous user are dropped. */
let generation = 0;

let notifyLanguageSwap: () => void = () => {};
let rateLimitedUntil = 0;
let rateLimitRetryTimer: ReturnType<typeof setTimeout> | null = null;
let prefetchPausedUntil = 0;

function emit() {
  version += 1;
  for (const listener of listeners) listener();
  notifyLanguageSwap();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getVersion() {
  return version;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const storageAvailable = !(Platform.OS === "web" && typeof window === "undefined");
let hydrated = !storageAvailable;
let hydration: Promise<void> | null = null;
const dirtyLanguages = new Set<Language>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function ensureHydrated(): Promise<void> {
  if (hydrated) return Promise.resolve();
  if (!hydration) {
    const hydrationGeneration = generation;
    hydration = (async () => {
      try {
        const pairs = await AsyncStorage.multiGet(LANGUAGES.map((lang) => STORAGE_PREFIX + lang));
        if (hydrationGeneration !== generation) return;
        pairs.forEach(([, raw], index) => {
          if (!raw) return;
          const parsed: unknown = JSON.parse(raw);
          if (!parsed || typeof parsed !== "object") return;
          const cache = store[LANGUAGES[index]];
          for (const [source, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof value === "string" && !cache.has(source)) {
              cache.set(source, { status: "ready", value });
            }
          }
        });
      } catch {
        // A corrupt/unavailable cache only means translating again.
      } finally {
        hydrated = true;
        emit();
      }
    })();
  }
  return hydration;
}

function schedulePersist(language: Language) {
  if (!storageAvailable) return;
  dirtyLanguages.add(language);
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const languages = [...dirtyLanguages];
    dirtyLanguages.clear();
    for (const lang of languages) {
      const ready: [string, string][] = [];
      for (const [source, entry] of store[lang]) {
        if (entry.status === "ready" && entry.value != null) ready.push([source, entry.value]);
      }
      // Map keeps insertion order, so this keeps the most recent translations.
      const kept = Object.fromEntries(ready.slice(-MAX_PERSISTED_PER_LANGUAGE));
      void AsyncStorage.setItem(STORAGE_PREFIX + lang, JSON.stringify(kept)).catch(() => undefined);
    }
  }, PERSIST_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// Language detection
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
export function isTextInAskPranaLanguage(text: string, language: Language) {
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

function isValidTranslation(source: string, translated: string, language: Language) {
  return acceptDisplayTranslation({ language, source, translated });
}

type Resolved = { status: AskPranaTranslationStatus; text: string };

function isRetryable(entry: Entry | undefined, now = Date.now()) {
  return (
    entry?.status === "error" &&
    (entry.attempts ?? 1) < MAX_ATTEMPTS &&
    now - (entry.failedAt ?? 0) >= RETRY_AFTER_MS
  );
}

function needsTranslation(text: string, language: Language) {
  return Boolean(text?.trim()) && !isTextInAskPranaLanguage(text, language);
}

/** Split only long display text, preferring paragraph/line/sentence boundaries. */
function translationUnits(text: string): string[] {
  const source = text.trim();
  if (source.length <= TRANSLATION_SEGMENT_MAX_CHARS) return [source];

  const units: string[] = [];
  let remaining = source;
  while (remaining.length > TRANSLATION_SEGMENT_MAX_CHARS) {
    const window = remaining.slice(0, TRANSLATION_SEGMENT_MAX_CHARS + 1);
    const candidates = [
      window.lastIndexOf("\n\n"),
      window.lastIndexOf("\n"),
      Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! ")) + 1,
      window.lastIndexOf(" "),
    ];
    const cut = candidates.find((index) => index >= Math.floor(TRANSLATION_SEGMENT_MAX_CHARS * 0.45)) ?? TRANSLATION_SEGMENT_MAX_CHARS;
    const unit = remaining.slice(0, cut).trim();
    if (!unit) break;
    units.push(unit);
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.trim()) units.push(remaining.trim());
  return units.length ? units : [source];
}

/** One cache entry per message, title, or preview. The original stays until that whole string is ready. */
function resolveText(text: string, language: Language): Resolved {
  if (!needsTranslation(text, language)) return { status: "ready", text };
  const source = text.trim();
  const wholeEntry = store[language].get(source);
  // Keep already-persisted single-message translations usable after upgrading
  // to segmented translation.
  if (wholeEntry?.status === "ready" && wholeEntry.value) return { status: "ready", text: wholeEntry.value };
  if (wholeEntry?.status === "error") return { status: "error", text };
  if (wholeEntry?.status === "loading") return { status: "loading", text };

  const units = translationUnits(source);
  const entries = units.map((unit) => store[language].get(unit));
  if (entries.every((entry) => entry?.status === "ready" && entry.value)) {
    return {
      status: "ready",
      text: entries.map((entry) => entry?.value?.trim() ?? "").join("\n\n"),
    };
  }
  if (entries.some((entry) => entry?.status === "loading")) return { status: "loading", text };
  if (entries.some((entry) => entry?.status === "error")) return { status: "error", text };
  return { status: "not_loaded", text };
}

// ---------------------------------------------------------------------------
// Dev-only language-switch metrics
// ---------------------------------------------------------------------------

type SwitchMetrics = {
  from: Language;
  to: Language;
  startedAt: number;
  cached: number;
  needTranslation: number;
  batches: number;
  apiCalls: number;
  failed: number;
  visibleReadyMs?: number;
  logged: boolean;
};
let metrics: SwitchMetrics | null = null;
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

function startSwitchMetrics(from: Language, to: Language) {
  if (!__DEV__) return;
  metrics = {
    from,
    to,
    startedAt: now(),
    cached: 0,
    needTranslation: 0,
    batches: 0,
    apiCalls: 0,
    failed: 0,
    logged: false,
  };
}

function checkSwitchMetrics() {
  if (!__DEV__ || !metrics || metrics.logged || metrics.to !== activeLanguage) return;
  const hasWork = (priority: AskPranaTranslationPriority) =>
    inFlightByPriority[priority] > 0 ||
    queues[priority].some((job) => job.language === activeLanguage) ||
    pendingUnits.has(`${activeLanguage}|${priority}`);
  if (metrics.visibleReadyMs == null && !hasWork("visible")) {
    metrics.visibleReadyMs = Math.round(now() - metrics.startedAt);
  }
  if (!hasWork("visible") && !hasWork("background")) {
    metrics.logged = true;
    console.log("[AskPranaTranslation] language switch", {
      switch: `${metrics.from} → ${metrics.to}`,
      cached: metrics.cached,
      needTranslation: metrics.needTranslation,
      batches: metrics.batches,
      apiCalls: metrics.apiCalls,
      failed: metrics.failed,
      visibleReadyMs: metrics.visibleReadyMs,
      fullHistoryReadyMs: Math.round(now() - metrics.startedAt),
    });
  }
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

/** Units requested in the current tick, merged into batches on flush. */
const rateLimitRetries = new WeakMap<Job, number>();
const pendingUnits = new Map<string, { language: Language; priority: AskPranaTranslationPriority; units: string[] }>();
let flushScheduled = false;

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  setTimeout(() => {
    flushScheduled = false;
    for (const { language, priority, units } of pendingUnits.values()) {
      const limits = BATCH_LIMITS[priority];
      let batch: string[] = [];
      let batchChars = 0;
      const flush = () => {
        if (batch.length) queues[priority].push({ language, priority, texts: batch });
        batch = [];
        batchChars = 0;
      };
      for (const unit of units) {
        if (batch.length >= limits.items || (batch.length && batchChars + unit.length > limits.chars)) {
          flush();
        }
        batch.push(unit);
        batchChars += unit.length;
      }
      flush();
    }
    pendingUnits.clear();
    pump();
  }, 0);
}

function totalInFlight() {
  return inFlightByPriority.visible + inFlightByPriority.background + inFlightByPriority.prefetch;
}

function nextJob(): Job | undefined {
  for (const priority of PRIORITY_ORDER) {
    if (priority === "prefetch" && Date.now() < prefetchPausedUntil) continue;
    if (queues[priority].length && inFlightByPriority[priority] < MAX_CONCURRENT_BY_PRIORITY[priority]) {
      return queues[priority].shift();
    }
  }
  return undefined;
}

function pump() {
  // While rate limited, queued work waits; the retry timer restarts the pump.
  if (Date.now() < rateLimitedUntil) return;
  while (totalInFlight() < MAX_CONCURRENT_REQUESTS) {
    const job = nextJob();
    if (!job) break;
    const cache = store[job.language];
    // Prefetch deliberately targets other languages; everything else is
    // dropped once the farmer has switched away from its language.
    if (job.priority !== "prefetch" && isStaleTranslation(job.language, activeLanguage)) {
      // The farmer switched away; forget these so switching back re-requests them.
      for (const text of job.texts) {
        if (cache.get(text)?.status === "loading") cache.delete(text);
      }
      emit();
      continue;
    }
    const jobGeneration = generation;
    inFlightByPriority[job.priority] += 1;
    if (__DEV__ && job.priority !== "prefetch" && metrics?.to === job.language) {
      metrics.batches += 1;
      metrics.apiCalls += 1;
    }
    // Message ids let the server store the result for every device.
    const jobIds = job.texts.map((text) => {
      const ids = messageIdsBySource.get(text.trim());
      return ids?.size ? ids.values().next().value ?? null : null;
    });
    void translateAskPranaHistory(job.texts, job.language, jobIds)
      .then((results) => {
        if (jobGeneration !== generation) return;
        job.texts.forEach((text, index) => {
          const value = results[index];
          if (typeof value === "string" && isValidTranslation(text, value, job.language)) {
            cache.set(text, { status: "ready", value: value.trim() });
          } else {
            if (__DEV__) {
              console.log("[AskPranaTranslation] rejected", {
                language: job.language,
                preview: typeof value === "string" ? value.slice(0, 120) : value,
              });
            }
            const attempts = (cache.get(text)?.attempts ?? 0) + 1;
            cache.set(text, { status: "error", failedAt: Date.now(), attempts });
            if (__DEV__ && metrics?.to === job.language) metrics.failed += 1;
          }
        });
        schedulePersist(job.language);
      })
      .catch((error) => {
        if (jobGeneration !== generation) return;
        const message = error instanceof Error ? error.message : String(error);
        if (__DEV__) {
          console.log("[AskPranaTranslation] failed", {
            language: job.language,
            error: message,
          });
          if (metrics?.to === job.language) metrics.failed += 1;
        }
        const rateLimited = /429|rate limit/i.test(message);
        if (rateLimited) {
          // Rate limited by OpenAI: put this batch back (it is still needed) and
          // retry it shortly instead of freezing translations for 20 seconds.
          // Prefetch for other languages pauses so it stops competing with the screen.
          prefetchPausedUntil = Date.now() + PREFETCH_PAUSE_AFTER_RATE_LIMIT_MS;
          const retries = rateLimitRetries.get(job) ?? 0;
          if (job.priority !== "prefetch" && retries < RATE_LIMIT_MAX_RETRIES) {
            const retryJob = { ...job };
            rateLimitRetries.set(retryJob, retries + 1);
            rateLimitedUntil = Date.now() + RATE_LIMIT_RETRY_MS * (retries + 1);
            queues[job.priority].unshift(retryJob);
            if (!rateLimitRetryTimer) {
              rateLimitRetryTimer = setTimeout(() => {
                rateLimitRetryTimer = null;
                rateLimitedUntil = 0;
                pump();
              }, RATE_LIMIT_RETRY_MS * (retries + 1));
            }
            return;
          }
          if (job.priority === "prefetch") {
            // Prefetch is best effort: forget it so a later visit asks again.
            for (const text of job.texts) {
              if (cache.get(text)?.status === "loading") cache.delete(text);
            }
            return;
          }
        }
        for (const text of job.texts) {
          const attempts = (cache.get(text)?.attempts ?? 0) + 1;
          cache.set(text, { status: "error", failedAt: Date.now(), attempts });
        }
      })
      .finally(() => {
        inFlightByPriority[job.priority] -= 1;
        revealPaintedLanguage();
        emit();
        if (Date.now() >= rateLimitedUntil) pump();
        checkSwitchMetrics();
      });
  }
}

// ---------------------------------------------------------------------------
// Stored (server) translations
// ---------------------------------------------------------------------------

/** Source text → stored message ids / session ids, for database lookups. */
const messageIdsBySource = new Map<string, Set<string>>();
const sessionIdsBySource = new Map<string, Set<string>>();

export type AskPranaStoredTranslationLoader = (
  language: Language,
  ids: { messageIds: string[]; sessionIds: string[] },
) => Promise<void>;
let storedTranslationLoader: AskPranaStoredTranslationLoader | null = null;
/** Languages whose stored translations are being read for a switch. */
const serverLoadInFlight = new Set<Language>();
const deferredRequests: { texts: readonly string[]; language: Language; priority: AskPranaTranslationPriority }[] = [];
const serverPending: Record<Language, Set<string>> = { en: new Set(), hi: new Set(), te: new Set() };
let serverRecheckTimer: ReturnType<typeof setTimeout> | null = null;
let serverRecheckRound = 0;

/** Registered by the history service; reads stored translations by id. */
export function setAskPranaStoredTranslationLoader(loader: AskPranaStoredTranslationLoader | null) {
  storedTranslationLoader = loader;
}

/** The language the picker selected (history requests ask the server for it). */
export function getAskPranaSelectedLanguage(): Language {
  return activeLanguage;
}

function addId(map: Map<string, Set<string>>, source: string | null | undefined, id: string) {
  const key = source?.trim();
  if (!key) return;
  const ids = map.get(key) ?? new Set<string>();
  ids.add(id);
  map.set(key, ids);
}

/** Remembers which stored message/session each display text belongs to. */
export function registerAskPranaTranslationSources(input: {
  messages?: readonly { id: string; text: string | null | undefined }[];
  sessions?: readonly { id: string; title?: string | null; preview?: string | null }[];
}) {
  for (const message of input.messages ?? []) addId(messageIdsBySource, message.text, message.id);
  for (const session of input.sessions ?? []) {
    addId(sessionIdsBySource, session.title, session.id);
    addId(sessionIdsBySource, session.preview, session.id);
  }
}

/**
 * Marks server translations ready before render, so a stored chat paints in
 * the selected language with no translate-history call.
 */
export function seedAskPranaDisplayTranslations(
  language: Language,
  pairs: readonly (readonly [source: string | null | undefined, translated: string | null | undefined])[],
) {
  const cache = store[language];
  let changed = false;
  for (const [source, translated] of pairs) {
    const key = source?.trim();
    const value = translated?.trim();
    if (!key || !value || !needsTranslation(key, language)) continue;
    if (!isValidTranslation(key, value, language)) continue;
    if (cache.get(key)?.value === value) continue;
    cache.set(key, { status: "ready", value });
    serverPending[language].delete(key);
    changed = true;
  }
  if (changed) {
    schedulePersist(language);
    emit();
  }
}

/**
 * The server is translating these in the background. Show the original as
 * "loading" (no live request) and re-read the database shortly.
 */
export function markAskPranaServerPending(language: Language, sources: readonly (string | null | undefined)[]) {
  const cache = store[language];
  let added = false;
  for (const source of sources) {
    const key = source?.trim();
    if (!key || !needsTranslation(key, language)) continue;
    const entry = cache.get(key);
    if (entry?.status === "ready" || (entry?.status === "loading" && !entry.serverPending)) continue;
    cache.set(key, { status: "loading", serverPending: true, attempts: entry?.attempts });
    serverPending[language].add(key);
    added = true;
  }
  if (!added) return;
  emit();
  if (!serverRecheckTimer) {
    serverRecheckRound = 0;
    scheduleServerRecheck();
  }
}

function scheduleServerRecheck() {
  const delay = SERVER_FILL_RECHECK_MS[serverRecheckRound] ?? SERVER_FILL_RECHECK_MS[SERVER_FILL_RECHECK_MS.length - 1];
  const previous = SERVER_FILL_RECHECK_MS[serverRecheckRound - 1] ?? 0;
  serverRecheckTimer = setTimeout(() => void runServerRecheck(), Math.max(0, delay - previous));
}

function idsForSources(sources: readonly string[]) {
  const messageIds = new Set<string>();
  const sessionIds = new Set<string>();
  for (const source of sources) {
    const key = source.trim();
    messageIdsBySource.get(key)?.forEach((id) => messageIds.add(id));
    sessionIdsBySource.get(key)?.forEach((id) => sessionIds.add(id));
  }
  return { messageIds: [...messageIds], sessionIds: [...sessionIds] };
}

async function runServerRecheck() {
  const recheckGeneration = generation;
  const lastRound = serverRecheckRound >= SERVER_FILL_RECHECK_MS.length - 1;
  for (const language of LANGUAGES) {
    const pending = [...serverPending[language]];
    if (!pending.length) continue;
    const ids = idsForSources(pending);
    if (storedTranslationLoader && (ids.messageIds.length || ids.sessionIds.length)) {
      // The loader seeds anything that has been stored since.
      await storedTranslationLoader(language, ids).catch(() => undefined);
      if (recheckGeneration !== generation) return;
    }
    if (!lastRound) continue;
    // Still missing after the server had time: fall back to a live request.
    const cache = store[language];
    const stillMissing = [...serverPending[language]];
    serverPending[language].clear();
    for (const key of stillMissing) {
      if (cache.get(key)?.serverPending) cache.delete(key);
    }
    emit();
    if (stillMissing.length && language === activeLanguage) {
      requestAskPranaDisplayTranslations(stillMissing, language, "visible");
    }
  }
  serverRecheckTimer = null;
  if (!lastRound && LANGUAGES.some((language) => serverPending[language].size)) {
    serverRecheckRound += 1;
    scheduleServerRecheck();
  }
}

/** Reads stored translations for everything on screen (one DB request). */
async function loadStoredTranslations(language: Language, texts: readonly string[]) {
  if (!storedTranslationLoader) return;
  const ids = idsForSources(texts.filter((text) => text?.trim() && needsTranslation(text, language)));
  if (!ids.messageIds.length && !ids.sessionIds.length) return;
  serverLoadInFlight.add(language);
  try {
    await Promise.race([
      storedTranslationLoader(language, ids).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, SERVER_LOAD_TIMEOUT_MS)),
    ]);
  } finally {
    serverLoadInFlight.delete(language);
    const replay = deferredRequests.splice(0).filter((request) => request.language === language);
    for (const request of replay) requestAskPranaDisplayTranslations(request.texts, request.language, request.priority);
  }
}

/** Drops cached, persisted and queued translations, e.g. when the user signs out. */
export function clearAskPranaDisplayTranslations() {
  generation += 1;
  for (const priority of PRIORITY_ORDER) queues[priority].length = 0;
  pendingUnits.clear();
  dirtyLanguages.clear();
  messageIdsBySource.clear();
  sessionIdsBySource.clear();
  deferredRequests.length = 0;
  for (const language of LANGUAGES) serverPending[language].clear();
  if (serverRecheckTimer) {
    clearTimeout(serverRecheckTimer);
    serverRecheckTimer = null;
  }
  for (const cache of Object.values(store)) cache.clear();
  if (storageAvailable) {
    void AsyncStorage.multiRemove(LANGUAGES.map((lang) => STORAGE_PREFIX + lang)).catch(() => undefined);
  }
  emit();
}

/**
 * Queue translations for every paragraph of `texts` not yet in `language`.
 * Cached, in-flight and permanently failed units are skipped, so repeated
 * calls (re-renders, sidebar reloads) never send duplicate requests.
 */
export function requestAskPranaDisplayTranslations(
  texts: readonly string[],
  language: Language,
  priority: AskPranaTranslationPriority = "background",
) {
  const isPrefetch = priority === "prefetch";
  if (!hydrated) {
    // Wait for the device cache first so cached text is never re-requested.
    void ensureHydrated().then(() => requestAskPranaDisplayTranslations(texts, language, priority));
    return;
  }
  if (serverLoadInFlight.has(language)) {
    // Stored translations for this language are being read; only what they
    // do not cover is sent for live translation afterwards.
    deferredRequests.push({ texts, language, priority });
    return;
  }

  const cache = store[language];
  const timestamp = Date.now();
  if (priority === "visible") {
    // Prefetch work already queued for this language is now needed on screen.
    const promoted = queues.prefetch.filter((job) => job.language === language);
    if (promoted.length) {
      queues.prefetch = queues.prefetch.filter((job) => job.language !== language);
      queues.visible.unshift(...promoted.map((job) => ({ ...job, priority: "visible" as const })));
      pump();
    }
  }
  const bucketKey = `${language}|${priority}`;
  const bucket = pendingUnits.get(bucketKey) ?? { language, priority, units: [] };
  const seen = new Set(bucket.units);
  let added = false;
  for (const text of texts) {
    const source = text?.trim();
    if (!source || !needsTranslation(text, language)) continue;
    const wholeEntry = cache.get(source);
    // A cached full-message result from an earlier version wins over chunks.
    if (wholeEntry?.status === "ready") {
      if (__DEV__ && !isPrefetch && metrics?.to === language) metrics.cached += 1;
      continue;
    }
    for (const key of translationUnits(source)) {
      if (!key || !needsTranslation(key, language) || seen.has(key)) continue;
      seen.add(key);
      const entry = cache.get(key);
      if (!shouldSendTranslation(entry?.status, isRetryable(entry, timestamp))) {
        if (entry?.status === "ready" && __DEV__ && !isPrefetch && metrics?.to === language) metrics.cached += 1;
        continue;
      }
      cache.set(key, { status: "loading", attempts: entry?.attempts });
      bucket.units.push(key);
      if (__DEV__ && !isPrefetch && metrics?.to === language) metrics.needTranslation += 1;
      added = true;
    }
  }
  if (added) {
    pendingUnits.set(bucketKey, bucket);
    emit();
    scheduleFlush();
  } else {
    checkSwitchMetrics();
  }
}

/**
 * Selects the language used to render the cache without scheduling work.
 * This is intentionally separate from requestAskPranaDisplayTranslations so
 * changing the picker can never be the cause of a translate-history call.
 */
export function getAskPranaDisplayLanguage(): Language {
  return paintedLanguage;
}

export function setAskPranaDisplayLanguage(language: Language) {
  if (language !== activeLanguage) {
    startSwitchMetrics(activeLanguage, language);
    activeLanguage = language;
  }
  const texts = visibleAskPranaTexts();
  if (texts.length) requestAskPranaDisplayTranslations(texts, language, "visible");
  // Paint the selected language now. Cached entries render in this update;
  // uncached entries keep their source text only until their own small batch
  // completes. Do not hold the entire chat behind the slowest message.
  paintedLanguage = language;
  version += 1;
  for (const listener of listeners) listener();
  checkSwitchMetrics();
}

function revealPaintedLanguage() {
  if (paintedLanguage === activeLanguage) return;
  paintedLanguage = activeLanguage;
  version += 1;
  for (const listener of listeners) listener();
}

export function getAskPranaVisibleTranslationPhase(): "ready" | "loading" | "error" {
  if (paintedLanguage === activeLanguage && isAskPranaDisplayLanguageReady(activeLanguage)) return "ready";
  const texts = visibleAskPranaTexts().filter((text) => text?.trim());
  if (texts.length === 0) return paintedLanguage === activeLanguage ? "ready" : "loading";
  const statuses = texts.map((text) => resolveText(text, activeLanguage).status);
  if (statuses.some((status) => status === "loading" || status === "not_loaded")) return "loading";
  if (statuses.some((status) => status === "error")) return "error";
  if (paintedLanguage !== activeLanguage) return "loading";
  return "ready";
}

export function retryAskPranaVisibleTranslations() {
  rateLimitedUntil = 0;
  if (rateLimitRetryTimer) {
    clearTimeout(rateLimitRetryTimer);
    rateLimitRetryTimer = null;
  }
  const language = activeLanguage;
  const cache = store[language];
  for (const text of visibleAskPranaTexts()) {
    const key = text?.trim();
    if (key && cache.get(key)?.status === "error") cache.delete(key);
  }
  requestAskPranaDisplayTranslations(visibleAskPranaTexts(), language, "visible");
  version += 1;
  for (const listener of listeners) listener();
}

const visibleTextSets = new Map<string, readonly string[]>();
type PendingLanguageSwap = {
  language: Language;
  apply: (language: Language) => void;
};
let pendingLanguageSwap: PendingLanguageSwap | null = null;

export function registerVisibleAskPranaTexts(id: string, texts: readonly string[]) {
  visibleTextSets.set(id, texts);
  flushPendingLanguageSwap();
}

export function unregisterVisibleAskPranaTexts(id: string) {
  visibleTextSets.delete(id);
}

function visibleAskPranaTexts() {
  return [...visibleTextSets.values()].flat();
}

/** True when every visible string can render in `language` without another request. */
export function isAskPranaDisplayLanguageReady(language: Language, texts: readonly string[] = visibleAskPranaTexts()) {
  // Nothing has registered yet, so a click must not switch the menus early.
  if (visibleTextSets.size === 0) return false;
  return texts.every((text) => !text?.trim() || resolveText(text, language).status === "ready");
}

function flushPendingLanguageSwap() {
  const pending = pendingLanguageSwap;
  if (!pending || !hydrated) return;
  if (!isAskPranaDisplayLanguageReady(pending.language)) return;
  pendingLanguageSwap = null;
  setAskPranaDisplayLanguage(pending.language);
  pending.apply(pending.language);
}

notifyLanguageSwap = flushPendingLanguageSwap;

/**
 * Labels and cached chat text switch immediately. Missing messages repaint
 * individually as their foreground translation batches return.
 */
export function selectAskPranaLanguageWhenReady(
  language: Language,
  apply: (language: Language) => void,
) {
  pendingLanguageSwap = null;
  if (language !== activeLanguage) {
    startSwitchMetrics(activeLanguage, language);
    activeLanguage = language;
  }
  paintedLanguage = language;
  // Hold live requests until the stored translations for the screen are read;
  // set before apply() so the re-render it triggers cannot send any.
  const texts = visibleAskPranaTexts();
  const stored = loadStoredTranslations(language, texts);
  apply(language);
  const request = async () => {
    await stored;
    if (activeLanguage !== language) return;
    const visible = visibleAskPranaTexts();
    if (visible.length) requestAskPranaDisplayTranslations(visible, language, "visible");
    revealPaintedLanguage();
    version += 1;
    for (const listener of listeners) listener();
  };
  if (hydrated) void request();
  else void ensureHydrated().then(request);
}

/**
 * Selected-language display for Ask Prana content. The language comes from
 * i18next — the same source as every static Ask Prana label.
 */
export function useAskPranaDisplayTranslation(
  texts: readonly string[],
  priority: Exclude<AskPranaTranslationPriority, "prefetch"> = "background",
  options?: {
    prefetchOtherLanguages?: boolean;
    /** Only the first N texts use `priority`; the rest translate in the background. */
    priorityCount?: number;
  },
) {
  const sourceId = useId();
  const storeVersion = useSyncExternalStore(subscribe, getVersion, getVersion);
  const signature = texts.join("␞");
  const priorityCount = options?.priorityCount;
  const prefetchOtherLanguages = options?.prefetchOtherLanguages;
  const selectedLanguage = storeVersion >= 0 ? activeLanguage : activeLanguage;
  const language = storeVersion >= 0 ? paintedLanguage : paintedLanguage;

  useEffect(() => {
    const sources = signature ? signature.split("␞") : [];
    const count = priorityCount == null ? sources.length : Math.max(0, priorityCount);
    const urgent = sources.slice(0, count);
    registerVisibleAskPranaTexts(sourceId, urgent);
    if (urgent.length) {
      requestAskPranaDisplayTranslations(urgent, activeLanguage, priority);
      revealPaintedLanguage();
    }
    return () => unregisterVisibleAskPranaTexts(sourceId);
  }, [signature, sourceId, priority, priorityCount, selectedLanguage]);

  useEffect(() => {
    if (paintedLanguage !== activeLanguage || !signature || priorityCount == null) return;
    const rest = signature.split("␞").slice(Math.max(0, priorityCount));
    if (rest.length) requestAskPranaDisplayTranslations(rest, activeLanguage, "background");
  }, [signature, language, selectedLanguage, priorityCount]);

  useEffect(() => {
    if (!signature || prefetchOtherLanguages === false) return;
    if (paintedLanguage !== activeLanguage) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sources = signature.split("␞");
    const scheduleOthers = () => {
      if (cancelled) return;
      if (queues.visible.length || inFlightByPriority.visible > 0) {
        timer = setTimeout(scheduleOthers, 500);
        return;
      }
      for (const target of LANGUAGES) {
        if (target === activeLanguage) continue;
        requestAskPranaDisplayTranslations(sources, target, "prefetch");
      }
    };
    const idle = typeof requestIdleCallback === "function" ? requestIdleCallback(() => scheduleOthers()) : null;
    if (idle == null) timer = setTimeout(scheduleOthers, 1500);
    return () => {
      cancelled = true;
      if (idle != null && typeof cancelIdleCallback === "function") cancelIdleCallback(idle);
      if (timer != null) clearTimeout(timer);
    };
  }, [signature, language, selectedLanguage, prefetchOtherLanguages]);

  const contentPhase = storeVersion >= 0 ? getAskPranaVisibleTranslationPhase() : "ready";

  const getStatus = useCallback(
    (text: string) => (storeVersion >= 0 ? resolveText(text, paintedLanguage).status : "not_loaded"),
    [storeVersion],
  );

  const displayText = useCallback(
    (text: string) => (storeVersion >= 0 ? resolveText(text, paintedLanguage).text : text),
    [storeVersion],
  );

  return { language, displayText, getStatus, contentPhase, retryVisibleTranslations: retryAskPranaVisibleTranslations };
}
