import { useEffect, useRef, useState } from "react";
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
  useWindowDimensions,
  View,
} from "react-native";
import {
  friendlyOtpVerifyError,
  isAuthSessionMissing,
  sendOTP,
  verifyOTP,
} from "../services/auth";
import { saveFarmerProfile } from "../services/local-profile";
import { useProfile } from "../context/profile-context";
import { useRouter, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import Feather from "@expo/vector-icons/Feather";
import { PranaHeader, PranaHeaderButton } from "../components/prana-header";
import { PRANA_FONT, prana, pranaGradientStyle } from "../constants/prana-theme";

const colors = {
  // Dark Ask Prana theme — matches the phone login screen.
  teal: "#2DD4BF",
  tealDark: "#0B5F59",
  background: prana.cream,
  text: "#F5F5F5",
  white: "#FFFFFF",
  mutedText: "#C9D1D0",
  mutedSoft: "#A0A0A0",
  borderEmpty: "#363636",
  otpEmptyFill: "#1B1B1B",
  otpFilledFill: "#212121",
  card: "#212121",
  shadow: "#000000",
};

function formatPhoneDisplay(phone?: string) {
  if (!phone) {
    return "your mobile number";
  }

  const digits = phone.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
  }
  return phone;
}

const isOtpRateLimitError = (message: string) =>
  /security purposes|only request this after|after \d+ seconds|rate limit|too many requests/i.test(
    message,
  );

/** Matches the "OTP expires in 5 minutes" note shown on this screen. */
const SMS_OTP_EXPIRY_SECONDS = 5 * 60;

