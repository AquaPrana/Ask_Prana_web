import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Session, User } from "@supabase/supabase-js";

const SESSION_KEY = "ask-prana-app-session";
const REGISTRATION_KEY = "ask-prana-registration";

export type AppAccount = {
  id: string;
  phone: string | null;
  email: string | null;
  name: string;
  state: string;
  district: string;
  language: string;
};

export type StoredAppSession = {
  token: string;
  expiresAt: string;
  user: AppAccount;
};

export type PendingRegistration = {
  registrationToken: string;
  phone: string | null;
  email: string | null;
};

function asSession(stored: StoredAppSession): Session {
  const expiresAt = Math.floor(new Date(stored.expiresAt).getTime() / 1000);
  const user = {
    id: stored.user.id,
    aud: "authenticated",
    role: "authenticated",
    email: stored.user.email ?? undefined,
    phone: stored.user.phone ?? undefined,
    app_metadata: {},
    user_metadata: {},
    created_at: new Date().toISOString(),
  } as User;
  return {
    access_token: stored.token,
    refresh_token: stored.token,
    expires_at: expiresAt,
    expires_in: Math.max(expiresAt - Math.floor(Date.now() / 1000), 0),
    token_type: "bearer",
    user,
  };
}

export function isAppSessionToken(token: string | null | undefined): boolean {
  return Boolean(token && token.startsWith("ap_"));
}

export async function saveAppSession(stored: StoredAppSession): Promise<Session> {
  await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(stored));
  await AsyncStorage.removeItem(REGISTRATION_KEY);
  return asSession(stored);
}

export async function loadAppSession(): Promise<Session | null> {
  const raw = await AsyncStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as StoredAppSession;
    if (!stored?.token?.startsWith("ap_") || !stored.user?.id || !stored.expiresAt) return null;
    if (new Date(stored.expiresAt).getTime() <= Date.now()) {
      await AsyncStorage.removeItem(SESSION_KEY);
      return null;
    }
    return asSession(stored);
  } catch {
    await AsyncStorage.removeItem(SESSION_KEY);
    return null;
  }
}

export async function clearAppSession(): Promise<void> {
  await AsyncStorage.removeItem(SESSION_KEY);
}

export async function savePendingRegistration(value: PendingRegistration): Promise<void> {
  await AsyncStorage.setItem(REGISTRATION_KEY, JSON.stringify(value));
}

export async function loadPendingRegistration(): Promise<PendingRegistration | null> {
  const raw = await AsyncStorage.getItem(REGISTRATION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingRegistration;
    if (!parsed?.registrationToken) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function clearPendingRegistration(): Promise<void> {
  await AsyncStorage.removeItem(REGISTRATION_KEY);
}
