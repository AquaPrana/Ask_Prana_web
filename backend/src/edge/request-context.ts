import { AsyncLocalStorage } from "node:async_hooks";

/** Public address of this API for the request being handled (used in file links). */
type RequestContext = { baseUrl: string };

export const requestContext = new AsyncLocalStorage<RequestContext>();

/** PUBLIC_API_URL when set (production), otherwise the address the browser used. */
export function publicBaseUrl(): string {
  const configured = (process.env.PUBLIC_API_URL ?? "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  return requestContext.getStore()?.baseUrl ?? `http://localhost:${process.env.PORT ?? 3001}`;
}
