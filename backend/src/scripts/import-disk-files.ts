// Copies files saved by the older disk-based storage (UPLOAD_DIR/storage/<bucket>/...)
// into the MySQL `storage_objects` table. Safe to run again: files already in
// MySQL are skipped. Run with `npm run import-files` after `npm run migrate`.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../config.js";
import { pool } from "../db.js";
import { writeStoredObject } from "../edge/supabase-mysql.js";

const storageRoot = path.resolve(env.UPLOAD_DIR, "storage");
const metaRoot = path.resolve(env.UPLOAD_DIR, "storage-meta");

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

let copied = 0, skipped = 0, failed = 0;
for (const bucketEntry of await readdir(storageRoot, { withFileTypes: true }).catch(() => [])) {
  if (!bucketEntry.isDirectory()) continue;
  const bucket = bucketEntry.name;
  for (const file of await listFiles(path.join(storageRoot, bucket))) {
    const key = path.relative(path.join(storageRoot, bucket), file).split(path.sep).join("/");
    try {
      let contentType = "application/octet-stream";
      try {
        contentType = JSON.parse(await readFile(path.join(metaRoot, bucket, `${key}.json`), "utf8")).contentType || contentType;
      } catch { /* no meta file */ }
      const saved = await writeStoredObject(bucket, key, await readFile(file), contentType, false);
      if (saved) { copied++; console.log(`Copied  ${bucket}/${key}`); }
      else { skipped++; console.log(`Skipped ${bucket}/${key} (already in MySQL)`); }
    } catch (error) {
      failed++;
      console.error(`Failed  ${bucket}/${key}: ${error instanceof Error ? error.message : error}`);
    }
  }
}
console.log(`Done: ${copied} copied, ${skipped} already there, ${failed} failed.`);
await pool.end();
if (failed) process.exitCode = 1;
