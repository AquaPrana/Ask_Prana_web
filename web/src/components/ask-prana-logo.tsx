import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { Image } from "expo-image";

const ASK_PRANA_LOGO = require("../../assets/images/ask-prana-logo.png");

// The source asset is a square 1024×1024 image on a solid black background,
// with the "ap" mark filling the middle ~62%. Rather than editing the asset,
// it is scaled up inside a clipped black badge so the mark stays legible at
// avatar sizes. Scaling is uniform, so the mark is never distorted.
const MARK_ZOOM = 1.4;

type Props = {
  /** Badge width and height in px. */
  size?: number;
  /** Hide from screen readers when an adjacent "Ask Prana" label already says it. */
  decorative?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** The official Ask Prana logo — use this everywhere the brand mark appears. */
export function AskPranaLogo({ size = 28, decorative = false, style }: Props) {
  const imageSize = size * MARK_ZOOM;
  return (
    <View
      style={[
        styles.badge,
        { width: size, height: size, borderRadius: Math.round(size * 0.28) },
        style,
      ]}
      accessible={!decorative}
      accessibilityRole={decorative ? undefined : "image"}
      accessibilityLabel={decorative ? undefined : "Ask Prana"}
      accessibilityElementsHidden={decorative}
      importantForAccessibility={decorative ? "no-hide-descendants" : "yes"}
    >
      <Image
        source={ASK_PRANA_LOGO}
        style={{ width: imageSize, height: imageSize }}
        contentFit="contain"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexShrink: 0,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    // Matches the asset's own background so the edges are seamless on light UI too.
    backgroundColor: "#000000",
  },
});
