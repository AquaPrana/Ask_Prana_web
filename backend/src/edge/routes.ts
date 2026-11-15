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
import { requestContext } from "./request-context.js";
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

/** Buckets the web app reads files from (both were public in Supabase). */
const PUBLIC_BUCKETS = new Set(["ask-prana-files", "profile-photos", "aquagpt-files"]);

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

function sendObject(res: ExpressResponse, found: { bytes: Buffer; contentType: string }, key: string, download: unknown) {
  res.setHeader("Content-Type", found.contentType);
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (typeof download === "string") {
    const name = download || key.split("/").pop() || "file";
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
    const paths: unknown[] = Array.isArray(req.body?.paths) ? req.body.paths : [];
    const expiresIn = Number(req.body?.expiresIn) || 3600;
    const out = [];
    for (const item of paths.slice(0, 500)) {
      const key = String(item ?? "");
      const exists = PUBLIC_BUCKETS.has(bucket) && key && await storedObjectExists(bucket, key);
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
    if (!PUBLIC_BUCKETS.has(bucket) || !await storedObjectExists(bucket, key)) {
      return res.status(400).json({ statusCode: "404", error: "not_found", message: "Object not found" });
    }
    res.json({ signedURL: signedObjectPath(bucket, key, Number(req.body?.expiresIn) || 3600) });
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
    const found = PUBLIC_BUCKETS.has(bucket) ? await readStoredObject(bucket, key) : null;
    if (!found) return res.status(404).json({ statusCode: "404", error: "not_found", message: "Object not found" });
    sendObject(res, found, key, req.query.download);
  });

  // The web app only uses Ask Prana sessions; Supabase Auth calls get a clean 401.
  app.all(/^\/auth\/v1\/.*/, (_req, res) => {
    res.status(401).json({ code: 401, error_code: "no_authorization", msg: "Supabase Auth is not used by this server." });
  });
}
