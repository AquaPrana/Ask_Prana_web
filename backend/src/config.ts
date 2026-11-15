import "dotenv/config";
import { z } from "zod";
const schema = z.object({ PORT: z.coerce.number().int().positive().default(3001), ALLOWED_ORIGINS: z.string().default("http://localhost:8081"), DB_HOST: z.string().default("127.0.0.1"), DB_PORT: z.coerce.number().int().default(3306), DB_NAME: z.string().min(1), DB_USER: z.string().min(1), DB_PASSWORD: z.string().min(1), DB_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(8).default(4), DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(10000), DB_SSL: z.enum(["off","verify-ca"]).default("off"), SESSION_SECRET: z.string().optional(), REGISTRATION_SECRET: z.string().optional(), OPENAI_API_KEY: z.string().optional(), OPENAI_MODEL: z.string().default("gpt-5.6-sol"), OPENAI_TTS_MODEL: z.string().default("gpt-4o-mini-tts"), OPENAI_TTS_VOICE: z.string().default("alloy"), REALTIME_VOICE_MODEL: z.string().default("gpt-realtime"), REALTIME_VOICE_VOICE: z.string().default("marin"), GOOGLE_WEB_CLIENT_ID: z.string().optional(), MSG91_AUTHKEY: z.string().optional(), MSG91_WIDGET_ID: z.string().optional(), MSG91_BASE_URL: z.string().url().default("https://control.msg91.com/api/v5/widget"), UPLOAD_DIR: z.string().default("./uploads"), MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(10485760) });
export const env = schema.parse(process.env);

/** Call from the HTTP entry point; maintenance commands only need DB settings. */
export function requireServerSecrets(): void {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32 || !env.REGISTRATION_SECRET || env.REGISTRATION_SECRET.length < 32) {
    throw new Error("SESSION_SECRET and REGISTRATION_SECRET must each contain at least 32 characters before starting the server.");
  }
}
