import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { UserAvatar } from "../components/user-avatar";
import { PranaHeader, PranaHeaderButton } from "../components/prana-header";
import { PRANA_FONT, prana, pranaGradientStyle } from "../constants/prana-theme";
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

// AskPrana cream / teal theme.
const colors = {
  background: prana.cream,
  card: prana.card,
  border: prana.inputBorder,
  text: prana.ink,
  muted: "#8A9B8B",
  primary: prana.teal,
  danger: "#9E4B3D",
  success: "#2E7767",
  warning: "#A06A1B",
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
  const { width: windowWidth } = useWindowDimensions();
  const isDesktop = windowWidth >= 1024;
  const [lockedPhone, setLockedPhone] = useState(false);
  const [lockedEmail, setLockedEmail] = useState(false);
  const { t } = useTranslation();
  const { applyProfileUpdate, applyAvatarUpdate } = useProfile();
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [logoutHovered, setLogoutHovered] = useState(false);
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
      <View style={styles.safeArea}>
        <View style={styles.loading}><ActivityIndicator color={colors.primary} /></View>
      </View>
    );
  }

  const emailField = (
    <>
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
    </>
  );

  return (
    <View style={styles.safeArea}>
      {isDesktop ? (
        <PranaHeader
          variant="light"
          left={<PranaHeaderButton icon="arrow-left" tone="light" onPress={leaveScreen} label="Go back" />}
        />
      ) : (
        <PranaHeader
          variant="wave"
          left={<PranaHeaderButton icon="message-square" onPress={leaveScreen} label="Go back" />}
          right={<View style={{ width: 42 }} />}
        />
      )}
      <ScrollView
        contentContainerStyle={[styles.content, isDesktop && styles.contentDesktop]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={[styles.inner, isDesktop && styles.card]}>
        <Pressable onPress={leaveScreen} style={styles.backLink} accessibilityRole="button" accessibilityLabel="Go back">
          <Feather name="arrow-left" size={13} color="#217C73" />
          <Text style={styles.backLinkText}>Chat</Text>
        </Pressable>
        <Text style={styles.kicker}>{registerMode ? "CREATE ACCOUNT" : "ACCOUNT"}</Text>
        <Text style={styles.title}>{registerMode ? "Create your Ask Prana account" : "Your profile"}</Text>
        <Text style={styles.caption}>{registerMode ? "This code is verified. Add your details to finish." : "Keep your account details up to date."}</Text>
        {registerMode ? null : (
          <View style={styles.photoBlock}>
            <UserAvatar
              name={name}
              avatarUrl={avatarUrl}
              avatarUpdatedAt={avatarUpdatedAt}
              size={66}
              variant="solid"
              loading={photoBusy}
              onPress={() => void changePhoto()}
            />
            <Pressable onPress={() => void changePhoto()} disabled={photoBusy} accessibilityRole="button" style={styles.changePhoto}>
              <Text style={styles.changePhotoText}>Change photo</Text>
            </Pressable>
          </View>
        )}
        {photoError ? <Text style={styles.photoError}>{photoError}</Text> : null}
        <Field label="Full name" value={name} onChangeText={setName} autoCapitalize="words" />
        <Field label="Mobile number" value={phone} onChangeText={setPhone} keyboardType="phone-pad" editable={!lockedPhone} />
        {emailField}
        <View style={styles.grid}>
          <View style={styles.gridCell}>
            <Field label="State" value={state} onChangeText={setState} autoCapitalize="words" />
          </View>
          <View style={styles.gridCell}>
            <Field label="District" value={district} onChangeText={setDistrict} autoCapitalize="words" />
          </View>
        </View>
        <Field label="Preferred language" value={language} onChangeText={setLanguage} autoCapitalize="words" />
        <Pressable onPress={() => void save()} disabled={saving} style={[styles.saveButton, pranaGradientStyle, saving && styles.saveButtonDisabled]} accessibilityRole="button">
          {saving ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.saveText}>{registerMode ? "Create account" : "Save changes"}</Text>}
        </Pressable>
        {saveNotice ? <Text style={styles.saveNotice} accessibilityLiveRegion="polite">{saveNotice}</Text> : null}
        {saveError ? <Text style={styles.saveError} accessibilityLiveRegion="polite">{saveError}</Text> : null}
        {registerMode ? null : (
          <Pressable
            onPress={() => {
              setLogoutError(null);
              setLogoutConfirmOpen(true);
            }}
            style={({ pressed }) => [
              styles.logoutButton,
              logoutHovered && styles.logoutButtonHovered,
              pressed && styles.logoutButtonPressed,
            ]}
            onHoverIn={() => setLogoutHovered(true)}
            onHoverOut={() => setLogoutHovered(false)}
            accessibilityRole="button"
            accessibilityLabel={t("profile.logout")}
          >
            <Text style={styles.logoutText}>Sign out</Text>
          </Pressable>
        )}
        </View>
      </ScrollView>
      <Modal visible={logoutConfirmOpen} transparent animationType="fade" onRequestClose={() => !loggingOut && setLogoutConfirmOpen(false)}>
        <View style={styles.logoutScreen}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => !loggingOut && setLogoutConfirmOpen(false)}
            accessibilityLabel="Cancel"
          />
          <View style={styles.logoutCard}>
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
            {loggingOut ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.logoutConfirmText}>Log out</Text>}
          </Pressable>
          <Pressable onPress={() => setLogoutConfirmOpen(false)} disabled={loggingOut} style={styles.logoutCancel} accessibilityRole="button">
            <Text style={styles.logoutCancelText}>Cancel</Text>
          </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function Field({ label, editable = true, error, hint, badge, ...inputProps }: React.ComponentProps<typeof TextInput> & { label: string; error?: string | null; hint?: string | null; badge?: { text: string; color: string } | null }) {
  return <View style={styles.field}><View style={styles.labelRow}><Text style={styles.label}>{label}</Text>{badge ? <Text style={[styles.badge, { color: badge.color, borderColor: badge.color }]}>{badge.text}</Text> : null}</View><TextInput {...inputProps} editable={editable} style={[styles.input, !editable && styles.inputDisabled, error ? styles.inputError : null]} placeholderTextColor={colors.muted} />{error ? <Text style={styles.errorText} accessibilityLiveRegion="polite">{error}</Text> : hint ? <Text style={styles.hintText}>{hint}</Text> : null}</View>;
}

