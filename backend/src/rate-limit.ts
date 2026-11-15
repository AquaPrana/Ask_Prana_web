import { hash } from "./security.js";
import { pool } from "./db.js";

/** Database-backed fixed-window limiter; callers must use an authenticated id or normalized identity. */
export async function consumeRateLimit(scope: string, subject: string, max: number, windowMs: number) {
  const start = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  const subjectHash = hash(subject);
  await pool.execute("INSERT INTO request_rate_limits (scope,subject_hash,window_start,count) VALUES (?,?,?,1) ON DUPLICATE KEY UPDATE count=count+1", [scope, subjectHash, start]);
  const [rows] = await pool.execute<any[]>("SELECT count FROM request_rate_limits WHERE scope=? AND subject_hash=? AND window_start=?", [scope, subjectHash, start]);
  return Number(rows[0]?.count ?? max + 1) <= max;
}
