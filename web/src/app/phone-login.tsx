import { useEffect, useRef, useState } from "react";
import {
  Geist_500Medium,
  Geist_700Bold,
  Geist_800ExtraBold,
  useFonts,
} from "@expo-google-fonts/geist";
import { sendOTP } from "../services/auth";
import { finishGoogleSignIn, startGoogleSignIn, takeGoogleReturn } from "../services/google-sign-in";
import { isValidEmail, normalizeEmail, sendEmailLoginCode } from "../services/profile";
import {
  AUTH_DARK_BACKGROUND,
} from "../components/phone-login-background";
import { AskPranaLogo } from "../components/ask-prana-logo";
import { PRIMARY_CTA_START } from "../constants/primary-cta";
import Feather from "@expo/vector-icons/Feather";

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
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";

// Dark Ask Prana theme with teal accents taken from the logo.
const colors = {
  primary: "#2DD4BF",
  primaryDark: "#0B5F59",
  primaryBright: "#5EEAD4",
  background: AUTH_DARK_BACKGROUND,
  white: "#FFFFFF",
  text: "#F5F5F5",
  textSoft: "#C9D1D0",
  muted: "#A0A0A0",
  border: "#363636",
  inputBg: "#212121",
  placeholder: "#6F7777",
  error: "#F87171",
  ctaDisabled: "#26302F",
  ctaDisabledText: "#7C8886",
  ctaGradientStart: PRIMARY_CTA_START,
  shadow: "#000000",
};

const fonts = {
  medium: "Geist_500Medium",
  bold: "Geist_700Bold",
  extraBold: "Geist_800ExtraBold",
} as const;

const INDIAN_MOBILE_REGEX = /^[6-9]\d{9}$/;

const MESSAGES = {
  empty: "Please enter your email or mobile number.",
  invalid_email: "Please enter a valid email address.",
  invalid_phone: "Please enter a valid 10-digit mobile number.",
} as const;

type LoginIdentifier =
  | { authMethod: "email"; identifier: string }
  | { authMethod: "phone"; identifier: string };

function GoogleMark() {
  return (
    <Svg width={18} height={18} viewBox="0 0 48 48">
      <Path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z" />
      <Path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z" />
      <Path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z" />
      <Path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z" />
    </Svg>
  );
}

function AppleMark() {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24">
      <Path fill="#FFFFFF" d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zm4.961-3.066c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701z" />
    </Svg>
  );
}

function PhoneMark() {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24">
      <Path
        fill="none"
        stroke="#FFFFFF"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"
      />
    </Svg>
  );
}

/**
 * Works out whether the single login field holds an email or an Indian mobile
 * number. Emails are normalized for Supabase; mobiles become +91XXXXXXXXXX and
 * an existing +91 / 91 / leading 0 is never duplicated.
 */
function parseLoginIdentifier(
  raw: string,
): LoginIdentifier | { error: "empty" | "invalid_email" | "invalid_phone" } {
  const value = raw.trim();
  if (!value) return { error: "empty" };

  // "@" or any letter means the user is typing an email, not a number.
  if (value.includes("@") || /[a-z]/i.test(value)) {
    return isValidEmail(value)
      ? { authMethod: "email", identifier: normalizeEmail(value) }
      : { error: "invalid_email" };
  }

  if (!/^\+?[\d\s\-().]+$/.test(value)) return { error: "invalid_phone" };
  let digits = value.replace(/\D/g, "");
  if (value.startsWith("+")) {
    if (!digits.startsWith("91")) return { error: "invalid_phone" };
    digits = digits.slice(2);
  } else if (digits.length === 12 && digits.startsWith("91")) {
    digits = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith("0")) {
    digits = digits.slice(1);
  }
  return INDIAN_MOBILE_REGEX.test(digits)
    ? { authMethod: "phone", identifier: `+91${digits}` }
    : { error: "invalid_phone" };
}

