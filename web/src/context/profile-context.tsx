import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  clearFarmerProfile,
  getFarmerProfile,
  saveFarmerProfile,
  type FarmerProfile,
} from "../services/local-profile";
import {
  getCurrentUserProfile,
  resolveFarmerDisplayName,
  type UserProfile,
} from "../services/profile";
import {
  subscribeToAuthSession,
  waitForAuthReady,
} from "../lib/supabase";

export type AppUserProfile = {
  name: string;
  state: string;
  district: string;
  language: string;
  phone?: string;
  avatarUrl?: string | null;
  avatarUpdatedAt?: string | null;
};

type ProfileContextValue = {
  profile: AppUserProfile | null;
  displayName: string;
  avatarUrl: string | null;
  avatarUpdatedAt: string | null;
  isLoading: boolean;
  refreshProfile: () => Promise<AppUserProfile | null>;
  /** Call only after a successful Supabase profile write. */
  applyProfileUpdate: (next: AppUserProfile) => Promise<void>;
  /** Call after a successful avatar upload/remove. */
  applyAvatarUpdate: (input: {
    avatarUrl: string | null;
    avatarUpdatedAt: string;
  }) => void;
  clearProfile: () => Promise<void>;
};

const ProfileContext = createContext<ProfileContextValue | null>(null);

function toAppProfile(
  profile: UserProfile | FarmerProfile | null | undefined,
): AppUserProfile | null {
  if (!profile) {
    return null;
  }
  const name = profile.name?.trim() ?? "";
  return {
    name,
    state: profile.state?.trim() ?? "",
    district: profile.district?.trim() ?? "",
    language: profile.language?.trim() || "English",
    phone: "phone" in profile ? profile.phone ?? "" : "",
    avatarUrl:
      "avatarUrl" in profile ? (profile.avatarUrl ?? null) : null,
    avatarUpdatedAt:
      "avatarUpdatedAt" in profile
        ? (profile.avatarUpdatedAt ?? null)
        : null,
  };
}

export function ProfileProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<AppUserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const mountedRef = useRef(true);

  const refreshProfile = useCallback(async () => {
    const session = await waitForAuthReady();
    if (!session?.user) {
      if (mountedRef.current) {
        setProfile(null);
        setIsLoading(false);
      }
      return null;
    }

    const { profile: remote, error } = await getCurrentUserProfile();
    const local = await getFarmerProfile();

    let next = toAppProfile(remote);
    if ((!next?.name || error) && local) {
      const fromLocal = toAppProfile(local);
      if (fromLocal) {
        next = {
          ...fromLocal,
          avatarUrl: next?.avatarUrl ?? null,
          avatarUpdatedAt: next?.avatarUpdatedAt ?? null,
          phone: next?.phone || fromLocal.phone,
        };
      }
    }

    if (next?.name && !error) {
      await saveFarmerProfile({
        name: next.name,
        state: next.state,
        district: next.district,
        language: next.language,
      });
    }

    // Keep displayName resolution consistent with Ask Prana fallback chain.
    if (next && !next.name.trim()) {
      const resolved = await resolveFarmerDisplayName(session.user);
      if (resolved && resolved !== "Farmer") {
        next = { ...next, name: resolved };
      }
    }

    if (mountedRef.current) {
      setProfile(next);
      setIsLoading(false);
    }
    return next;
  }, []);

  const applyProfileUpdate = useCallback(async (next: AppUserProfile) => {
    const normalized: AppUserProfile = {
      name: next.name.trim(),
      state: next.state.trim(),
      district: next.district.trim(),
      language: next.language.trim() || "English",
      phone: next.phone?.trim() ?? "",
      avatarUrl: next.avatarUrl ?? null,
      avatarUpdatedAt: next.avatarUpdatedAt ?? null,
    };

    await saveFarmerProfile({
      name: normalized.name,
      state: normalized.state,
      district: normalized.district,
      language: normalized.language,
    });

    if (mountedRef.current) {
      setProfile((current) => ({
        ...normalized,
        avatarUrl:
          normalized.avatarUrl !== undefined
            ? normalized.avatarUrl
            : (current?.avatarUrl ?? null),
        avatarUpdatedAt:
          normalized.avatarUpdatedAt !== undefined
            ? normalized.avatarUpdatedAt
            : (current?.avatarUpdatedAt ?? null),
      }));
      setIsLoading(false);
    }
  }, []);

  const applyAvatarUpdate = useCallback(
    (input: { avatarUrl: string | null; avatarUpdatedAt: string }) => {
      if (!mountedRef.current) {
        return;
      }
      setProfile((current) => {
        if (!current) {
          return {
            name: "",
            state: "",
            district: "",
            language: "English",
            phone: "",
            avatarUrl: input.avatarUrl,
            avatarUpdatedAt: input.avatarUpdatedAt,
          };
        }
        return {
          ...current,
          avatarUrl: input.avatarUrl,
          avatarUpdatedAt: input.avatarUpdatedAt,
        };
      });
    },
    [],
  );

  const clearProfile = useCallback(async () => {
    await clearFarmerProfile();
    if (mountedRef.current) {
      setProfile(null);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refreshProfile();

    const unsubscribe = subscribeToAuthSession((session, event) => {
      if (!session?.user) {
        void clearProfile().finally(() => {
          if (mountedRef.current) {
            setIsLoading(false);
          }
        });
        return;
      }

      if (
        event === "SIGNED_IN" ||
        event === "RESTORED" ||
        event === "TOKEN_REFRESHED" ||
        event === "USER_UPDATED"
      ) {
        void refreshProfile();
      }
    });

    return () => {
      mountedRef.current = false;
      unsubscribe();
    };
  }, [clearProfile, refreshProfile]);

  const displayName = useMemo(() => {
    const name = profile?.name?.trim();
    return name || "Farmer";
  }, [profile?.name]);

  const avatarUrl = profile?.avatarUrl?.trim() || null;
  const avatarUpdatedAt = profile?.avatarUpdatedAt ?? null;

  const value = useMemo(
    () => ({
      profile,
      displayName,
      avatarUrl,
      avatarUpdatedAt,
      isLoading,
      refreshProfile,
      applyProfileUpdate,
      applyAvatarUpdate,
      clearProfile,
    }),
    [
      profile,
      displayName,
      avatarUrl,
      avatarUpdatedAt,
      isLoading,
      refreshProfile,
      applyProfileUpdate,
      applyAvatarUpdate,
      clearProfile,
    ],
  );

  return (
    <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>
  );
}

export function useProfile() {
  const context = useContext(ProfileContext);
  if (!context) {
    throw new Error("useProfile must be used within ProfileProvider");
  }
  return context;
}

/** Safe for components that may render outside the provider during boot. */
export function useOptionalProfile() {
  return useContext(ProfileContext);
}
