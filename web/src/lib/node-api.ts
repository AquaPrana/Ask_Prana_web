import { requireNodeApiUrl } from "./backend-mode";
import { ensureValidSession } from "./supabase";

export async function nodeJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = await ensureValidSession();
  if (!session?.access_token) throw new Error("No active session. Please sign in again.");
  const response = await fetch(`${requireNodeApiUrl()}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}`, ...(init.headers ?? {}) },
  });
  const data = await response.json().catch(() => ({})) as T & { error?: unknown };
  if (!response.ok || typeof data.error === "string") throw new Error(typeof data.error === "string" ? data.error : "Request failed.");
  return data;
}

export async function nodeAnonymousJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${requireNodeApiUrl()}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({})) as T & { error?: unknown };
  if (!response.ok || typeof data.error === "string") throw new Error(typeof data.error === "string" ? data.error : "Request failed.");
  return data;
}
