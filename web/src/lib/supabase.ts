import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createClient,
  type AuthChangeEvent,
  type Session,
  type SupportedStorage,
} from "@supabase/supabase-js";
import Constants from "expo-constants";
import { AppState, Platform } from "react-native";
import { isAppSessionToken, loadAppSession } from "../services/app-session";

type ExpoExtra = {
  supabaseUrl?: string | null;
  hasSupabaseAnonKey?: boolean;
};

const extra = (Constants.expoConfig?.extra ?? {}) as ExpoExtra;

/** Prefer EXPO_PUBLIC_* (inlined at EAS build); fall back to app.config.js extra for APK. */
const supabaseUrl = (
  process.env.EXPO_PUBLIC_SUPABASE_URL ??
  extra.supabaseUrl ??
  ""
).trim();
const supabaseAnonKey = (process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "").trim();

function isInvalidSupabaseUrl(url: string): boolean {
  if (!url) return true;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0") {
      return true;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

if (!supabaseUrl || !supabaseAnonKey) {
  console.error(
    "[supabase] Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY. " +
      "APK/EAS builds must include these env vars. " +
      `urlFromExtra=${Boolean(extra.supabaseUrl)} hasAnonKeyExtra=${Boolean(extra.hasSupabaseAnonKey)}`,
  );
} else if (isInvalidSupabaseUrl(supabaseUrl)) {
  console.error(
    "[supabase] EXPO_PUBLIC_SUPABASE_URL looks invalid or points at localhost:",
  supabaseUrl,
  );
}

/** Dev-only helpers: hostname + project ref — never logs keys or tokens. */
export function getSupabaseProjectInfo() {
  try {
    const hostname = supabaseUrl
      ? new URL(supabaseUrl).hostname
      : "(missing EXPO_PUBLIC_SUPABASE_URL)";
    const projectRef = hostname.endsWith(".supabase.co")
      ? hostname.replace(".supabase.co", "")
      : null;
    return { hostname, projectRef };
  } catch {
    return { hostname: "(invalid EXPO_PUBLIC_SUPABASE_URL)", projectRef: null };
  }
}

const isDev =
  typeof __DEV__ !== "undefined"
    ? __DEV__
    : process.env.NODE_ENV !== "production";

const AUTH_ERROR_MARKERS = [
  "pgrst303",
  "jwt issued at future",
  "jwt expired",
  "invalid jwt",
  "invalid token",
];

type AuthErrorLike = {
  code?: string | null;
  message?: string | null;
  details?: string | null;
};

type AuthStateListener = (
  session: Session | null,
  event: AuthChangeEvent | "RESTORED",
) => void;

let currentSession: Session | null = null;
let authReady = false;
let authInitialization: Promise<Session | null> | null = null;
let refreshPromise: Promise<Session | null> | null = null;
let invalidSessionHandler: (() => void) | null = null;
const authStateListeners = new Set<AuthStateListener>();

function decodeBase64(value: string): string {
  if (typeof globalThis.atob === "function") return globalThis.atob(value);
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
  let binary = "";
  let index = 0;
  while (index < value.length) {
    const first = alphabet.indexOf(value[index++]);
    const second = alphabet.indexOf(value[index++]);
    const third = alphabet.indexOf(value[index++]);
    const fourth = alphabet.indexOf(value[index++]);
    binary += String.fromCharCode((first << 2) | (second >> 4));
    if (third !== 64) binary += String.fromCharCode(((second & 15) << 4) | (third >> 2));
    if (fourth !== 64) binary += String.fromCharCode(((third & 3) << 6) | fourth);
  }
  return binary;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const encoded = token.split(".")[1];
    if (!encoded) return null;
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "=",
    );
    const decoded = decodeBase64(padded);
    return decoded ? (JSON.parse(decoded) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Safe development diagnostics. Never logs the token itself. */
export function logAuthClockDiagnostics(session: Session | null) {
  if (!isDev || !session?.access_token) return;
  const payload = decodeJwtPayload(session.access_token);
  const tokenIssuedAt = Number(payload?.iat);
  const tokenExpiresAt = Number(payload?.exp);
  const clientTimeSeconds = Math.floor(Date.now() / 1000);
  const differenceSeconds = Number.isFinite(tokenIssuedAt)
    ? clientTimeSeconds - tokenIssuedAt
    : null;

  console.log("[auth-clock]", {
    clientTimeSeconds,
    tokenIssuedAt: Number.isFinite(tokenIssuedAt) ? tokenIssuedAt : null,
    tokenExpiresAt: Number.isFinite(tokenExpiresAt) ? tokenExpiresAt : null,
    differenceSeconds,
  });

  if (differenceSeconds != null && differenceSeconds < -60) {
    console.warn("[auth-clock] Possible device clock mismatch detected.");
  }
}

export function isRecoverableAuthError(error: unknown): boolean {
  if (!error) return false;
  const value = error as AuthErrorLike;
  const combined = [value.code, value.message, value.details, String(error)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return AUTH_ERROR_MARKERS.some((marker) => combined.includes(marker));
}

function publishAuthState(
  session: Session | null,
  event: AuthChangeEvent | "RESTORED",
) {
  currentSession = session;
  authReady = true;
  logAuthClockDiagnostics(session);
  queueMicrotask(() => {
    for (const listener of authStateListeners) listener(session, event);
  });
}

/** Prevents APK splash/profile from hanging forever on slow/offline auth. */
export const AUTH_SESSION_TIMEOUT_MS = 8000;

export function withTimeout<T>(
  promise: PromiseLike<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);

    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

if (isDev) {
  const info = getSupabaseProjectInfo();
  console.log("[supabase] hostname:", info.hostname);
  console.log("[supabase] projectRef:", info.projectRef);
  console.log("[supabase] hasAnonKey:", Boolean(supabaseAnonKey));
}

/**
 * SSR-safe auth storage:
 * - Node / Expo web SSR: in-memory (no `window`)
 * - Browser web: localStorage
 * - iOS / Android APK: AsyncStorage (persists JWT across restarts)
 */
function createAuthStorage(): SupportedStorage {
  // Expo Router web SSR runs in Node — AsyncStorage touches `window` and crashes.
  if (typeof window === "undefined") {
    const memory = new Map<string, string>();
    return {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => {
        memory.set(key, value);
      },
      removeItem: (key) => {
        memory.delete(key);
      },
    };
  }

  if (Platform.OS === "web") {
    return {
      getItem: (key) => {
        try {
          return window.localStorage.getItem(key);
        } catch {
          return null;
        }
      },
      setItem: (key, value) => {
        try {
          window.localStorage.setItem(key, value);
        } catch {
          // ignore quota / private mode errors
        }
      },
      removeItem: (key) => {
        try {
          window.localStorage.removeItem(key);
        } catch {
          // ignore
        }
      },
    };
  }

  return AsyncStorage;
}

/**
 * React Native / Expo APK requires persistent auth storage.
 * Without it, Edge Function calls fail with 401 after restart / backgrounding.
 */
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: createAuthStorage(),
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: Platform.OS === "web",
  },
  global: {
    fetch: authSafeFetch,
  },
});

