import { useId } from "react";
import { Platform, StyleSheet, View } from "react-native";
import Svg, {
  Defs,
  LinearGradient as SvgLinearGradient,
  Rect,
  Stop,
} from "react-native-svg";
import {
  PRIMARY_CTA_CSS_HORIZONTAL,
  PRIMARY_CTA_DISABLED,
  PRIMARY_CTA_STOPS,
} from "../constants/primary-cta";

type PrimaryCtaGradientFillProps = {
  disabled?: boolean;
  /** Optional SVG gradient id; auto-generated on native when omitted. */
  gradientId?: string;
};

/**
 * Shared primary button fill — same gradient as phone-login SEND OTP.
 * Web: CSS linear-gradient. Native: SVG LinearGradient (smooth teal → aqua).
 */
export function PrimaryCtaGradientFill({
  disabled = false,
  gradientId,
}: PrimaryCtaGradientFillProps) {
  const autoId = useId().replace(/:/g, "");
  const resolvedGradientId = gradientId ?? `primaryCtaGrad-${autoId}`;

  if (disabled) {
    return (
      <View
        style={[StyleSheet.absoluteFill, { backgroundColor: PRIMARY_CTA_DISABLED }]}
        pointerEvents="none"
      />
    );
  }

  if (Platform.OS === "web") {
    return (
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { backgroundImage: PRIMARY_CTA_CSS_HORIZONTAL } as object,
        ]}
      />
    );
  }

  return (
    <Svg
      width="100%"
      height="100%"
      style={StyleSheet.absoluteFill}
      preserveAspectRatio="none"
      pointerEvents="none"
    >
      <Defs>
        <SvgLinearGradient
          id={resolvedGradientId}
          x1="0"
          y1="0"
          x2="1"
          y2="0"
        >
          <Stop offset="0%" stopColor={PRIMARY_CTA_STOPS[0]} />
          <Stop offset="33%" stopColor={PRIMARY_CTA_STOPS[1]} />
          <Stop offset="66%" stopColor={PRIMARY_CTA_STOPS[2]} />
          <Stop offset="100%" stopColor={PRIMARY_CTA_STOPS[3]} />
        </SvgLinearGradient>
      </Defs>
      <Rect
        x="0"
        y="0"
        width="100%"
        height="100%"
        fill={`url(#${resolvedGradientId})`}
      />
    </Svg>
  );
}
