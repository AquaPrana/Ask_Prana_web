/**
 * A small Supabase-style client for the ported functions in src/functions.
 *
 * The functions were written for Supabase (`supabase.from("chat_messages")
 * .select(...).eq(...)`, `supabase.storage.from(bucket).upload(...)`). This
 * file gives them the same calls, but the data and the files both live in
 * MySQL (files in the `storage_objects` table). Results use the Supabase shape
 * `{ data, error }`, so the function code stays unchanged.
 *
 * Only the query features the functions use are supported.
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { RowDataPacket } from "mysql2";
import { env } from "../config.js";
import { pool } from "../db.js";
import { publicBaseUrl } from "./request-context.js";

type Row = Record<string, unknown>;
type DbError = { message: string; code: string; details: string | null; hint: string | null };
type Result<T = unknown> = { data: T; error: DbError | null; count?: number | null; status: number; statusText: string };

/** Table facts the queries need: primary key, generated uuid id, value types. */
const TABLES: Record<string, { pk: string[]; uuid?: boolean; booleans?: string[]; json?: string[] }> = {
  users: { pk: ["id"], uuid: true, booleans: ["is_deleted", "is_active"] },
  user_sessions: { pk: ["id"], uuid: true },
  chat_sessions: { pk: ["id"], uuid: true },
  chat_messages: { pk: ["id"], uuid: true, json: ["metadata"] },
  chat_message_translations: { pk: ["message_id", "lang"] },
  chat_session_translations: { pk: ["session_id", "lang"] },
  translation_cache: { pk: ["text_hash", "lang"] },
};
const tableInfo = (table: string) => TABLES[table] ?? { pk: ["id"], uuid: true };

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
function ident(name: string): string {
  const clean = name.trim();
  if (!IDENT.test(clean)) throw new Error(`Unsupported column name: ${name}`);
  return `\`${clean}\``;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** Date/time columns (`created_at`, `expires_at`, ...). Only these get date conversion. */
const isDateColumn = (column: string) => /_at$/.test(column) || column === "window_start" || column === "run_after";

/**
 * JS value -> MySQL parameter. ISO date text becomes a Date only for date
 * columns, so a message that happens to look like a date stays as typed.
 * Objects become JSON.
 */
function toDb(column: string, value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "string" && isDateColumn(column) && ISO_DATE.test(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date;
  }
  if (value instanceof Uint8Array || value instanceof Date || value === null) return value;
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

/** MySQL row -> Supabase-style row (ISO date strings, real booleans, parsed JSON). */
function fromDb(table: string, row: Row): Row {
  const info = tableInfo(table);
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Date) out[key] = value.toISOString();
    else if (info.booleans?.includes(key) && value !== null) out[key] = Boolean(Number(value));
    else if (info.json?.includes(key) && typeof value === "string") {
      try { out[key] = JSON.parse(value); } catch { out[key] = value; }
    } else out[key] = value;
  }
  return out;
}

function dbError(error: unknown): DbError {
  const e = error as { code?: string; message?: string; sqlMessage?: string };
  const code = e?.code === "ER_DUP_ENTRY" ? "23505"
    : e?.code === "ER_NO_SUCH_TABLE" ? "42P01"
    : e?.code === "ER_BAD_FIELD_ERROR" ? "42703"
    : e?.code === "ER_NO_REFERENCED_ROW_2" ? "23503"
    : typeof e?.code === "string" ? e.code : "MYSQL_ERROR";
  return { message: e?.sqlMessage ?? e?.message ?? "Database error", code, details: null, hint: null };
}

function selectList(columns: string): string {
  const parts = columns.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0 || parts.includes("*")) return "*";
  return parts.map((part) => {
    const alias = part.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z_][A-Za-z0-9_]*)$/);
    return alias ? `${ident(alias[2])} AS ${ident(alias[1])}` : ident(part);
  }).join(", ");
}

/** Parses PostgREST list text like `(a,b,"c")`. */
function parseList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return String(value).replace(/^\(|\)$/g, "").split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
}

