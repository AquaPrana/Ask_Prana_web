import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { UserAvatar } from "../components/user-avatar";
import { useProfile } from "../context/profile-context";
import {
  pickProfilePhotoCandidate,
  promptProfilePhotoAction,
  removeProfilePhoto,
  uploadPreparedProfilePhoto,
} from "../lib/profile-photo";
import { subscribeToAuthSession, supabase } from "../lib/supabase";
import { logout } from "../services/auth";
import { isAppSessionToken, loadAppSession, loadPendingRegistration } from "../services/app-session";
import {
  type AuthEmailState,
  getCurrentUserEmailState,
  getCurrentUserProfile,
  isValidEmail,
  normalizeEmail,
  registerAskPranaAccount,
  requestCurrentUserEmailChange,
  resendEmailChangeVerification,
  updateCurrentUserProfile,
} from "../services/profile";

const colors = {
  background: "#171717",
  card: "#212121",
  border: "#363636",
  text: "#F5F5F5",
  muted: "#A0A0A0",
  primary: "#4F8CF7",
  danger: "#F87171",
  success: "#34D399",
  warning: "#FBBF24",
};

const EMAIL_STATUS_BADGE: Record<AuthEmailState["status"], { text: string; color: string }> = {
  none: { text: "Email not added", color: colors.muted },
  verified: { text: "Verified", color: colors.success },
  unverified: { text: "Not verified", color: colors.warning },
  pending: { text: "Verification pending", color: colors.warning },
};

const VERIFICATION_SENT_MESSAGE =
  "A verification code was sent to your new email address. Enter that code to confirm it.";

