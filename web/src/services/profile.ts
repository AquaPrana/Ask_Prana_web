import type { User } from "@supabase/supabase-js";
import { supabase, waitForAuthReady, withTimeout, acceptAuthenticatedSession } from "../lib/supabase";
import { completeVerifiedLogin, isAuthSessionMissing, readFunctionError } from "./auth";
import { loadAppSession, loadPendingRegistration, saveAppSession } from "./app-session";
import { getFarmerProfile } from "./local-profile";
import { sendMsg91EmailOtp } from "./msg91";

export const ACCOUNT_DELETED_MESSAGE =
  "This account has been deleted.\nPlease contact support to restore your account.";

const PROFILE_QUERY_TIMEOUT_MS = 10000;

export type UserProfile = {
  name: string;
  state: string;
  district: string;
  language: string;
  phone?: string;
  email?: string;
  avatarUrl?: string | null;
  avatarUpdatedAt?: string | null;
  isDeleted?: boolean;
};

export async function getCurrentUserProfile(): Promise<{
  profile: UserProfile | null;
  error: Error | null;
}> {
  try {
    const session = await waitForAuthReady();
    const user = session?.user;

    if (!user) {
      return { profile: null, error: null };
    }

    if (session?.access_token.startsWith("ap_")) {
      const { data, error } = await supabase.functions.invoke("msg91-auth", {
        body: { action: "me" },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (error || data?.success !== true || !data.user) {
        return {
          profile: null,
          error: new Error(await readFunctionError(error, data?.error ?? "Unable to load profile right now.")),
        };
      }
      const row = data.user as {
        name?: string;
        state?: string;
        district?: string;
        language?: string;
        phone?: string | null;
        email?: string | null;
        avatar_url?: string | null;
        avatar_updated_at?: string | null;
      };
      return {
        profile: {
          name: row.name || "",
          state: row.state || "",
          district: row.district || "",
          language: row.language || "English",
          phone: row.phone || "",
          email: row.email || "",
          avatarUrl: row.avatar_url ?? null,
          avatarUpdatedAt: row.avatar_updated_at ?? null,
        },
        error: null,
      };
    }

    const { data, error } = await withTimeout(
      supabase
        .from("users")
        .select(
          "name, state, district, language, phone, avatar_url, avatar_updated_at, is_deleted",
        )
        .eq("id", user.id)
        .maybeSingle(),
      PROFILE_QUERY_TIMEOUT_MS,
      "users.profile",
    );

    if (error) {
      if (isAuthSessionMissing(error)) {
        return { profile: null, error: null };
      }
      return { profile: null, error: new Error(error.message) };
    }

    if (!data) {
      return {
        profile: {
          name: "",
          state: "",
          district: "",
          language: "English",
          phone: user.phone ?? "",
        },
        error: null,
      };
    }

    return {
      profile: {
        name: data.name || "",
        state: data.state || "",
        district: data.district || "",
        language: data.language || "English",
        phone: data.phone || user.phone || "",
        avatarUrl: data.avatar_url ?? null,
        avatarUpdatedAt: data.avatar_updated_at ?? null,
        isDeleted: Boolean(data.is_deleted),
      },
      error: null,
    };
  } catch (error: unknown) {
    return {
      profile: null,
      error: new Error(
        error instanceof Error
          ? error.message
          : "Unable to load profile right now.",
      ),
    };
  }
}

export async function isCurrentUserDeleted(): Promise<boolean> {
  try {
    const session = await waitForAuthReady();
    const userId = session?.user?.id;

    if (!userId) {
      return false;
    }

    if (session?.access_token.startsWith("ap_")) {
      return false;
    }

    const { data, error } = await withTimeout(
      supabase
        .from("users")
        .select("is_deleted")
        .eq("id", userId)
        .maybeSingle(),
      PROFILE_QUERY_TIMEOUT_MS,
      "users.is_deleted",
    );

    if (error || !data) {
      return false;
    }

    return Boolean(data.is_deleted);
  } catch {
    return false;
  }
}

export async function farmerExistsForPhone(phone: string): Promise<{
  exists: boolean;
  profile: UserProfile | null;
  error: Error | null;
}> {
  const { data, error } = await supabase
    .from("users")
    .select("name, state, district, language, phone, is_deleted")
    .eq("phone", phone)
    .maybeSingle();

  if (error) {
    if (isAuthSessionMissing(error)) {
      return { exists: false, profile: null, error: null };
    }
    return { exists: false, profile: null, error: new Error(error.message) };
  }

  if (data?.is_deleted) {
    return {
      exists: true,
      profile: {
        name: data.name || "",
        state: data.state || "",
        district: data.district || "",
        language: data.language || "English",
        phone: data.phone || "",
        isDeleted: true,
      },
      error: null,
    };
  }

  if (data?.name?.trim()) {
    return {
      exists: true,
      profile: {
        ...data,
        isDeleted: Boolean(data.is_deleted),
      },
      error: null,
    };
  }

  return { exists: false, profile: null, error: null };
}

export async function saveProfile(
  name: string,
  state: string,
  district: string,
  language: string,
  phone?: string,
) {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.id) {
    return {
      data: null,
      error: new Error("You must be signed in to update your profile."),
    };
  }

  return await supabase.from("users").upsert({
    id: user.id,
    phone: phone?.trim() || user.phone,
    name,
    state,
    district,
    language,
  });
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Trimmed, lower-cased form used for comparison and for Supabase Auth. */
export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string) {
  return EMAIL_PATTERN.test(normalizeEmail(email));
}

/**
 * none = no email on the account; verified = confirmed email; unverified =
 * email present but not confirmed; pending = a change awaits confirmation.
 */
export type EmailStatus = "none" | "verified" | "unverified" | "pending";

export type AuthEmailState = {
  email: string;
  pendingEmail: string;
  status: EmailStatus;
};

function emailStateFromUser(user: User): AuthEmailState {
  const email = user.email ?? "";
  const pendingEmail = user.new_email ?? "";
  const status: EmailStatus = pendingEmail
    ? "pending"
    : !email
      ? "none"
      : user.email_confirmed_at
        ? "verified"
        : "unverified";
  return { email, pendingEmail, status };
}

/** Readable message for Supabase Auth email errors (raw errors are only logged). */
export function friendlyEmailError(error: unknown): string {
  const record = (error ?? {}) as { message?: unknown; code?: unknown; status?: unknown };
  const message = String(record.message ?? error ?? "").toLowerCase();
  const code = String(record.code ?? "").toLowerCase();
  const status = Number(record.status);
  console.warn("[profile] email update error:", code || status || "unknown", record.message ?? "");

  if (code === "email_exists" || code === "user_already_exists" || /already (been )?registered|already exists|already in use/.test(message)) {
    return "This email address is already associated with another account.";
  }
  if (code === "email_address_invalid" || code === "validation_failed" || /invalid.*email|unable to validate email|email address.*invalid/.test(message)) {
    return "Please enter a valid email address, for example farmer@example.com.";
  }
  // Per-address cooldown: "For security purposes, you can only request this after 42 seconds."
  const waitSeconds = message.match(/after (\d+) seconds?/)?.[1];
  if (waitSeconds || code === "over_request_rate_limit" || /security purposes/.test(message)) {
    return waitSeconds
      ? `Please wait ${waitSeconds} seconds before requesting another code.`
      : "Please wait a minute before requesting another code.";
  }
  // Project-wide email quota (Supabase's built-in sender allows only a few emails per hour).
  if (code === "over_email_send_rate_limit" || /email rate limit/.test(message)) {
    return "Email sending limit reached for now. Please try again in about an hour, or log in with your phone number.";
  }
  if (code.includes("rate_limit") || status === 429 || /rate limit|too many/.test(message)) {
    return "Too many email requests. Please wait a few minutes and try again.";
  }
  if (code === "otp_expired" || /expired/.test(message)) {
    return "The verification link has expired. Please request a new verification email.";
  }
  if (code === "email_provider_disabled" || /email.*(disabled|not enabled)|signups? not allowed/.test(message)) {
    return "Email can't be added to this account right now. Please try again later.";
  }
  if (code === "session_not_found" || code === "bad_jwt" || status === 401 || /session|jwt|not authenticated|auth session missing/.test(message)) {
    return "Your session has expired. Please log in again and retry.";
  }
  if (/fetch|network|timed out|timeout|offline/.test(message)) {
    return "Network problem. Please check your internet connection and try again.";
  }
  return "Unable to send the verification code. Please try again.";
}

/** Latest email state from the Auth server (not a cached session). */
export async function getCurrentUserEmailState(): Promise<{
  state: AuthEmailState | null;
  error: string | null;
}> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    return { state: null, error: error ? friendlyEmailError(error) : null };
  }
  return { state: emailStateFromUser(data.user), error: null };
}