let authSubscriptionStarted = false;

function startAuthSubscription() {
  if (authSubscriptionStarted) return;
  authSubscriptionStarted = true;
  supabase.auth.onAuthStateChange((event, session) => {
    if (
      event === "INITIAL_SESSION" ||
      event === "SIGNED_IN" ||
      event === "TOKEN_REFRESHED" ||
      event === "SIGNED_OUT" ||
      event === "USER_UPDATED"
    ) {
      // An Ask Prana session is not a Supabase Auth session. Supabase sign-out
      // and token refresh must not wipe it or send the user back to login.
      if (isAppSessionToken(currentSession?.access_token)) return;
      publishAuthState(session, event);
    }
  });
}

/** Resolves only after Supabase has restored its persisted session (with timeout). */
export function initializeAuthSession(): Promise<Session | null> {
  if (authReady) return Promise.resolve(currentSession);
  if (authInitialization) return authInitialization;

  startAuthSubscription();
  authInitialization = (async () => {
    try {
      if (!supabaseUrl || !supabaseAnonKey || isInvalidSupabaseUrl(supabaseUrl)) {
        console.warn(
          "[auth] Supabase env missing/invalid — skipping session restore.",
        );
        publishAuthState(null, "RESTORED");
        return null;
      }

      const appSession = await loadAppSession();
      if (appSession) {
        publishAuthState(appSession, "RESTORED");
        return appSession;
      }

      const { data, error } = await withTimeout(
        supabase.auth.getSession(),
        AUTH_SESSION_TIMEOUT_MS,
        "auth.getSession",
      );

      if (error) {
        console.warn("[auth] Session restoration failed:", error.message);
        publishAuthState(null, "RESTORED");
        return null;
      }

      publishAuthState(data.session, "RESTORED");
      return data.session;
    } catch (error: unknown) {
      console.warn(
        "[auth] Session restoration failed:",
        error instanceof Error ? error.message : String(error),
      );
      publishAuthState(null, "RESTORED");
      return null;
    }
  })();

  return authInitialization;
}

