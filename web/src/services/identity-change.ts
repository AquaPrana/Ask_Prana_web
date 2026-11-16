/**
 * Adding or changing the signed-in user's mobile number or email.
 *
 * The server only links a new phone/email to an account after the user proves
 * they own it, so this is a two-step flow:
 * 1. requestIdentityChangeCode: MSG91 sends a code to the NEW phone/email.
 * 2. confirmIdentityChange: the code (with the server's reqId + otpBind) is
 *    sent to msg91-auth "link-phone" / "link-email", which checks it and saves.
 */
import { supabase, acceptAuthenticatedSession } from "../lib/supabase";
import { readFunctionError } from "./auth";
import { loadAppSession, saveAppSession, type AppAccount } from "./app-session";
import { sendMsg91EmailOtp, sendMsg91Otp } from "./msg91";

export type IdentityKind = "phone" | "email";

type PendingChange = { kind: IdentityKind; value: string; reqId: string; otpBind?: string };

const STORAGE_KEY = "ask-prana-identity-change-otp";
let pendingChange: PendingChange | null = null;

function normalize(kind: IdentityKind, value: string): string {
  return kind === "email" ? value.trim().toLowerCase() : value.replace(/\D/g, "").slice(-10);
}

function readPending(): PendingChange | null {
  if (typeof sessionStorage === "undefined") return pendingChange;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return pendingChange;
    const parsed = JSON.parse(raw) as Partial<PendingChange>;
    if ((parsed.kind === "phone" || parsed.kind === "email") && typeof parsed.value === "string" && typeof parsed.reqId === "string") {
      pendingChange = {
        kind: parsed.kind,
        value: parsed.value,
        reqId: parsed.reqId,
        otpBind: typeof parsed.otpBind === "string" ? parsed.otpBind : undefined,
      };
    }
  } catch {
    // A corrupt saved request just means a fresh code is sent.
  }
  return pendingChange;
}

function writePending(value: PendingChange | null) {
  pendingChange = value;
  if (typeof sessionStorage === "undefined") return;
  try {
    if (value) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode can block storage; the in-memory request still works.
  }
}

/** Sends (or re-sends) a code to the new phone/email. */
export async function requestIdentityChangeCode(kind: IdentityKind, value: string): Promise<{ error: string | null }> {
  const normalized = normalize(kind, value);
  if (!normalized) return { error: kind === "phone" ? "Please enter a valid mobile number." : "Please enter a valid email address." };
  const pending = readPending();
  const resend = pending && pending.kind === kind && pending.value === normalized ? pending : null;
  try {
    const sent = kind === "phone"
      ? await sendMsg91Otp(normalized, "web", resend?.reqId, resend?.otpBind)
      : await sendMsg91EmailOtp(normalized, resend?.reqId, resend?.otpBind);
    writePending({ kind, value: normalized, reqId: sent.reqId, otpBind: sent.otpBind });
    return { error: null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Unable to send the code. Please try again." };
  }
}

/** Checks the code and saves the new phone/email on the signed-in account. */
export async function confirmIdentityChange(
  kind: IdentityKind,
  value: string,
  otp: string,
): Promise<{ user: AppAccount | null; error: string | null }> {
  const normalized = normalize(kind, value);
  const pending = readPending();
  if (!pending || pending.kind !== kind || pending.value !== normalized) {
    return { user: null, error: "Please request a new code." };
  }
  const session = await loadAppSession();
  if (!session?.access_token.startsWith("ap_")) {
    return { user: null, error: "Your session has expired. Please log in again." };
  }
  const { data, error } = await supabase.functions.invoke("msg91-auth", {
    body: {
      action: kind === "phone" ? "link-phone" : "link-email",
      [kind]: normalized,
      reqId: pending.reqId,
      otp: otp.trim(),
      otpBind: pending.otpBind,
    },
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  if (error || data?.success !== true || !data?.user) {
    return { user: null, error: await readFunctionError(error, data?.error ?? "Unable to verify the code. Please try again.") };
  }
  writePending(null);
  // Keep the stored session's account details in step with the server.
  const user = data.user as AppAccount;
  const updated = await saveAppSession({
    token: session.access_token,
    expiresAt: new Date((session.expires_at ?? 0) * 1000).toISOString(),
    user,
  });
  acceptAuthenticatedSession(updated);
  return { user, error: null };
}