const EMAIL_CHANGE_STORAGE_KEY = "ask-prana-email-change-otp";
let pendingEmailChange: { email: string; reqId: string } | null = null;

function readPendingEmailChange(): { email: string; reqId: string } | null {
  if (typeof sessionStorage === "undefined") return pendingEmailChange;
  try {
    const raw = sessionStorage.getItem(EMAIL_CHANGE_STORAGE_KEY);
    if (!raw) return pendingEmailChange;
    const parsed = JSON.parse(raw) as { email?: unknown; reqId?: unknown };
    if (typeof parsed.email === "string" && typeof parsed.reqId === "string") {
      pendingEmailChange = { email: parsed.email, reqId: parsed.reqId };
    }
  } catch {
    // Ignore a corrupt saved request and send a new code.
  }
  return pendingEmailChange;
}

function writePendingEmailChange(value: { email: string; reqId: string } | null) {
  pendingEmailChange = value;
  if (typeof sessionStorage === "undefined") return;
  try {
    if (value) sessionStorage.setItem(EMAIL_CHANGE_STORAGE_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(EMAIL_CHANGE_STORAGE_KEY);
  } catch {
    // Private mode can block storage; the in-memory request still works.
  }
}

/**
 * Sends an MSG91 code to the new address. The address is written onto the
 * signed-in account only after that code is verified, so Supabase does not
 * email a confirmation.
 */
export async function requestCurrentUserEmailChange(email: string): Promise<{
  state: AuthEmailState | null;
  error: string | null;
}> {
  const normalized = normalizeEmail(email);
  const current = await getCurrentUserEmailState();
  if (!current.state && current.error) return { state: null, error: current.error };
  if (current.state?.status === "verified" && normalizeEmail(current.state.email) === normalized) {
    return { state: current.state, error: null };
  }
  try {
    const pending = readPendingEmailChange();
    const sent = await sendMsg91EmailOtp(
      normalized,
      pending?.email === normalized ? pending.reqId : undefined,
    );
    writePendingEmailChange({ email: normalized, reqId: sent.reqId });
    return {
      state: {
        email: current.state?.email ?? "",
        pendingEmail: normalized,
        status: "pending",
      },
      error: null,
    };
  } catch (error) {
    return {
      state: null,
      error: error instanceof Error ? error.message : "Unable to send the verification code. Please try again.",
    };
  }
}

/** Re-sends the MSG91 code for a pending email change. */
export async function resendEmailChangeVerification(pendingEmail: string): Promise<{
  error: string | null;
}> {
  const normalized = normalizeEmail(pendingEmail);
  try {
    const pending = readPendingEmailChange();
    const sent = await sendMsg91EmailOtp(
      normalized,
      pending?.email === normalized ? pending.reqId : undefined,
    );
    writePendingEmailChange({ email: normalized, reqId: sent.reqId });
    return { error: null };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Unable to send the verification code. Please try again.",
    };
  }
}