export default function EditProfileScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ mode?: string }>();
  const registerMode = params.mode === "register";
  const [lockedPhone, setLockedPhone] = useState(false);
  const [lockedEmail, setLockedEmail] = useState(false);
  const { t } = useTranslation();
  const { applyProfileUpdate, applyAvatarUpdate } = useProfile();
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  // Email as the Supabase Auth account currently holds it (confirmed + pending).
  const [emailState, setEmailState] = useState<AuthEmailState | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailNotice, setEmailNotice] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  // True once the farmer types in the Email field, so refreshes never overwrite it.
  const emailDirtyRef = useRef(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [state, setState] = useState("");
  const [district, setDistrict] = useState("");
  const [language, setLanguage] = useState("English");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarUpdatedAt, setAvatarUpdatedAt] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);

  const applyEmailState = useCallback((next: AuthEmailState) => {
    setEmailState(next);
    if (!emailDirtyRef.current) setEmail(next.pendingEmail || next.email);
    if (next.status !== "pending") setEmailNotice(null);
  }, []);

  /** Re-reads the Auth user from the server, e.g. after the verification link. */
  const refreshEmailState = useCallback(async () => {
    const appSession = await loadAppSession();
    if (isAppSessionToken(appSession?.access_token)) return;
    const { state: next } = await getCurrentUserEmailState();
    if (next) applyEmailState(next);
  }, [applyEmailState]);

  const loadProfile = useCallback(async () => {
    setLoading(true);
    const appSession = await loadAppSession();
    const hasAppSession = isAppSessionToken(appSession?.access_token);

    if (registerMode && !hasAppSession) {
      const pending = await loadPendingRegistration();
      if (!pending) {
        router.replace("/phone-login" as never);
        return;
      }
      setName("");
      setPhone(pending.phone ?? "");
      setEmail(pending.email ?? "");
      setLockedPhone(Boolean(pending.phone));
      setLockedEmail(Boolean(pending.email));
      setState("");
      setDistrict("");
      setLanguage("English");
      setLoading(false);
      return;
    }

    if (!hasAppSession) {
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      if (userError || !user) {
        router.replace("/phone-login" as never);
        return;
      }
    }

    const { profile, error } = await getCurrentUserProfile();
    if (error) {
      Alert.alert("Unable to load profile", error.message);
      setLoading(false);
      return;
    }

    // Set once when the profile loads (never on every render), so typing is kept.
    emailDirtyRef.current = false;
    if (hasAppSession) {
      const accountEmail = profile?.email || appSession?.user.email || "";
      setEmail(accountEmail);
      setEmailState({
        email: accountEmail,
        pendingEmail: "",
        status: accountEmail ? "verified" : "none",
      });
    } else {
      const { state: authEmail } = await getCurrentUserEmailState();
      if (authEmail) applyEmailState(authEmail);
    }
    setName(profile?.name ?? "");
    setPhone(profile?.phone ?? appSession?.user.phone ?? "");
    setState(profile?.state ?? "");
    setDistrict(profile?.district ?? "");
    setLanguage(profile?.language ?? "English");
    setAvatarUrl(profile?.avatarUrl ?? null);
    setAvatarUpdatedAt(profile?.avatarUpdatedAt ?? null);
    setLoading(false);
  }, [applyEmailState, registerMode, router]);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  // Pick up a confirmation done in the email app or another tab: on screen
  // focus, on browser tab focus, and when the verification link updates the session.
  useFocusEffect(
    useCallback(() => {
      void refreshEmailState();
    }, [refreshEmailState]),
  );
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const onFocus = () => void refreshEmailState();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshEmailState]);
  useEffect(() => {
    const unsubscribe = subscribeToAuthSession((session, event) => {
      if (session?.user && (event === "USER_UPDATED" || event === "SIGNED_IN")) {
        void refreshEmailState();
      }
    });
    return () => {
      unsubscribe();
    };
  }, [refreshEmailState]);

  // New accounts arrive here straight from OTP verification (profile setup)
  // with no screen behind them, so continue into Ask Prana instead.
  const changePhoto = async () => {
    if (registerMode || photoBusy) return;
    const action = await promptProfilePhotoAction(Boolean(avatarUrl));
    if (action === "cancel") return;
    setPhotoError(null);
    setPhotoBusy(true);
    try {
      if (action === "remove") {
        const removed = await removeProfilePhoto(avatarUrl);
        if (removed.error || !removed.updatedAt) {
          setPhotoError(removed.error ?? "Unable to remove your profile photo.");
          return;
        }
        setAvatarUrl(null);
        setAvatarUpdatedAt(removed.updatedAt);
        applyAvatarUpdate({ avatarUrl: null, avatarUpdatedAt: removed.updatedAt });
        return;
      }
      const picked = await pickProfilePhotoCandidate(action);
      if (picked.canceled) return;
      if (picked.error || !picked.localUri) {
        setPhotoError(picked.error ?? "Unable to select a profile photo.");
        return;
      }
      const uploaded = await uploadPreparedProfilePhoto(picked.localUri, avatarUrl);
      if (uploaded.error || !uploaded.data) {
        setPhotoError(uploaded.error ?? "Unable to upload profile photo.");
        return;
      }
      setAvatarUrl(uploaded.data.remoteUrl);
      setAvatarUpdatedAt(uploaded.data.updatedAt);
      applyAvatarUpdate({
        avatarUrl: uploaded.data.remoteUrl,
        avatarUpdatedAt: uploaded.data.updatedAt,
      });
    } finally {
      setPhotoBusy(false);
    }
  };

  const leaveScreen = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/ask-prana" as never);
  };

  const save = async () => {
    if (!name.trim()) {
      setSaveNotice(null);
      setSaveError("Please enter your full name.");
      return;
    }
    // Validate on save only (typing is never blocked) and before any request.
    const nextEmail = normalizeEmail(email);
    const currentEmail = normalizeEmail(emailState?.pendingEmail || emailState?.email || "");
    const emailChanged = nextEmail !== currentEmail;
    if (nextEmail && !isValidEmail(nextEmail)) {
      setEmailError("Please enter a valid email address, for example farmer@example.com.");
      return;
    }
    if (!nextEmail && currentEmail) {
      setEmailError("Email can't be removed once added. Enter a new email address or keep the current one.");
      return;
    }
    setEmailError(null);
    setSaveNotice(null);
    setSaveError(null);
    setSaving(true);
    try {
      if (registerMode) {
        const created = await registerAskPranaAccount({
          name: name.trim(),
          phone: phone.trim(),
          email: nextEmail,
          state: state.trim(),
          district: district.trim(),
          language: language.trim() || "English",
        });
        if (created.error) {
          Alert.alert("Unable to create account", created.error);
          return;
        }
        router.replace("/ask-prana" as never);
        return;
      }
      const appSession = await loadAppSession();
      const { error } = await updateCurrentUserProfile({
        name: name.trim(),
        phone: phone.trim(),
        email: appSession ? nextEmail : undefined,
        state: state.trim(),
        district: district.trim(),
        language: language.trim() || "English",
      });
      if (error) {
        setSaveError(error.message);
        return;
      }
      const { profile: savedProfile, error: reloadError } = await getCurrentUserProfile();
      if (!reloadError && savedProfile) {
        await applyProfileUpdate({
          name: savedProfile.name,
          state: savedProfile.state,
          district: savedProfile.district,
          language: savedProfile.language,
          phone: savedProfile.phone ?? "",
          avatarUrl: savedProfile.avatarUrl ?? null,
          avatarUpdatedAt: savedProfile.avatarUpdatedAt ?? null,
        });
        setName(savedProfile.name);
        setPhone(savedProfile.phone ?? "");
        setState(savedProfile.state);
        setDistrict(savedProfile.district);
        setLanguage(savedProfile.language || "English");
        if (savedProfile.email) setEmail(savedProfile.email);
        setAvatarUrl(savedProfile.avatarUrl ?? null);
        setAvatarUpdatedAt(savedProfile.avatarUpdatedAt ?? null);
      }

      // Unchanged email (ignoring case/whitespace) sends no Auth request.
      if (!appSession && emailChanged && nextEmail) {
        // Email belongs to the Supabase Auth account, not the users table.
        const result = await requestCurrentUserEmailChange(nextEmail);
        if (result.error) {
          setEmailError(`Your other details were saved. ${result.error}`);
          return;
        }
        emailDirtyRef.current = false;
        setEmail(nextEmail);
        if (result.state) applyEmailState(result.state);
        if (!result.state || result.state.status === "pending") {
          // Not changed until the emailed code is verified for this same account.
          setEmailNotice(VERIFICATION_SENT_MESSAGE);
          openEmailVerification(nextEmail);
          return;
        }
      }

      setSaveError(null);
      router.replace("/ask-prana" as never);
    } finally {
      setSaving(false);
    }
  };

  /** Code entry for an email change already requested for this account. */
  const openEmailVerification = (address: string) => {
    router.push({
      pathname: "/verify-email",
      params: { email: address, sent: "1", next: "back" },
    } as never);
  };

  const resendVerification = async () => {
    const pending = emailState?.pendingEmail;
    if (!pending || resending) return;
    setResending(true);
    setEmailError(null);
    const { error } = await resendEmailChangeVerification(pending);
    setResending(false);
    if (error) {
      setEmailError(error);
      return;
    }
    setEmailNotice(`Verification email sent again to ${pending}. Please check your inbox and spam folder.`);
  };

  const confirmLogout = async () => {
    setLoggingOut(true);
    setLogoutError(null);
    const { error } = await logout();
    setLoggingOut(false);
    if (error) {
      // Stay signed in and tell the farmer; never pretend logout succeeded.
      setLogoutError(t("profile.logoutFailed"));
      return;
    }
    setLogoutConfirmOpen(false);
    // Drop private screens from the stack so Back cannot reopen them.
    if (router.canDismiss()) router.dismissAll();
    router.replace("/phone-login" as never);
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.loading}><ActivityIndicator color={colors.primary} /></View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <Pressable onPress={leaveScreen} style={styles.backButton} accessibilityRole="button" accessibilityLabel="Go back">
          <Feather name="arrow-left" size={20} color={colors.text} />
        </Pressable>
        <Text style={styles.title}>{registerMode ? "Create your Ask Prana account" : "Edit profile"}</Text>
        <View style={styles.backButton} />
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {registerMode ? null : (
          <View style={styles.photoBlock}>
            <UserAvatar
              name={name}
              avatarUrl={avatarUrl}
              avatarUpdatedAt={avatarUpdatedAt}
              size={88}
              variant="solid"
              showEditBadge
              loading={photoBusy}
              onPress={() => void changePhoto()}
            />
            {photoError ? <Text style={styles.photoError}>{photoError}</Text> : null}
          </View>
        )}
        <Text style={styles.caption}>{registerMode ? "This code is verified. Add your details to finish." : "Your account details"}</Text>
        <Field label="Full name" value={name} onChangeText={setName} autoCapitalize="words" />
        <Field
          label="Email"
          badge={emailState ? EMAIL_STATUS_BADGE[emailState.status] : null}
          value={email}
          onChangeText={(value) => {
            emailDirtyRef.current = true;
            setEmail(value);
            if (emailError) setEmailError(null);
          }}
          keyboardType="email-address"
          inputMode="email"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          textContentType="emailAddress"
          editable={!lockedEmail}
          placeholder="farmer@example.com"
          error={emailError}
          hint={
            emailNotice ??
            (emailState?.status === "pending"
              ? `Waiting for confirmation of ${emailState.pendingEmail}. Open the link sent to that address to finish the change.`
              : null)
          }
        />
        {emailState?.status === "pending" ? (
          <Pressable
            onPress={() => openEmailVerification(emailState.pendingEmail)}
            style={({ pressed }) => [styles.resendLink, pressed && styles.resendLinkPressed]}
            accessibilityRole="button"
          >
            <Text style={styles.resendLinkText}>Enter verification code</Text>
          </Pressable>
        ) : null}
        {emailState?.status === "pending" ? (
          <Pressable
            onPress={() => void resendVerification()}
            disabled={resending}
            style={({ pressed }) => [styles.resendLink, (pressed || resending) && styles.resendLinkPressed]}
            accessibilityRole="button"
          >
            {resending ? <ActivityIndicator size="small" color={colors.primary} /> : null}
            <Text style={styles.resendLinkText}>Resend verification email</Text>
          </Pressable>
        ) : null}
        <Field label="Phone number" value={phone} onChangeText={setPhone} keyboardType="phone-pad" editable={!lockedPhone} />
        <Field label="State" value={state} onChangeText={setState} autoCapitalize="words" />
        <Field label="District" value={district} onChangeText={setDistrict} autoCapitalize="words" />
        <Field label="Language" value={language} onChangeText={setLanguage} autoCapitalize="words" />
        <Pressable onPress={() => void save()} disabled={saving} style={[styles.saveButton, saving && styles.saveButtonDisabled]} accessibilityRole="button">
          {saving ? <ActivityIndicator color={colors.text} /> : <Text style={styles.saveText}>{registerMode ? "Create account" : "Save changes"}</Text>}
        </Pressable>
        {saveNotice ? <Text style={styles.saveNotice} accessibilityLiveRegion="polite">{saveNotice}</Text> : null}
        {saveError ? <Text style={styles.saveError} accessibilityLiveRegion="polite">{saveError}</Text> : null}
        {registerMode ? null : (
          <Pressable
            onPress={() => {
              setLogoutError(null);
              setLogoutConfirmOpen(true);
            }}
            style={({ pressed, hovered }) => [styles.logoutButton, hovered && styles.logoutButtonHovered, pressed && styles.logoutButtonPressed]}
            accessibilityRole="button"
            accessibilityLabel={t("profile.logout")}
          >
            <Feather name="log-out" size={17} color={colors.danger} />
            <Text style={styles.logoutText}>{t("profile.logout")}</Text>
          </Pressable>
        )}
      </ScrollView>
      <Modal visible={logoutConfirmOpen} transparent animationType="fade" onRequestClose={() => !loggingOut && setLogoutConfirmOpen(false)}>
        <View style={styles.logoutScreen}>
          <Text style={styles.logoutTitle}>Log out of Ask Prana?</Text>
          <View style={styles.logoutAccount}>
            <UserAvatar name={name} avatarUrl={avatarUrl} avatarUpdatedAt={avatarUpdatedAt} size={36} variant="solid" />
            <View style={styles.logoutAccountCopy}>
              <Text style={styles.logoutName} numberOfLines={1}>{name || "Ask Prana"}</Text>
              <Text style={styles.logoutEmail} numberOfLines={1}>{email || phone}</Text>
            </View>
          </View>
          <Text style={styles.logoutHint}>You'll need to log in again to access your chats.</Text>
          {logoutError ? <Text style={styles.dialogError}>{logoutError}</Text> : null}
          <Pressable onPress={() => void confirmLogout()} disabled={loggingOut} style={[styles.logoutConfirm, loggingOut && styles.saveButtonDisabled]} accessibilityRole="button">
            {loggingOut ? <ActivityIndicator color="#171717" /> : <Text style={styles.logoutConfirmText}>Log out</Text>}
          </Pressable>
          <Pressable onPress={() => setLogoutConfirmOpen(false)} disabled={loggingOut} style={styles.logoutCancel} accessibilityRole="button">
            <Text style={styles.logoutCancelText}>Cancel</Text>
          </Pressable>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function Field({ label, editable = true, error, hint, badge, ...inputProps }: React.ComponentProps<typeof TextInput> & { label: string; error?: string | null; hint?: string | null; badge?: { text: string; color: string } | null }) {
  return <View style={styles.field}><View style={styles.labelRow}><Text style={styles.label}>{label}</Text>{badge ? <Text style={[styles.badge, { color: badge.color, borderColor: badge.color }]}>{badge.text}</Text> : null}</View><TextInput {...inputProps} editable={editable} style={[styles.input, !editable && styles.inputDisabled, error ? styles.inputError : null]} placeholderTextColor={colors.muted} />{error ? <Text style={styles.errorText} accessibilityLiveRegion="polite">{error}</Text> : hint ? <Text style={styles.hintText}>{hint}</Text> : null}</View>;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: { height: 58, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: colors.border },
  backButton: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 20 },
  title: { color: colors.text, fontSize: 18, lineHeight: 23, fontWeight: "600" },
  content: { width: "100%", maxWidth: 520, alignSelf: "center", padding: 20, gap: 16 },
  caption: { color: colors.muted, fontSize: 14, lineHeight: 20, fontWeight: "400", marginBottom: 4 },
  photoBlock: { alignItems: "center", gap: 8 },
  photoError: { color: colors.danger, fontSize: 13, lineHeight: 18, fontWeight: "500", textAlign: "center" },
  field: { gap: 7 },
  label: { color: colors.text, fontSize: 14, lineHeight: 20, fontWeight: "500" },
  input: { minHeight: 46, color: colors.text, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 12, fontSize: 15, lineHeight: 21, fontWeight: "400" },
  inputDisabled: { color: colors.muted, opacity: 0.8 },
  inputError: { borderColor: colors.danger },
  errorText: { color: colors.danger, fontSize: 13, lineHeight: 18, fontWeight: "500" },
  labelRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  badge: { fontSize: 12, lineHeight: 16, fontWeight: "600", borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, overflow: "hidden" },
  resendLink: { flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start", marginTop: -8, paddingVertical: 4 },
  resendLinkPressed: { opacity: 0.6 },
  resendLinkText: { color: colors.primary, fontSize: 13, lineHeight: 18, fontWeight: "600" },
  hintText: { color: colors.muted, fontSize: 13, lineHeight: 18, fontWeight: "400" },
  saveButton: { minHeight: 46, marginTop: 8, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: "#0F766E" },
  saveButtonDisabled: { opacity: 0.6 },
  saveText: { color: colors.text, fontSize: 14, lineHeight: 20, fontWeight: "600" },
  saveNotice: { color: colors.success, fontSize: 15, lineHeight: 21, fontWeight: "600", textAlign: "center" },
  saveError: { color: colors.danger, fontSize: 14, lineHeight: 20, fontWeight: "600", textAlign: "center" },
  logoutButton: { minHeight: 46, flexDirection: "row", gap: 8, borderRadius: 8, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  logoutButtonHovered: { borderColor: colors.danger },
  logoutButtonPressed: { opacity: 0.7 },
  logoutText: { color: colors.danger, fontSize: 14, lineHeight: 20, fontWeight: "600" },
  dialogError: { color: colors.danger, fontSize: 13, lineHeight: 19, fontWeight: "500", textAlign: "center" },
  logoutScreen: { flex: 1, backgroundColor: "#000000", alignItems: "center", justifyContent: "center", paddingHorizontal: 24, gap: 16 },
  logoutTitle: { color: "#FFFFFF", fontSize: 28, lineHeight: 34, fontWeight: "600", textAlign: "center", marginBottom: 8 },
  logoutAccount: { width: "100%", maxWidth: 360, minHeight: 64, borderRadius: 16, borderWidth: 1, borderColor: "#3A3A3A", paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 12 },
  logoutAccountCopy: { flex: 1, minWidth: 0 },
  logoutName: { color: "#FFFFFF", fontSize: 15, lineHeight: 20, fontWeight: "600" },
  logoutEmail: { color: "#A3A3A3", fontSize: 13, lineHeight: 18 },
  logoutHint: { color: "#D4D4D4", fontSize: 14, lineHeight: 20, textAlign: "center" },
  logoutConfirm: { width: "100%", maxWidth: 360, minHeight: 48, borderRadius: 24, backgroundColor: "#FFFFFF", alignItems: "center", justifyContent: "center" },
  logoutConfirmText: { color: "#171717", fontSize: 16, lineHeight: 22, fontWeight: "600" },
  logoutCancel: { width: "100%", maxWidth: 360, minHeight: 48, borderRadius: 24, borderWidth: 1, borderColor: "#5A5A5A", alignItems: "center", justifyContent: "center" },
  logoutCancelText: { color: "#FFFFFF", fontSize: 16, lineHeight: 22, fontWeight: "500" },
});
