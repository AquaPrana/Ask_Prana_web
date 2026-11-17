/**
 * Express routes for the Ask Prana features (Node + Express + MySQL).
 *
 *   POST /functions/v1/<name>       the same request/response contract the web
 *                                   app already uses (chat, voice, files, login)
 *   POST /storage/v1/object/sign/…  temporary file links for the web app
 *   GET  /storage/v1/object/…       serves stored files from the server disk
 */
import express, { type Express, type Request as ExpressRequest, type Response as ExpressResponse } from "express";
import { handler as askPrana } from "../functions/ask-prana/index.js";
import { handler as askPranaTranscribe } from "../functions/ask-prana-transcribe/index.js";
import { handler as askPranaTranslateBackfill } from "../functions/ask-prana-translate-backfill/index.js";
import { handler as askPranaTts } from "../functions/ask-prana-tts/index.js";
import { handler as askPranaVoiceSession } from "../functions/ask-prana-voice-session/index.js";
import { handler as googleAuth } from "../functions/google-auth/index.js";
import { handler as msg91Auth } from "../functions/msg91-auth/index.js";
import type { RowDataPacket } from "mysql2";
import { pool } from "../db.js";
import { hash } from "../security.js";
import { CLIENT_IP_HEADER, requestContext } from "./request-context.js";
import { readStoredObject, signedObjectPath, storedObjectExists, verifyStorageToken } from "./supabase-mysql.js";

type FetchHandler = (req: Request) => Promise<Response>;

const FUNCTIONS: Record<string, FetchHandler> = {
  "ask-prana": askPrana,
  "ask-prana-transcribe": askPranaTranscribe,
  "ask-prana-translate-backfill": askPranaTranslateBackfill,
  "ask-prana-tts": askPranaTts,
  "ask-prana-voice-session": askPranaVoiceSession,
  "google-auth": googleAuth,
  "msg91-auth": msg91Auth,
};

/**
 * File access rules:
 * - Profile photos are shown as avatars, so they stay readable by their link.
 * - Chat files (photos, PDFs, generated Excel/Word) are private: a download link
 *   is only signed for the logged-in owner, and links last at most one hour.
 */
const PUBLIC_READ_BUCKETS = new Set(["profile-photos"]);
const SIGNABLE_BUCKETS = new Set(["ask-prana-files", "profile-photos"]);
const MAX_LINK_SECONDS = 60 * 60;

function linkSeconds(requested: unknown): number {
  const seconds = Math.floor(Number(requested) || MAX_LINK_SECONDS);
  return Math.min(Math.max(seconds, 1), MAX_LINK_SECONDS);
}

/** The logged-in user for an "Authorization: Bearer ap_…" session, or null. */
async function sessionUserId(req: ExpressRequest): Promise<string | null> {
  const raw = (req.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!raw.startsWith("ap_")) return null;
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT s.user_id FROM user_sessions s JOIN users u ON u.id = s.user_id " +
      "WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP(3) AND u.is_deleted = 0 LIMIT 1",
    [hash(raw)],
  );
  return rows[0]?.user_id ? String(rows[0].user_id) : null;
}

/** Chat files live under images/<userId>/ or documents/<userId>/; photos under <userId>/. */
function ownsObject(bucket: string, key: string, userId: string): boolean {
  if (bucket === "ask-prana-files") return key.startsWith(`images/${userId}/`) || key.startsWith(`documents/${userId}/`);
  if (bucket === "profile-photos") return key.startsWith(`${userId}/`);
  return false;
}

const signInRequired = { statusCode: "401", error: "Unauthorized", message: "Please log in to open this file." };

/** Chat attachments arrive as base64 JSON (20 MB file ≈ 27 MB of text). */
const MAX_BODY = "40mb";
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "host", "upgrade", "expect"]);

function requestBaseUrl(req: ExpressRequest): string {
  return `${req.protocol}://${req.get("host")}`;
}

/** Runs one ported function with a Fetch API Request and streams its Response back. */
async function runFunction(handler: FetchHandler, req: ExpressRequest, res: ExpressResponse) {
  const aborter = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) aborter.abort();
  });

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  // The caller's address as seen by Express ("trust proxy" handles Render's
  // proxy). Always overwritten here, so a client cannot fake it; functions use
  // it for per-address rate limits.
  headers.set(CLIENT_IP_HEADER, req.ip || req.socket.remoteAddress || "unknown");
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && Buffer.isBuffer(req.body) && req.body.length > 0;
  const request = new Request(`${requestBaseUrl(req)}${req.originalUrl}`, {
    method: req.method,
    headers,
    body: hasBody ? req.body : undefined,
    signal: aborter.signal,
  });

  const response = await requestContext.run({ baseUrl: requestBaseUrl(req) }, () => handler(request));
  res.status(response.status);
  response.headers.forEach((value, name) => {
    if (name === "content-length" || name === "content-encoding" || name === "transfer-encoding") return;
    // CORS is decided once by the server (ALLOWED_ORIGINS), not by each feature.
    if (name.startsWith("access-control-")) return;
    res.setHeader(name, value);
  });
  if (!response.body) {
    res.end();
    return;
  }
  // Stream (voice answers are server-sent events, sentence by sentence).
  res.flushHeaders();
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) await new Promise((resolve) => res.once("drain", resolve));
    }
  } catch (error) {
    if (!aborter.signal.aborted) console.error("[functions] stream failed", error instanceof Error ? error.message : error);
  } finally {
    res.end();
  }
}

