import { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { useRootNavigationState, useRouter } from "expo-router";
import { AUTH_SESSION_TIMEOUT_MS, waitForAuthReady, withTimeout } from "../lib/supabase";
import { completeEmailLinkSignIn, logout } from "../services/auth";
import {
  ACCOUNT_DELETED_MESSAGE,
  isCurrentUserDeleted,
} from "../services/profile";
import { Alert } from "react-native";

export default function StartupScreen() {
  const router = useRouter();
  const rootNavigationState = useRootNavigationState();

  useEffect(() => {
    if (!rootNavigationState?.key) return;

    let mounted = true;
    const routeToAskPrana = async () => {
      try {
        // Opened from an email sign-in link (web): finish or report it first.
        const link = await completeEmailLinkSignIn();
        if (!mounted) return;
        if (link.error) {
          router.replace({ pathname: "/phone-login", params: { authError: link.error } } as never);
          return;
        }

        const session = await waitForAuthReady();
        if (!mounted) return;

        if (session?.user) {
          const deleted = await withTimeout(
            isCurrentUserDeleted(),
            AUTH_SESSION_TIMEOUT_MS,
            "isCurrentUserDeleted",
          ).catch(() => false);
          if (deleted) {
            Alert.alert("Account deleted", ACCOUNT_DELETED_MESSAGE);
            await logout();
            if (mounted) router.replace("/phone-login" as never);
            return;
          }
          router.replace("/ask-prana" as never);
          return;
        }

        router.replace("/phone-login" as never);
      } catch (error) {
        console.warn("[startup] auth check failed:", error);
        if (mounted) router.replace("/phone-login" as never);
      }
    };

    void routeToAskPrana();
    return () => {
      mounted = false;
    };
  }, [rootNavigationState?.key, router]);

  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <ActivityIndicator size="large" color="#0F766E" />
    </View>
  );
}
