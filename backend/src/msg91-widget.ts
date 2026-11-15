export class OtpProviderError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

export type Msg91Config = { authkey?: string; widgetId?: string; baseUrl: string };
export type FetchLike = (input: string, init: RequestInit) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export function providerFailure(json: any, fallback: string) {
  const text = [json?.message, json?.error, json?.type, json?.code]
    .filter((x) => typeof x === "string").join(" ").toLowerCase();
  if (/invalid.*auth|authkey|authenticationfailure|authentication/.test(text)) return new OtpProviderError("OTP service authentication was rejected. Check the server MSG91 configuration.", 503, "provider_auth_rejected");
  if (/widget/.test(text)) return new OtpProviderError("OTP widget configuration was rejected. Check the configured MSG91 widget.", 503, "provider_widget_rejected");
  if (/ipblocked|ip blocked/.test(text)) return new OtpProviderError("OTP provider blocked this network. Please try again later.", 429, "provider_ip_blocked");
  if (/rate|limit|too many/.test(text)) return new OtpProviderError("OTP provider rate limit reached. Please wait and try again.", 429, "provider_rate_limited");
  if (/expired|already used|already verified/.test(text)) return new OtpProviderError("This OTP has expired. Please request a new OTP.", 401, "otp_expired");
  if (/wrong otp|otp invalid|invalid otp|not match|incorrect/.test(text)) return new OtpProviderError("Incorrect OTP. Please check the code and try again.", 401, "otp_invalid");
  return new OtpProviderError(fallback, 502, "provider_failed");
}

/** MSG91 Widget's custom-UI endpoints all require widgetId in the JSON body. */
export async function requestMsg91Widget(
  config: Msg91Config,
  path: string,
  body: Record<string, string>,
  fetcher: FetchLike = fetch,
): Promise<any> {
  if (!config.authkey) throw new OtpProviderError("OTP service is not configured.", 503, "missing_authkey");
  if (!config.widgetId) throw new OtpProviderError("OTP widget is not configured.", 503, "missing_widget_id");
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetcher(`${config.baseUrl}${path}`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", authkey: config.authkey },
      body: JSON.stringify({ widgetId: config.widgetId, ...body }),
    });
  } catch {
    throw new OtpProviderError("OTP provider is temporarily unavailable. Please try again.", 503, "provider_network");
  }
  const json = await response.json().catch(() => ({})) as any;
  if (!response.ok || json?.type === "error" || json?.success === false) {
    throw providerFailure(json, "OTP provider could not complete the request. Please try again.");
  }
  return json;
}

export type VerifiedIdentity = { phone: string | null; email: string | null };
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phone = (value: unknown) => {
  if (typeof value !== "string") return null;
  const digits = value.replace(/\D/g, "");
  if (/^91[6-9]\d{9}$/.test(digits)) return `+${digits}`;
  return null;
};
const email = (value: unknown) => typeof value === "string" && emailPattern.test(value.trim()) ? value.trim().toLowerCase() : null;

function jwtPayload(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || value.split(".").length !== 3) return null;
  try {
    const b64 = value.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(b64, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch { return null; }
}

/** Extract only a concrete identifier supplied by MSG91's verify response/JWT. */
export function identityFromMsg91(value: unknown): VerifiedIdentity {
  const seen = new Set<unknown>();
  const walk = (candidate: unknown): VerifiedIdentity => {
    const primitive = { phone: phone(candidate), email: email(candidate) };
    if (primitive.phone || primitive.email) return primitive;
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return { phone: null, email: null };
    seen.add(candidate);
    const record = candidate as Record<string, unknown>;
    const direct = {
      phone: phone(record.phone ?? record.mobile ?? record.identifier),
      email: email(record.email ?? record.identifier),
    };
    if (direct.phone || direct.email) return direct;
    for (const nested of Object.values(record)) {
      const fromJwt = jwtPayload(nested);
      const found = fromJwt ? walk(fromJwt) : walk(nested);
      if (found.phone || found.email) return found;
    }
    return { phone: null, email: null };
  };
  return walk(value);
}
