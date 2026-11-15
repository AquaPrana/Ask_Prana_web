import { pool } from "../db.js";

const [rows] = await pool.query(`
  SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, CHARACTER_SET_NAME, COLLATION_NAME, IS_NULLABLE
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME IN ('users', 'user_sessions', 'chat_sessions', 'chat_messages')
  ORDER BY TABLE_NAME, ORDINAL_POSITION
`);
console.table(rows);
await pool.end();
