import { useEffect, useRef, useState } from "react";
import { sendOTP } from "../services/auth";
import { finishGoogleSignIn, startGoogleSignIn, takeGoogleReturn } from "../services/google-sign-in";
import { isValidEmail, normalizeEmail, sendEmailLoginCode } from "../services/profile";
import { AskPranaLogo } from "../components/ask-prana-logo";
import { AskPranaVoiceWaveformIcon } from "../components/ask-prana-voice-waveform-icon";
import {
  PranaBrand,
  PranaHeader,
  PranaHeaderButton,
  PranaHeaderLogin,
} from "../components/prana-header";
import { PranaThemeToggle } from "../components/prana-theme-toggle";
import { PRANA_FONT, prana, pranaGradientStyle } from "../constants/prana-theme";
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
import { pc } from "../constants/prana-theme-mode";

// AskPrana cream / teal theme.
const colors = {
  primary: prana.teal,
  primaryDark: prana.tealDeep,
  primaryBright: prana.teal,
  background: prana.cream,
  white: "#FFFFFF",
  text: prana.ink,
  textSoft: prana.muted,
  muted: "#8A9985",
  border: prana.inputBorder,
  inputBg: prana.card,
  placeholder: "#8A9B8B",
  error: prana.error,
  ctaDisabled: "#9FC0B6",
  ctaDisabledText: "#FFFFFF",
  ctaGradientStart: PRIMARY_CTA_START,
  shadow: "#1D4B36",
};

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
      <Path fill="#245B4E" d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zm4.961-3.066c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701z" />
    </Svg>
  );
}

