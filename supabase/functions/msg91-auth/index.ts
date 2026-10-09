import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const WIDGET_API = "https://control.msg91.com/api/v5/widget";
const SESSION_DAYS = 30;
const REGISTRATION_MINUTES = 15;

const USER_SELECT =
  "id, phone, email, name, state, district, language, is_deleted, avatar_url, avatar_updated_at";

type UserRow = {
  id: string;
  phone: string | null;
  email: string | null;
  name: string | null;
  state: string | null;
  district: string | null;
  language: string | null;
  is_deleted: boolean;
  avatar_url: string | null;
  avatar_updated_at: string | null;
};

type VerifiedIdentity = { phone: string | null; email: string | null };

function response(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function envValue(name: string): string {
  return (Deno.env.get(name) ?? "").trim().replace(/^["']+|["']+$/g, "");
}

function widgetId(): string {
  return envValue("MSG91_WIDGET_ID");
}

function authkey(): string {
  return envValue("MSG91_AUTHKEY");
}

function adminClient(): SupabaseClient | null {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() ?? "";
  const serviceKey = (
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    Deno.env.get("SERVICE_ROLE_KEY") ??
    ""
  ).trim();
  if (!supabaseUrl || !serviceKey) return null;
  return createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function serviceSecret(): string {
  return (
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    Deno.env.get("SERVICE_ROLE_KEY") ??
    ""
  ).trim();
}

/** Same rules as public.ask_prana_phone_canonical. */
function canonicalPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, "");
  const plus = trimmed.startsWith("+");
  if (plus && /^91[6-9]\d{9}$/.test(digits)) return `+${digits}`;
  if (/^0[6-9]\d{9}$/.test(digits)) return `+91${digits.slice(1)}`;
  if (/^[6-9]\d{9}$/.test(digits)) return `+91${digits}`;
  if (/^91[6-9]\d{9}$/.test(digits)) return `+${digits}`;
  if (plus && /^[1-9]\d{7,14}$/.test(digits)) return `+${digits}`;
  return null;
}

function canonicalEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const email = raw.trim().toLowerCase();
  if (!email) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function phoneVariants(canonical: string): string[] {
  const digits = canonical.replace(/\D/g, "");
  const local = digits.startsWith("91") && digits.length === 12 ? digits.slice(2) : digits;
  return Array.from(new Set([canonical, `+${digits}`, digits, local, `0${local}`]));
}

function samePhone(stored: string | null | undefined, canonical: string | null): boolean {
  if (!canonical || !stored?.trim()) return false;
  if (stored === canonical || phoneVariants(canonical).includes(stored)) return true;
  return canonicalPhone(stored) === canonical;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(digest);
}

async function hmacKey() {
  const secret = await sha256Hex(serviceSecret());
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signPayload(payload: Record<string, unknown>): Promise<string> {
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey();
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function readSignedPayload(token: string): Promise<Record<string, unknown> | null> {
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const sigBytes = base64UrlDecode(signature);
  if (!sigBytes) return null;
  const key = await hmacKey();
  const valid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(body));
  if (!valid) return null;
  const payloadBytes = base64UrlDecode(body);
  if (!payloadBytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(payloadBytes)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function signRegistration(identity: VerifiedIdentity): Promise<string> {
  const payload = {
    purpose: "register",
    phone: identity.phone,
    email: identity.email,
    exp: Date.now() + REGISTRATION_MINUTES * 60 * 1000,
  };
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey();
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function signOtpBind(reqId: string, identity: VerifiedIdentity): Promise<string> {
  return await signPayload({
    purpose: "otp",
    reqId,
    phone: identity.phone,
    email: identity.email,
    exp: Date.now() + REGISTRATION_MINUTES * 60 * 1000,
  });
}

async function readOtpBind(token: string): Promise<{ reqId: string; phone: string | null; email: string | null } | null> {
  const payload = await readSignedPayload(token);
  if (!payload || payload.purpose !== "otp") return null;
  if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
  if (typeof payload.reqId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(payload.reqId)) return null;
  const phone = typeof payload.phone === "string" ? canonicalPhone(payload.phone) : null;
  const email = typeof payload.email === "string" ? canonicalEmail(payload.email) : null;
  if (!phone && !email) return null;
  return { reqId: payload.reqId, phone, email };
}

async function readRegistration(token: string): Promise<VerifiedIdentity | null> {
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const sigBytes = base64UrlDecode(signature);
  if (!sigBytes) return null;
  const key = await hmacKey();
  const valid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(body));
  if (!valid) return null;
  const payloadBytes = base64UrlDecode(body);
  if (!payloadBytes) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as {
      purpose?: unknown;
      phone?: unknown;
      email?: unknown;
      exp?: unknown;
    };
    if (payload.purpose !== "register") return null;
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    const phone = typeof payload.phone === "string" ? canonicalPhone(payload.phone) : null;
    const email = typeof payload.email === "string" ? canonicalEmail(payload.email) : null;
    if (!phone && !email) return null;
    return { phone, email };
  } catch {
    return null;
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  const bytes = base64UrlDecode(part);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function emailInText(value: string): string | null {
  const match = value.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return match ? canonicalEmail(match[0]) : null;
}

function identityFromUnknown(value: unknown, depth = 0): VerifiedIdentity {
  const found: VerifiedIdentity = { phone: null, email: null };
  if (depth > 5 || value == null) return found;
  if (typeof value === "string") {
    const email = emailInText(value);
    const phone = canonicalPhone(value);
    if (email) found.email = email;
    else if (phone) found.phone = phone;
    return found;
  }
  if (typeof value !== "object") return found;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (typeof nested === "string" && /email/i.test(key)) {
      found.email = emailInText(nested) ?? found.email;
    } else if (typeof nested === "string" && /identifier|mobile|phone/i.test(key)) {
      if (nested.includes("@")) found.email = emailInText(nested) ?? found.email;
      else found.phone = canonicalPhone(nested) ?? found.phone;
    } else if (typeof nested === "string" && key.toLowerCase() === "message") {
      const trimmed = nested.trim();
      const looksLikeJwt = trimmed.split(".").length === 3 && trimmed.length > 20;
      if (!looksLikeJwt && trimmed.includes("@")) found.email = emailInText(trimmed) ?? found.email;
      else if (!looksLikeJwt) found.phone = canonicalPhone(trimmed) ?? found.phone;
    } else if (nested && typeof nested === "object") {
      const inner = identityFromUnknown(nested, depth + 1);
      found.phone = found.phone ?? inner.phone;
      found.email = found.email ?? inner.email;
    }
  }
  return found;
}

function isMsg91Success(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const record = body as { type?: unknown; status?: unknown };
  return String(record.type ?? record.status ?? "").toLowerCase() === "success";
}

function msg91Meta(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as { type?: unknown; code?: unknown; status?: unknown };
  return `${record.type ?? ""}:${record.code ?? ""}:${record.status ?? ""}`;
}

function findJwt(value: unknown): string {
  const queue: unknown[] = [value];
  const jwt = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
  while (queue.length) {
    const current = queue.shift();
    if (typeof current === "string") {
      const match = current.match(jwt);
      if (match) return match[0];
      continue;
    }
    if (current && typeof current === "object") queue.push(...Object.values(current as Record<string, unknown>));
  }
  return "";
}

function tokenStillValid(payload: Record<string, unknown> | null): boolean {
  const exp = Number(payload?.exp);
  if (!payload || !Number.isFinite(exp)) return true;
  const expiresAt = exp > 1e12 ? exp : exp * 1000;
  return expiresAt >= Date.now() - 30_000;
}

function widgetMatches(payload: Record<string, unknown> | null, widgetId: string): boolean {
  const tokenWidget = typeof payload?.widgetId === "string" ? payload.widgetId.trim() : "";
  return !tokenWidget || tokenWidget === widgetId;
}

function mergeIdentity(primary: VerifiedIdentity, extra: VerifiedIdentity): VerifiedIdentity {
  return {
    phone: primary.phone ?? extra.phone,
    email: primary.email ?? extra.email,
  };
}

function identityFromAccessToken(accessToken: string, body: unknown, widgetId: string): VerifiedIdentity | null {
  const payload = decodeJwtPayload(accessToken);
  // MSG91's verifyAccessToken success body is the verified phone or email.
  // A widget-id or expiry claim must not discard that identifier.
  const fromBody = identityFromUnknown(body);
  if (fromBody.phone || fromBody.email) return fromBody;
  if (!tokenStillValid(payload) || !widgetMatches(payload, widgetId)) return null;
  const fromToken = identityFromUnknown(payload);
  if (!fromToken.phone && !fromToken.email) return null;
  return fromToken;
}

/** Confirms the widget JWT with MSG91. The widget token is not an authkey, so it is never sent as one. */
async function msg91Widget(path: string, payload: Record<string, unknown>): Promise<unknown> {
  const key = authkey();
  const id = widgetId();
  if (!key || !id) {
    return {
      type: "error",
      message: !key
        ? "OTP service is not configured. The MSG91 authkey is missing."
        : "OTP service is not configured. The MSG91 widget id is missing.",
    };
  }
  const result = await fetch(`${WIDGET_API}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      authkey: key,
    },
    body: JSON.stringify({ widgetId: id, ...payload }),
  });
  return await result.json().catch(() => null);
}

async function verifyAccessToken(accessToken: string) {
  const body = await msg91Widget("/verifyAccessToken", { "access-token": accessToken });
  if (!isMsg91Success(body)) {
    console.warn("[msg91-auth] verifyAccessToken rejected", msg91Meta(body));
    return null;
  }
  const identity = identityFromAccessToken(accessToken, body, widgetId());
  if (identity) return identity;
  console.warn("[msg91-auth] access token had no identifier", msg91Meta(body));
  return null;
}

function msg91Message(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const message = (body as { message?: unknown }).message;
  return typeof message === "string" ? message.trim() : "";
}

function msg91FailureText(body: unknown): string {
  const message = msg91Message(body);
  return `${message} ${JSON.stringify(body ?? "")}`.toLowerCase();
}

function textSaysAlreadyVerified(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[_-]+/g, " ");
  return /already\s*verified/.test(normalized) || /verified\s*already/.test(normalized);
}

function otpAlreadyVerified(body: unknown): boolean {
  return textSaysAlreadyVerified(msg91FailureText(body));
}

function otpFailure(body: unknown, fallback: string): { error: string; code?: string } {
  const message = msg91Message(body);
  const text = msg91FailureText(body);
  if (/authkey is missing|widget id is missing/.test(text)) {
    return { error: message, code: "missing_authkey" };
  }
  if (/ipblocked|ip blocked/.test(text)) {
    return { error: message || "MSG91 blocked this request (IPBlocked).", code: "ip_blocked" };
  }
  if (/authenticationfailure|authentication failure/.test(text)) {
    return { error: message || "MSG91 rejected the OTP request (AuthenticationFailure).", code: "auth_rejected" };
  }
  if (/expired|already used/.test(text)) {
    return { error: "This OTP has expired. Please request a new OTP.", code: "otp_expired" };
  }
  if (/wrong otp|otp invalid|invalid otp|not match|incorrect otp|does not match/.test(text)) {
    return { error: "Incorrect OTP. Please check the code and try again.", code: "otp_mismatch" };
  }
  if (textSaysAlreadyVerified(text)) {
    return { error: "This OTP has expired. Please request a new OTP.", code: "already_verified" };
  }
  if (message && message.length < 180 && !/eyJ|authkey|tokenauth/i.test(message)) {
    return { error: message };
  }
  return { error: fallback };
}

function requestIdFrom(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  for (const key of ["message", "request_id", "requestId", "reqId"]) {
    const value = record[key];
    if (typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value.trim())) return value.trim();
  }
  return "";
}

/**
 * Checks the code with MSG91 from this function. The identifier comes from
 * MSG91's response, not from the phone or email the app claims.
 */
async function verifyOtpWithMsg91(
  reqId: string,
  otp: string,
): Promise<{ identity: VerifiedIdentity | null; error: string | null; code?: string }> {
  const body = await msg91Widget("/verifyOtp", { reqId, otp });
  if (!isMsg91Success(body) || otpAlreadyVerified(body)) {
    if (otpAlreadyVerified(body)) {
      return { identity: null, error: null, code: "already_verified" };
    }
    console.warn("[msg91-auth] verifyOtp rejected", msg91Meta(body));
    const failure = otpFailure(body, "MSG91 could not verify the code.");
    if (failure.code === "already_verified" || textSaysAlreadyVerified(failure.error)) {
      return { identity: null, error: null, code: "already_verified" };
    }
    return { identity: null, error: failure.error, code: failure.code ?? "otp_rejected" };
  }
  const jwt = findJwt(body);
  const payload = jwt ? decodeJwtPayload(jwt) : null;
  let identity = mergeIdentity(identityFromUnknown(body), identityFromUnknown(payload));
  if (jwt) {
    const confirmed = await verifyAccessToken(jwt);
    if (confirmed) identity = mergeIdentity(confirmed, identity);
  }
  if (!identity.phone && !identity.email) {
    const reason = payload && !widgetMatches(payload, widgetId()) ? "widget_mismatch" : "no_identifier";
    console.warn("[msg91-auth] verified otp had no identifier", msg91Meta(body), reason);
    return { identity: null, error: null, code: "verified_no_identifier" };
  }
  return { identity, error: null };
}

function publicUser(row: UserRow) {
  return {
    id: row.id,
    phone: row.phone,
    email: row.email,
    name: row.name ?? "",
    state: row.state ?? "",
    district: row.district ?? "",
    language: row.language ?? "English",
    avatar_url: row.avatar_url ?? null,
    avatar_updated_at: row.avatar_updated_at ?? null,
  };
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function avatarStoragePath(avatarUrl: string | null | undefined, userId: string): string | null {
  const url = avatarUrl?.trim();
  if (!url) return null;
  const marker = "/object/public/profile-photos/";
  const index = url.indexOf(marker);
  if (index < 0) return null;
  const path = decodeURIComponent(url.slice(index + marker.length).split("?")[0] ?? "");
  if (!path.startsWith(`${userId}/`)) return null;
  return path;
}

async function findUsers(admin: SupabaseClient, identity: VerifiedIdentity): Promise<UserRow[]> {
  const matches = new Map<string, UserRow>();
  const add = (rows: UserRow[] | null) => {
    for (const row of rows ?? []) matches.set(row.id, row);
  };
  if (identity.phone) {
    const variants = phoneVariants(identity.phone);
    const { data, error } = await admin.from("users").select(USER_SELECT).in("phone", variants);
    if (error) throw new Error(error.message);
    add((data ?? []) as UserRow[]);
    const local = variants.find((value) => /^[6-9]\d{9}$/.test(value));
    if (local) {
      const { data: loose, error: looseError } = await admin
        .from("users")
        .select(USER_SELECT)
        .ilike("phone", `%${local}%`);
      if (looseError) throw new Error(looseError.message);
      add(((loose ?? []) as UserRow[]).filter((row) => samePhone(row.phone, identity.phone)));
    }
  }
  if (identity.email) {
    const { data, error } = await admin.from("users").select(USER_SELECT).ilike("email", identity.email);
    if (error) throw new Error(error.message);
    add(((data ?? []) as UserRow[]).filter((row) => canonicalEmail(row.email) === identity.email));
  }
  return [...matches.values()];
}

/** One row for every stored form of the same phone or email. */
function chooseExisting(rows: UserRow[], _identity: VerifiedIdentity): UserRow | null {
  void _identity;
  const active = rows.filter((row) => !row.is_deleted);
  const pool = active.length ? active : rows;
  if (!pool.length) return null;
  return pool.slice().sort((a, b) => a.id.localeCompare(b.id))[0];
}

async function issueSession(admin: SupabaseClient, user: UserRow) {
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token = `ap_${bytesToHex(tokenBytes.buffer)}`;
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await admin.from("user_sessions").insert({
    user_id: user.id,
    token_hash: await sha256Hex(token),
    expires_at: expiresAt,
  });
  if (error) {
    console.warn("[msg91-auth] session insert failed:", error.code ?? "");
    return null;
  }
  return { token, expiresAt };
}

function claimedMismatch(input: { phone?: unknown; email?: unknown }, identity: VerifiedIdentity): boolean {
  if (typeof input.phone === "string" && input.phone.trim()) {
    const claimed = canonicalPhone(input.phone);
    if (!claimed || claimed !== identity.phone) return true;
  }
  if (typeof input.email === "string" && input.email.trim()) {
    const claimed = canonicalEmail(input.email);
    if (!claimed || claimed !== identity.email) return true;
  }
  return false;
}

function duplicateMessage(phoneTaken: boolean, emailTaken: boolean): string {
  if (phoneTaken && emailTaken) return "An account already exists with these details. Please log in using OTP.";
  if (phoneTaken) return "This phone number is already registered. Please log in using OTP.";
  return "This email is already registered. Please log in using OTP.";
}

function constraintMessage(error: { message?: string; code?: string } | null): string | null {
  if (error?.code !== "23505") return null;
  const text = `${error.message ?? ""}`.toLowerCase();
  const phoneTaken = /phone/.test(text);
  const emailTaken = /email/.test(text);
  if (phoneTaken && emailTaken) return duplicateMessage(true, true);
  if (phoneTaken) return duplicateMessage(true, false);
  if (emailTaken) return duplicateMessage(false, true);
  return "An account already exists with these details. Please log in using OTP.";
}

async function bearerUser(admin: SupabaseClient, req: Request): Promise<UserRow | null> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token.startsWith("ap_")) return null;
  const { data, error } = await admin
    .from("user_sessions")
    .select("user_id, expires_at, revoked_at")
    .eq("token_hash", await sha256Hex(token))
    .maybeSingle();
  if (error || !data || data.revoked_at) return null;
  if (new Date(String(data.expires_at)).getTime() <= Date.now()) return null;
  const { data: user, error: userError } = await admin
    .from("users")
    .select(USER_SELECT)
    .eq("id", data.user_id)
    .maybeSingle();
  if (userError || !user || user.is_deleted) return null;
  await admin
    .from("user_sessions")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("token_hash", await sha256Hex(token));
  return user as UserRow;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return response({ success: false, error: "Method not allowed." }, 405);

  const admin = adminClient();
  if (!admin || !serviceSecret()) {
    console.error("[msg91-auth] service role key missing");
    return response({ success: false, error: "Authentication service is unavailable." }, 503);
  }

  try {
    const input = await req.json().catch(() => null) as {
      action?: unknown;
      accessToken?: unknown;
      reqId?: unknown;
      otp?: unknown;
      otpBind?: unknown;
      registrationToken?: unknown;
      phone?: unknown;
      email?: unknown;
      name?: unknown;
      state?: unknown;
      district?: unknown;
      language?: unknown;
      imageBase64?: unknown;
      remove?: unknown;
      isNewUser?: unknown;
      verified?: unknown;
      otpVerified?: unknown;
    } | null;
    const action = typeof input?.action === "string" ? input.action : "";

    if (action === "send-otp") {
      const phone = typeof input?.phone === "string" ? canonicalPhone(input.phone) : null;
      const email = typeof input?.email === "string" ? canonicalEmail(input.email) : null;
      const identifier = phone ? phone.slice(1) : email;
      if (!identifier) return response({ success: false, error: "Please enter a valid email or mobile number." }, 400);
      const retryId = typeof input?.reqId === "string" ? input.reqId.trim() : "";
      if (/^[A-Za-z0-9_-]{8,128}$/.test(retryId)) {
        const retried = await msg91Widget("/retryOtp", { reqId: retryId });
        if (isMsg91Success(retried)) {
          const otpBind = await signOtpBind(retryId, { phone, email });
          return response({ success: true, reqId: retryId, otpBind });
        }
      }
      const body = await msg91Widget("/sendOtp", { identifier });
      if (!isMsg91Success(body)) {
        const failure = otpFailure(body, "MSG91 could not send the code.");
        const status = failure.code === "missing_authkey" ? 503 : failure.code === "ip_blocked" ? 403 : 400;
        return response({ success: false, error: failure.error, code: failure.code }, status);
      }
      const reqId = requestIdFrom(body);
      if (!reqId) return response({ success: false, error: "MSG91 did not return a request id." }, 502);
      const otpBind = await signOtpBind(reqId, { phone, email });
      return response({ success: true, reqId, otpBind });
    }
    // Frontend flags are ignored. Existence is decided only after MSG91 verification.
    void input?.isNewUser;
    void input?.verified;
    void input?.otpVerified;

    if (action === "logout") {
      const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
      if (token.startsWith("ap_")) {
        await admin
          .from("user_sessions")
          .update({ revoked_at: new Date().toISOString() })
          .eq("token_hash", await sha256Hex(token));
      }
      return response({ success: true });
    }

    if (action === "me" || action === "update-profile") {
      const user = await bearerUser(admin, req);
      if (!user) return response({ success: false, error: "Your session has expired. Please log in again." }, 401);
      if (action === "me") return response({ success: true, user: publicUser(user) });

      const name = typeof input?.name === "string" ? input.name.trim() : "";
      const state = typeof input?.state === "string" ? input.state.trim() : "";
      const district = typeof input?.district === "string" ? input.district.trim() : "";
      const language = typeof input?.language === "string" && input.language.trim()
        ? input.language.trim()
        : user.language ?? "English";
      if (!name || name.length > 80) return response({ success: false, error: "Please enter your full name." }, 400);

      let nextPhone = user.phone;
      let nextEmail = user.email;
      if (typeof input?.phone === "string") {
        const phone = input.phone.trim() ? canonicalPhone(input.phone) : null;
        if (input.phone.trim() && !phone) {
          return response({ success: false, error: "Please enter a valid mobile number." }, 400);
        }
        nextPhone = phone;
      }
      if (typeof input?.email === "string") {
        const email = input.email.trim() ? canonicalEmail(input.email) : null;
        if (input.email.trim() && !email) {
          return response({ success: false, error: "Please enter a valid email address." }, 400);
        }
        nextEmail = email;
      }
      if (!nextPhone && !nextEmail) {
        return response({ success: false, error: "An account needs an email or a phone number." }, 400);
      }

      const phoneChanged = canonicalPhone(user.phone) !== nextPhone && user.phone !== nextPhone;
      const emailChanged = canonicalEmail(user.email) !== nextEmail && (user.email ?? null) !== nextEmail;
      const phoneTaken = nextPhone && phoneChanged
        ? (await findUsers(admin, { phone: nextPhone, email: null })).some((row) => row.id !== user.id)
        : false;
      const emailTaken = nextEmail && emailChanged
        ? (await findUsers(admin, { phone: null, email: nextEmail })).some((row) => row.id !== user.id)
        : false;
      if (phoneTaken || emailTaken) {
        return response({ success: false, error: duplicateMessage(phoneTaken, emailTaken) }, 409);
      }

      const { data, error } = await admin
        .from("users")
        .update({ name, state, district, language, phone: nextPhone, email: nextEmail })
        .eq("id", user.id)
        .select(USER_SELECT)
        .maybeSingle();
      const conflict = constraintMessage(error);
      if (conflict) return response({ success: false, error: conflict }, 409);
      if (error || !data) return response({ success: false, error: "Unable to save your profile. Please try again." }, 500);
      return response({ success: true, user: publicUser(data as UserRow) });
    }

    if (action === "update-avatar") {
      const user = await bearerUser(admin, req);
      if (!user) return response({ success: false, error: "Your session has expired. Please log in again." }, 401);

      if (input?.remove === true) {
        const updatedAt = new Date().toISOString();
        const { data, error } = await admin
          .from("users")
          .update({ avatar_url: null, avatar_updated_at: updatedAt })
          .eq("id", user.id)
          .select(USER_SELECT)
          .maybeSingle();
        if (error || !data) return response({ success: false, error: "Unable to remove your profile photo. Please try again." }, 500);
        const path = avatarStoragePath(user.avatar_url, user.id);
        if (path) {
          const removed = await admin.storage.from("profile-photos").remove([path]);
          if (removed.error) console.warn("[msg91-auth] avatar delete failed");
        }
        return response({ success: true, user: publicUser(data as UserRow) });
      }

      const raw = typeof input?.imageBase64 === "string" ? input.imageBase64.trim() : "";
      const payload = raw.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "").replace(/\s/g, "");
      const bytes = payload ? decodeBase64(payload) : null;
      if (!bytes || bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
        return response({ success: false, error: "Please choose a JPEG image." }, 400);
      }
      if (bytes.length > 5 * 1024 * 1024) {
        return response({ success: false, error: "This photo is larger than the 5 MB limit. Please choose a smaller image." }, 400);
      }

      const path = `${user.id}/profile-${Date.now()}.jpg`;
      const uploaded = await admin.storage.from("profile-photos").upload(path, new Blob([bytes], { type: "image/jpeg" }), {
        contentType: "image/jpeg",
        upsert: false,
      });
      if (uploaded.error) {
        console.warn("[msg91-auth] avatar upload failed");
        return response({ success: false, error: "Unable to upload profile photo." }, 500);
      }

      const avatarUrl = admin.storage.from("profile-photos").getPublicUrl(path).data.publicUrl;
      const updatedAt = new Date().toISOString();
      const { data, error } = await admin
        .from("users")
        .update({ avatar_url: avatarUrl, avatar_updated_at: updatedAt })
        .eq("id", user.id)
        .select(USER_SELECT)
        .maybeSingle();
      if (error || !data) {
        await admin.storage.from("profile-photos").remove([path]);
        return response({ success: false, error: "Unable to save your profile photo. Please try again." }, 500);
      }
      const previous = avatarStoragePath(user.avatar_url, user.id);
      if (previous && previous !== path) await admin.storage.from("profile-photos").remove([previous]);
      return response({ success: true, user: publicUser(data as UserRow) });
    }

    if (action === "register") {
      const registrationToken = typeof input?.registrationToken === "string" ? input.registrationToken.trim() : "";
      const identity = await readRegistration(registrationToken);
      if (!identity) return response({ success: false, error: "Please verify your code again." }, 401);
      const name = typeof input?.name === "string" ? input.name.trim() : "";
      const state = typeof input?.state === "string" ? input.state.trim() : "";
      const district = typeof input?.district === "string" ? input.district.trim() : "";
      const language = typeof input?.language === "string" && input.language.trim() ? input.language.trim() : "English";
      if (!name || name.length > 80) return response({ success: false, error: "Please enter your full name." }, 400);

      let phone = identity.phone;
      let email = identity.email;
      if (!phone && typeof input?.phone === "string" && input.phone.trim()) {
        phone = canonicalPhone(input.phone);
        if (!phone) return response({ success: false, error: "Please enter a valid mobile number." }, 400);
      }
      if (!email && typeof input?.email === "string" && input.email.trim()) {
        email = canonicalEmail(input.email);
        if (!email) return response({ success: false, error: "Please enter a valid email address." }, 400);
      }
      if (typeof input?.phone === "string" && input.phone.trim() && identity.phone) {
        if (canonicalPhone(input.phone) !== identity.phone) {
          return response({ success: false, error: "Verification failed. Please request a new code." }, 401);
        }
      }
      if (typeof input?.email === "string" && input.email.trim() && identity.email) {
        if (canonicalEmail(input.email) !== identity.email) {
          return response({ success: false, error: "Verification failed. Please request a new code." }, 401);
        }
      }

      const existing = (await findUsers(admin, { phone, email })).filter((row) => !row.is_deleted);
      const phoneTaken = Boolean(phone && existing.some((row) => samePhone(row.phone, phone)));
      const emailTaken = Boolean(email && existing.some((row) => canonicalEmail(row.email) === email));
      if (existing.length) {
        return response({
          success: false,
          error: duplicateMessage(phoneTaken || !emailTaken, emailTaken || !phoneTaken),
        }, 409);
      }

      const { data, error } = await admin
        .from("users")
        .insert({ phone, email, name, state, district, language })
        .select(USER_SELECT)
        .maybeSingle();
      const conflict = constraintMessage(error);
      if (conflict) return response({ success: false, error: conflict }, 409);
      if (error || !data) {
        console.warn("[msg91-auth] user insert failed:", error?.code ?? "");
        return response({ success: false, error: "Unable to create your account. Please try again." }, 500);
      }
      const session = await issueSession(admin, data as UserRow);
      if (!session) return response({ success: false, error: "Unable to sign in. Please try again." }, 500);
      return response({
        success: true,
        isNewUser: false,
        user: publicUser(data as UserRow),
        session,
      });
    }

    if (action !== "verify") return response({ success: false, error: "Invalid verification request." }, 400);

    const reqId = typeof input?.reqId === "string" ? input.reqId.trim() : "";
    const otp = typeof input?.otp === "string" ? input.otp.trim() : "";
    const accessToken = typeof input?.accessToken === "string" ? input.accessToken.trim() : "";
    let identity: VerifiedIdentity | null = null;
    if (/^[A-Za-z0-9_-]{8,128}$/.test(reqId) && /^\d{4,8}$/.test(otp)) {
      const verified = await verifyOtpWithMsg91(reqId, otp);
      const recoverFromBind = verified.code === "already_verified" || verified.code === "verified_no_identifier";
      if (recoverFromBind) {
        const otpBind = typeof input?.otpBind === "string" ? input.otpBind.trim() : "";
        const bound = await readOtpBind(otpBind);
        const claimedEmail = typeof input?.email === "string" ? canonicalEmail(input.email) : null;
        const claimedPhone = typeof input?.phone === "string" ? canonicalPhone(input.phone) : null;
        const sameRequest = Boolean(
          bound &&
          bound.reqId === reqId &&
          ((bound.email && bound.email === claimedEmail) || (bound.phone && bound.phone === claimedPhone)),
        );
        if (!sameRequest || !bound) {
          return response({
            success: false,
            error: "This OTP has expired. Please request a new OTP.",
            code: "otp_expired",
          }, 401);
        }
        identity = { phone: bound.phone, email: bound.email };
      } else if (!verified.identity) {
        const status = verified.code === "missing_authkey" ? 503 : verified.code === "ip_blocked" ? 403 : 401;
        return response({
          success: false,
          error: verified.error ?? "MSG91 could not verify the code.",
          code: verified.code ?? "otp_rejected",
        }, status);
      } else {
        identity = verified.identity;
      }
    } else if (accessToken.split(".").length === 3 && accessToken.length <= 8192) {
      identity = await verifyAccessToken(accessToken);
      if (!identity) return response({ success: false, error: "Verification failed. Please request a new code." }, 401);
    } else {
      return response({ success: false, error: "Please request a new OTP." }, 401);
    }
    if (claimedMismatch(input ?? {}, identity)) {
      return response({ success: false, error: "Verification failed. Please request a new code." }, 401);
    }

    const matches = await findUsers(admin, identity);
    if (matches.some((row) => row.is_deleted) && !matches.some((row) => !row.is_deleted)) {
      return response({
        success: false,
        error: "This account has been deleted.\nPlease contact support to restore your account.",
      }, 403);
    }
    const existing = chooseExisting(matches, identity);
    if (existing) {
      const session = await issueSession(admin, existing);
      if (!session) return response({ success: false, error: "Unable to sign in. Please try again." }, 500);
      return response({
        success: true,
        isNewUser: false,
        user: publicUser(existing),
        session,
      });
    }

    return response({
      success: true,
      isNewUser: true,
      verifiedIdentifier: identity,
      registrationToken: await signRegistration(identity),
    });
  } catch (error) {
    console.warn("[msg91-auth] request failed:", error instanceof Error ? error.message : "unknown");
    return response({ success: false, error: "Unable to verify your code right now." }, 503);
  }
});
