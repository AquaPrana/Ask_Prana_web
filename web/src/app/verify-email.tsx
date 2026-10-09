import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  AUTH_DARK_BACKGROUND,
  PhoneLoginBackground,
} from "../components/phone-login-background";
import { PrimaryCtaGradientFill } from "../components/primary-cta-gradient";
import { PRIMARY_CTA_START } from "../constants/primary-cta";
import { useProfile } from "../context/profile-context";
import { waitForAuthReady } from "../lib/supabase";
import { friendlyOtpVerifyError, logout } from "../services/auth";
import { saveFarmerProfile } from "../services/local-profile";
import {
  ACCOUNT_DELETED_MESSAGE,
  EMAIL_OTP_LENGTH,
  ensureCurrentUserProfile,
  getCurrentUserEmailState,
  isCurrentUserDeleted,
  maskEmail,
  normalizeEmail,
  requestCurrentUserEmailChange,
  resendEmailChangeVerification,
  sendEmailLoginCode,
  verifyEmailChangeCode,
  verifyEmailLoginCode,
} from "../services/profile";

// Same dark Ask Prana theme as the phone login / OTP screens.
const colors = {
  teal: "#2DD4BF",
  background: AUTH_DARK_BACKGROUND,
  text: "#F5F5F5",
  mutedText: "#C9D1D0",
  mutedSoft: "#A0A0A0",
  border: "#363636",
  card: "#212121",
  danger: "#F87171",
  success: "#34D399",
  ctaDisabled: "#26302F",
  ctaDisabledText: "#7C8886",
};

/** Supabase's default minimum interval between emails to the same address. */
const RESEND_SECONDS = 60;

/** Supabase Auth → Providers → Email → "Email OTP Expiration" (default 1 hour). */
const EMAIL_OTP_EXPIRY_SECONDS = 3600;

/**
 * Two uses of the same code screen:
 * - mode=link (default): verifies an email for the CURRENT signed-in phone
 *   user with an MSG91 code, then attaches that address to the same account.
 * - mode=login: signed-out login. MSG91 sends the code, and a matching
 *   account is signed in (a new address gets one account after the code).
 *
 * Params: email (required); sent=1 when the code was already requested;
 * next=back to return to the previous screen (default: Ask Prana).
 */
