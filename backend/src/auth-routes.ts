import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { env } from "./config.js";
import { pool } from "./db.js";
import { issueProof, verifyProof } from "./proofs.js";
import { consumeRateLimit } from "./rate-limit.js";
import { canonicalPhone, createSession, hash, normalizeEmail, requireAuth, type Account, type AuthedRequest } from "./security.js";
import { identityFromMsg91, requestMsg91Widget } from "./msg91-widget.js";

type Identity = { phone: string | null; email: string | null };
const publicUser = (row: any) => ({ id: row.id, phone: row.phone ?? null, pendingPhone: row.pending_phone ?? row.pendingPhone ?? null, email: row.email ?? null, name: row.name ?? "", state: row.state ?? "", district: row.district ?? "", language: row.language ?? "English", avatarUrl: row.avatar_path ?? null, avatarUpdatedAt: row.avatar_updated_at ?? null });
const identity = (input: any): Identity | null => {
  const phone = typeof input?.phone === "string" && input.phone.trim() ? canonicalPhone(input.phone) : null;
  const rawEmail = typeof input?.email === "string" ? input.email.trim() : "";
  const email = rawEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail) ? normalizeEmail(rawEmail) : null;
  return phone || email ? { phone, email } : null;
};
const identityValue = (x: Identity) => x.phone ?? x.email!;
async function userByIdentity(x: Identity) {
  const [rows] = await pool.execute<any[]>("SELECT * FROM users WHERE (phone IS NOT NULL AND phone=?) OR (email IS NOT NULL AND email=?) ORDER BY id LIMIT 2", [x.phone, x.email]);
  return rows;
}
async function issueFor(row: any) {
  if (row.is_deleted || !row.is_active) throw Object.assign(new Error("This account is unavailable."), { status: 403 });
  return createSession(publicUser(row) as Account);
}
const msg91 = (path: string, body: Record<string, string>) => requestMsg91Widget({ authkey: env.MSG91_AUTHKEY, widgetId: env.MSG91_WIDGET_ID, baseUrl: env.MSG91_BASE_URL }, path, body);
/** MSG91 Widget may return its request id as `message`, request_id, reqId or requestId. */
export function providerRequestId(value: any) {
  for (const candidate of [value?.message, value?.request_id, value?.reqId, value?.requestId, value?.data?.message, value?.data?.request_id]) {
    const requestId = typeof candidate === "string" ? candidate.trim() : "";
    if (/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) return requestId;
  }
  return "";
}

