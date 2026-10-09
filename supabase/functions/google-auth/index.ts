import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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

function response(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function envValue(name: string): string {
  return (Deno.env.get(name) ?? "").trim().replace(/^["']+|["']+$/g, "");
}

function googleClientId(): string {
  return envValue("GOOGLE_WEB_CLIENT_ID");
}

function serviceSecret(): string {
  return (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_ROLE_KEY") ?? "").trim();
}

function adminClient(): SupabaseClient | null {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() ?? "";
  const serviceKey = serviceSecret();
  if (!supabaseUrl || !serviceKey) return null;
  return createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function canonicalEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const email = raw.trim().toLowerCase();
  if (!email) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
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
    ["sign"],
  );
}

async function signRegistration(email: string): Promise<string> {
  const payload = {
    purpose: "register",
    phone: null,
    email,
    exp: Date.now() + REGISTRATION_MINUTES * 60 * 1000,
  };
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey();
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${base64UrlEncode(new Uint8Array(signature))}`;
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
  if (error) return null;
  return { token, expiresAt };
}

function decodeJson(part: string): Record<string, unknown> | null {
  const bytes = base64UrlDecode(part);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function verifiedGoogleEmail(idToken: string, clientId: string, nonce: string): Promise<string | null> {
  const parts = idToken.split(".");
  if (parts.length !== 3 || !nonce) return null;
  const header = decodeJson(parts[0]);
  if (!header || header.alg !== "RS256" || typeof header.kid !== "string") return null;
  const certs = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!certs.ok) return null;
  const body = await certs.json() as { keys?: Array<{ kid?: string; kty?: string; n?: string; e?: string }> };
  const jwk = (body.keys ?? []).find((key) => key.kid === header.kid && key.kty === "RSA" && key.n && key.e);
  if (!jwk?.n || !jwk.e) return null;
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signature = base64UrlDecode(parts[2]);
  if (!signature) return null;
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) return null;
  const payload = decodeJson(parts[1]);
  if (!payload) return null;
  if (payload.iss !== "accounts.google.com" && payload.iss !== "https://accounts.google.com") return null;
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(clientId)) return null;
  const exp = typeof payload.exp === "number" ? payload.exp : Number(payload.exp);
  if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) return null;
  if (payload.nonce !== nonce) return null;
  if (payload.email_verified !== true && payload.email_verified !== "true") return null;
  return canonicalEmail(typeof payload.email === "string" ? payload.email : null);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return response({ success: false, error: "Method not allowed." }, 405);

  const clientId = googleClientId();
  if (!clientId) return response({ success: false, error: "Google sign-in is unavailable." }, 503);

  const input = await req.json().catch(() => null) as { action?: unknown; idToken?: unknown; nonce?: unknown } | null;
  const action = typeof input?.action === "string" ? input.action : "";

  if (action === "client") return response({ success: true, clientId });

  if (action !== "sign-in") return response({ success: false, error: "Invalid sign-in request." }, 400);

  const admin = adminClient();
  if (!admin || !serviceSecret()) return response({ success: false, error: "Authentication service is unavailable." }, 503);

  const idToken = typeof input?.idToken === "string" ? input.idToken.trim() : "";
  const nonce = typeof input?.nonce === "string" ? input.nonce.trim() : "";
  if (!idToken || idToken.length > 8192 || !nonce) {
    return response({ success: false, error: "Google sign-in could not be verified." }, 401);
  }

  try {
    const email = await verifiedGoogleEmail(idToken, clientId, nonce);
    if (!email) return response({ success: false, error: "Google sign-in could not be verified." }, 401);

    const { data, error } = await admin.from("users").select(USER_SELECT).ilike("email", email);
    if (error) return response({ success: false, error: "Unable to sign in. Please try again." }, 500);
    const matches = ((data ?? []) as UserRow[]).filter((row) => canonicalEmail(row.email) === email);
    if (matches.some((row) => row.is_deleted) && !matches.some((row) => !row.is_deleted)) {
      return response({
        success: false,
        error: "This account has been deleted.\nPlease contact support to restore your account.",
      }, 403);
    }
    const active = matches.filter((row) => !row.is_deleted);
    const pool = active.length ? active : matches;
    const existing = pool.slice().sort((a, b) => a.id.localeCompare(b.id))[0] ?? null;
    if (existing) {
      const session = await issueSession(admin, existing);
      if (!session) return response({ success: false, error: "Unable to sign in. Please try again." }, 500);
      return response({ success: true, isNewUser: false, user: publicUser(existing), session });
    }

    return response({
      success: true,
      isNewUser: true,
      verifiedIdentifier: { phone: null, email },
      registrationToken: await signRegistration(email),
    });
  } catch {
    return response({ success: false, error: "Google sign-in could not be verified." }, 503);
  }
});
