import mysql from "mysql2/promise";
import { env } from "./config.js";
export const pool = mysql.createPool({ host: env.DB_HOST, port: env.DB_PORT, database: env.DB_NAME, user: env.DB_USER, password: env.DB_PASSWORD, waitForConnections: true, connectionLimit: env.DB_CONNECTION_LIMIT, queueLimit: 32, connectTimeout: env.DB_CONNECT_TIMEOUT_MS, timezone: "Z", charset: "utf8mb4_unicode_ci", enableKeepAlive: true, ssl: env.DB_SSL === "verify-ca" ? {} : undefined });

// All times are stored in UTC. Without this, MySQL fills `created_at` defaults
// in the computer's own time zone (India time on Windows), 5½ hours away from
// the UTC times the app writes, which mixes up chat order.
pool.on("connection", (connection) => {
  connection.query("SET time_zone = '+00:00'");
});

export async function ready() { await pool.query("SELECT 1"); }