export default function PhoneLoginScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const isDesktop = windowWidth >= 1024;
  const [shellSidebar, setShellSidebar] = useState(false);
  const [identifierInput, setIdentifierInput] = useState("");
  const [phoneInput, setPhoneInput] = useState("");
  const [panelOpen, setPanelOpen] = useState(true);
  const [phoneStep, setPhoneStep] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [isSendingOtp, setIsSendingOtp] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [googleReturn] = useState(() => takeGoogleReturn());
  const [googleHandoff, setGoogleHandoff] = useState(
    () => googleReturn !== null && !("error" in googleReturn),
  );
  const [googleNotice, setGoogleNotice] = useState<string | null>(
    () => (googleReturn && "error" in googleReturn ? googleReturn.error : null),
  );
  const isSendingOtpRef = useRef(false);
  // A failed/unusable email sign-in link comes back here as ?authError=.
  const { authError } = useLocalSearchParams<{ authError?: string }>();
  const [errorMessage, setErrorMessage] = useState<string | null>(
    typeof authError === "string" && authError ? authError : null,
  );
  const [fontsLoaded] = useFonts({
    Geist_500Medium,
    Geist_700Bold,
    Geist_800ExtraBold,
  });

  const canSendEmail = Boolean(identifierInput.trim()) && !isSendingOtp;
  const canSendPhone = Boolean(phoneInput.trim()) && !isSendingOtp;

  useEffect(() => {
    if (!googleReturn || "error" in googleReturn) return;
    void finishGoogleSignIn(googleReturn).then((result) => {
      if (result.error) {
        setGoogleNotice(result.error);
        setGoogleHandoff(false);
        return;
      }
      router.replace((result.isNewUser ? { pathname: "/edit-profile", params: { mode: "register" } } : "/ask-prana") as never);
    });
  }, [googleReturn, router]);

  const handleGoogle = async () => {
    if (googleBusy) return;
    setGoogleNotice(null);
    setGoogleBusy(true);
    const result = await startGoogleSignIn();
    if (result.error) {
      setGoogleNotice(result.error);
      setGoogleBusy(false);
    }
  };

  const openLogin = () => setPanelOpen(true);
  const showSidebar = isDesktop || shellSidebar;

  const handleSendOtp = async (raw: string, method: "email" | "phone") => {
    if (isSendingOtpRef.current) return;

    const parsed = parseLoginIdentifier(raw);
    if ("error" in parsed || parsed.authMethod !== method) {
      setErrorMessage(method === "email" ? MESSAGES.invalid_email : MESSAGES.invalid_phone);
      return;
    }

    isSendingOtpRef.current = true;
    setIsSendingOtp(true);
    setErrorMessage(null);

    try {
      if (parsed.authMethod === "email") {
        // Existing email signs in after the code. A new email opens Create account.
        const result = await sendEmailLoginCode(parsed.identifier);
        if (result.error) {
          setErrorMessage(result.error);
          return;
        }
        router.push({
          pathname: "/verify-email",
          params: {
            email: parsed.identifier,
            mode: "login",
            sent: "1",
            identifier: parsed.identifier,
            authMethod: "email",
          },
        } as never);
        return;
      }

      // Existing number signs in after the code. A new number opens Create account.
      const { error } = await sendOTP(parsed.identifier);
      if (error) {
        setErrorMessage(error.message);
        return;
      }
      router.replace({
        pathname: "/verify-otp",
        params: {
          phone: parsed.identifier,
          identifier: parsed.identifier,
          authMethod: "phone",
        },
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "MSG91 could not send the code.");
    } finally {
      isSendingOtpRef.current = false;
      setIsSendingOtp(false);
    }
  };

  if (googleHandoff) {
    return (
      <View style={styles.root}>
        <StatusBar barStyle="light-content" backgroundColor={colors.background} />
      </View>
    );
  }

  if (!fontsLoaded) {
    return (
      <View style={[styles.root, styles.fontLoading]}>
        <StatusBar barStyle="light-content" backgroundColor={colors.background} />
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={colors.background} />
      <View style={styles.shell}>
        {showSidebar ? (
          <View style={[styles.previewSidebar, !isDesktop && styles.previewSidebarMobile]}>
            <View style={styles.previewBrandRow}>
              <View style={styles.previewBrand}>
                <AskPranaLogo size={28} decorative />
                <Text style={styles.previewBrandText}>ASK PRANA</Text>
              </View>
              <Pressable onPress={() => setShellSidebar(false)} accessibilityRole="button" accessibilityLabel="Close sidebar">
                <Feather name={isDesktop ? "sidebar" : "x"} size={17} color="#9AA4B2" />
              </Pressable>
            </View>
            <Pressable onPress={openLogin} style={styles.previewNewChat} accessibilityRole="button">
              <Feather name="plus" size={18} color="#F4F7FA" />
              <Text style={styles.previewNewChatText}>New chat</Text>
            </Pressable>
            <Pressable onPress={openLogin} style={styles.previewSearch} accessibilityRole="button">
              <Feather name="search" size={16} color="#9AA4B2" />
              <Text style={styles.previewSearchText}>Search chats</Text>
            </Pressable>
          </View>
        ) : null}
        <View style={styles.previewMain}>
          <View style={styles.previewHeader}>
            {showSidebar ? <View style={styles.previewHeaderSide} /> : (
              <Pressable onPress={() => setShellSidebar(true)} style={styles.previewHeaderSide} accessibilityRole="button" accessibilityLabel="Open sidebar">
                <Feather name="menu" size={21} color="#0F766E" />
              </Pressable>
            )}
            <View style={styles.previewHeaderCenter}>
              <AskPranaLogo size={28} decorative />
              <Text style={styles.previewTitle}>Ask Prana</Text>
            </View>
            <View style={[styles.previewHeaderSide, styles.previewHeaderRight]}>
              {panelOpen ? null : (
                <Pressable onPress={openLogin} style={styles.reopenButton} accessibilityRole="button">
                  <Text style={styles.reopenText}>Log in</Text>
                </Pressable>
              )}
            </View>
          </View>
          <Pressable onPress={openLogin} style={styles.previewEmpty} accessibilityRole="button">
            <AskPranaLogo size={72} decorative />
            <Text style={styles.previewTitle}>Ask Prana</Text>
          </Pressable>
          <Pressable onPress={openLogin} style={[styles.previewComposer, { marginBottom: Math.max(insets.bottom, 16) }]} accessibilityRole="button" accessibilityLabel="Message Ask Prana">
            <Feather name="plus" size={22} color="#9AA4B2" />
            <Text style={styles.previewComposerText}>Message Ask Prana</Text>
            <Feather name="mic" size={18} color="#F4F7FA" />
            <View style={styles.previewSend}>
              <Feather name="radio" size={16} color="#FFFFFF" />
            </View>
          </Pressable>
        </View>
      </View>
      {panelOpen ? (
        <KeyboardAvoidingView
          style={styles.loginOverlay}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          pointerEvents="box-none"
        >
          <ScrollView
            contentContainerStyle={styles.loginOverlayContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.authCard}>
                  <View style={styles.authHeader}>
                    <Text style={styles.authTitle}>Log in or sign up</Text>
                    <Pressable
                      onPress={() => setPanelOpen(false)}
                      style={styles.closeButton}
                      accessibilityRole="button"
                      accessibilityLabel="Close"
                    >
                      <Text style={styles.closeMark}>×</Text>
                    </Pressable>
                  </View>
                  {phoneStep ? (
                    <View style={styles.inputGroup}>
                      <Text style={styles.label}>Mobile number</Text>
                      <View style={[styles.inputContainer, inputFocused && styles.inputContainerFocused, errorMessage ? styles.inputContainerError : null]}>
                        <TextInput
                          value={phoneInput}
                          onChangeText={(value) => {
                            setPhoneInput(value);
                            if (errorMessage) setErrorMessage(null);
                          }}
                          editable={!isSendingOtp}
                          placeholder="10-digit mobile number"
                          placeholderTextColor={colors.placeholder}
                          keyboardType="phone-pad"
                          style={styles.input}
                          onFocus={() => setInputFocused(true)}
                          onBlur={() => setInputFocused(false)}
                          onSubmitEditing={() => void handleSendOtp(phoneInput, "phone")}
                          accessibilityLabel="Mobile number"
                        />
                      </View>
                    </View>
                  ) : (
                    <>
                      <Pressable onPress={() => void handleGoogle()} disabled={googleBusy} style={styles.providerButton} accessibilityRole="button">
                        <View style={styles.providerContent}>
                          <GoogleMark />
                          <Text style={styles.providerText}>{googleBusy ? "Opening Google..." : "Continue with Google"}</Text>
                        </View>
                      </Pressable>
                      {googleNotice ? <Text style={styles.googleNotice}>{googleNotice}</Text> : null}
                      <Pressable style={styles.providerButton} accessibilityRole="button">
                        <View style={styles.providerContent}>
                          <AppleMark />
                          <Text style={styles.providerText}>Continue with Apple</Text>
                        </View>
                      </Pressable>
                      <Pressable
                        onPress={() => {
                          setErrorMessage(null);
                          setPhoneStep(true);
                        }}
                        style={styles.providerButton}
                        accessibilityRole="button"
                      >
                        <View style={styles.providerContent}>
                          <PhoneMark />
                          <Text style={styles.providerText}>Continue with phone</Text>
                        </View>
                      </Pressable>
                      <Text style={styles.orDivider}>OR</Text>
                      <View style={[styles.inputContainer, inputFocused && styles.inputContainerFocused, errorMessage ? styles.inputContainerError : null]}>
                        <TextInput
                          value={identifierInput}
                          onChangeText={(value) => {
                            setIdentifierInput(value);
                            if (errorMessage) setErrorMessage(null);
                          }}
                          editable={!isSendingOtp}
                          placeholder="Email address"
                          placeholderTextColor={colors.placeholder}
                          keyboardType="email-address"
                          autoCapitalize="none"
                          autoCorrect={false}
                          autoComplete="email"
                          style={styles.input}
                          onFocus={() => setInputFocused(true)}
                          onBlur={() => setInputFocused(false)}
                          onSubmitEditing={() => void handleSendOtp(identifierInput, "email")}
                          accessibilityLabel="Email address"
                        />
                      </View>
                    </>
                  )}
                  {errorMessage ? (
                    <Text style={styles.errorText} accessibilityLiveRegion="polite">{errorMessage}</Text>
                  ) : null}
                  <Pressable
                    onPress={() => void handleSendOtp(phoneStep ? phoneInput : identifierInput, phoneStep ? "phone" : "email")}
                    disabled={phoneStep ? !canSendPhone : !canSendEmail}
                    style={[styles.continueButton, (phoneStep ? !canSendPhone : !canSendEmail) && styles.continueDisabled]}
                    accessibilityRole="button"
                  >
                    {isSendingOtp ? <ActivityIndicator color="#171717" /> : <Text style={styles.continueText}>Continue</Text>}
                  </Pressable>
                  {phoneStep ? (
                    <Pressable onPress={() => { setPhoneStep(false); setErrorMessage(null); }} accessibilityRole="button">
                      <Text style={styles.backLink}>Back</Text>
                    </Pressable>
                  ) : null}
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      ) : null}
    </View>
  );
}


const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
    overflow: "hidden",
  },
  fontLoading: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.background,
  },
  safeArea: {
    flex: 1,
    backgroundColor: "transparent",
    overflow: "hidden",
  },
  keyboardView: {
    flex: 1,
    overflow: "hidden",
  },
  scroll: {
    flex: 1,
  },
  pageContent: {
    flexGrow: 1,
    paddingHorizontal: 20,
  },
  centerWrapper: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 32,
  },
  loginContainer: {
    width: "100%",
    maxWidth: 540,
  },
  brandBlock: {
    alignItems: "center",
    marginBottom: 24,
  },
  welcomeLabel: {
    color: colors.primary,
    fontFamily: fonts.bold,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 1.4,
    textTransform: "uppercase",
    marginBottom: 8,
    textAlign: "center",
  },
  title: {
    color: colors.text,
    fontFamily: fonts.extraBold,
    marginBottom: 8,
    textAlign: "center",
  },
  subtitle: {
    color: colors.textSoft,
    fontFamily: fonts.medium,
    fontSize: 15,
    lineHeight: 21,
    marginBottom: 18,
    textAlign: "center",
  },
  inputGroup: {
    gap: 8,
    marginBottom: 16,
  },
  label: {
    color: colors.text,
    fontFamily: fonts.bold,
    fontSize: 14,
    lineHeight: 18,
  },
  inputContainer: {
    height: 54,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    backgroundColor: colors.inputBg,
    overflow: "hidden",
  },
  inputContainerFocused: {
    borderColor: colors.primary,
  },
  inputContainerError: {
    borderColor: colors.error,
  },
  input: {
    flex: 1,
    height: "100%",
    paddingHorizontal: 14,
    color: colors.text,
    fontFamily: fonts.medium,
    fontSize: 16,
    lineHeight: 22,
    ...(Platform.OS === "web"
      ? ({ outlineStyle: "none", outlineWidth: 0 } as object)
      : null),
  },
  errorText: {
    color: colors.error,
    fontFamily: fonts.medium,
    fontSize: 12,
    lineHeight: 16,
  },
  googleNotice: {
    color: colors.textSoft,
    fontFamily: fonts.medium,
    fontSize: 12,
    lineHeight: 16,
    textAlign: "center",
  },
  actions: {
    gap: 12,
  },
  button: {
    height: 54,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    shadowColor: colors.shadow,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 3,
  },
  buttonPressed: {
    opacity: 0.92,
  },
  buttonContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  buttonText: {
    color: colors.white,
    fontFamily: fonts.bold,
    fontSize: 15,
    lineHeight: 20,
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  buttonTextDisabled: {
    color: colors.ctaDisabledText,
  },
  termsText: {
    marginTop: 4,
    textAlign: "center",
    color: colors.muted,
    fontFamily: fonts.medium,
    fontSize: 11,
    lineHeight: 15,
  },
  authCard: {
    width: "100%",
    maxWidth: 400,
    gap: 12,
    paddingHorizontal: 24,
    paddingTop: 28,
    paddingBottom: 22,
    borderRadius: 28,
    backgroundColor: "#2F2F2F",
  },
  authHeader: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  authTitle: {
    color: colors.white,
    fontFamily: fonts.bold,
    fontSize: 20,
    lineHeight: 26,
    textAlign: "center",
  },
  closeButton: {
    position: "absolute",
    right: 0,
    top: 0,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#3A3A3A",
  },
  closeMark: {
    color: colors.white,
    fontSize: 22,
    lineHeight: 24,
  },
  providerButton: {
    minHeight: 48,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: "#5A5A5A",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#303030",
  },
  providerContent: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  providerText: {
    color: colors.white,
    fontFamily: fonts.medium,
    fontSize: 16,
    lineHeight: 22,
  },
  orDivider: {
    color: colors.muted,
    fontFamily: fonts.medium,
    fontSize: 12,
    lineHeight: 16,
    textAlign: "center",
    letterSpacing: 1,
  },
  continueButton: {
    minHeight: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFFFFF",
  },
  continueDisabled: {
    opacity: 0.55,
  },
  continueText: {
    color: "#171717",
    fontFamily: fonts.bold,
    fontSize: 16,
    lineHeight: 22,
  },
  backLink: {
    color: colors.textSoft,
    fontFamily: fonts.medium,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  reopenButton: {
    minHeight: 44,
    paddingHorizontal: 18,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FFFFFF",
  },
  reopenText: {
    color: "#171717",
    fontFamily: fonts.bold,
    fontSize: 15,
    lineHeight: 20,
  },
  shell: {
    flex: 1,
    flexDirection: "row",
    backgroundColor: "#171717",
  },
  previewSidebar: {
    width: 280,
    borderRightWidth: 1,
    borderRightColor: "#2A303C",
    backgroundColor: "#171717",
    paddingHorizontal: 12,
    paddingTop: 12,
    gap: 10,
  },
  previewSidebarMobile: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    zIndex: 2,
  },
  previewBrandRow: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  previewBrand: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  previewBrandText: {
    color: "#F4F7FA",
    fontFamily: fonts.bold,
    fontSize: 18,
    lineHeight: 23,
  },
  previewNewChat: {
    minHeight: 42,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: "#21262F",
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  previewNewChatText: {
    color: "#F4F7FA",
    fontFamily: fonts.bold,
    fontSize: 14,
    lineHeight: 20,
  },
  previewSearch: {
    minHeight: 38,
    borderWidth: 1,
    borderColor: "#2A303C",
    borderRadius: 7,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
  },
  previewSearchText: {
    color: "#9AA4B2",
    fontFamily: fonts.medium,
    fontSize: 14,
    lineHeight: 20,
  },
  previewMain: {
    flex: 1,
    minWidth: 0,
  },
  previewHeader: {
    height: 64,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
  },
  previewHeaderSide: {
    width: 96,
    height: 40,
    alignItems: "flex-start",
    justifyContent: "center",
  },
  previewHeaderRight: {
    alignItems: "flex-end",
    width: 110,
  },
  previewHeaderCenter: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  previewTitle: {
    color: "#F4F7FA",
    fontFamily: fonts.bold,
    fontSize: 20,
    lineHeight: 25,
  },
  previewEmpty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  previewComposer: {
    minHeight: 52,
    marginHorizontal: 16,
    marginBottom: 16,
    paddingHorizontal: 14,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: "#2A303C",
    backgroundColor: "#212121",
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  previewComposerText: {
    flex: 1,
    color: "#9AA4B2",
    fontFamily: fonts.medium,
    fontSize: 15,
    lineHeight: 22,
  },
  previewSend: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#0F766E",
    alignItems: "center",
    justifyContent: "center",
  },
  loginOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  loginOverlayContent: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
});