export default function VerifyEmailScreen() {
  const router = useRouter();
  const { applyProfileUpdate } = useProfile();
  const params = useLocalSearchParams<{ email?: string; sent?: string; next?: string; mode?: string }>();
  const loginMode = params.mode === "login";
  const requestedEmail = normalizeEmail(typeof params.email === "string" ? params.email : "");
  const alreadySent = params.sent === "1" || loginMode;
  const returnBack = params.next === "back";
  const codeLength = EMAIL_OTP_LENGTH;
  // After phone login this is where the app was about to go (e.g. /ask-prana).
  const nextPath =
    typeof params.next === "string" && params.next.startsWith("/") ? params.next : "/ask-prana";

  // The address the next code is for; with secure email change this becomes
  // the current address after the new one is confirmed.
  const [targetEmail, setTargetEmail] = useState(requestedEmail);
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(!alreadySent);
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resendSeconds, setResendSeconds] = useState(alreadySent ? RESEND_SECONDS : 0);
  const [resending, setResending] = useState(false);
  const requestLockRef = useRef(false);
  const verifyLockRef = useRef(false);
  const lastAutoVerifiedRef = useRef("");
  // When the current code was sent; tells an expired code from a wrong one.
  const codeSentAtRef = useRef(0);
  useEffect(() => {
    codeSentAtRef.current = Date.now();
  }, []);

  const finish = useCallback(() => {
    if (returnBack && router.canGoBack()) router.back();
    else router.replace(nextPath as never);
  }, [nextPath, returnBack, router]);

  // Send the first code (unless the caller already did).
  useEffect(() => {
    let active = true;
    // Login mode: the login screen already sent the code; no session yet.
    if (loginMode) {
      if (!requestedEmail) router.replace("/phone-login" as never);
      return;
    }
    void (async () => {
      const session = await waitForAuthReady();
      if (!active) return;
      if (!session?.user) {
        router.replace("/phone-login" as never);
        return;
      }
      if (!requestedEmail) {
        finish();
        return;
      }
      const { state } = await getCurrentUserEmailState();
      if (!active) return;
      if (state?.status === "verified" && normalizeEmail(state.email) === requestedEmail) {
        setVerified(true);
        setSending(false);
        return;
      }
      if (alreadySent || requestLockRef.current) return;
      requestLockRef.current = true;
      const result = await requestCurrentUserEmailChange(requestedEmail);
      requestLockRef.current = false;
      if (!active) return;
      setSending(false);
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.state?.status === "verified" && normalizeEmail(result.state.email) === requestedEmail) {
        // Project doesn't require confirmation: the email is already set.
        setVerified(true);
        return;
      }
      setResendSeconds(RESEND_SECONDS);
    })();
    return () => {
      active = false;
    };
    // Runs once for this screen's email.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (resendSeconds <= 0) return;
    const timer = setInterval(() => setResendSeconds((seconds) => Math.max(seconds - 1, 0)), 1000);
    return () => clearInterval(timer);
  }, [resendSeconds]);

  const loginFinishedRef = useRef(false);
  /** Same post-login checks as phone login, keyed by the Auth user id. */
  const finishEmailLogin = useCallback(async () => {
    if (loginFinishedRef.current) return;
    loginFinishedRef.current = true;
    if (await isCurrentUserDeleted()) {
      await logout();
      loginFinishedRef.current = false;
      setError(ACCOUNT_DELETED_MESSAGE);
      return;
    }
    // Existing account → its profile; new account → a profile row is created
    // (keyed by auth.uid()) and the empty name sends it to profile setup.
    const { profile, error: profileError } = await ensureCurrentUserProfile();
    if (profileError) {
      loginFinishedRef.current = false;
      setError("Signed in, but your profile couldn't be loaded. Please try again.");
      return;
    }
    if (profile?.name) {
      await saveFarmerProfile({
        name: profile.name,
        state: profile.state ?? "",
        district: profile.district ?? "",
        language: profile.language ?? "",
      });
      await applyProfileUpdate({
        name: profile.name,
        state: profile.state ?? "",
        district: profile.district ?? "",
        language: profile.language ?? "",
        phone: profile.phone ?? "",
      });
    }
    alert("Welcome back");
    router.replace("/ask-prana" as never);
  }, [applyProfileUpdate, router]);

  const verify = useCallback(async (value: string) => {
    const digits = value.replace(/\D/g, "");
    if (verifyLockRef.current || verified) return;
    if (digits.length < codeLength) {
      setError(`Enter the ${codeLength}-digit code from your email.`);
      return;
    }
    verifyLockRef.current = true;
    setVerifying(true);
    setError(null);
    if (loginMode) {
      const login = await verifyEmailLoginCode(targetEmail, digits);
      if (login.error) {
        verifyLockRef.current = false;
        setVerifying(false);
        setError(
          login.cause
            ? friendlyOtpVerifyError(login.cause, codeSentAtRef.current, EMAIL_OTP_EXPIRY_SECONDS)
            : login.error,
        );
        return;
      }
      if (login.isNewUser) {
        verifyLockRef.current = false;
        setVerifying(false);
        router.replace({ pathname: "/edit-profile", params: { mode: "register" } } as never);
        return;
      }
      await finishEmailLogin();
      verifyLockRef.current = false;
      setVerifying(false);
      return;
    }
    const result = await verifyEmailChangeCode(targetEmail, digits);
    verifyLockRef.current = false;
    setVerifying(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    const state = result.state;
    if (state?.status === "pending" && state.email && normalizeEmail(state.email) !== targetEmail) {
      // Secure email change: the current address must confirm too.
      setTargetEmail(normalizeEmail(state.email));
      setCode("");
      lastAutoVerifiedRef.current = "";
      setResendSeconds(RESEND_SECONDS);
      setNotice(`New email confirmed. Enter the code sent to ${maskEmail(state.email)} to finish.`);
      return;
    }
    setNotice(null);
    setVerified(true);
  }, [codeLength, finishEmailLogin, loginMode, targetEmail, verified]);

  // Login verifies only from the button, so the code is sent once.
  // Email change still verifies when the code is complete.
  useEffect(() => {
    if (loginMode) return;
    if (code.length < codeLength) {
      lastAutoVerifiedRef.current = "";
      return;
    }
    if (code !== lastAutoVerifiedRef.current) {
      lastAutoVerifiedRef.current = code;
      void verify(code);
    }
  }, [code, codeLength, loginMode, verify]);

  const resend = async () => {
    if (resendSeconds > 0 || resending || requestLockRef.current) return;
    requestLockRef.current = true;
    setResending(true);
    setError(null);
    const { error: resendError } = loginMode
      ? await sendEmailLoginCode(targetEmail)
      : await resendEmailChangeVerification(targetEmail);
    requestLockRef.current = false;
    setResending(false);
    if (resendError) {
      setError(resendError);
      return;
    }
    codeSentAtRef.current = Date.now();
    setCode("");
    setNotice(`A new code was sent to ${maskEmail(targetEmail)}.`);
    setResendSeconds(RESEND_SECONDS);
  };

  const canVerify = code.length >= codeLength && !verifying && !sending && !verified;

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={colors.background} />
      <PhoneLoginBackground waveProfile="tall" appearance="dark">
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <SafeAreaView style={styles.flex} edges={["top", "bottom"]}>
            <View style={styles.backRow}>
              <Pressable
                onPress={() => {
                  // Email login is normally opened with push, but retain a
                  // fallback for a directly opened verification URL.
                  if (router.canGoBack()) router.back();
                  else router.replace("/phone-login" as never);
                }}
                style={styles.backButton}
                accessibilityRole="button"
                accessibilityLabel="Change email or mobile number"
                hitSlop={8}
              >
                <Text style={styles.backArrow}>←</Text>
              </Pressable>
            </View>
            <View style={styles.content}>
              <Text style={styles.eyebrow}>{loginMode ? "SECURE VERIFICATION" : "EMAIL VERIFICATION"}</Text>
              <Text style={styles.heading}>Verify your email</Text>

              {verified ? (
                <>
                  <Text style={styles.successText} accessibilityLiveRegion="polite">
                    Email verified successfully.
                  </Text>
                  <Text style={styles.sentTo}>{maskEmail(requestedEmail)} is now linked to your account.</Text>
                  <PrimaryButton label="CONTINUE →" onPress={finish} />
                </>
              ) : (
                <>
                  <Text style={styles.sentTo}>
                    {sending ? "Sending a verification code to:" : "Enter the OTP sent to your email"}
                    {"\n"}
                    <Text style={styles.emailText}>{maskEmail(targetEmail)}</Text>
                  </Text>

                  <Text style={styles.label}>Verification code</Text>
                  <TextInput
                    value={code}
                    onChangeText={(value) => {
                      setCode(value.replace(/\D/g, "").slice(0, codeLength));
                      if (error) setError(null);
                    }}
                    autoFocus
                    editable={!sending && !verifying}
                    keyboardType="number-pad"
                    inputMode="numeric"
                    textContentType="oneTimeCode"
                    autoComplete="one-time-code"
                    maxLength={codeLength}
                    placeholder={"•".repeat(codeLength)}
                    placeholderTextColor={colors.mutedSoft}
                    style={[styles.codeInput, error ? styles.codeInputError : null]}
                    accessibilityLabel="Email verification code"
                    returnKeyType="done"
                    onSubmitEditing={() => void verify(code)}
                  />

                  {error ? (
                    <Text style={styles.errorText} accessibilityLiveRegion="polite">{error}</Text>
                  ) : notice ? (
                    <Text style={styles.noticeText}>{notice}</Text>
                  ) : null}

                  <PrimaryButton
                    label={sending ? "SENDING OTP..." : verifying ? "VERIFYING..." : "VERIFY EMAIL"}
                    onPress={() => void verify(code)}
                    disabled={!canVerify}
                    loading={sending || verifying}
                  />

                  <Text style={styles.resendLine}>
                    <Text style={styles.resendPrompt}>Didn&apos;t receive it? </Text>
                    <Text
                      onPress={resendSeconds > 0 || resending || sending ? undefined : () => void resend()}
                      style={[styles.resendAction, (resendSeconds > 0 || resending || sending) && styles.resendActionDisabled]}
                      accessibilityRole="button"
                      accessibilityState={{ disabled: resendSeconds > 0 || resending || sending }}
                    >
                      {resending ? "Sending…" : resendSeconds > 0 ? `Resend OTP in ${resendSeconds}s` : "Resend OTP"}
                    </Text>
                  </Text>

                  <Pressable
                    onPress={loginMode ? () => router.replace("/phone-login" as never) : finish}
                    style={styles.skip}
                    accessibilityRole="button"
                  >
                    <Text style={styles.skipText}>
                      {loginMode ? "Change email or mobile number" : returnBack ? "Cancel" : "Skip for now"}
                    </Text>
                  </Pressable>
                </>
              )}
            </View>
          </SafeAreaView>
        </KeyboardAvoidingView>
      </PhoneLoginBackground>
    </View>
  );
}

