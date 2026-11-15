/**
 * Checks that the database in backend/.env stores data, using the same code
 * the app uses. Writes a test user, a test chat and two messages, reads them
 * back and prints them.
 *
 *   npx tsx src/scripts/check-db.ts            write test data and keep it
 *   npx tsx src/scripts/check-db.ts --cleanup  remove the test data
 */
import { createClient } from "../edge/supabase-mysql.js";
import { pool } from "../db.js";

const TEST_PHONE = "+910000000001";
const db = createClient();

async function removeTestData() {
  // Deleting the test user also deletes its chats and messages.
  const { error } = await db.from("users").delete().eq("phone", TEST_PHONE);
  if (error) throw new Error(error.message);
}

async function main() {
  const [[info]] = await pool.query<any[]>("SELECT @@hostname AS server, DATABASE() AS db");
  console.log(`Database: ${info.db}  (server ${info.server})\n`);

  if (process.argv.includes("--cleanup")) {
    await removeTestData();
    console.log("Test data removed.");
    return;
  }

  await removeTestData();

  const user = await db.from("users")
    .insert({ phone: TEST_PHONE, name: "TEST USER (delete me)", state: "Telangana", district: "Hyderabad", language: "English" })
    .select("id, name, phone").single();
  if (user.error) throw new Error(`users: ${user.error.message}`);
  console.log("1. User saved:", user.data);

  const chat = await db.from("chat_sessions")
    .insert({ user_id: user.data.id, title: "Test chat: what is aquaculture?" })
    .select("id, title, created_at").single();
  if (chat.error) throw new Error(`chat_sessions: ${chat.error.message}`);
  console.log("2. Chat saved:", chat.data);

  const now = Date.now();
  const messages = await db.from("chat_messages").insert([
    { session_id: chat.data.id, user_id: user.data.id, role: "user", content: "What is aquaculture?", created_at: new Date(now).toISOString() },
    { session_id: chat.data.id, user_id: user.data.id, role: "assistant", content: "Aquaculture is the farming of fish, shrimp and other water animals and plants.", created_at: new Date(now + 1000).toISOString() },
  ]).select("role, content, created_at");
  if (messages.error) throw new Error(`chat_messages: ${messages.error.message}`);
  console.log("3. Messages saved:", messages.data);

  const readBack = await db.from("chat_messages").select("role, content")
    .eq("session_id", chat.data.id).order("created_at", { ascending: true });
  if (readBack.error) throw new Error(`read: ${readBack.error.message}`);
  console.log(`\n4. Read back from the database: ${readBack.data.length} messages`);

  const [[counts]] = await pool.query<any[]>("SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM chat_sessions) AS chats, (SELECT COUNT(*) FROM chat_messages) AS messages");
  console.log("   Totals now:", counts);
  console.log("\nOK: data is stored in this database. Look for 'TEST USER (delete me)' in the users table.");
  console.log("Remove it with: npx tsx src/scripts/check-db.ts --cleanup");
}

main()
  .catch((error) => {
    console.error("\nFAILED:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