/** Digits in the MSG91 widget code used for email login and email changes. */
export const EMAIL_OTP_LENGTH = 6;

/**
 * Confirms an email change for the CURRENT signed-in user with the MSG91 code.
 * The session stays the same user, so no second account is created.
 */
export async function verifyEmailChangeCode(email: string, code: string): Promise<{
  state: AuthEmailState | null;
  error: string | null;
}> {
  const normalized = normalizeEmail(email);
  const pending = readPendingEmailChange();
  const reqId = pending?.email === normalized ? pending.reqId : "";
  if (!reqId) return { state: null, error: "Please request a new code." };

  const { data, error } = await supabase.functions.invoke("msg91-auth", {
    body: { action: "link-email", email: normalized, otp: code.trim(), reqId },
  });
  if (error || data?.email_confirmed !== true) {
    return {
      state: null,
      error: await readFunctionError(error, "Unable to verify the code. Please try again."),
    };
  }
  writePendingEmailChange(null);
  const refreshed = await getCurrentUserEmailState();
  if (refreshed.state && normalizeEmail(refreshed.state.email) === normalized) {
    return { state: refreshed.state, error: null };
  }
  return { state: { email: normalized, pendingEmail: "", status: "verified" }, error: null };
}

/** Masks an email for display, e.g. v****@gmail.com. */
export function maskEmail(email: string) {
  const [local, domain] = normalizeEmail(email).split("@");
  if (!local || !domain) return email;
  return `${local[0]}${"*".repeat(Math.max(3, local.length - 1))}@${domain}`;
}

// ---------------------------------------------------------------------------
// Email login / registration (MSG91 code, same account rules as phone)
// ---------------------------------------------------------------------------

const EMAIL_OTP_STORAGE_KEY = "ask-prana-email-otp";
let pendingEmailOtp: { email: string; reqId: string; otpBind?: string } | null = null;
let emailVerifyInflight: {
  key: string;
  task: Promise<{ userId: string | null; isNewUser: boolean; error: string | null; cause: unknown }>;
} | null = null;

