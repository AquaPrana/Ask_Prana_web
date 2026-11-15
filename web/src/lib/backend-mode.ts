/**
 * Which backend the web app talks to.
 *   (unset) or "supabase"  -> Supabase (EXPO_PUBLIC_SUPABASE_URL)
 *   "node"                 -> the Node/Express/MySQL server at EXPO_PUBLIC_API_URL
 */
export type BackendMode = "supabase" | "node";

export function backendMode(): BackendMode {
  return (process.env.EXPO_PUBLIC_BACKEND ?? "supabase").trim().toLowerCase() === "node" ? "node" : "supabase";
}

/** Node server address in Node mode, otherwise null. */
export function nodeApiUrl(): string | null {
  if (backendMode() !== "node") return null;
  const url = (process.env.EXPO_PUBLIC_API_URL ?? "").trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(url)) return url;
  console.error("[backend] EXPO_PUBLIC_BACKEND=node needs EXPO_PUBLIC_API_URL (for example http://localhost:3001).");
  return null;
}

export function requireNodeApiUrl(): string {
  const url = nodeApiUrl();
  if (!url) throw new Error("Node backend mode requires EXPO_PUBLIC_API_URL.");
  return url;
}
