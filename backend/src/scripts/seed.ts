import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2";
import { pool } from "../db.js";

const phone = "+919000000000";
const id = randomUUID();
await pool.execute(
  "INSERT INTO users (id,phone,name,state,district,language) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=id",
  [id, phone, "Demo Farmer", "Andhra Pradesh", "Demo", "English"],
);
const [rows] = await pool.execute<(RowDataPacket & { id: string })[]>("SELECT id FROM users WHERE phone=?", [phone]);
console.log(`Synthetic development user ready: ${rows[0]?.id ?? id}`);
await pool.end();