function readPendingEmailOtp(): { email: string; reqId: string; otpBind?: string } | null {
  if (typeof sessionStorage === "undefined") return pendingEmailOtp;
  try {
    const raw = sessionStorage.getItem(EMAIL_OTP_STORAGE_KEY);
    if (!raw) return pendingEmailOtp;
    const parsed = JSON.parse(raw) as { email?: unknown; reqId?: unknown; otpBind?: unknown };
    if (typeof parsed.email === "string" && typeof parsed.reqId === "string") {
      pendingEmailOtp = {
        email: parsed.email,
        reqId: parsed.reqId,
        otpBind: typeof parsed.otpBind === "string" ? parsed.otpBind : undefined,
      };
    }
  } catch {
    // Ignore a corrupt saved request and send a new code.
  }
  return pendingEmailOtp;
}

function writePendingEmailOtp(value: { email: string; reqId: string; otpBind?: string } | null) {
  pendingEmailOtp = value;
  if (typeof sessionStorage === "undefined") return;
  try {
    if (value) sessionStorage.setItem(EMAIL_OTP_STORAGE_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(EMAIL_OTP_STORAGE_KEY);
  } catch {
    // Private mode can block storage; the in-memory request still works.
  }
}

/**
 * Sends a login/registration code through MSG91. Supabase does not email
 * this code. An existing address signs in and a new address gets an account
 * only after the code is verified.
 */
export async function sendEmailLoginCode(email: string): Promise<{
  error: string | null;
  cause: unknown;
}> {
  const normalized = normalizeEmail(email);
  try {
    const pending = readPendingEmailOtp();
    const sent = await sendMsg91EmailOtp(
      normalized,
      pending?.email === normalized ? pending.reqId : undefined,
    );
    writePendingEmailOtp({ email: normalized, reqId: sent.reqId, otpBind: sent.otpBind });
    return { error: null, cause: null };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Unable to send the login code. Please try again.",
      cause: error,
    };
  }
}

/** Verifies the MSG91 email code. The server decides whether the account exists. */
export async function verifyEmailLoginCode(email: string, code: string): Promise<{
  userId: string | null;
  isNewUser: boolean;
  error: string | null;
  cause: unknown;
}> {
  const normalized = normalizeEmail(email);
  const pending = readPendingEmailOtp();
  const reqId = pending?.email === normalized ? pending.reqId : "";
  if (!reqId) {
    return { userId: null, isNewUser: false, error: "Please request a new code.", cause: null };
  }

  const key = `${normalized}\n${code.trim()}\n${reqId}`;
  if (emailVerifyInflight?.key === key) return emailVerifyInflight.task;
  const task = verifyEmailLoginOnce(normalized, code.trim(), reqId, pending?.otpBind);
  emailVerifyInflight = { key, task };
  try {
    return await task;
  } finally {
    if (emailVerifyInflight?.task === task) emailVerifyInflight = null;
  }
}

