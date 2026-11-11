import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import Feather from "@expo/vector-icons/Feather";
import { PranaHeader, PranaHeaderButton } from "../components/prana-header";
import { PRANA_FONT, prana, pranaGradientStyle } from "../constants/prana-theme";
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

// AskPrana cream / teal theme.
const colors = {
  teal: prana.teal,
  background: prana.cream,
  text: prana.ink,
  mutedText: prana.muted,
  mutedSoft: "#7FA79B",
  border: prana.inputBorder,
  card: prana.card,
  danger: prana.error,
  success: "#2E7767",
  ctaDisabled: "#9FC0B6",
  ctaDisabledText: "#FFFFFF",
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
  const [backButtonHovered, setBackButtonHovered] = useState(false);
  const [backButtonFocused, setBackButtonFocused] = useState(false);
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

  const { width: windowWidth } = useWindowDimensions();
  const isDesktop = windowWidth >= 1024;
  const goBack = () => {
    // Email login is normally opened with push, but retain a
    // fallback for a directly opened verification URL.
    if (router.canGoBack()) router.back();
    else router.replace("/phone-login" as never);
  };

  const canVerify = code.length >= codeLength && !verifying && !sending && !verified;

  return (
    <View style={styles.root}>
      <StatusBar
        barStyle={isDesktop ? "dark-content" : "light-content"}
        backgroundColor={isDesktop ? prana.desktopHeader : prana.headerDark}
      />
      {isDesktop ? (
        <PranaHeader
          variant="light"
          left={<PranaHeaderButton icon="arrow-left" tone="light" onPress={goBack} label="Change email or mobile number" />}
        />
      ) : (
        <PranaHeader
          variant="wave"
          left={<PranaHeaderButton icon="arrow-left" onPress={goBack} label="Change email or mobile number" />}
          right={<View style={{ width: 42 }} />}
        />
      )}
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <SafeAreaView style={styles.flex} edges={["bottom"]}>
            <ScrollView
              contentContainerStyle={[styles.scroll, isDesktop && styles.scrollDesktop]}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
            <View style={[styles.content, isDesktop && styles.card]}>
              <Text style={styles.eyebrow}>{loginMode ? "SECURE VERIFICATION" : "EMAIL VERIFICATION"}</Text>
              <Text style={styles.heading}>Verify your email</Text>

              {verified ? (
                <>
                  <Text style={styles.successText} accessibilityLiveRegion="polite">
                    Email verified successfully.
                  </Text>
                  <Text style={styles.sentTo}>{maskEmail(requestedEmail)} is now linked to your account.</Text>
                  <PrimaryButton label="Continue →" onPress={finish} />
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
                    label={sending ? "Sending code…" : verifying ? "Verifying…" : "Verify & continue →"}
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
            </ScrollView>
          </SafeAreaView>
        </KeyboardAvoidingView>
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
        pranaGradientStyle,
        disabled && { opacity: 0.48 },
        pressed && !disabled && styles.buttonPressed,
      ]}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
    >
      <View style={styles.buttonContent}>
        {loading ? <ActivityIndicator size="small" color={colors.ctaDisabledText} /> : null}
        <Text style={[styles.buttonText, disabled && styles.buttonTextDisabled]}>{label}</Text>
      </View>
    </Pressable>
  );
}

const F = PRANA_FONT;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: prana.cream, overflow: "hidden" },
  flex: { flex: 1 },
  scroll: { flexGrow: 1, paddingBottom: 28 },
  scrollDesktop: { alignItems: "center", justifyContent: "center", paddingVertical: 40 },
  content: { width: "100%", maxWidth: 540, alignSelf: "center", paddingHorizontal: 24, paddingTop: 14, gap: 12 },
  card: {
    maxWidth: 440,
    paddingHorizontal: 32,
    paddingVertical: 30,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: prana.line,
    shadowColor: "#1D4B36",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.08,
    shadowRadius: 30,
  },
  eyebrow: { color: prana.tealText, fontFamily: F, fontSize: 10, lineHeight: 13, fontWeight: "800", letterSpacing: 1.1 },
  heading: { color: prana.ink, fontFamily: F, fontSize: 29, lineHeight: 34, fontWeight: "800" },
  sentTo: { color: prana.muted, fontFamily: F, fontSize: 13, lineHeight: 21, marginBottom: 12 },
  emailText: { color: prana.ink, fontSize: 15, fontWeight: "800" },
  label: { color: prana.ink, fontFamily: F, fontSize: 12, lineHeight: 16, fontWeight: "700" },
  codeInput: {
    height: 56,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: "#C4D0BE",
    backgroundColor: prana.card,
    color: prana.ink,
    fontFamily: F,
    fontSize: 23,
    fontWeight: "800",
    letterSpacing: 8,
    textAlign: "center",
    ...(Platform.OS === "web" ? ({ outlineStyle: "none", outlineWidth: 0, caretColor: "#008081" } as object) : null),
  },
  codeInputError: { borderColor: colors.danger },
  errorText: { color: colors.danger, fontFamily: F, fontSize: 12, lineHeight: 18 },
  noticeText: { color: prana.muted, fontFamily: F, fontSize: 12, lineHeight: 18 },
  successText: { color: colors.success, fontFamily: F, fontSize: 15, lineHeight: 22, fontWeight: "700" },
  button: {
    minHeight: 54,
    marginTop: 8,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    shadowColor: "#24665A",
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.1,
    shadowRadius: 14,
  },
  buttonPressed: { opacity: 0.9 },
  buttonContent: { flexDirection: "row", alignItems: "center", gap: 8 },
  buttonText: { color: "#FFFFFF", fontFamily: F, fontSize: 14, lineHeight: 20, fontWeight: "800" },
  buttonTextDisabled: { color: "#FFFFFF" },
  resendLine: { marginTop: 4, textAlign: "center", fontFamily: F, fontSize: 11, lineHeight: 16 },
  resendPrompt: { color: prana.muted },
  resendAction: { color: "#217C73", fontWeight: "700" },
  resendActionDisabled: { color: "#7FA79B", fontWeight: "600" },
  skip: { alignSelf: "center", minHeight: 44, justifyContent: "center", paddingHorizontal: 12 },
  skipText: { color: "#217C73", fontFamily: F, fontSize: 12, lineHeight: 16, fontWeight: "700" },
});