function PhoneMark() {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24">
      <Path
        fill="none"
        stroke="#245B4E"
        strokeWidth={1.6}
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
        <StatusBar barStyle="light-content" backgroundColor={pc.bg(colors.background)} />
      </View>
    );
  }


  const loginForm = (
    <>
      <Text style={styles.kicker}>WELCOME TO ASKPRANA</Text>
      <Text style={styles.authTitle}>Log in or sign up</Text>
      <Text style={styles.authSubtitle}>Choose how you'd like to continue.</Text>
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
              placeholderTextColor={pc.fg(colors.placeholder)}
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
          <View style={styles.providerList}>
            <Pressable onPress={() => void handleGoogle()} disabled={googleBusy} style={({ pressed }) => [styles.providerButton, pressed && styles.pressed]} accessibilityRole="button">
              <View style={styles.providerIcon}><GoogleMark /></View>
              <Text style={styles.providerText}>{googleBusy ? "Opening Google..." : "Continue with Google"}</Text>
            </Pressable>
            {googleNotice ? <Text style={styles.googleNotice}>{googleNotice}</Text> : null}
            <Pressable style={({ pressed }) => [styles.providerButton, pressed && styles.pressed]} accessibilityRole="button">
              <View style={styles.providerIcon}><AppleMark /></View>
              <Text style={styles.providerText}>Continue with Apple</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setErrorMessage(null);
                setPhoneStep(true);
              }}
              style={({ pressed }) => [styles.providerButton, pressed && styles.pressed]}
              accessibilityRole="button"
            >
              <View style={styles.providerIcon}><PhoneMark /></View>
              <Text style={styles.providerText}>Continue with phone</Text>
            </Pressable>
          </View>
          <View style={styles.orRow}>
            <View style={styles.orLine} />
            <Text style={styles.orDivider}>OR</Text>
            <View style={styles.orLine} />
          </View>
          <Text style={styles.label}>Email address</Text>
          <View style={[styles.inputContainer, inputFocused && styles.inputContainerFocused, errorMessage ? styles.inputContainerError : null]}>
            <TextInput
              value={identifierInput}
              onChangeText={(value) => {
                setIdentifierInput(value);
                if (errorMessage) setErrorMessage(null);
              }}
              editable={!isSendingOtp}
              placeholder="Email address"
              placeholderTextColor={pc.fg(colors.placeholder)}
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
        style={[styles.continueButton, pranaGradientStyle, (phoneStep ? !canSendPhone : !canSendEmail) && styles.continueDisabled]}
        accessibilityRole="button"
      >
        {isSendingOtp ? (
          <ActivityIndicator color={pc.fg("#FFFFFF")} />
        ) : (
          <>
            <Text style={styles.continueText}>Continue</Text>
            <Feather name="arrow-right" size={18} color={pc.fg("#FFFFFF")} />
          </>
        )}
      </Pressable>
      {phoneStep ? (
        <Pressable onPress={() => { setPhoneStep(false); setErrorMessage(null); }} accessibilityRole="button" style={styles.backLinkWrap}>
          <Feather name="arrow-left" size={13} color={pc.fg("#217C73")} />
          <Text style={styles.backLink}>Back</Text>
        </Pressable>
      ) : null}
    </>
  );

  const closeButton = (
    <Pressable
      onPress={() => setPanelOpen(false)}
      style={styles.closeButton}
      accessibilityRole="button"
      accessibilityLabel="Close"
    >
      <Feather name="x" size={17} color={pc.fg("#52806B")} />
    </Pressable>
  );

  // Phones: the login form is its own page under the wave header.
  if (panelOpen && !isDesktop) {
    return (
      <View style={styles.root}>
        <StatusBar barStyle="light-content" backgroundColor={pc.bg(prana.headerDark)} />
        <PranaHeader
          variant="wave"
          left={<PranaHeaderButton icon="message-square" onPress={() => setPanelOpen(false)} label="Back to chat" />}
          right={<View style={{ width: 42 }} />}
        />
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <ScrollView
            contentContainerStyle={[styles.mobileForm, { paddingBottom: Math.max(insets.bottom, 24) }]}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.mobileCloseRow}>{closeButton}</View>
            {loginForm}
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    );
  }

  const composerPreview = (
    <Pressable
      onPress={openLogin}
      style={[styles.previewComposer, isDesktop ? styles.previewComposerDesktop : { paddingBottom: Math.max(insets.bottom, 12) }]}
      accessibilityRole="button"
      accessibilityLabel="Message AskPrana"
    >
      <View style={styles.previewRow}>
        <View style={[styles.tileAttach, isDesktop && styles.tileAttachDesktop]}>
          <Feather name="paperclip" size={19} color={pc.fg("#397F6E")} />
          <Text style={styles.tileLabel}>Attach</Text>
        </View>
        <View style={[styles.previewBox, isDesktop && styles.previewBoxDesktop]}>
          <Text style={styles.previewComposerText} numberOfLines={1}>Message AskPrana…</Text>
          <View style={styles.previewDictate}>
            <Feather name="mic" size={17} color={pc.fg("#538478")} />
            <Text style={styles.dictateLabel}>Dictate</Text>
          </View>
        </View>
        <View style={[styles.tileVoice, isDesktop && styles.tileVoiceDesktop]}>
          <AskPranaVoiceWaveformIcon size={18} color={pc.fg("#397C6A")} />
          <Text style={styles.tileLabel} numberOfLines={1}>Voice chat</Text>
        </View>
        <View style={[styles.tileSend, pranaGradientStyle, isDesktop && styles.tileSendDesktop]}>
          <Feather name="send" size={19} color={pc.fg("#FFFFFF")} />
          <Text style={[styles.tileLabel, { color: pc.fg("#FFFFFF") }]}>Send</Text>
        </View>
      </View>
      <Text style={styles.previewNote}>Type a message, attach a file or use the mic.</Text>
    </Pressable>
  );

  return (
    <View style={styles.root}>
      <StatusBar
        barStyle={isDesktop ? "dark-content" : "light-content"}
        backgroundColor={isDesktop ? pc.bg(prana.desktopHeader) : pc.bg(prana.tealDeep)}
      />
      <View style={styles.shell}>
        {showSidebar ? (
          <View style={[styles.previewSidebar, !isDesktop && styles.previewSidebarMobile, !isDesktop && { paddingTop: insets.top + 24 }]}>
            <View style={styles.previewBrandRow}>
              <View style={styles.previewBrand}>
                <AskPranaLogo size={31} decorative />
                <Text style={styles.previewBrandText}>AskPrana</Text>
              </View>
              <Pressable onPress={() => setShellSidebar(false)} style={styles.collapseButton} accessibilityRole="button" accessibilityLabel="Close sidebar">
                <Feather name={isDesktop ? "sidebar" : "x"} size={18} color={pc.fg("#82927E")} />
              </Pressable>
            </View>
            <Pressable onPress={openLogin} style={styles.previewNewChat} accessibilityRole="button">
              <Feather name="plus" size={16} color={pc.fg("#235B4B")} />
              <Text style={styles.previewNewChatText}>New chat</Text>
            </Pressable>
            <Pressable onPress={openLogin} style={styles.previewSearch} accessibilityRole="button">
              <Feather name="search" size={15} color={pc.fg("#7D927F")} />
              <Text style={styles.previewSearchText}>Search chats</Text>
            </Pressable>
            <Text style={styles.sidebarLabel}>YOUR CONVERSATIONS</Text>
            <Text style={styles.sidebarEmpty}>Your conversations will appear here after you sign in.</Text>
            <View style={{ flex: 1 }} />
            <View style={styles.sidebarBottom}>
              <PranaThemeToggle />
              <Pressable onPress={openLogin} style={[styles.sidebarLogin, pranaGradientStyle]} accessibilityRole="button">
                <Text style={styles.sidebarLoginText}>Log in</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
        <View style={[styles.previewMain, !isDesktop && { backgroundColor: pc.bg(prana.tealDeep), paddingTop: insets.top }]}>
          <PranaHeader
            variant={isDesktop ? "light" : "teal"}
            includeTopInset={false}
            left={
              showSidebar && isDesktop ? null : (
                <PranaHeaderButton
                  icon="menu"
                  tone={isDesktop ? "light" : "dark"}
                  onPress={() => setShellSidebar(true)}
                  label="Open sidebar"
                />
              )
            }
            right={<PranaHeaderLogin onPress={openLogin} tone={isDesktop ? "light" : "dark"} />}
          />
          <View style={styles.previewBody}>
            <Pressable onPress={openLogin} style={styles.previewEmpty} accessibilityRole="button" accessibilityLabel="Log in to chat">
              <PranaBrand
                color={pc.fg(prana.ink)}
                iconSize={isDesktop ? 48 : 29}
                wordSize={isDesktop ? 46 : 29}
                subtitle={null}
              />
              <Text style={[styles.guestSubtitle, isDesktop && styles.guestSubtitleDesktop]}>Your aquaculture assistant</Text>
              <Text style={[styles.guestCopy, isDesktop && styles.guestCopyDesktop]}>
                Ask about your pond, water quality, feeding, growth or harvest.
              </Text>
            </Pressable>
            {composerPreview}
          </View>
        </View>
      </View>
      {panelOpen ? (
        <KeyboardAvoidingView
          style={styles.loginOverlay}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <Pressable style={styles.overlayBackdrop} onPress={() => setPanelOpen(false)} accessibilityLabel="Close" />
          <ScrollView
            contentContainerStyle={styles.loginOverlayContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.authCard}>
              <View style={styles.cardCloseRow}>{closeButton}</View>
              {loginForm}
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      ) : null}
    </View>
  );
}

const F = PRANA_FONT;

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: pc.bg(colors.background),
    overflow: "hidden",
  },
  fontLoading: {
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { opacity: 0.85 },
  // ---- Login form ----
  mobileForm: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: 4,
  },
  mobileCloseRow: { alignItems: "flex-end", marginBottom: -14, zIndex: 2 },
  cardCloseRow: { alignItems: "flex-end", marginBottom: -18, zIndex: 2 },
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: pc.bg("#E6EBD8"),
  },
  kicker: {
    color: pc.fg(prana.tealText),
    fontFamily: F,
    fontSize: 10,
    lineHeight: 13,
    fontWeight: "800",
    letterSpacing: 1.1,
    marginTop: 15,
    marginBottom: 8,
  },
  authTitle: {
    color: pc.fg(prana.ink),
    fontFamily: F,
    fontSize: 29,
    lineHeight: 34,
    fontWeight: "800",
    marginBottom: 12,
  },
  authSubtitle: {
    color: pc.fg(prana.muted),
    fontFamily: F,
    fontSize: 13,
    lineHeight: 21,
    marginBottom: 19,
  },
  providerList: { gap: 9 },
  providerButton: {
    minHeight: 48,
    paddingHorizontal: 36,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: pc.bd("#B7CDB8"),
    backgroundColor: pc.bg(prana.card),
    alignItems: "center",
    justifyContent: "center",
  },
  providerIcon: {
    position: "absolute",
    left: 15,
    top: 0,
    bottom: 0,
    justifyContent: "center",
  },
  providerText: {
    color: pc.fg("#245B4E"),
    fontFamily: F,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "700",
    textAlign: "center",
  },
  googleNotice: {
    color: pc.fg(prana.muted),
    fontFamily: F,
    fontSize: 12,
    lineHeight: 16,
    textAlign: "center",
  },
  orRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 16 },
  orLine: { flex: 1, height: 1, backgroundColor: pc.bg("#D8DFC8") },
  orDivider: {
    color: pc.fg(colors.muted),
    fontFamily: F,
    fontSize: 10,
    lineHeight: 13,
  },
  inputGroup: { gap: 0, marginBottom: 0 },
  label: {
    color: pc.fg(prana.ink),
    fontFamily: F,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "700",
    marginBottom: 9,
  },
  inputContainer: {
    height: 51,
    borderWidth: 1.4,
    borderColor: pc.bd(colors.border),
    borderRadius: 11,
    backgroundColor: pc.bg(colors.inputBg),
    overflow: "hidden",
  },
  inputContainerFocused: { borderColor: pc.bd(prana.teal) },
  inputContainerError: { borderColor: pc.bd(colors.error) },
  input: {
    flex: 1,
    height: "100%",
    paddingHorizontal: 12,
    color: pc.fg(prana.ink),
    fontFamily: F,
    // 16 px or more: iPhone Safari zooms the page into smaller text boxes.
    fontSize: 16,
    lineHeight: 20,
    ...(Platform.OS === "web"
      ? ({ outlineStyle: "none", outlineWidth: 0 } as object)
      : null),
  },
  errorText: {
    color: pc.fg(colors.error),
    fontFamily: F,
    fontSize: 12,
    lineHeight: 16,
    marginTop: 9,
  },
  continueButton: {
    marginTop: 12,
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
  continueDisabled: { opacity: 0.48 },
  continueText: {
    color: pc.fg("#FFFFFF"),
    fontFamily: F,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "800",
  },
  backLinkWrap: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    minHeight: 44,
    marginTop: 6,
  },
  backLink: {
    color: pc.fg("#217C73"),
    fontFamily: F,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "700",
  },
  // ---- Desktop login card ----
  loginOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  overlayBackdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "rgba(21, 57, 58, 0.4)",
  },
  loginOverlayContent: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  authCard: {
    width: "100%",
    maxWidth: 440,
    paddingHorizontal: 32,
    paddingTop: 24,
    paddingBottom: 28,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: pc.bd(prana.line),
    backgroundColor: pc.bg(prana.cream),
    shadowColor: "#15393A",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.18,
    shadowRadius: 40,
  },
  // ---- Guest shell ----
  shell: {
    flex: 1,
    flexDirection: "row",
    backgroundColor: pc.bg(prana.cream),
  },
  previewSidebar: {
    width: 264,
    borderRightWidth: 1,
    borderRightColor: pc.bd(prana.sidebarBorder),
    backgroundColor: pc.bg(prana.sidebar),
    paddingTop: 29,
    paddingHorizontal: 19,
    paddingBottom: 19,
  },
  previewSidebarMobile: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    width: "84%",
    maxWidth: 320,
    zIndex: 5,
    shadowColor: "#15393A",
    shadowOffset: { width: 12, height: 0 },
    shadowOpacity: 0.13,
    shadowRadius: 40,
  },
  previewBrandRow: {
    paddingHorizontal: 7,
    paddingBottom: 28,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  previewBrand: { flexDirection: "row", alignItems: "center", gap: 9 },
  previewBrandText: {
    color: pc.fg(prana.ink),
    fontFamily: F,
    fontSize: 24,
    lineHeight: 29,
    fontWeight: "800",
    letterSpacing: -0.4,
  },
  collapseButton: { width: 29, height: 29, alignItems: "center", justifyContent: "center" },
  previewNewChat: {
    minHeight: 49,
    paddingHorizontal: 15,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: pc.bd("#8EB49E"),
    backgroundColor: pc.bg("#DCE9D6"),
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
  },
  previewNewChatText: {
    color: pc.fg("#235B4B"),
    fontFamily: F,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "700",
  },
  previewSearch: {
    minHeight: 42,
    marginTop: 12,
    borderWidth: 1,
    borderColor: pc.bd("#CBD5BF"),
    backgroundColor: pc.bg("#F8F8E9"),
    borderRadius: 10,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
  },
  previewSearchText: {
    color: pc.fg("#829481"),
    fontFamily: F,
    fontSize: 12,
    lineHeight: 18,
  },
  sidebarLabel: {
    color: pc.fg("#94A08A"),
    fontFamily: F,
    fontSize: 9,
    lineHeight: 12,
    fontWeight: "800",
    letterSpacing: 1.2,
    marginTop: 29,
    marginBottom: 4,
    marginHorizontal: 9,
  },
  sidebarEmpty: {
    color: pc.fg("#8C9C85"),
    fontFamily: F,
    fontSize: 11,
    lineHeight: 20,
    paddingVertical: 14,
    paddingHorizontal: 9,
  },
  sidebarBottom: {
    borderTopWidth: 1,
    borderTopColor: pc.bd("#D4DDC5"),
    paddingTop: 4,
  },
  sidebarLogin: {
    minHeight: 43,
    marginTop: 10,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  sidebarLoginText: {
    color: pc.fg("#FFFFFF"),
    fontFamily: F,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "800",
  },
  previewMain: {
    flex: 1,
    minWidth: 0,
  },
  previewBody: {
    flex: 1,
    minHeight: 0,
    backgroundColor: pc.bg(prana.cream),
  },
  previewEmpty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 29,
  },
  guestSubtitle: {
    color: pc.fg("#34766A"),
    fontFamily: F,
    fontSize: 14,
    lineHeight: 21,
    fontWeight: "700",
    marginTop: 14,
    textAlign: "center",
  },
  guestSubtitleDesktop: { fontSize: 17, lineHeight: 24, marginTop: 20, color: pc.fg("#4F8174") },
  guestCopy: {
    color: pc.fg("#6A8574"),
    fontFamily: F,
    fontSize: 12,
    lineHeight: 21,
    marginTop: 10,
    textAlign: "center",
    maxWidth: 420,
  },
  guestCopyDesktop: { fontSize: 14, lineHeight: 24, maxWidth: 580 },
  previewComposer: {
    backgroundColor: pc.bg(prana.card),
    borderTopWidth: 1,
    borderTopColor: pc.bd(prana.line),
    paddingTop: 12,
    paddingHorizontal: 14,
    gap: 10,
    shadowColor: "#325B41",
    shadowOffset: { width: 0, height: -3 },
    shadowOpacity: 0.06,
    shadowRadius: 16,
  },
  previewComposerDesktop: {
    width: "100%",
    maxWidth: 840,
    alignSelf: "center",
    marginBottom: 19,
    paddingTop: 15,
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderWidth: 1,
    borderColor: pc.bd("#C8D9BF"),
    borderTopColor: pc.bd("#C8D9BF"),
    borderRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    shadowRadius: 25,
  },
  previewRow: { flexDirection: "row", alignItems: "stretch", gap: 7 },
  tileAttach: {
    width: 44,
    minHeight: 54,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: pc.bd(prana.attachBorder),
    backgroundColor: pc.bg(prana.attachBg),
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  tileAttachDesktop: { width: 47, minHeight: 58, borderWidth: 0 },
  tileVoice: {
    width: 50,
    minHeight: 54,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: pc.bd(prana.chipBorder),
    backgroundColor: pc.bg(prana.chip),
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
  },
  tileVoiceDesktop: { width: 58, minHeight: 58, borderColor: pc.bd("#D3DFC9"), backgroundColor: pc.bg("#F8F9ED") },
  tileSend: {
    width: 44,
    minHeight: 54,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  tileSendDesktop: { width: 51, minHeight: 58 },
  tileLabel: {
    color: pc.fg("#397F6E"),
    fontFamily: F,
    fontSize: 8,
    lineHeight: 10,
    fontWeight: "700",
  },
  previewBox: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: pc.bd("#B9CEBA"),
    borderRadius: 13,
    backgroundColor: pc.bg(prana.card),
    paddingLeft: 10,
    paddingRight: 3,
    paddingVertical: 3,
  },
  previewBoxDesktop: { borderWidth: 0, backgroundColor: pc.bg("#F5F6E7"), paddingLeft: 17 },
  previewComposerText: {
    flex: 1,
    color: pc.fg(prana.placeholder),
    fontFamily: F,
    fontSize: 14,
    lineHeight: 20,
  },
  previewDictate: {
    width: 39,
    minHeight: 44,
    alignSelf: "stretch",
    marginLeft: 5,
    borderLeftWidth: 1,
    borderLeftColor: pc.bd("#E1E6D3"),
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  dictateLabel: {
    color: pc.fg("#538478"),
    fontFamily: F,
    fontSize: 7,
    lineHeight: 9,
    fontWeight: "600",
  },
  previewChips: { flexDirection: "row", gap: 7 },
  previewChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 43,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: pc.bd(prana.chipBorder),
    backgroundColor: pc.bg(prana.chip),
  },
  previewChipText: {
    color: pc.fg(prana.chipText),
    fontFamily: F,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "700",
  },
  previewNote: {
    textAlign: "center",
    color: pc.fg("#75877C"),
    fontFamily: F,
    fontSize: 9,
    lineHeight: 13,
  },
});
