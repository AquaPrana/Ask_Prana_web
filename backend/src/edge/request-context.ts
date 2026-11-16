import { AsyncLocalStorage } from "node:async_hooks";

/** Public address of this API for the request being handled (used in file links). */
type RequestContext = { baseUrl: string };

export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Header carrying the caller's IP into ported functions. routes.ts always sets
 * it from Express (overwriting anything the client sent), so it can be trusted
 * for per-address rate limits.
 */
export const CLIENT_IP_HEADER = "x-ask-prana-client-ip";

/** PUBLIC_API_URL when set (production), otherwise the address the browser used. */
export function publicBaseUrl(): string {
  const configured = (process.env.PUBLIC_API_URL ?? "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  return requestContext.getStore()?.baseUrl ?? `http://localhost:${process.env.PORT ?? 3001}`;
}