export function mountAuth(app: Express) {
  app.post("/v1/auth", async (req, res, next) => { try {
    const action = String(req.body?.action ?? "");
    if (action === "send-otp" || action === "retry-otp") {
      const id = identity(req.body); if (!id) return res.status(400).json({ success: false, error: "Please enter a valid email or mobile number." });
      if (!await consumeRateLimit("otp-send", identityValue(id), 5, 15 * 60_000)) return res.status(429).json({ success: false, error: "Please wait before requesting another code." });
      const retry = typeof req.body?.reqId === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(req.body.reqId);
      // MSG91 Widget accepts either a country-code-prefixed mobile number or email identifier.
      const identifier = id.phone ? id.phone.slice(1) : id.email!;
      const body: Record<string, string> = retry ? { reqId: String(req.body.reqId) } : { identifier };
      const result = await msg91(retry ? "/retryOtp" : "/sendOtp", body);
      const reqId = retry ? String(req.body.reqId) : providerRequestId(result);
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(reqId)) return res.status(502).json({ success: false, error: "OTP provider returned an invalid request id." });
      const challengeId = randomUUID(); const binding = `${reqId}:${identityValue(id)}`;
      await pool.execute("INSERT INTO auth_challenges (id,identity_value,identity_type,provider_request_id,binding_hash,expires_at) VALUES (?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 10 MINUTE))", [challengeId, identityValue(id), id.phone ? "phone" : "email", reqId, (await import("./security.js")).hash(binding)]);
      const proof = issueProof(identityValue(id), "login", undefined, 10 * 60_000);
      return res.json({ success: true, reqId, otpBind: proof.token });
    }
    if (action === "verify") {
      const reqId = String(req.body?.reqId ?? "").trim(), otp = String(req.body?.otp ?? "").trim(); const id = identity(req.body);
      if (!id || !/^[A-Za-z0-9_-]{8,128}$/.test(reqId) || !/^\d{4,8}$/.test(otp)) return res.status(400).json({ success: false, error: "Please enter a valid code." });
      if (!await consumeRateLimit("otp-verify", identityValue(id), 8, 15 * 60_000)) return res.status(429).json({ success: false, error: "Too many attempts. Request a new code." });
      const [challenges] = await pool.execute<any[]>("SELECT * FROM auth_challenges WHERE provider_request_id=? AND identity_value=? AND consumed_at IS NULL AND expires_at>UTC_TIMESTAMP(3) ORDER BY created_at DESC LIMIT 1", [reqId, identityValue(id)]);
      if (!challenges[0]) return res.status(401).json({ success: false, error: "This code has expired. Please request a new code." });
      const result = await msg91("/verifyOtp", { reqId, otp });
      const verified = identityFromMsg91(result);
      // Some MSG91 Widget configurations return only a verification result, not
      // the identifier. The server-created reqId challenge remains the binding:
      // it was stored against this normalized identity before verification and
      // is atomically consumed below. Reject only an explicit provider mismatch.
      if ((verified.phone || verified.email) && identityValue(verified) !== identityValue(id)) {
        return res.status(401).json({ success: false, error: "Verified identity does not match this OTP request." });
      }
      const c = challenges[0]; const [updated] = await pool.execute("UPDATE auth_challenges SET consumed_at=UTC_TIMESTAMP(3), attempts=attempts+1 WHERE id=? AND consumed_at IS NULL", [c.id]);
      if ((updated as any).affectedRows !== 1) return res.status(409).json({ success: false, error: "This code was already used." });
      const rows = await userByIdentity(id); const existing = rows.find(x => !x.is_deleted) ?? null;
      if (existing) return res.json({ success: true, isNewUser: false, user: publicUser(existing), session: await issueFor(existing) });
      const proof = issueProof(identityValue(id), "registration");
      await pool.execute("INSERT INTO verification_proofs (id,identity_value,identity_type,purpose,expires_at) VALUES (?,?,?,?,?)", [proof.id, identityValue(id), id.phone ? "phone" : "email", "registration", proof.expiresAt]);
      return res.json({ success: true, isNewUser: true, verifiedIdentifier: id, registrationToken: proof.token });
    }
    if (action === "register") {
      const proof = verifyProof(String(req.body?.registrationToken ?? ""), "registration"); if (!proof) return res.status(401).json({ success: false, error: "Please verify your code again." });
      const [proofRows] = await pool.execute<any[]>("SELECT id FROM verification_proofs WHERE id=? AND identity_value=? AND purpose='registration' AND consumed_at IS NULL AND expires_at>UTC_TIMESTAMP(3)", [proof.id, proof.identity]);
      if (!proofRows[0]) return res.status(401).json({ success: false, error: "Please verify your code again." });
      const name = String(req.body?.name ?? "").trim(); if (!name || name.length > 80) return res.status(400).json({ success: false, error: "Please enter your full name." });
      const id: Identity = proof.identity.startsWith("+") ? { phone: proof.identity, email: null } : { phone: null, email: proof.identity };
      // The form can display both fields. Compare only the identity which the
      // registration proof actually verified (phone or email), not the other
      // optional profile field.
      const supplied = id.phone ? identity({ phone: req.body?.phone }) : identity({ email: req.body?.email });
      if (supplied && identityValue(supplied) !== identityValue(id)) return res.status(401).json({ success: false, error: "Verified identity does not match." });
      const userId = randomUUID();
      const pendingPhone = id.email && typeof req.body?.phone === "string" && req.body.phone.trim() ? canonicalPhone(req.body.phone) : null;
      if (typeof req.body?.phone === "string" && req.body.phone.trim() && !pendingPhone) return res.status(400).json({ success: false, error: "Please enter a valid mobile number." });
      try { await pool.execute("INSERT INTO users (id,phone,pending_phone,email,name,state,district,language) VALUES (?,?,?,?,?,?,?,?)", [userId,id.phone,pendingPhone,id.email,name,String(req.body?.state ?? "").trim().slice(0,120),String(req.body?.district ?? "").trim().slice(0,120),String(req.body?.language ?? "English").trim().slice(0,32)]); }
      catch (error: any) { if (error?.code === "ER_DUP_ENTRY") return res.status(409).json({ success: false, error: "An account with this verified identity already exists." }); throw error; }
      await pool.execute("UPDATE verification_proofs SET consumed_at=UTC_TIMESTAMP(3) WHERE id=? AND consumed_at IS NULL", [proof.id]);
      const [rows] = await pool.execute<any[]>("SELECT * FROM users WHERE id=?", [userId]); return res.json({ success: true, isNewUser: false, user: publicUser(rows[0]), session: await issueFor(rows[0]) });
    }
    if (action === "google-client") return res.json({ success: Boolean(env.GOOGLE_WEB_CLIENT_ID), clientId: env.GOOGLE_WEB_CLIENT_ID || null });
    return res.status(400).json({ success: false, error: "Invalid authentication request." });
  } catch (error) { next(error); } });

  app.get("/v1/profile", requireAuth, (req: AuthedRequest, res) => res.json({ success: true, user: publicUser(req.account) }));
  app.post("/v1/profile/email/request", requireAuth, async (req: AuthedRequest, res, next) => { try {
    const id = identity({ email: req.body?.email }); const account = req.account!;
    if (!id?.email) return res.status(400).json({ error: "Please enter a valid email address." });
    if (account.email === id.email) return res.json({ success: true, alreadyVerified: true });
    const retry = typeof req.body?.reqId === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(req.body.reqId);
    const result = await msg91(retry ? "/retryOtp" : "/sendOtp", retry ? { reqId: req.body.reqId } : { identifier: id.email });
    const reqId = retry ? req.body.reqId : providerRequestId(result);
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(reqId)) return res.status(502).json({ error: "OTP provider returned an invalid request id." });
    await pool.execute("INSERT INTO auth_challenges (id,identity_value,identity_type,provider_request_id,binding_hash,expires_at) VALUES (?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 10 MINUTE))", [randomUUID(), id.email, "email", reqId, hash(`${reqId}:${id.email}:${account.id}`)]);
    res.json({ success: true, reqId });
  } catch (error) { next(error); } });
  app.post("/v1/profile/email/verify", requireAuth, async (req: AuthedRequest, res, next) => { try {
    const id = identity({ email: req.body?.email }); const reqId = String(req.body?.reqId ?? "").trim(), otp = String(req.body?.otp ?? "").trim(); const account = req.account!;
    if (!id?.email || !/^[A-Za-z0-9_-]{8,128}$/.test(reqId) || !/^\d{4,8}$/.test(otp)) return res.status(400).json({ error: "Please enter a valid code." });
    const [rows] = await pool.execute<any[]>("SELECT * FROM auth_challenges WHERE provider_request_id=? AND identity_value=? AND consumed_at IS NULL AND expires_at>UTC_TIMESTAMP(3) ORDER BY created_at DESC LIMIT 1", [reqId, id.email]); const challenge = rows[0];
    if (!challenge || challenge.binding_hash !== hash(`${reqId}:${id.email}:${account.id}`)) return res.status(401).json({ error: "This code has expired. Please request a new code." });
    const result = await msg91("/verifyOtp", { reqId, otp }); const verified = identityFromMsg91(result);
    if (verified.email && verified.email !== id.email) return res.status(401).json({ error: "Verified identity does not match this email request." });
    const [used] = await pool.execute("UPDATE auth_challenges SET consumed_at=UTC_TIMESTAMP(3), attempts=attempts+1 WHERE id=? AND consumed_at IS NULL", [challenge.id]);
    if ((used as any).affectedRows !== 1) return res.status(409).json({ error: "This code was already used." });
    try { await pool.execute("UPDATE users SET email=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [id.email, account.id]); } catch (error: any) { if (error?.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "This email address is already associated with another account." }); throw error; }
    const [users] = await pool.execute<any[]>("SELECT * FROM users WHERE id=?", [account.id]); res.json({ success: true, user: publicUser(users[0]) });
  } catch (error) { next(error); } });
  app.patch("/v1/profile", requireAuth, async (req: AuthedRequest, res, next) => { try {
    const current = req.account!; const name = String(req.body?.name ?? "").trim(); if (!name || name.length > 80) return res.status(400).json({ error: "Please enter your full name." });
    const nextIdentity = identity(req.body) ?? { phone: current.phone, email: current.email };
    if (!nextIdentity.phone && !nextIdentity.email) return res.status(400).json({ error: "An account needs an email or a phone number." });
    if (nextIdentity.phone !== current.phone || nextIdentity.email !== current.email) return res.status(409).json({ error: "Verify a new phone or email before changing it." });
    await pool.execute("UPDATE users SET name=?,state=?,district=?,language=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?", [name,String(req.body?.state ?? "").trim().slice(0,120),String(req.body?.district ?? "").trim().slice(0,120),String(req.body?.language ?? current.language).trim().slice(0,32),current.id]);
    const [rows] = await pool.execute<any[]>("SELECT * FROM users WHERE id=?", [current.id]); res.json({ success: true, user: publicUser(rows[0]) });
  } catch (error) { next(error); } });
}
