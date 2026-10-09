import { Platform } from "react-native";
import type { EmailOtpType } from "@supabase/supabase-js";
import {
  acceptAuthenticatedSession,
  clearPublishedSession,
  supabase,
} from "../lib/supabase";
import {
  clearAppSession,
  isAppSessionToken,
  loadAppSession,
  saveAppSession,
  savePendingRegistration,
  type AppAccount,
} from "./app-session";
import { sendMsg91Otp } from "./msg91";

export function isAuthSessionMissing(error: unknown): boolean {
  if (!error) return false;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error && "message" in error
        ? String((error as { message: unknown }).message)
        : String(error);
  return /auth session missing/i.test(message);
}

export type OtpSendFailure = "rate_limited" | "network" | "failed";

/** Buckets a Supabase signInWithOtp error (or thrown error) for the login screen. */
export function classifyOtpSendError(error: unknown): OtpSendFailure {
  const record = (error ?? {}) as { message?: unknown; code?: unknown; status?: unknown; name?: unknown };
  if (/signups? not allowed|signup_disabled|otp_disabled/i.test(`${record.code ?? ""} ${record.message ?? ""}`)) {
    // New-user sign-up is switched off in the Supabase dashboard (Auth → Providers).
    console.warn("[auth] OTP refused: sign-ups are disabled for this provider");
  }
  const message = String(record.message ?? error ?? "").toLowerCase();
  const code = String(record.code ?? "").toLowerCase();
  const status = Number(record.status);
  if (/ipblocked|ip blocked|blocked this network/.test(message)) return "failed";
  if (
    code.includes("rate_limit") ||
    status === 429 ||
    /security purposes|only request this after|after \d+ seconds|rate limit|too many requests/.test(message)
  ) {
    return "rate_limited";
  }
  if (
    record.name === "AuthRetryableFetchError" ||
    /failed to fetch|fetch failed|load failed|timed? ?out|network request failed|network error/.test(message)
  ) {
    return "network";
  }
  return "failed";
}

/**
 * Readable message for a failed verifyOtp. Supabase reports wrong and expired
 * codes with the same error, so the time since the code was sent decides.
 */
export function friendlyOtpVerifyError(
  error: unknown,
  sentAtMs: number,
  expirySeconds: number,
): string {
  const record = (error ?? {}) as { message?: unknown; code?: unknown };
  const message = String(record.message ?? error ?? "");
  if (/IP Security|request a new OTP|Unable to sign in|unavailable|Verification failed/i.test(message)) {
    return message;
  }
  const lower = message.toLowerCase().replace(/[_-]+/g, " ");
  if (/already\s*verified|verified\s*already/.test(lower)) {
    return "This OTP has expired. Please request a new OTP.";
  }
  const code = String(record.code ?? "").toLowerCase();
  if (message && lower !== "invalid" && lower !== "expired" && !/expired|invalid|token/.test(lower)) {
    return message;
  }
  if (code === "otp_expired" || /expired|invalid|token/.test(lower)) {
    return Date.now() - sentAtMs > expirySeconds * 1000
      ? "This OTP has expired. Please request a new OTP."
      : "Incorrect OTP. Please check the code and try again.";
  }
  if (classifyOtpSendError(error) === "network") {
    return "Network error. Please check your connection and try again.";
  }
  return "Unable to verify OTP. Please try again.";
}

/**
 * MSG91 widget request for the phone currently being verified. Kept in memory
 * so resend retries the same request instead of starting a second one.
 */
const PENDING_OTP_KEY = "ask-prana-phone-otp";
let pendingPhoneOtp: { phone: string; reqId: string } | null = null;

function readPendingPhoneOtp(): { phone: string; reqId: string } | null {
  if (typeof sessionStorage === "undefined") return pendingPhoneOtp;
  try {
    const raw = sessionStorage.getItem(PENDING_OTP_KEY);
    if (!raw) return pendingPhoneOtp;
    const parsed = JSON.parse(raw) as { phone?: unknown; reqId?: unknown };
    if (typeof parsed.phone === "string" && typeof parsed.reqId === "string") {
      pendingPhoneOtp = { phone: parsed.phone, reqId: parsed.reqId };
    }
  } catch {
    // Ignore a corrupt saved request and send a new code.
  }
  return pendingPhoneOtp;
}