export const waitForAuthReady = initializeAuthSession;

export function acceptAuthenticatedSession(session: Session) {
  publishAuthState(session, "SIGNED_IN");
}

export function clearPublishedSession() {
  publishAuthState(null, "SIGNED_OUT");
}

export function subscribeToAuthSession(listener: AuthStateListener) {
  authStateListeners.add(listener);
  void initializeAuthSession();
  if (authReady) queueMicrotask(() => listener(currentSession, "RESTORED"));
  return () => authStateListeners.delete(listener);
}

export function setInvalidSessionHandler(handler: (() => void) | null) {
  invalidSessionHandler = handler;
  return () => {
    if (invalidSessionHandler === handler) invalidSessionHandler = null;
  };
}

async function clearInvalidSession() {
  if (isAppSessionToken(currentSession?.access_token)) return;
  const appSession = await loadAppSession();
  if (appSession) {
    publishAuthState(appSession, "SIGNED_IN");
    return;
  }
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch (error) {
    console.warn(
      "[auth] Unable to clear invalid session:",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    publishAuthState(null, "SIGNED_OUT");
    invalidSessionHandler?.();
  }
}

/** Refreshes at most once even when several protected requests fail together. */
export async function refreshValidSession(): Promise<Session | null> {
  if (isAppSessionToken(currentSession?.access_token)) {
    const expiresAt = Number(currentSession?.expires_at);
    if (Number.isFinite(expiresAt) && expiresAt > Math.floor(Date.now() / 1000) + 60) {
      return currentSession;
    }
    publishAuthState(null, "SIGNED_OUT");
    return null;
  }
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const { data, error } = await supabase.auth.refreshSession();
    if (error || !data.session?.access_token) {
      const appSession = await loadAppSession();
      if (appSession) {
        publishAuthState(appSession, "RESTORED");
        return appSession;
      }
      // No Supabase session to refresh. Do not send the OTP screen back to login.
      if (!currentSession?.access_token || isAppSessionToken(currentSession.access_token)) {
        return null;
      }
      console.warn("[auth] Session refresh failed:", error?.message ?? "No session");
      await clearInvalidSession();
      return null;
    }
    publishAuthState(data.session, "TOKEN_REFRESHED");
    return data.session;
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

export async function ensureValidSession(): Promise<Session | null> {
  const restored = await initializeAuthSession();
  const session = currentSession ?? restored;
  if (!session?.access_token) return null;

  if (isAppSessionToken(session.access_token)) {
    const expiresAt = Number(session.expires_at);
    if (Number.isFinite(expiresAt) && expiresAt <= Math.floor(Date.now() / 1000) + 60) return null;
    return session;
  }

  const payload = decodeJwtPayload(session.access_token);
  const issuedAt = Number(payload?.iat);
  const expiresAt = Number(payload?.exp ?? session.expires_at);
  const now = Math.floor(Date.now() / 1000);
  const issuedInFuture = Number.isFinite(issuedAt) && issuedAt > now + 60;
  const expiresSoon = Number.isFinite(expiresAt) && expiresAt <= now + 60;

  if (issuedInFuture || expiresSoon) return refreshValidSession();
  return session;
}

type ResultWithError = { error?: unknown };

/** Runs a protected operation and retries it once after a recoverable auth error. */
export async function executeWithValidSession<T extends ResultWithError>(
  request: () => Promise<T>,
): Promise<T> {
  const session = await ensureValidSession();
  if (!session) throw new Error("No active session. Please sign in again.");

  try {
    const first = await request();
    if (!isRecoverableAuthError(first.error)) return first;
  } catch (error) {
    if (!isRecoverableAuthError(error)) throw error;
  }

  const refreshed = await refreshValidSession();
  if (!refreshed) throw new Error("Your session has expired. Please sign in again.");

  try {
    const retry = await request();
    if (isRecoverableAuthError(retry.error)) await clearInvalidSession();
    return retry;
  } catch (error) {
    if (isRecoverableAuthError(error)) await clearInvalidSession();
    throw error;
  }
}

const platformFetch = globalThis.fetch.bind(globalThis);

function requestUrl(input: RequestInfo | URL) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function isTransientNetworkFailure(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(error ?? "");
  return /failed to fetch|network request failed|networkerror|fetch failed|timed out|timeout|aborted|offline|internet/i.test(
    message,
  );
}

function networkFailureResponse(): Response {
  return new Response(
    JSON.stringify({
      message: "Network unavailable",
      code: "NETWORK_ERROR",
    }),
    {
      status: 503,
      statusText: "Network Unavailable",
      headers: { "Content-Type": "application/json" },
    },
  );
}

async function responseHasAuthError(response: Response) {
  if (response.status === 401) return true;
  if (response.status < 400) return false;
  try {
    const body = await response.clone().text();
    return isRecoverableAuthError(body);
  } catch {
    return false;
  }
}

/** Supabase-wide one-shot JWT recovery for PostgREST, Storage and Functions. */
async function authSafeFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);

  let firstResponse: Response;
  try {
    firstResponse = await platformFetch(request.clone());
  } catch (error) {
    // Avoid raw "Failed to fetch" throws — Expo surfaces them as Console Error overlays.
    if (isTransientNetworkFailure(error)) {
      return networkFailureResponse();
    }
    throw error;
  }

  const url = requestUrl(input);

  // MSG91 verification and Ask Prana sessions are not Supabase JWTs. A 401
  // from those calls must not refresh or clear the login.
  if (
    url.includes("/functions/v1/msg91-auth") ||
    isAppSessionToken(currentSession?.access_token)
  ) {
    return firstResponse;
  }

  if (url.includes("/auth/v1/") || !(await responseHasAuthError(firstResponse))) {
    return firstResponse;
  }

  const refreshed = await refreshValidSession();
  if (!refreshed?.access_token) return firstResponse;

  const headers = new Headers(request.headers);
  headers.set("Authorization", `Bearer ${refreshed.access_token}`);

  try {
    const retryResponse = await platformFetch(
      new Request(request, { headers }),
    );

    if (await responseHasAuthError(retryResponse)) await clearInvalidSession();
    return retryResponse;
  } catch (error) {
    if (isTransientNetworkFailure(error)) {
      return networkFailureResponse();
    }
    throw error;
  }
}

// Keep the access token fresh while the app is foregrounded (APK / release).
if (Platform.OS !== "web" && typeof window !== "undefined") {
  AppState.addEventListener("change", (state) => {
    if (state === "active") {
      void supabase.auth.startAutoRefresh();
    } else {
      void supabase.auth.stopAutoRefresh();
    }
  });
}

export function getSupabasePublicConfig() {
  return {
    url: supabaseUrl,
    hasAnonKey: Boolean(supabaseAnonKey),
    isValidUrl: Boolean(supabaseUrl) && !isInvalidSupabaseUrl(supabaseUrl),
    ...getSupabaseProjectInfo(),
  };
}

/** Prefer local session (no network) over auth.getUser() which can Failed to fetch. */
export async function getLocalAuthUser() {
  const session = await ensureValidSession();

  if (!session?.user) {
    return {
      user: null as null,
      session: null as null,
      error: "User session is unavailable. Please sign in again.",
    };
  }

  return {
    user: session.user,
    session,
    error: null as null,
  };
}