type Filter = { sql: string; params: unknown[] };
type Action = "select" | "insert" | "upsert" | "update" | "delete";

class QueryBuilder<T = any> implements PromiseLike<Result<T>> {
  private action: Action = "select";
  private columns = "*";
  private returning: string | null = null;
  private filters: Filter[] = [];
  private orders: string[] = [];
  private limitCount: number | null = null;
  private offsetCount = 0;
  private mode: "many" | "single" | "maybe" = "many";
  private values: Row[] = [];
  private upsertOptions: { onConflict?: string; ignoreDuplicates?: boolean } = {};
  private countMode: string | null = null;
  private headOnly = false;

  constructor(private readonly table: string) {
    ident(table);
  }

  select(columns = "*", options?: { count?: string; head?: boolean }) {
    if (this.action === "select") {
      this.columns = columns;
      this.countMode = options?.count ?? null;
      this.headOnly = options?.head === true;
    } else {
      this.returning = columns;
    }
    return this;
  }

  insert(values: Row | Row[], _options?: unknown) {
    this.action = "insert";
    this.values = Array.isArray(values) ? values : [values];
    return this;
  }

  upsert(values: Row | Row[], options?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.action = "upsert";
    this.values = Array.isArray(values) ? values : [values];
    this.upsertOptions = options ?? {};
    return this;
  }

  update(values: Row, _options?: unknown) {
    this.action = "update";
    this.values = [values];
    return this;
  }

  delete(_options?: unknown) {
    this.action = "delete";
    return this;
  }

  private where(sql: string, ...params: unknown[]) {
    this.filters.push({ sql, params });
    return this;
  }

  eq(column: string, value: unknown) {
    return value === null ? this.where(`${ident(column)} IS NULL`) : this.where(`${ident(column)} = ?`, toDb(column, value));
  }
  neq(column: string, value: unknown) {
    return value === null ? this.where(`${ident(column)} IS NOT NULL`) : this.where(`${ident(column)} <> ?`, toDb(column, value));
  }
  gt(column: string, value: unknown) { return this.where(`${ident(column)} > ?`, toDb(column, value)); }
  gte(column: string, value: unknown) { return this.where(`${ident(column)} >= ?`, toDb(column, value)); }
  lt(column: string, value: unknown) { return this.where(`${ident(column)} < ?`, toDb(column, value)); }
  lte(column: string, value: unknown) { return this.where(`${ident(column)} <= ?`, toDb(column, value)); }
  like(column: string, pattern: string) { return this.where(`${ident(column)} LIKE BINARY ?`, pattern); }
  ilike(column: string, pattern: string) { return this.where(`LOWER(${ident(column)}) LIKE LOWER(?)`, pattern); }
  in(column: string, values: unknown[]) {
    const list = parseList(values);
    if (list.length === 0) return this.where("FALSE");
    return this.where(`${ident(column)} IN (?)`, list.map((v) => toDb(column, v)));
  }
  is(column: string, value: null | boolean) {
    if (value === null) return this.where(`${ident(column)} IS NULL`);
    return this.where(`${ident(column)} IS ${value ? "TRUE" : "FALSE"}`);
  }
  not(column: string, operator: string, value: unknown) {
    if (operator === "is") {
      if (value === null || value === "null") return this.where(`${ident(column)} IS NOT NULL`);
      return this.where(`${ident(column)} IS NOT ${value === true || value === "true" ? "TRUE" : "FALSE"}`);
    }
    if (operator === "in") {
      const list = parseList(value);
      return list.length ? this.where(`${ident(column)} NOT IN (?)`, list.map((v) => toDb(column, v))) : this;
    }
    if (operator === "eq") return this.neq(column, value);
    throw new Error(`Unsupported not() operator: ${operator}`);
  }
  match(query: Row) {
    for (const [column, value] of Object.entries(query)) this.eq(column, value);
    return this;
  }
  filter(column: string, operator: string, value: unknown) {
    switch (operator) {
      case "eq": return this.eq(column, value);
      case "neq": return this.neq(column, value);
      case "gt": return this.gt(column, value);
      case "gte": return this.gte(column, value);
      case "lt": return this.lt(column, value);
      case "lte": return this.lte(column, value);
      case "like": return this.like(column, String(value));
      case "ilike": return this.ilike(column, String(value));
      case "in": return this.in(column, parseList(value));
      case "is": return this.is(column, value === "null" ? null : (value as boolean | null));
      default: throw new Error(`Unsupported filter operator: ${operator}`);
    }
  }

