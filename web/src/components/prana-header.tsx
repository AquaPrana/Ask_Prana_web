import type { ReactNode } from "react";
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AskPranaLogo } from "./ask-prana-logo";
import { APP_SCREEN_WAVE } from "./phone-login-background";
import { PRANA_FONT, prana, pranaGradientStyle } from "../constants/prana-theme";

const WAVE_W = 649;
const WAVE_H = 513;
/** Last row of the wave artwork before its transparent bottom. */
const WAVE_CONTENT_BOTTOM = 446;
/** Visible wave band under the header row (prototype: 649 × 212). */
const WAVE_BAND = 212;

type BrandProps = {
  color?: string;
  iconSize?: number;
  wordSize?: number;
  subtitle?: string | null;
  subtitleColor?: string;
  align?: "center" | "left";
};

/** Logo badge + "AskPrana" word mark, with the optional tagline under it. */
export function PranaBrand({
  color = "#FFFFFF",
  iconSize = 27,
  wordSize = 21,
  subtitle = "Your aquaculture assistant",
  subtitleColor = prana.headerSubtitle,
  align = "center",
}: BrandProps) {
  return (
    <View style={{ alignItems: align === "center" ? "center" : "flex-start", minWidth: 0 }}>
      <View style={styles.brandRow}>
        <AskPranaLogo size={iconSize} decorative />
        <Text
          style={[styles.brandWord, { color, fontSize: wordSize, lineHeight: Math.round(wordSize * 1.2) }]}
          numberOfLines={1}
        >
          AskPrana
        </Text>
      </View>
      {subtitle ? (
        <Text
          style={[
            styles.brandSubtitle,
            { color: subtitleColor },
            align === "left" ? { paddingLeft: iconSize + 8 } : null,
          ]}
          numberOfLines={1}
        >
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}

type HeaderButtonProps = {
  icon: keyof typeof Feather.glyphMap;
  onPress: () => void;
  label: string;
  tone?: "dark" | "light";
};

/** Square translucent header button (menu, back, chat). */
export function PranaHeaderButton({ icon, onPress, label, tone = "dark" }: HeaderButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.headerButton,
        tone === "light" && styles.headerButtonLight,
        pressed && { opacity: 0.8 },
      ]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Feather name={icon} size={21} color={tone === "light" ? "#7E957F" : "#FFFFFF"} />
    </Pressable>
  );
}

type LanguageButtonProps = {
  label: string;
  onPress?: () => void;
  accessibilityLabel?: string;
  tone?: "dark" | "light";
};

/** "EN ▾" language control used in the header. */
export function PranaLanguageButton({ label, onPress, accessibilityLabel, tone = "dark" }: LanguageButtonProps) {
  const light = tone === "light";
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.langButton, light && styles.langButtonLight, pressed && { opacity: 0.8 }]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
    >
      <Text style={[styles.langText, light && { color: "#577E5F" }]}>{label.toUpperCase()}</Text>
      <Feather name="chevron-down" size={12} color={light ? "#577E5F" : "#FFFFFF"} />
    </Pressable>
  );
}

/** Cream "Log in" pill used in guest headers. */
export function PranaHeaderLogin({ onPress, label = "Log in", tone = "dark" }: { onPress: () => void; label?: string; tone?: "dark" | "light" }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.loginButton, tone === "light" && styles.loginButtonLight, pressed && { opacity: 0.85 }]}
      accessibilityRole="button"
    >
      <Text style={[styles.loginText, tone === "light" && { color: "#4C7654", fontSize: 12 }]}>{label}</Text>
    </Pressable>
  );
}

type HeaderProps = {
  /**
   * wave  = dark teal header with the layered wave artwork (login, OTP, history, profile).
   * teal  = flat teal gradient bar (mobile chat).
   * light = cream bar with a hairline (desktop).
   */
  variant: "wave" | "teal" | "light";
  left?: ReactNode;
  right?: ReactNode;
  /** Adds the device's top safe-area inset (mobile screens). */
  includeTopInset?: boolean;
  subtitle?: string | null;
  style?: StyleProp<ViewStyle>;
};

