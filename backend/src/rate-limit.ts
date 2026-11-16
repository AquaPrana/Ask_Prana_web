import { hash } from "./security.js";
import { pool } from "./db.js";

/** Database-backed fixed-window limiter; callers must use an authenticated id or normalized identity. */
export async function consumeRateLimit(scope: string, subject: string, max: number, windowMs: number) {
  const start = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  const subjectHash = hash(subject);
  await pool.execute("INSERT INTO request_rate_limits (scope,subject_hash,window_start,count) VALUES (?,?,?,1) ON DUPLICATE KEY UPDATE count=count+1", [scope, subjectHash, start]);
  const [rows] = await pool.execute<any[]>("SELECT count FROM request_rate_limits WHERE scope=? AND subject_hash=? AND window_start=?", [scope, subjectHash, start]);
  // Now and then drop windows older than a day so the table stays small.
  if (Math.random() < 0.01) {
    pool.execute("DELETE FROM request_rate_limits WHERE window_start < UTC_TIMESTAMP(3) - INTERVAL 1 DAY")
      .catch((error) => console.warn("[rate-limit] cleanup failed:", error instanceof Error ? error.message : error));
  }
  return Number(rows[0]?.count ?? max + 1) <= max;
}