  /** Postgres order: ascending puts empty values last, descending puts them first. */
  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }) {
    const ascending = options?.ascending !== false;
    const nullsFirst = options?.nullsFirst ?? !ascending;
    this.orders.push(`${ident(column)} IS NULL ${nullsFirst ? "DESC" : "ASC"}`, `${ident(column)} ${ascending ? "ASC" : "DESC"}`);
    return this;
  }
  limit(count: number) {
    this.limitCount = Math.max(0, Math.floor(Number(count) || 0));
    return this;
  }
  range(from: number, to: number) {
    this.offsetCount = Math.max(0, Math.floor(from));
    this.limitCount = Math.max(0, Math.floor(to) - this.offsetCount + 1);
    return this;
  }
  single() { this.mode = "single"; return this; }
  maybeSingle() { this.mode = "maybe"; return this; }
  abortSignal(_signal: AbortSignal) { return this; }
  returns() { return this; }

  then<R1 = Result<T>, R2 = never>(
    onfulfilled?: ((value: Result<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private whereSql(): { sql: string; params: unknown[] } {
    if (this.filters.length === 0) return { sql: "", params: [] };
    return {
      sql: ` WHERE ${this.filters.map((f) => `(${f.sql})`).join(" AND ")}`,
      params: this.filters.flatMap((f) => f.params),
    };
  }

  private tail(): string {
    let sql = this.orders.length ? ` ORDER BY ${this.orders.join(", ")}` : "";
    if (this.limitCount !== null) sql += ` LIMIT ${this.limitCount}`;
    if (this.offsetCount) sql += `${this.limitCount === null ? " LIMIT 18446744073709551615" : ""} OFFSET ${this.offsetCount}`;
    return sql;
  }

  private shape(rows: Row[], count: number | null = null): Result<any> {
    const data = rows.map((row) => fromDb(this.table, row));
    if (this.mode === "many") return { data: this.headOnly ? null : data, error: null, count, status: 200, statusText: "OK" };
    if (data.length > 1) {
      return { data: null, error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116", details: `Results contain ${data.length} rows`, hint: null }, count, status: 406, statusText: "Not Acceptable" };
    }
    if (data.length === 0 && this.mode === "single") {
      return { data: null, error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116", details: "Results contain 0 rows", hint: null }, count, status: 406, statusText: "Not Acceptable" };
    }
    return { data: data[0] ?? null, error: null, count, status: 200, statusText: "OK" };
  }

  private async rowsByKeys(keys: Row[], columns: string): Promise<Row[]> {
    if (keys.length === 0) return [];
    const pk = tableInfo(this.table).pk;
    const clauses = keys.map(() => `(${pk.map((k) => `${ident(k)} = ?`).join(" AND ")})`).join(" OR ");
    const params = keys.flatMap((key) => pk.map((k) => toDb(k, key[k])));
    const [rows] = await pool.query<RowDataPacket[]>(`SELECT ${selectList(columns)} FROM ${ident(this.table)} WHERE ${clauses}`, params);
    return rows as Row[];
  }

  private async execute(): Promise<Result<any>> {
    try {
      const table = ident(this.table);
      const info = tableInfo(this.table);
      if (this.action === "select") {
        const where = this.whereSql();
        let count: number | null = null;
        if (this.countMode) {
          const [counted] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${table}${where.sql}`, where.params);
          count = Number(counted[0]?.n ?? 0);
        }
        if (this.headOnly) return this.shape([], count);
        const [rows] = await pool.query<RowDataPacket[]>(`SELECT ${selectList(this.columns)} FROM ${table}${where.sql}${this.tail()}`, where.params);
        return this.shape(rows as Row[], count);
      }

      if (this.action === "insert" || this.action === "upsert") {
        if (this.values.length === 0) return this.shape([]);
        const records = this.values.map((value) => {
          const record: Row = { ...value };
          if (info.uuid && info.pk.length === 1 && record[info.pk[0]] == null) record[info.pk[0]] = randomUUID();
          return record;
        });
        const columns = [...new Set(records.flatMap((record) => Object.keys(record)))];
        const placeholders = records.map((record) => `(${columns.map((c) => (c in record ? "?" : "DEFAULT")).join(", ")})`).join(", ");
        const params = records.flatMap((record) => columns.filter((c) => c in record).map((c) => toDb(c, record[c])));
        let sql = `INSERT${this.action === "upsert" && this.upsertOptions.ignoreDuplicates ? " IGNORE" : ""} INTO ${table} (${columns.map(ident).join(", ")}) VALUES ${placeholders}`;
        if (this.action === "upsert" && !this.upsertOptions.ignoreDuplicates) {
          const conflict = (this.upsertOptions.onConflict ?? "").split(",").map((c) => c.trim()).filter(Boolean);
          const keep = new Set([...info.pk, ...conflict]);
          const updates = columns.filter((c) => !keep.has(c));
          sql += ` ON DUPLICATE KEY UPDATE ${updates.length ? updates.map((c) => `${ident(c)} = VALUES(${ident(c)})`).join(", ") : `${ident(info.pk[0])} = ${ident(info.pk[0])}`}`;
        }
        await pool.query(sql, params);
        if (this.returning === null) return { data: null, error: null, status: 201, statusText: "Created" };
        const conflict = (this.upsertOptions.onConflict ?? "").split(",").map((c) => c.trim()).filter(Boolean);
        if (this.action === "upsert" && conflict.length) {
          const rows: Row[] = [];
          for (const record of records) {
            const [found] = await pool.query<RowDataPacket[]>(`SELECT ${selectList(this.returning)} FROM ${table} WHERE ${conflict.map((c) => `${ident(c)} = ?`).join(" AND ")} LIMIT 1`, conflict.map((c) => toDb(c, record[c])));
            rows.push(...(found as Row[]));
          }
          return this.shape(rows);
        }
        return this.shape(await this.rowsByKeys(records, this.returning));
      }

      const where = this.whereSql();
      const keys = this.returning !== null
        ? ((await pool.query<RowDataPacket[]>(`SELECT ${info.pk.map(ident).join(", ")} FROM ${table}${where.sql}`, where.params))[0] as Row[])
        : [];
      const previous = this.action === "delete" && this.returning !== null ? await this.rowsByKeys(keys, this.returning) : [];

      if (this.action === "update") {
        const entries = Object.entries(this.values[0] ?? {}).filter(([, value]) => value !== undefined);
        if (entries.length === 0) return this.shape([]);
        await pool.query(`UPDATE ${table} SET ${entries.map(([c]) => `${ident(c)} = ?`).join(", ")}${where.sql}`, [...entries.map(([c, v]) => toDb(c, v)), ...where.params]);
        if (this.returning === null) return { data: null, error: null, status: 204, statusText: "No Content" };
        // Keys may change in the update itself (e.g. an id), so re-read by the new values where given.
        const changed = keys.map((key) => {
          const next = { ...key };
          for (const [c, v] of entries) if (c in next) next[c] = v;
          return next;
        });
        return this.shape(await this.rowsByKeys(changed, this.returning));
      }

      await pool.query(`DELETE FROM ${table}${where.sql}`, where.params);
      if (this.returning === null) return { data: null, error: null, status: 204, statusText: "No Content" };
      return this.shape(previous);
    } catch (error) {
      return { data: null, error: dbError(error), count: null, status: 400, statusText: "Bad Request" };
    }
  }
}

// ---- Storage (files in the MySQL `storage_objects` table) ---------------------
//
// Files are kept in MySQL rather than on the server's disk, so they survive
// redeploys and work on hosts whose disk is wiped (Vercel, Render free).

const MAX_OBJECT_KEY_LENGTH = 1000;

/** Checks the bucket and path and returns the normalised key plus its row id. */
function safeObjectPath(bucket: string, objectPath: string): { key: string; hash: Buffer } {
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(bucket)) throw new Error("Invalid bucket.");
  const key = String(objectPath ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = key.split("/");
  if (!key || key.length > MAX_OBJECT_KEY_LENGTH || segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new Error("Invalid file path.");
  }
  return { key, hash: createHash("sha256").update(`${bucket}/${key}`).digest() };
}

function signingKey() {
  return env.SESSION_SECRET || "ask-prana-local-storage-signing";
}

/** Signature for a temporary file link: `<expiry>.<hmac>`. */
export function signStorageToken(bucket: string, key: string, expiresInSeconds: number): string {
  const expires = Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(expiresInSeconds));
  const mac = createHmac("sha256", signingKey()).update(`${bucket}/${key}:${expires}`).digest("base64url");
  return `${expires}.${mac}`;
}

export function verifyStorageToken(bucket: string, key: string, token: string): boolean {
  const [expires, mac] = String(token ?? "").split(".");
  if (!expires || !mac || Number(expires) < Math.floor(Date.now() / 1000)) return false;
  const expected = createHmac("sha256", signingKey()).update(`${bucket}/${key}:${expires}`).digest("base64url");
  const a = Buffer.from(mac), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Relative path used by the Supabase storage client: `/object/sign/<bucket>/<key>?token=...`. */
export function signedObjectPath(bucket: string, key: string, expiresInSeconds: number): string {
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  return `/object/sign/${bucket}/${encoded}?token=${encodeURIComponent(signStorageToken(bucket, key, expiresInSeconds))}`;
}

export async function readStoredObject(bucket: string, objectPath: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  let hash: Buffer;
  try {
    hash = safeObjectPath(bucket, objectPath).hash;
  } catch {
    return null;
  }
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT data, content_type FROM storage_objects WHERE key_hash = ? LIMIT 1",
    [hash],
  );
  const row = rows[0];
  if (!row) return null;
  return { bytes: Buffer.from(row.data as Buffer), contentType: String(row.content_type || "application/octet-stream") };
}

export async function storedObjectExists(bucket: string, objectPath: string): Promise<boolean> {
  let hash: Buffer;
  try {
    hash = safeObjectPath(bucket, objectPath).hash;
  } catch {
    return false;
  }
  const [rows] = await pool.query<RowDataPacket[]>("SELECT 1 FROM storage_objects WHERE key_hash = ? LIMIT 1", [hash]);
  return rows.length > 0;
}

/** Saves a file. Without `upsert`, an existing file is left alone and `false` is returned. */
export async function writeStoredObject(bucket: string, objectPath: string, bytes: Buffer, contentType: string, upsert: boolean): Promise<boolean> {
  const { key, hash } = safeObjectPath(bucket, objectPath);
  const type = (contentType || "application/octet-stream").slice(0, 255);
  const insert = "INSERT INTO storage_objects (key_hash, bucket, object_key, content_type, byte_size, data) VALUES (?,?,?,?,?,?)";
  const values = [hash, bucket, key, type, bytes.length, bytes];
  if (upsert) {
    await pool.query(`${insert} ON DUPLICATE KEY UPDATE content_type=VALUES(content_type), byte_size=VALUES(byte_size), data=VALUES(data)`, values);
    return true;
  }
  try {
    await pool.query(insert, values);
    return true;
  } catch (error) {
    if ((error as { code?: string })?.code === "ER_DUP_ENTRY") return false;
    throw error;
  }
}

async function toBytes(body: unknown): Promise<Buffer> {
  if (body instanceof Buffer) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (body && typeof (body as Blob).arrayBuffer === "function") return Buffer.from(await (body as Blob).arrayBuffer());
  if (typeof body === "string") return Buffer.from(body);
  throw new Error("Unsupported upload body.");
}

const storageError = (message: string) => ({ name: "StorageError", message, statusCode: "400" });

class StorageBucket {
  constructor(private readonly bucket: string) {}

  async upload(objectPath: string, body: unknown, options?: { contentType?: string; upsert?: boolean }) {
    try {
      const { key } = safeObjectPath(this.bucket, objectPath);
      const bytes = await toBytes(body);
      const contentType = options?.contentType || (body as Blob)?.type || "application/octet-stream";
      const saved = await writeStoredObject(this.bucket, key, bytes, contentType, Boolean(options?.upsert));
      if (!saved) {
        return { data: null, error: { ...storageError("The resource already exists"), statusCode: "409" } };
      }
      return { data: { id: key, path: key, fullPath: `${this.bucket}/${key}` }, error: null };
    } catch (error) {
      return { data: null, error: storageError(error instanceof Error ? error.message : "Upload failed.") };
    }
  }

  async download(objectPath: string) {
    const found = await readStoredObject(this.bucket, objectPath);
    if (!found) return { data: null, error: { ...storageError("Object not found"), statusCode: "404" } };
    return { data: new Blob([new Uint8Array(found.bytes)], { type: found.contentType }), error: null };
  }

  async createSignedUrl(objectPath: string, expiresIn: number, options?: { download?: string | boolean }) {
    try {
      const { key } = safeObjectPath(this.bucket, objectPath);
      if (!await storedObjectExists(this.bucket, key)) return { data: null, error: { ...storageError("Object not found"), statusCode: "404" } };
      const download = options?.download ? `&download=${options.download === true ? "" : encodeURIComponent(options.download)}` : "";
      return { data: { signedUrl: `${publicBaseUrl()}/storage/v1${signedObjectPath(this.bucket, key, expiresIn)}${download}` }, error: null };
    } catch (error) {
      return { data: null, error: storageError(error instanceof Error ? error.message : "Could not sign the file.") };
    }
  }

  async createSignedUrls(paths: string[], expiresIn: number, options?: { download?: string | boolean }) {
    const data = [];
    for (const objectPath of paths) {
      const one = await this.createSignedUrl(objectPath, expiresIn, options);
      data.push({ path: objectPath, signedUrl: one.data?.signedUrl ?? null, error: one.error?.message ?? null });
    }
    return { data, error: null };
  }

  getPublicUrl(objectPath: string) {
    const key = String(objectPath).replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
    return { data: { publicUrl: `${publicBaseUrl()}/storage/v1/object/public/${this.bucket}/${key}` } };
  }

  async remove(paths: string[]) {
    const removed = [];
    for (const objectPath of paths) {
      try {
        const { key, hash } = safeObjectPath(this.bucket, objectPath);
        await pool.query("DELETE FROM storage_objects WHERE key_hash = ?", [hash]);
        removed.push({ name: key });
      } catch {
        // Missing or invalid files count as removed, like Supabase.
      }
    }
    return { data: removed, error: null };
  }
}

// ---- Client -------------------------------------------------------------------

export class SupabaseClient {
  readonly storage = { from: (bucket: string) => new StorageBucket(bucket) };

  /** The Node backend only uses Ask Prana `ap_` sessions, never Supabase Auth. */
  readonly auth = {
    getUser: async (_jwt?: string) => ({
      data: { user: null },
      error: { name: "AuthApiError", message: "Supabase Auth is not used by this server.", status: 401 },
    }),
  };

  from(table: string) {
    return new QueryBuilder(table);
  }

  async rpc(name: string) {
    return { data: null, error: { message: `Database function ${name} is not available.`, code: "42883", details: null, hint: null } };
  }
}

export function createClient(_url?: string, _key?: string, _options?: unknown): SupabaseClient {
  return new SupabaseClient();
}