export default function VerifyOtpScreen() {
  const router = useRouter();
  const { applyProfileUpdate } = useProfile();
  const { width: windowWidth } = useWindowDimensions();
  // The unified login screen passes { identifier, authMethod: "phone" };
  // `phone` is kept for older links into this screen.
  const params = useLocalSearchParams<{
    phone?: string;
    identifier?: string;
    authMethod?: "email" | "phone";
  }>();
  const phone =
    params.authMethod === "phone" && typeof params.identifier === "string"
      ? params.identifier
      : params.phone;
  const [otp, setOtp] = useState("");
  // When the current code was sent; tells an expired code from a wrong one.
  const otpSentAtRef = useRef(0);
  useEffect(() => {
    otpSentAtRef.current = Date.now();
  }, []);
  const [resendSeconds, setResendSeconds] = useState(30);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const otpInputRef = useRef<TextInput>(null);
  const lastAutoVerifiedRef = useRef("");

  const isOtpValid = otp.length === 6;
  const isResendDisabled = resendSeconds > 0 || isResending;
  const phoneDisplay = formatPhoneDisplay(
    typeof phone === "string" ? phone : undefined,
  );

  const horizontalPadding = 20;
  const otpGap = 8;
  const otpBoxSize = Math.min(
    58,
    Math.max(
      48,
      Math.floor(
        (windowWidth - horizontalPadding * 2 - otpGap * 5) / 6,
      ),
    ),
  );
  const titleSize = Math.round(
    Math.min(32, Math.max(28, windowWidth * 0.076)),
  );

  useEffect(() => {
    if (resendSeconds <= 0) {
      return;
    }

    const timer = setInterval(() => {
      setResendSeconds((seconds) => Math.max(seconds - 1, 0));
    }, 1000);

    return () => clearInterval(timer);
  }, [resendSeconds]);

  const handleOtpChange = (value: string) => {
    const digitsOnly = value.replace(/\D/g, "").slice(0, 6);
    setOtp(digitsOnly);
  };

  const focusOtpInput = () => {
    const input = otpInputRef.current;
    if (!input) {
      return;
    }

    const alreadyFocused =
      typeof input.isFocused === "function" ? input.isFocused() : false;

    if (alreadyFocused) {
      input.blur();
      requestAnimationFrame(() => {
        otpInputRef.current?.focus();
      });
      return;
    }

    input.focus();
  };

  const handleResendOtp = async () => {
    if (isResending || resendSeconds > 0) {
      return;
    }

    const phoneNumber = typeof phone === "string" ? phone.trim() : "";
    if (!phoneNumber) {
      alert("Phone number is missing. Go back and request OTP again.");
      return;
    }

    setIsResending(true);
    try {
      const { error } = await sendOTP(phoneNumber);
      if (error) {
        alert(
          isAuthSessionMissing(error)
            ? "Unable to resend OTP. Please try again."
            : isOtpRateLimitError(error.message)
              ? "Too many OTP requests. Please wait a moment and try again."
              : "Unable to resend OTP. Please try again.",
        );
        return;
      }

      otpSentAtRef.current = Date.now();
      setOtp("");
      lastAutoVerifiedRef.current = "";
      setResendSeconds(30);
      alert("OTP resent.");
      requestAnimationFrame(() => {
        otpInputRef.current?.focus();
      });
    } catch {
      alert("Unable to resend OTP. Please try again.");
    } finally {
      setIsResending(false);
    }
  };

  const handleVerifyOtp = async () => {
    if (!isOtpValid || isVerifying) {
      return;
    }

    setIsVerifying(true);

    try {
      const { data, error } = await verifyOTP(phone as string, otp);

      if (error) {
        alert(
          isAuthSessionMissing(error)
            ? "Unable to verify OTP. Please try again."
            : friendlyOtpVerifyError(error, otpSentAtRef.current, SMS_OTP_EXPIRY_SECONDS),
        );
        return;
      }

      if (data?.isNewUser) {
        router.replace({ pathname: "/edit-profile", params: { mode: "register" } } as never);
        return;
      }

      const user = data?.user;
      if (user?.name) {
        await saveFarmerProfile({
          name: user.name,
          state: user.state ?? "",
          district: user.district ?? "",
          language: user.language ?? "",
        });
        await applyProfileUpdate({
          name: user.name,
          state: user.state ?? "",
          district: user.district ?? "",
          language: user.language ?? "",
          phone: user.phone ?? "",
        });
      }
      alert("Welcome back");
      router.replace("/ask-prana" as never);
    } finally {
      setIsVerifying(false);
    }
  };

  useEffect(() => {
    if (otp.length < 6) {
      lastAutoVerifiedRef.current = "";
      return;
    }

    if (otp.length === 6 && otp !== lastAutoVerifiedRef.current && !isVerifying) {
      lastAutoVerifiedRef.current = otp;
      void handleVerifyOtp();
    }
    // Intentionally depends on otp length/value only for one-shot auto verify.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [otp]);

  const isDesktop = windowWidth >= 1024;
  const goBack = () => {
    // Login opens this screen with replace, so there is often
    // no history entry; go to login to change the number.
    if (router.canGoBack()) router.back();
    else router.replace("/phone-login" as never);
  };

  const form = (
    <>
      <Text style={styles.eyebrow}>SECURE VERIFICATION</Text>
      <Text style={styles.heading} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>
        Enter 6-digit OTP
      </Text>
      <Text style={styles.sentTo}>Enter the code sent to your mobile number.</Text>
      <View style={styles.phoneLine}>
        <Text style={styles.phoneText}>{phoneDisplay}</Text>
        <Pressable onPress={goBack} accessibilityRole="button" accessibilityLabel="Change mobile number" hitSlop={8}>
          <Text style={styles.changeLink}>Change</Text>
        </Pressable>
      </View>

      <Pressable
        onPress={focusOtpInput}
        style={styles.otpRowWrap}
        accessibilityRole="button"
        accessibilityLabel="OTP verification code"
      >
        <View style={styles.otpRow} pointerEvents="none">
          {Array.from({ length: 6 }).map((_, index) => {
            const digit = otp[index] ?? "";
            const isFilled = digit.length > 0;
            const isActive = index === otp.length && otp.length < 6;
            return (
              <View
                key={index}
                style={[styles.otpBox, (isFilled || isActive) && styles.otpBoxFilled]}
              >
                <Text style={styles.otpDigit}>{digit}</Text>
              </View>
            );
          })}
        </View>

        <TextInput
          ref={otpInputRef}
          value={otp}
          onChangeText={handleOtpChange}
          autoFocus
          showSoftInputOnFocus
          keyboardType="number-pad"
          inputMode="numeric"
          maxLength={6}
          style={styles.otpOverlayInput}
          textContentType="oneTimeCode"
          autoComplete="sms-otp"
          importantForAutofill="yes"
          returnKeyType="done"
          onSubmitEditing={handleVerifyOtp}
          accessibilityLabel="OTP verification code"
          caretHidden
          contextMenuHidden={false}
          pointerEvents="none"
        />
      </Pressable>

      <View style={styles.expiryRow}>
        <Feather name="clock" size={12} color={prana.muted} />
        <Text style={styles.expiryText}>Code expires in 5 minutes</Text>
      </View>

      <Pressable
        onPress={() => void handleVerifyOtp()}
        disabled={!isOtpValid || isVerifying}
        style={[styles.verifyButton, pranaGradientStyle, (!isOtpValid || isVerifying) && styles.verifyButtonDisabled]}
        accessibilityRole="button"
      >
        {isVerifying ? (
          <>
            <ActivityIndicator color="#FFFFFF" />
            <Text style={styles.verifyText}>Verifying…</Text>
          </>
        ) : (
          <>
            <Text style={styles.verifyText}>Verify & continue</Text>
            <Feather name="arrow-right" size={18} color="#FFFFFF" />
          </>
        )}
      </Pressable>

      <View style={styles.resendContainer}>
        <Text style={styles.resendLine}>
          <Text style={styles.resendPrompt}>Didn't receive it?{"  "}</Text>
          <Text
            onPress={isResendDisabled ? undefined : handleResendOtp}
            style={[styles.resendAction, isResendDisabled && styles.resendActionDisabled]}
            accessibilityRole="button"
            accessibilityState={{ disabled: isResendDisabled }}
          >
            {isResending
              ? "Sending…"
              : isResendDisabled
              ? `Resend in ${resendSeconds}s`
              : "Resend OTP"}
          </Text>
        </Text>
      </View>

      <Pressable onPress={goBack} style={styles.backLinkWrap} accessibilityRole="button">
        <Feather name="arrow-left" size={13} color="#217C73" />
        <Text style={styles.backLink}>Back to mobile number</Text>
      </Pressable>
    </>
  );

  return (
    <View style={styles.root}>
      <StatusBar
        barStyle={isDesktop ? "dark-content" : "light-content"}
        backgroundColor={isDesktop ? prana.desktopHeader : prana.headerDark}
      />
      {isDesktop ? (
        <PranaHeader
          variant="light"
          left={<PranaHeaderButton icon="arrow-left" tone="light" onPress={goBack} label="Go back" />}
        />
      ) : (
        <PranaHeader
          variant="wave"
          left={<PranaHeaderButton icon="arrow-left" onPress={goBack} label="Go back" />}
          right={<View style={{ width: 42 }} />}
        />
      )}
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <SafeAreaView style={styles.safeArea} edges={["bottom"]}>
          <ScrollView
            contentContainerStyle={[styles.scrollContent, isDesktop && styles.scrollContentDesktop]}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={[styles.content, isDesktop && styles.card]}>{form}</View>
          </ScrollView>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </View>
  );
}

const F = PRANA_FONT;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: prana.cream, overflow: "hidden" },
  keyboardView: { flex: 1, overflow: "hidden" },
  safeArea: { flex: 1, backgroundColor: "transparent" },
  scrollContent: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 14, paddingBottom: 28 },
  scrollContentDesktop: { alignItems: "center", justifyContent: "center", paddingVertical: 40 },
  content: { width: "100%", maxWidth: 540 },
  card: {
    maxWidth: 440,
    paddingHorizontal: 32,
    paddingVertical: 30,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: prana.line,
    backgroundColor: prana.cream,
    shadowColor: "#1D4B36",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.08,
    shadowRadius: 30,
  },
  eyebrow: {
    color: prana.tealText,
    fontFamily: F,
    fontSize: 10,
    lineHeight: 13,
    fontWeight: "800",
    letterSpacing: 1.1,
    marginBottom: 8,
  },
  heading: {
    color: prana.ink,
    fontFamily: F,
    fontSize: 29,
    lineHeight: 34,
    fontWeight: "800",
    marginBottom: 12,
  },
  sentTo: {
    color: prana.muted,
    fontFamily: F,
    fontSize: 13,
    lineHeight: 21,
    marginBottom: 27,
  },
  phoneLine: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 4,
    marginTop: -8,
    marginBottom: 20,
  },
  phoneText: {
    flexShrink: 1,
    color: prana.ink,
    fontFamily: F,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "800",
    letterSpacing: 0.4,
  },
  changeLink: {
    color: "#217C73",
    fontFamily: F,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "700",
    paddingVertical: 12,
    paddingHorizontal: 4,
  },
  otpRowWrap: { position: "relative", marginTop: 14, marginBottom: 15 },
  otpRow: { flexDirection: "row", gap: 7 },
  otpBox: {
    flex: 1,
    minWidth: 0,
    height: 53,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: "#C4D0BE",
    backgroundColor: prana.card,
    alignItems: "center",
    justifyContent: "center",
  },
  otpBoxFilled: { borderColor: prana.teal },
  otpDigit: {
    color: prana.ink,
    fontFamily: F,
    fontSize: 23,
    lineHeight: 28,
    fontWeight: "800",
  },
  otpOverlayInput: {
    ...StyleSheet.absoluteFill,
    color: "transparent",
    backgroundColor: "transparent",
    // Invisible, but 16 px stops iPhone Safari zooming in when it is focused.
    fontSize: 16,
    letterSpacing: 0,
    opacity: 0.015,
    zIndex: 2,
    ...(Platform.OS === "web"
      ? ({
          outlineStyle: "none",
          outlineWidth: 0,
          caretColor: "transparent",
        } as object)
      : null),
  },
  expiryRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 24 },
  expiryText: { color: prana.muted, fontFamily: F, fontSize: 11, lineHeight: 15 },
  verifyButton: {
    minHeight: 54,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    shadowColor: "#24665A",
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.1,
    shadowRadius: 14,
  },
  verifyButtonDisabled: { opacity: 0.48 },
  verifyText: { color: "#FFFFFF", fontFamily: F, fontSize: 14, lineHeight: 20, fontWeight: "800" },
  resendContainer: { marginTop: 12, marginBottom: 13, alignItems: "center" },
  resendLine: { textAlign: "center", fontFamily: F, fontSize: 11, lineHeight: 16 },
  resendPrompt: { color: prana.muted },
  resendAction: { color: "#217C73", fontWeight: "700" },
  resendActionDisabled: { color: "#7FA79B", fontWeight: "600" },
  backLinkWrap: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    minHeight: 44,
    paddingBottom: 18,
    borderBottomWidth: 1,
    borderBottomColor: prana.line,
  },
  backLink: { color: "#217C73", fontFamily: F, fontSize: 12, lineHeight: 16, fontWeight: "700" },
});