export function PranaHeader({ variant, left, right, includeTopInset = true, subtitle, style }: HeaderProps) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const top = includeTopInset ? insets.top : 0;

  if (variant === "light") {
    return (
      <View style={[styles.lightBar, style]}>
        <View style={styles.lightSide}>{left}</View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <PranaBrand
            color={prana.ink}
            wordSize={23}
            align="left"
            subtitle={subtitle === undefined ? "Your aquaculture assistant" : subtitle}
            subtitleColor="#8B9B83"
          />
        </View>
        <View style={styles.rightControls}>{right}</View>
      </View>
    );
  }

  const row = (
    <View style={styles.row}>
      <View style={styles.side}>{left}</View>
      <View style={styles.center}>
        <PranaBrand subtitle={subtitle === undefined ? "Your aquaculture assistant" : subtitle} />
      </View>
      <View style={[styles.rightControls, styles.rightSide]}>{right}</View>
    </View>
  );

  if (variant === "teal") {
    return (
      <View style={[styles.tealBar, pranaGradientStyle, { paddingTop: top + 10 }, style]}>
        {row}
      </View>
    );
  }

  // Wave header: the bottom 212 units of the artwork sit under the header row.
  const scale = width / WAVE_W;
  const band = Math.round(WAVE_BAND * scale);
  const rowHeight = 59;
  const height = top + rowHeight + band;
  const imageHeight = WAVE_H * scale;
  const imageTop = height - WAVE_CONTENT_BOTTOM * scale;
  return (
    <View style={[styles.waveWrap, { height }, style]}>
      <View style={[styles.waveTopFill, { height: Math.max(0, imageTop) + 2 }]} pointerEvents="none" />
      <Image
        source={APP_SCREEN_WAVE}
        style={{ position: "absolute", left: 0, top: imageTop, width, height: imageHeight }}
        resizeMode="stretch"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      />
      <View style={{ paddingTop: top + 9 }}>{row}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  brandRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  brandWord: {
    fontFamily: PRANA_FONT,
    fontWeight: "800",
    letterSpacing: -0.4,
  },
  brandSubtitle: {
    fontFamily: PRANA_FONT,
    fontSize: 9,
    lineHeight: 12,
    marginTop: 3,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 18,
    paddingBottom: 4,
    minHeight: 46,
  },
  side: { width: 42, alignItems: "flex-start" },
  rightSide: { minWidth: 42, justifyContent: "flex-end" },
  center: { flex: 1, minWidth: 0, alignItems: "center" },
  rightControls: { flexDirection: "row", alignItems: "center", gap: 7 },
  tealBar: {
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(26,105,90,0.1)",
  },
  waveWrap: {
    position: "relative",
    overflow: "hidden",
    backgroundColor: prana.cream,
  },
  waveTopFill: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    backgroundColor: prana.headerDark,
  },
  headerButton: {
    width: 42,
    height: 42,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.094)",
  },
  headerButtonLight: {
    width: 36,
    height: 36,
    backgroundColor: "transparent",
  },
  langButton: {
    minWidth: 50,
    height: 36,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.33)",
    backgroundColor: "rgba(255,255,255,0.086)",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingHorizontal: 9,
  },
  langButtonLight: {
    backgroundColor: "#F2F5E5",
    borderColor: "#C5D6BD",
  },
  langText: {
    color: "#FFFFFF",
    fontFamily: PRANA_FONT,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "700",
  },
  loginButton: {
    minHeight: 36,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 11,
    backgroundColor: prana.card,
    alignItems: "center",
    justifyContent: "center",
  },
  loginButtonLight: {
    backgroundColor: "#EDF2E2",
    borderWidth: 1,
    borderColor: "#BFD1B6",
    paddingHorizontal: 16,
  },
  loginText: {
    color: "#205F54",
    fontFamily: PRANA_FONT,
    fontSize: 10,
    lineHeight: 14,
    fontWeight: "800",
  },
  lightBar: {
    height: 81,
    paddingHorizontal: 34,
    flexDirection: "row",
    alignItems: "center",
    gap: 15,
    backgroundColor: prana.desktopHeader,
    borderBottomWidth: 1,
    borderBottomColor: prana.desktopHeaderBorder,
  },
  lightSide: { minWidth: 0 },
});