function PrimaryButton({
  label,
  onPress,
  disabled = false,
  loading = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: disabled ? colors.ctaDisabled : PRIMARY_CTA_START },
        pressed && !disabled && styles.buttonPressed,
      ]}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
    >
      {!disabled ? <PrimaryCtaGradientFill /> : null}
      <View style={styles.buttonContent}>
        {loading ? <ActivityIndicator size="small" color={colors.ctaDisabledText} /> : null}
        <Text style={[styles.buttonText, disabled && styles.buttonTextDisabled]}>{label}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background, overflow: "hidden" },
  flex: { flex: 1 },
  backRow: { width: "100%", maxWidth: 520, alignSelf: "center", paddingHorizontal: 20, paddingTop: 12 },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  backArrow: { color: colors.text, fontSize: 22, lineHeight: 24, fontWeight: "700", marginTop: -1 },
  content: { width: "100%", maxWidth: 520, alignSelf: "center", paddingHorizontal: 20, paddingTop: 72, gap: 12 },
  eyebrow: { color: colors.teal, fontSize: 14, lineHeight: 18, fontWeight: "800", letterSpacing: 1.2 },
  heading: { color: colors.text, fontSize: 30, lineHeight: 36, fontWeight: "800" },
  sentTo: { color: colors.mutedText, fontSize: 16, lineHeight: 24, fontWeight: "600", marginBottom: 12 },
  emailText: { color: colors.text, fontWeight: "700" },
  label: { color: colors.text, fontSize: 14, lineHeight: 18, fontWeight: "700" },
  codeInput: {
    height: 58,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: colors.teal,
    backgroundColor: colors.card,
    color: colors.text,
    fontSize: 26,
    fontWeight: "800",
    letterSpacing: 8,
    textAlign: "center",
    ...(Platform.OS === "web" ? ({ outlineStyle: "none", outlineWidth: 0 } as object) : null),
  },
  codeInputError: { borderColor: colors.danger },
  errorText: { color: colors.danger, fontSize: 14, lineHeight: 20, fontWeight: "600" },
  noticeText: { color: colors.mutedText, fontSize: 14, lineHeight: 20, fontWeight: "500" },
  successText: { color: colors.success, fontSize: 17, lineHeight: 24, fontWeight: "700" },
  button: {
    height: 54,
    marginTop: 8,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  buttonPressed: { opacity: 0.92 },
  buttonContent: { flexDirection: "row", alignItems: "center", gap: 8 },
  buttonText: { color: "#FFFFFF", fontSize: 15, lineHeight: 20, fontWeight: "700", letterSpacing: 0.4 },
  buttonTextDisabled: { color: colors.ctaDisabledText },
  resendLine: { marginTop: 12, textAlign: "center", fontSize: 15, lineHeight: 22 },
  resendPrompt: { color: colors.mutedText, fontWeight: "600" },
  resendAction: { color: colors.teal, fontWeight: "800" },
  resendActionDisabled: { color: colors.mutedSoft, fontWeight: "700" },
  skip: { alignSelf: "center", paddingVertical: 8, paddingHorizontal: 12 },
  skipText: { color: colors.mutedSoft, fontSize: 14, lineHeight: 18, fontWeight: "600" },
});
