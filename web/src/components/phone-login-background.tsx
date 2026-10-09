import type { ReactNode } from "react";
import {
  Image,
  ImageBackground,
  Platform,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/** Shared cream wave-line pattern background (used across screens). */
export const APP_SCREEN_BG = require("../../assets/images/app-screen-bg.png");

/** Shared teal header wave graphic (used across screens). */
export const APP_SCREEN_WAVE = require("../../assets/images/app-screen-wave.png");

const WAVE_ASSET_WIDTH = 649;
const WAVE_ASSET_HEIGHT = 513;
/** Lowest useful wave row before empty/black padding. */
const WAVE_CONTENT_HEIGHT = 446;

const SCREEN_BACKGROUND = "#F7F4EF";
/** Same dark surface as the Ask Prana screen. */
export const AUTH_DARK_BACKGROUND = "#171717";

export type AppScreenWaveProfile = "compact" | "tall" | "ponds";

function useWaveMetrics(profile: AppScreenWaveProfile = "compact") {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const scale = windowWidth / WAVE_ASSET_WIDTH;
  const imageHeight = Math.round(WAVE_ASSET_HEIGHT * scale);
  const waveContentScaled = WAVE_CONTENT_HEIGHT * scale;

  let waveClipHeight: number;
  let contentInset: number;

  if (profile === "ponds") {
    // Target (~824px tall): waves end ~215px, cream gap, first card ~250–255px (~30.5%).
    const creamBreathing = Math.round(
      Math.min(Math.max(windowHeight * 0.045, 34), 45),
    );
    const decorativeTotal = Math.round(
      Math.min(
        Math.max(windowHeight * 0.32, insets.top + 210),
        insets.top + 290,
      ),
    );
    // Keep enough clip height to show the layered wave transition without hard crop.
    const minUncroppedWave = Math.round(
      Math.min(Math.max(waveContentScaled * 0.5, 190), windowHeight * 0.34),
    );
    waveClipHeight = Math.max(decorativeTotal - creamBreathing, minUncroppedWave);
    // Reserve header + waves + cream breathing space before the pond list.
    contentInset = Math.max(decorativeTotal, waveClipHeight + creamBreathing);
  } else {
    // compact = phone login; tall = verify OTP
    const ratio = profile === "tall" ? 0.21 : 0.18;
    const minH = profile === "tall" ? 130 : 110;
    const maxH = profile === "tall" ? 180 : 150;
    waveClipHeight = Math.round(
      Math.min(Math.max(windowHeight * ratio, minH), maxH),
    );
    contentInset = Math.max(waveClipHeight - 4, insets.top + 56);
  }

  // Align the bottom of the wave artwork to the bottom of the clip.
  const translateY = Math.round(waveClipHeight - waveContentScaled);

  return {
    windowWidth,
    waveClipHeight,
    imageHeight,
    translateY,
    contentInset,
  };
}

export function usePhoneLoginWaveInset(
  profile: AppScreenWaveProfile = "compact",
) {
  return useWaveMetrics(profile).contentInset;
}

export function usePhoneLoginWaveClipHeight(
  profile: AppScreenWaveProfile = "compact",
) {
  return useWaveMetrics(profile).waveClipHeight;
}

type PhoneLoginBackgroundProps = {
  children: ReactNode;
  /** compact = phone login; tall = verify OTP; ponds = home header */
  waveProfile?: AppScreenWaveProfile;
  /**
   * bottom = align wave artwork bottom into clip (OTP/phone login).
   * top = show full top of wave (no crop) — ponds header.
   */
  waveAlign?: "bottom" | "top";
  /** Extra translateY for the wave image (negative = move up / crop top). */
  waveOffsetY?: number;
  /**
   * light = cream pattern + teal wave artwork.
   * dark = flat Ask Prana dark surface (no pattern/wave), used by the auth screens.
   */
  appearance?: "light" | "dark";
};

export function PhoneLoginBackground({
  children,
  waveProfile = "compact",
  waveAlign = "bottom",
  waveOffsetY = 0,
  appearance = "light",
}: PhoneLoginBackgroundProps) {
  const { windowWidth, waveClipHeight, imageHeight, translateY } =
    useWaveMetrics(waveProfile);
  // Ponds: bottom-align layered waves into the taller wave clip (cream gap is reserved in contentInset).
  const alignedTranslateY =
    (waveProfile === "ponds" || waveAlign === "bottom" ? translateY : 0) +
    waveOffsetY;

  if (appearance === "dark") {
    return (
      <View style={[styles.root, styles.rootDark]}>
        <View style={styles.content}>{children}</View>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <ImageBackground
        source={APP_SCREEN_BG}
        style={StyleSheet.absoluteFill}
        resizeMode="cover"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      />

      <View
        style={[styles.waveClip, { height: waveClipHeight }]}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Image
          source={APP_SCREEN_WAVE}
          style={{
            width: windowWidth,
            height: imageHeight,
            transform: [{ translateY: alignedTranslateY }],
          }}
          resizeMode="stretch"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
      </View>

      <View style={styles.content}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: SCREEN_BACKGROUND,
    overflow: "hidden",
    // Keep the wave pinned to the viewport — prevent document/page scroll on web.
    minHeight: 0,
    ...(Platform.OS === "web" ? ({ height: "100%" } as object) : null),
  },
  rootDark: {
    backgroundColor: AUTH_DARK_BACKGROUND,
  },
  waveClip: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    overflow: "hidden",
    zIndex: 0,
  },
  content: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
    zIndex: 1,
  },
});
