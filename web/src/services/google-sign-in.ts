import { Platform } from "react-native";
import { acceptAuthenticatedSession, supabase } from "../lib/supabase";
import { saveAppSession, savePendingRegistration, type AppAccount } from "./app-session";

const NONCE_KEY = "ask-prana-google-nonce";

type GooglePayload = {
  success?: boolean;
  error?: unknown;
  isNewUser?: boolean;
  clientId?: unknown;
  registrationToken?: unknown;
  verifiedIdentifier?: { email?: unknown };
  user?: AppAccount;
  session?: { token?: unknown; expiresAt?: unknown };
};

function webWindow(): Window | null {
  if (Platform.OS !== "web" || typeof window === "undefined") return null;
  return window;
}

const GOOGLE_AUTH_TIMEOUT_MS = 15_000;

async function invokeGoogle(body: Record<string, unknown>): Promise<GooglePayload | null> {
  // Never leave the button stuck on "Opening Google..." if the network or the
  // browser stalls the request: give up after 15s and show the normal error.
  const result = await Promise.race([
    supabase.functions.invoke("google-auth", { body }),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), GOOGLE_AUTH_TIMEOUT_MS)),
  ]);
  if (!result) {
    console.warn("[google-sign-in] google-auth request timed out");
    return null;
  }
  const { data, error } = result;
  if (data && typeof data === "object") return data as GooglePayload;
  const context = (error as { context?: { json?: () => Promise<unknown> } } | null)?.context;
  if (context && typeof context.json === "function") {
    try {
      return (await context.json()) as GooglePayload;
    } catch {
      return null;
    }
  }
  return null;
}

export function beginGoogleAccountChooser(clientId: string): void {
  const page = webWindow();
  if (!page) return;
  const nonce = page.crypto.randomUUID().replace(/-/g, "");
  page.sessionStorage.setItem(NONCE_KEY, nonce);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", `${page.location.origin}/phone-login`);
  url.searchParams.set("response_type", "id_token");
  url.searchParams.set("scope", "openid email");
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("prompt", "consent select_account");
  url.searchParams.set("response_mode", "fragment");
  page.location.assign(url.toString());
}

export async function startGoogleSignIn(): Promise<{ error: string | null }> {
  if (!webWindow()) return { error: "Google sign-in opens in the browser." };
  const data = await invokeGoogle({ action: "client" });
  const clientId = typeof data?.clientId === "string" ? data.clientId.trim() : "";
  if (!data || data.success !== true || !clientId) {
    return { error: "Google sign-in is unavailable." };
  }
  beginGoogleAccountChooser(clientId);
  return { error: null };
}

export function takeGoogleReturn(): { idToken: string; nonce: string } | { error: string } | null {
  const page = webWindow();
  if (!page || !page.location.hash.includes("id_token") && !page.location.hash.includes("error=")) return null;
  const hash = new URLSearchParams(page.location.hash.replace(/^#/, ""));
  page.history.replaceState(null, "", `${page.location.pathname}${page.location.search}`);
  const nonce = page.sessionStorage.getItem(NONCE_KEY) ?? "";
  page.sessionStorage.removeItem(NONCE_KEY);
  const returnedError = hash.get("error");
  if (returnedError) {
    return { error: returnedError === "redirect_uri_mismatch"
      ? "Google could not return to Ask Prana. Add this site as a redirect URI on the Google client."
      : "Google sign-in was cancelled." };
  }
  const idToken = hash.get("id_token") ?? "";
  if (!idToken || !nonce) return { error: "Google sign-in could not be verified." };
  return { idToken, nonce };
}

export async function finishGoogleSignIn(proof: { idToken: string; nonce: string }): Promise<{
  isNewUser: boolean;
  error: string | null;
}> {
  const data = await invokeGoogle({ action: "sign-in", idToken: proof.idToken, nonce: proof.nonce });
  if (!data || data.success !== true) {
    return { isNewUser: false, error: typeof data?.error === "string" ? data.error : "Google sign-in could not be verified." };
  }
  if (data.isNewUser === true && typeof data.registrationToken === "string") {
    const email = typeof data.verifiedIdentifier?.email === "string" ? data.verifiedIdentifier.email : null;
    await savePendingRegistration({ registrationToken: data.registrationToken, phone: null, email });
    return { isNewUser: true, error: null };
  }
  const user = data.user;
  const session = data.session;
  if (!user?.id || typeof session?.token !== "string" || typeof session.expiresAt !== "string") {
    return { isNewUser: false, error: "Unable to sign in. Please try again." };
  }
  const appSession = await saveAppSession({ token: session.token, expiresAt: session.expiresAt, user });
  acceptAuthenticatedSession(appSession);
  return { isNewUser: false, error: null };
}