async function verifyEmailLoginOnce(
  normalized: string,
  code: string,
  reqId: string,
  otpBind: string | undefined,
): Promise<{
  userId: string | null;
  isNewUser: boolean;
  error: string | null;
  cause: unknown;
}> {
  try {
    const result = await completeVerifiedLogin({ reqId, otp: code, otpBind }, { email: normalized });
    if (result.error) {
      return { userId: null, isNewUser: false, error: result.error.message, cause: result.error };
    }
    writePendingEmailOtp(null);
    return { userId: result.user?.id ?? null, isNewUser: result.isNewUser, error: null, cause: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to verify the code. Please try again.";
    return { userId: null, isNewUser: false, error: message, cause: error };
  }
}

/**
 * Reads the signed-in profile. It never inserts a users row. A new account is
 * created only by the registration request after MSG91 verification.
 */
export async function ensureCurrentUserProfile(): Promise<{
  profile: UserProfile | null;
  error: Error | null;
}> {
  const session = await waitForAuthReady();
  if (!session?.user) return { profile: null, error: new Error("You must be signed in.") };
  return await getCurrentUserProfile();
}

export async function registerAskPranaAccount(input: {
  name: string;
  state: string;
  district: string;
  language: string;
  phone?: string;
  email?: string;
}): Promise<{ error: string | null }> {
  const pending = await loadPendingRegistration();
  if (!pending) return { error: "Please verify your code again." };
  const { data, error } = await supabase.functions.invoke("msg91-auth", {
    body: {
      action: "register",
      registrationToken: pending.registrationToken,
      name: input.name,
      state: input.state,
      district: input.district,
      language: input.language,
      phone: input.phone,
      email: input.email,
    },
  });
  if (error || data?.success !== true || !data.user?.id || !data.session?.token) {
    return { error: await readFunctionError(error, data?.error ?? "Unable to create your account. Please try again.") };
  }
  const appSession = await saveAppSession({
    token: data.session.token,
    expiresAt: data.session.expiresAt,
    user: data.user,
  });
  acceptAuthenticatedSession(appSession);
  return { error: null };
}

export async function updateCurrentUserProfile(input: {
  name: string;
  phone?: string;
  email?: string;
  state: string;
  district: string;
  language: string;
}): Promise<{ error: Error | null }> {
  const appSession = await loadAppSession();
  if (appSession?.access_token.startsWith("ap_")) {
    const { data, error } = await supabase.functions.invoke("msg91-auth", {
      body: { action: "update-profile", ...input },
      headers: { Authorization: `Bearer ${appSession.access_token}` },
    });
    if (error || data?.success !== true) {
      return { error: new Error(await readFunctionError(error, data?.error ?? "Unable to save your profile. Please try again.")) };
    }
    return { error: null };
  }

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user?.id) {
    return {
      error: userError ?? new Error("You must be signed in to update your profile."),
    };
  }

  const { data, error } = await supabase
    .from("users")
    .update({
      name: input.name,
      phone: input.phone?.trim() || user.phone || null,
      state: input.state,
      district: input.district,
      language: input.language,
    })
    .eq("id", user.id)
    .select("id")
    .maybeSingle();

  if (error) {
    return { error: new Error(error.message) };
  }

  if (!data) {
    // Row may not exist yet for some accounts — fall back to upsert.
    const upsertResult = await saveProfile(
      input.name,
      input.state,
      input.district,
      input.language,
      input.phone,
    );

    if (upsertResult.error) {
      return { error: new Error(upsertResult.error.message) };
    }
  }

  return { error: null };
}

export async function updateAppSessionAvatar(input: {
  imageBase64?: string;
  remove?: boolean;
}): Promise<{ avatarUrl: string | null; avatarUpdatedAt: string | null; error: Error | null }> {
  const appSession = await loadAppSession();
  if (!appSession?.access_token.startsWith("ap_")) {
    return {
      avatarUrl: null,
      avatarUpdatedAt: null,
      error: new Error("You must be signed in to update your profile photo."),
    };
  }
  const { data, error } = await supabase.functions.invoke("msg91-auth", {
    body: {
      action: "update-avatar",
      imageBase64: input.imageBase64,
      remove: input.remove === true,
    },
    headers: { Authorization: `Bearer ${appSession.access_token}` },
  });
  if (error || data?.success !== true) {
    return {
      avatarUrl: null,
      avatarUpdatedAt: null,
      error: new Error(await readFunctionError(error, data?.error ?? "Unable to update profile photo.")),
    };
  }
  const user = data.user as { avatar_url?: string | null; avatar_updated_at?: string | null } | undefined;
  return {
    avatarUrl: user?.avatar_url ?? null,
    avatarUpdatedAt: user?.avatar_updated_at ?? null,
    error: null,
  };
}

export async function updateCurrentUserAvatar(input: {
  avatarUrl: string | null;
  avatarUpdatedAt: string;
}): Promise<{ error: Error | null }> {
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user?.id) {
    return {
      error:
        userError ??
        new Error("You must be signed in to update your profile photo."),
    };
  }

  const { data, error } = await supabase
    .from("users")
    .update({
      avatar_url: input.avatarUrl,
      avatar_updated_at: input.avatarUpdatedAt,
    })
    .eq("id", user.id)
    .select("id")
    .maybeSingle();

  if (error) {
    return { error: new Error(error.message) };
  }

  if (!data) {
    return {
      error: new Error(
        "Unable to update profile photo. Your account profile was not found.",
      ),
    };
  }

  return { error: null };
}

export async function resolveFarmerDisplayName(sessionUser?: {
  user_metadata?: Record<string, unknown> | null;
  phone?: string | null;
} | null): Promise<string> {
  const [remoteResult, localProfile] = await Promise.all([
    getCurrentUserProfile(),
    getFarmerProfile(),
  ]);

  const metadataName =
    typeof sessionUser?.user_metadata?.name === "string"
      ? sessionUser.user_metadata.name.trim()
      : "";

  return (
    remoteResult.profile?.name?.trim() ||
    localProfile?.name?.trim() ||
    metadataName ||
    "Farmer"
  );
}