function objectKey(raw: string): string {
  return raw.split("/").map((part) => decodeURIComponent(part)).join("/");
}

/**
 * Types a browser may show inline. They cannot run scripts. Anything else
 * (HTML, SVG, XML, JavaScript, unknown) is always sent as a download with a
 * neutral type, so a stored file can never open as a web page on this API's
 * address, including files saved before upload types were checked.
 */
const INLINE_SAFE_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "application/pdf", "text/plain", "text/csv",
]);

function isInlineSafe(contentType: string): boolean {
  const type = contentType.split(";")[0].trim().toLowerCase();
  return INLINE_SAFE_TYPES.has(type) || (type.startsWith("audio/") && !type.includes("+xml"));
}

function sendObject(res: ExpressResponse, found: { bytes: Buffer; contentType: string }, key: string, download: unknown) {
  const safe = isInlineSafe(found.contentType);
  res.setHeader("Content-Type", safe ? found.contentType : "application/octet-stream");
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (typeof download === "string" || !safe) {
    const name = (typeof download === "string" && download) || key.split("/").pop() || "file";
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  }
  res.end(found.bytes);
}

export function mountFunctionRoutes(app: Express) {
  const raw = express.raw({ type: () => true, limit: MAX_BODY });

  app.all("/functions/v1/:name", raw, async (req, res, next) => {
    const handler = FUNCTIONS[String(req.params.name)];
    if (!handler) return res.status(404).json({ error: "Function not found." });
    try {
      await runFunction(handler, req, res);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      next(error);
    }
  });

  const json = express.json({ limit: "1mb" });

  // Many links at once: POST /storage/v1/object/sign/<bucket>  { expiresIn, paths }
  app.post(/^\/storage\/v1\/object\/sign\/([A-Za-z0-9_-]+)\/?$/, json, async (req, res) => {
    const bucket = String((req.params as Record<string, string>)[0]);
    const userId = await sessionUserId(req);
    if (!userId) return res.status(401).json(signInRequired);
    const paths: unknown[] = Array.isArray(req.body?.paths) ? req.body.paths : [];
    const expiresIn = linkSeconds(req.body?.expiresIn);
    const out = [];
    for (const item of paths.slice(0, 500)) {
      const key = String(item ?? "");
      // Someone else's file is reported as "not found", the same as a missing one.
      const exists = SIGNABLE_BUCKETS.has(bucket) && key && ownsObject(bucket, key, userId) && await storedObjectExists(bucket, key);
      out.push(exists
        ? { path: key, signedURL: signedObjectPath(bucket, key, expiresIn), error: null }
        : { path: key, signedURL: null, error: "Object not found" });
    }
    res.json(out);
  });

  // One link: POST /storage/v1/object/sign/<bucket>/<path>  { expiresIn }
  app.post(/^\/storage\/v1\/object\/sign\/([A-Za-z0-9_-]+)\/(.+)$/, json, async (req, res) => {
    const params = req.params as Record<string, string>;
    const bucket = String(params[0]);
    const key = objectKey(String(params[1]));
    const userId = await sessionUserId(req);
    if (!userId) return res.status(401).json(signInRequired);
    if (!SIGNABLE_BUCKETS.has(bucket) || !ownsObject(bucket, key, userId) || !await storedObjectExists(bucket, key)) {
      return res.status(400).json({ statusCode: "404", error: "not_found", message: "Object not found" });
    }
    res.json({ signedURL: signedObjectPath(bucket, key, linkSeconds(req.body?.expiresIn)) });
  });

  // Open a signed link: GET /storage/v1/object/sign/<bucket>/<path>?token=…&download=
  app.get(/^\/storage\/v1\/object\/sign\/([A-Za-z0-9_-]+)\/(.+)$/, async (req, res) => {
    const params = req.params as Record<string, string>;
    const bucket = String(params[0]);
    const key = objectKey(String(params[1]));
    if (!verifyStorageToken(bucket, key, String(req.query.token ?? ""))) {
      return res.status(400).json({ statusCode: "403", error: "InvalidJWT", message: "The link has expired." });
    }
    const found = await readStoredObject(bucket, key);
    if (!found) return res.status(404).json({ statusCode: "404", error: "not_found", message: "Object not found" });
    sendObject(res, found, key, req.query.download);
  });

  // Public file: GET /storage/v1/object/public/<bucket>/<path>
  app.get(/^\/storage\/v1\/object\/public\/([A-Za-z0-9_-]+)\/(.+)$/, async (req, res) => {
    const params = req.params as Record<string, string>;
    const bucket = String(params[0]);
    const key = objectKey(String(params[1]));
    const found = PUBLIC_READ_BUCKETS.has(bucket) ? await readStoredObject(bucket, key) : null;
    if (!found) return res.status(404).json({ statusCode: "404", error: "not_found", message: "Object not found" });
    sendObject(res, found, key, req.query.download);
  });

  // The web app only uses Ask Prana sessions; Supabase Auth calls get a clean 401.
  app.all(/^\/auth\/v1\/.*/, (_req, res) => {
    res.status(401).json({ code: 401, error_code: "no_authorization", msg: "Supabase Auth is not used by this server." });
  });
}
