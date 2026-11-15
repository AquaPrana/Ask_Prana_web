import { randomUUID } from "node:crypto";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { env } from "./config.js";
import { pool, ready } from "./db.js";
import { hash, requireAuth, type AuthedRequest } from "./security.js";
import { mountAuth } from "./auth-routes.js";
import { mountFunctionRoutes } from "./edge/routes.js";

const app = express();
app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: false, contentSecurityPolicy: false }));

const allowedOrigins = new Set(env.ALLOWED_ORIGINS.split(",").map((x) => x.trim()).filter(Boolean));
/** Local development: localhost, 127.0.0.1 and phones on the same Wi-Fi (private IPs). */
const DEV_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/;
const originAllowed = (origin: string | undefined) =>
  !origin || allowedOrigins.has(origin) || (process.env.NODE_ENV !== "production" && DEV_ORIGIN.test(origin));
// Browsers from other websites are refused (requests without an Origin, such
// as server-to-server calls, are not browser cross-site requests).
app.use((req, res, next) => {
  const origin = req.header("origin");
  if (originAllowed(origin)) return next();
  console.warn(`[cors] blocked origin ${origin}. Add it to ALLOWED_ORIGINS in backend/.env.`);
  res.status(403).json({ error: "This website is not allowed to use the Ask Prana API." });
});
app.use(cors({ origin: true, credentials: false, maxAge: 600 }));
app.use((req: AuthedRequest, res, next) => {
  req.requestId = randomUUID();
  res.setHeader("X-Request-ID", req.requestId);
  next();
});

app.get("/health", (_q, r) => r.json({ ok: true }));
app.get("/ready", async (_q, r, next) => {
  try {
    await ready();
    r.json({ ok: true, database: true });
  } catch (e) {
    next(e);
  }
});

// Ask Prana features: chat, voice chat, microphone, files, history, login.
mountFunctionRoutes(app);

// JSON API (/v1). The web app uses /functions/v1 above; these stay for API clients.
app.use("/v1", express.json({ limit: "1mb" }));
mountAuth(app);
app.post("/v1/auth/logout", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const raw = req.header("authorization")!.replace(/^Bearer\s+/i, "");
    await pool.execute("UPDATE user_sessions SET revoked_at=UTC_TIMESTAMP(3) WHERE token_hash=?", [hash(raw)]);
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});
app.get("/v1/auth/me", requireAuth, (req: AuthedRequest, res) => res.json({ user: req.account }));

app.use((err: any, _req: AuthedRequest, res: express.Response, _next: express.NextFunction) => {
  const status = err?.status && err.status < 600 ? err.status : err?.type === "entity.too.large" ? 413 : 500;
  console.error("request failed", err?.code ?? "internal", err?.message);
  if (res.headersSent) return res.end();
  res.status(status).json({
    error: err?.expose === true || status < 500 ? err.message : status === 502 || status === 503 ? err.message : "An unexpected server error occurred.",
    code: typeof err?.code === "string" ? err.code : undefined,
  });
});

export { app };
