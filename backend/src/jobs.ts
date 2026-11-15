import { randomUUID } from "node:crypto";
import { pool } from "./db.js";

export async function enqueueJob(kind: string, dedupeKey: string, payload: unknown) {
  await pool.execute("INSERT INTO durable_jobs (id,kind,dedupe_key,payload) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE payload=VALUES(payload), status=IF(status='completed','completed','queued'), run_after=IF(status='completed',run_after,UTC_TIMESTAMP(3))", [randomUUID(), kind, dedupeKey, JSON.stringify(payload)]);
}