const F = PRANA_FONT;

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: prana.cream },
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  content: { flexGrow: 1, paddingBottom: 32 },
  contentDesktop: { alignItems: "center", paddingTop: 32 },
  inner: { width: "100%", maxWidth: 540, alignSelf: "center", paddingHorizontal: 24, paddingTop: 10 },
  card: {
    maxWidth: 560,
    paddingHorizontal: 36,
    paddingVertical: 28,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: prana.line,
    shadowColor: "#1D4B36",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.08,
    shadowRadius: 30,
  },
  backLink: { flexDirection: "row", alignItems: "center", gap: 5, alignSelf: "flex-start", minHeight: 40, paddingRight: 8, marginBottom: 6 },
  backLinkText: { color: "#217C73", fontFamily: F, fontSize: 12, lineHeight: 16, fontWeight: "700" },
  kicker: { color: prana.tealText, fontFamily: F, fontSize: 10, lineHeight: 13, fontWeight: "800", letterSpacing: 1.1, marginBottom: 8 },
  title: { color: prana.ink, fontFamily: F, fontSize: 29, lineHeight: 34, fontWeight: "800", marginBottom: 12 },
  caption: { color: prana.muted, fontFamily: F, fontSize: 13, lineHeight: 21, marginBottom: 24 },
  photoBlock: { flexDirection: "row", alignItems: "center", gap: 16, marginBottom: 26 },
  changePhoto: { minHeight: 31, justifyContent: "center" },
  changePhotoText: { color: "#217C73", fontFamily: F, fontSize: 12, lineHeight: 16, fontWeight: "700" },
  photoError: { color: colors.danger, fontFamily: F, fontSize: 12, lineHeight: 18, marginTop: -16, marginBottom: 12 },
  field: { gap: 9, marginBottom: 17 },
  grid: { flexDirection: "row", gap: 11 },
  gridCell: { flex: 1, minWidth: 0 },
  label: { color: prana.ink, fontFamily: F, fontSize: 12, lineHeight: 16, fontWeight: "700" },
  input: {
    minHeight: 51,
    color: prana.ink,
    backgroundColor: prana.card,
    borderWidth: 1.4,
    borderColor: prana.inputBorder,
    borderRadius: 11,
    paddingHorizontal: 12,
    fontFamily: F,
    fontSize: 13,
    lineHeight: 19,
    fontWeight: "400",
    ...(Platform.OS === "web" ? ({ outlineStyle: "none", outlineWidth: 0 } as object) : null),
  },
  inputDisabled: { color: "#6E8476", backgroundColor: "#F2F2DE" },
  inputError: { borderColor: colors.danger },
  errorText: { color: colors.danger, fontFamily: F, fontSize: 12, lineHeight: 17 },
  labelRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  badge: { fontFamily: F, fontSize: 10, lineHeight: 14, fontWeight: "700", borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, overflow: "hidden" },
  resendLink: { flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start", marginTop: -8, marginBottom: 12, paddingVertical: 4 },
  resendLinkPressed: { opacity: 0.6 },
  resendLinkText: { color: "#217C73", fontFamily: F, fontSize: 12, lineHeight: 17, fontWeight: "700" },
  hintText: { color: prana.muted, fontFamily: F, fontSize: 11, lineHeight: 17 },
  saveButton: {
    minHeight: 54,
    marginTop: 8,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#24665A",
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.1,
    shadowRadius: 14,
  },
  saveButtonDisabled: { opacity: 0.6 },
  saveText: { color: "#FFFFFF", fontFamily: F, fontSize: 14, lineHeight: 20, fontWeight: "800" },
  saveNotice: { color: colors.success, fontFamily: F, fontSize: 13, lineHeight: 19, fontWeight: "700", textAlign: "center", marginTop: 12 },
  saveError: { color: colors.danger, fontFamily: F, fontSize: 13, lineHeight: 19, fontWeight: "700", textAlign: "center", marginTop: 12 },
  logoutButton: { minHeight: 44, marginTop: 16, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  logoutButtonHovered: { backgroundColor: "rgba(158,75,61,0.08)" },
  logoutButtonPressed: { opacity: 0.7 },
  logoutText: { color: colors.danger, fontFamily: F, fontSize: 12, lineHeight: 16, fontWeight: "700" },
  dialogError: { color: colors.danger, fontFamily: F, fontSize: 13, lineHeight: 19, textAlign: "center" },
  logoutScreen: { flex: 1, backgroundColor: "rgba(21,57,58,0.6)", alignItems: "center", justifyContent: "center", paddingHorizontal: 20 },
  logoutTitle: { color: prana.ink, fontFamily: F, fontSize: 22, lineHeight: 28, fontWeight: "800", textAlign: "center", marginBottom: 4 },
  logoutAccount: { width: "100%", minHeight: 64, borderRadius: 12, borderWidth: 1, borderColor: prana.line, backgroundColor: "#FFFFFF", paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 12 },
  logoutCard: { width: "100%", maxWidth: 380, padding: 22, gap: 14, borderRadius: 20, backgroundColor: prana.cream, borderWidth: 1, borderColor: prana.line, shadowColor: "#15393A", shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.2, shadowRadius: 40 },
  logoutAccountCopy: { flex: 1, minWidth: 0 },
  logoutName: { color: prana.ink, fontFamily: F, fontSize: 14, lineHeight: 20, fontWeight: "700" },
  logoutEmail: { color: prana.muted, fontFamily: F, fontSize: 12, lineHeight: 17 },
  logoutHint: { color: prana.muted, fontFamily: F, fontSize: 13, lineHeight: 19, textAlign: "center" },
  logoutConfirm: { width: "100%", minHeight: 50, borderRadius: 12, backgroundColor: "#9E4B3D", alignItems: "center", justifyContent: "center", marginTop: 4 },
  logoutConfirmText: { color: "#FFFFFF", fontFamily: F, fontSize: 14, lineHeight: 20, fontWeight: "800" },
  logoutCancel: { width: "100%", minHeight: 50, borderRadius: 12, borderWidth: 1, borderColor: "#B9CEBC", backgroundColor: "transparent", alignItems: "center", justifyContent: "center" },
  logoutCancelText: { color: "#286C62", fontFamily: F, fontSize: 14, lineHeight: 20, fontWeight: "700" },
});
