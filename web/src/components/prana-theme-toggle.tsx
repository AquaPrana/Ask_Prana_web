import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { PRANA_FONT } from "../constants/prana-theme";
import { pc, usePranaThemeMode } from "../constants/prana-theme-mode";

type Props = {
  label?: string;
  style?: StyleProp<ViewStyle>;
};

/** "Dark theme" row with an on/off switch. Changes only colours. */
export function PranaThemeToggle({ label = "Dark theme", style }: Props) {
  const [mode, setMode] = usePranaThemeMode();
  const dark = mode === "dark";
  return (
    <Pressable
      onPress={() => setMode(dark ? "light" : "dark")}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.85 }, style]}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: dark }}
    >
      <Feather name={dark ? "moon" : "sun"} size={17} color={pc.fg("#607C67")} />
      <Text style={styles.label} numberOfLines={1}>{label}</Text>
      <View style={[styles.track, dark && styles.trackOn]}>
        <View style={[styles.thumb, dark && styles.thumbOn]} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    paddingHorizontal: 9,
    borderRadius: 8,
  },
  label: {
    flex: 1,
    minWidth: 0,
    color: pc.fg("#607C67"),
    fontFamily: PRANA_FONT,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "600",
  },
  track: {
    width: 40,
    height: 23,
    borderRadius: 12,
    padding: 3,
    backgroundColor: pc.bg("#D6DEC9"),
    justifyContent: "center",
  },
  trackOn: { backgroundColor: "#008081" },
  thumb: {
    width: 17,
    height: 17,
    borderRadius: 9,
    backgroundColor: "#FFFFFF",
    shadowColor: "#15393A",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
  },
  thumbOn: { transform: [{ translateX: 17 }] },
});
