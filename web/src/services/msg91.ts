import { supabase } from "../lib/supabase";

export function toMsg91Mobile(phone: string): string | null {
  const trimmed = phone.trim();
  let digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) {
    if (!digits.startsWith("91")) return null;
    digits = digits.slice(2);
  } else if (digits.startsWith("91") && digits.length === 12) {
    digits = digits.slice(2);
  } else if (digits.startsWith("0") && digits.length === 11) {
    digits = digits.slice(1);
  }
  return /^[6-9]\d{9}$/.test(digits) ? `91${digits}` : null;
}

async function authError(error: unknown, data: { error?: unknown } | null, fallback: string): Promise<string> {
  if (typeof data?.error === "string" && data.error.trim()) return data.error.trim();
  const context = (error as { context?: { json?: () => Promise<unknown> } } | null)?.context;
  if (context && typeof context.json === "function") {
    try {
      const body = (await context.json()) as { error?: unknown };
      if (typeof body?.error === "string" && body.error.trim()) return body.error.trim();
    } catch {
      // The response body can only be read once.
    }
  }
  return fallback;
}

async function requestAuth(body: Record<string, unknown>, fallback: string): Promise<{ reqId: string; otpBind?: string }> {
  const { data, error } = await supabase.functions.invoke("msg91-auth", { body });
  const payload = data as { success?: boolean; reqId?: unknown; otpBind?: unknown; error?: unknown } | null;
  if (error || payload?.success !== true || typeof payload.reqId !== "string") {
    throw new Error(await authError(error, payload, fallback));
  }
  return {
    reqId: payload.reqId,
    otpBind: typeof payload.otpBind === "string" ? payload.otpBind : undefined,
  };
}

export async function sendMsg91Otp(
  phone: string,
  _platform: "web" | "mobile",
  reqId?: string,
): Promise<{ reqId: string }> {
  if (!toMsg91Mobile(phone)) throw new Error("Please enter a valid 10-digit mobile number.");
  return await requestAuth(
    { action: "send-otp", phone, reqId },
    "MSG91 could not send the code.",
  );
}

export async function sendMsg91EmailOtp(email: string, reqId?: string): Promise<{ reqId: string; otpBind?: string }> {
  const identifier = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier)) {
    throw new Error("Please enter a valid email address.");
  }
  return await requestAuth(
    { action: "send-otp", email: identifier, reqId },
    "MSG91 could not send the code.",
  );
}
