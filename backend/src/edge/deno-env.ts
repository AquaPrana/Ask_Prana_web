/**
 * The ported functions read settings with `Deno.env.get(...)`. In Node the same
 * settings come from backend/.env (process.env).
 *
 * They also check that a database address and key exist before working. Here
 * the database is MySQL (DB_* settings), so those two get fixed placeholder
 * values; nothing is sent to Supabase.
 */
const NODE_DATABASE = "node-mysql";
const PLACEHOLDERS: Record<string, string> = {
  SUPABASE_URL: NODE_DATABASE,
  SUPABASE_SERVICE_ROLE_KEY: NODE_DATABASE,
  SERVICE_ROLE_KEY: NODE_DATABASE,
};

export const Deno = {
  env: {
    get(name: string): string | undefined {
      if (name in PLACEHOLDERS) return PLACEHOLDERS[name];
      return process.env[name];
    },
  },
};
