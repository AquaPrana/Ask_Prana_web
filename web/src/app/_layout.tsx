import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  LogBox,
  View,
} from "react-native";
import { Stack, usePathname, useRouter } from "expo-router";
import { AskPranaChatProvider } from "../context/ask-prana-chat-context";
import { ProfileProvider } from "../context/profile-context";
import { loadStoredLanguage } from "../i18n";
import { logout } from "../services/auth";
import {
  ACCOUNT_DELETED_MESSAGE,
  isCurrentUserDeleted,
} from "../services/profile";
import {
  initializeAuthSession,
  setInvalidSessionHandler,
  subscribeToAuthSession,
} from "../lib/supabase";

// Transient offline/network noise must never block the farmer with a red overlay.
LogBox.ignoreLogs([
  "Failed to fetch",
  "Network request failed",
  "NetworkError",
  "network unavailable",
]);

export default function RootLayout() {
  const router = useRouter();
  const pathname = usePathname();
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    let mounted = true;
    // Resolve the saved language before the first screen renders so Ask Prana
    // never paints English and then switches to Hindi/Telugu.
    void Promise.all([loadStoredLanguage(), initializeAuthSession()]).finally(() => {
      if (mounted) setAuthReady(true);
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(
    () =>
      setInvalidSessionHandler(() => {
        router.replace("/phone-login" as never);
      }),
    [router],
  );

  useEffect(() => {
    if (!authReady) return;

    const loginFlowRoute =
      pathname === "/" ||
      pathname === "/phone-login" ||
      pathname === "/verify-otp" ||
      pathname === "/edit-profile" ||
      // Email-login code entry happens before there is a session.
      pathname === "/verify-email";

    let mounted = true;
    const blockDeletedAccount = async () => {
      if (loginFlowRoute) return;
      const deleted = await isCurrentUserDeleted();
      if (!mounted || !deleted) return;
      Alert.alert("Account deleted", ACCOUNT_DELETED_MESSAGE);
      await logout();
      router.replace("/phone-login" as never);
    };

    void blockDeletedAccount();
    const unsubscribeAuth = subscribeToAuthSession((_session, event) => {
      // No session (logout, expiry, direct URL): private screens must not stay open.
      if (!_session?.user) {
        if (!loginFlowRoute) router.replace("/phone-login" as never);
        return;
      }
      if (
        _session?.user &&
        (event === "SIGNED_IN" || event === "RESTORED" || event === "TOKEN_REFRESHED")
      ) {
        void blockDeletedAccount();
      }
    });

    return () => {
      mounted = false;
      unsubscribeAuth();
    };
  }, [authReady, pathname, router]);

  if (!authReady) {
    return <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <ActivityIndicator size="large" color="#0A84FF" />
    </View>;
  }

  return <ProfileProvider>
    <AskPranaChatProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </AskPranaChatProvider>
  </ProfileProvider>;
}