function writePendingPhoneOtp(value: { phone: string; reqId: string } | null) {
  pendingPhoneOtp = value;
  if (typeof sessionStorage === "undefined") return;
  try {
    if (value) sessionStorage.setItem(PENDING_OTP_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(PENDING_OTP_KEY);
  } catch {
    // Private mode can block storage; the in-memory request still works.
  }
}

export async function readFunctionError(error: unknown, fallback: string): Promise<string> {
  if ((error as { name?: string } | null)?.name === "FunctionsFetchError") {
    return "Network error. Please check your connection and try again.";
  }
  const context = (error as { context?: { json?: () => Promise<unknown> } } | null)?.context;
  if (context && typeof context.json === "function") {
    try {
      const body = (await context.json()) as { error?: unknown };
      if (typeof body?.error === "string" && body.error.trim()) return body.error.trim();
    } catch {
      // The response body can only be read once.
    }
  }
  if (error instanceof Error && error.message && !/edge function|non-2xx/i.test(error.message)) {
    return error.message;
  }
  return fallback;
}

/**
 * Sends a phone OTP through MSG91. An existing number signs in and a new
 * number gets an account only after the code is verified, so the same phone
 * never creates a second account.
 */
export async function sendOTP(phone: string) {
  try {
    const pending = readPendingPhoneOtp();
    const sent = await sendMsg91Otp(
      phone,
      Platform.OS === "web" ? "web" : "mobile",
      pending?.phone === phone ? pending.reqId : undefined,
    );
    writePendingPhoneOtp({ phone, reqId: sent.reqId });
    return { data: { reqId: sent.reqId }, error: null };
  } catch (error) {
    return {
      data: null,
      error: error instanceof Error ? error : new Error("MSG91 could not send the code."),
    };
  }
}

type VerifyResult = {
  isNewUser: boolean;
  user: AppAccount | null;
  error: { message: string } | null;
};

type VerifyPayload = {
  success?: boolean;
  error?: unknown;
  code?: unknown;
  isNewUser?: boolean;
  registrationToken?: unknown;
  verifiedIdentifier?: { phone?: unknown; email?: unknown };
  user?: AppAccount;
  session?: { token?: unknown; expiresAt?: unknown };
};

async function invokeVerify(body: Record<string, unknown>): Promise<{
  data: VerifyPayload | null;
  error: unknown;
}> {
  const { data, error } = await supabase.functions.invoke("msg91-auth", { body });
  if (data && typeof data === "object") return { data: data as VerifyPayload, error };
  const context = (error as { context?: { json?: () => Promise<unknown> } } | null)?.context;
  if (context && typeof context.json === "function") {
    try {
      return { data: (await context.json()) as VerifyPayload, error };
    } catch {
      // The body was empty or already read.
    }
  }
  return { data: null, error };
}

async function verifyFailure(error: unknown, data: VerifyPayload | null): Promise<VerifyResult> {
  return {
    isNewUser: false,
    user: null,
    error: { message: await readFunctionError(error, typeof data?.error === "string" ? data.error : "Unable to verify OTP. Please try again.") },
  };
}

/**
 * The backend checks the code with MSG91 and decides whether this identifier
 * already has an account. A phone or email sent here is only a mismatch check.
 * It is not trusted.
 */
export async function completeVerifiedLogin(
  proof: { reqId: string; otp: string; otpBind?: string },
  claimed: { phone?: string; email?: string },
): Promise<VerifyResult> {
  const { data, error } = await invokeVerify({
    action: "verify",
    reqId: proof.reqId,
    otp: proof.otp,
    otpBind: proof.otpBind,
    phone: claimed.phone,
    email: claimed.email,
  });
  if (!data || error || data.success !== true) return await verifyFailure(error, data);
  if (data.isNewUser === true && typeof data.registrationToken === "string") {
    const identifier = data.verifiedIdentifier ?? {};
    await savePendingRegistration({
      registrationToken: data.registrationToken,
      phone: typeof identifier.phone === "string" ? identifier.phone : null,
      email: typeof identifier.email === "string" ? identifier.email : null,
    });
    return { isNewUser: true, user: null, error: null };
  }
  const user = data.user as AppAccount | undefined;
  const session = data.session as { token?: unknown; expiresAt?: unknown } | undefined;
  if (!user?.id || typeof session?.token !== "string" || typeof session.expiresAt !== "string") {
    return { isNewUser: false, user: null, error: { message: "Unable to sign in. Please try again." } };
  }
  const appSession = await saveAppSession({ token: session.token, expiresAt: session.expiresAt, user });
  acceptAuthenticatedSession(appSession);
  return { isNewUser: false, user, error: null };
}

export async function verifyOTP(phone: string, otp: string): Promise<{
  data: { isNewUser: boolean; user: AppAccount | null } | null;
  error: { message: string } | null;
}> {
  const pending = readPendingPhoneOtp();
  const reqId = pending?.phone === phone ? pending.reqId : "";
  if (!reqId) {
    return { data: null, error: { message: "Please request a new OTP." } };
  }
  try {
    const result = await completeVerifiedLogin({ reqId, otp: otp.trim() }, { phone });
    if (result.error) return { data: null, error: result.error };
    writePendingPhoneOtp(null);
    return { data: { isNewUser: result.isNewUser, user: result.user }, error: null };
  } catch (error) {
    return {
      data: null,
      error: { message: error instanceof Error ? error.message : "Unable to verify OTP. Please try again." },
    };
  }
}

/**
 * Ends the current user's session on this device only. Server data (profile,
 * ponds, Ask Prana history, files) is never touched. Supabase emits
 * SIGNED_OUT, which the profile and Ask Prana contexts use to reset state.
 */
/**
 * Web only: finishes sign-in when Ask Prana is opened from an email link.
 * Handles every link format Supabase can send — `#access_token` (implicit),
 * `?token_hash=&type=` (custom template), `?code=` (PKCE) — and link errors
 * such as an expired/used link, then removes the tokens from the address bar.
 * Returns an error message for the login screen when the link can't be used.
 */
// Address the app was opened with, captured before the Supabase client can
// strip the link's #tokens/#error from it. Processed at most once.
const INITIAL_WEB_URL =
  Platform.OS === "web" && typeof window !== "undefined" ? window.location.href : "";
let emailLinkProcessed = false;

export async function completeEmailLinkSignIn(): Promise<{
  handled: boolean;
  error: string | null;
}> {
  if (Platform.OS !== "web" || typeof window === "undefined" || emailLinkProcessed) {
    return { handled: false, error: null };
  }
  emailLinkProcessed = true;
  const url = new URL(INITIAL_WEB_URL || window.location.href);
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  const query = url.searchParams;
  const get = (key: string) => hash.get(key) ?? query.get(key);

  const linkError = get("error_code") || get("error");
  const tokenHash = query.get("token_hash");
  const code = query.get("code");
  const accessToken = hash.get("access_token");
  const refreshToken = hash.get("refresh_token");
  if (!linkError && !tokenHash && !code && !accessToken) {
    return { handled: false, error: null };
  }

  const clearUrl = () => {
    window.history.replaceState(null, "", `${url.origin}${url.pathname}`);
  };

  if (linkError) {
    clearUrl();
    const expired = /otp_expired|expired/i.test(`${linkError} ${get("error_description") ?? ""}`);
    console.warn("[auth] email link error:", linkError);
    return {
      handled: true,
      error: expired
        ? "This sign-in link has expired or was already used. Please request a new one."
        : "This sign-in link couldn't be used. Please request a new one.",
    };
  }

  let failed = false;
  if (tokenHash) {
    const type = (query.get("type") || "magiclink") as EmailOtpType;
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    failed = Boolean(error);
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    failed = Boolean(error);
  } else if (accessToken && refreshToken) {
    // Normally read automatically (detectSessionInUrl); set it if that missed.
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      const { error } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
      failed = Boolean(error);
    }
  }
  clearUrl();
  if (failed) {
    console.warn("[auth] email link sign-in failed");
    return {
      handled: true,
      error: "This sign-in link has expired or was already used. Please request a new one.",
    };
  }
  return { handled: true, error: null };
}

export async function logout(): Promise<{ error: Error | null }> {
  const appSession = await loadAppSession();
  if (appSession && isAppSessionToken(appSession.access_token)) {
    await supabase.functions.invoke("msg91-auth", {
      body: { action: "logout" },
      headers: { Authorization: `Bearer ${appSession.access_token}` },
    });
    await clearAppSession();
    clearPublishedSession();
  }
  const { error } = await supabase.auth.signOut({ scope: "local" });
  if (error && !isAuthSessionMissing(error)) {
    // Safe diagnostics only — never log tokens or the session object.
    console.warn("[auth] signOut failed:", error.name, error.message);
    return { error };
  }
  // An already-expired/missing session counts as logged out.
  return { error: null };
}
