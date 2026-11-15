import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { env } from "./config.js";

type ProofPayload = { id: string; identity: string; purpose: string; exp: number; userId?: string };
const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const mac = (body: string) => createHmac("sha256", env.REGISTRATION_SECRET || "invalid-unconfigured-registration-secret").update(body).digest("base64url");

export function issueProof(identity: string, purpose: ProofPayload["purpose"], userId?: string, ttlMs = 10 * 60_000) {
  const payload: ProofPayload = { id: randomUUID(), identity, purpose, userId, exp: Date.now() + ttlMs };
  const body = encode(payload);
  return { id: payload.id, token: `${body}.${mac(body)}`, expiresAt: new Date(payload.exp) };
}

export function verifyProof(token: string, purpose: string): ProofPayload | null {
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const expected = mac(body);
  const a = Buffer.from(signature), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ProofPayload;
    return payload.purpose === purpose && payload.exp > Date.now() && payload.id && payload.identity ? payload : null;
  } catch { return null; }
}
