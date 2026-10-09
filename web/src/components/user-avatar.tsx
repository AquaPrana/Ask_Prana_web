import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { avatarDisplayUrl } from "../lib/profile-photo";

type UserAvatarProps = {
  name?: string | null;
  avatarUrl?: string | null;
  avatarUpdatedAt?: string | null;
  size?: number;
  /** Dark teal circle (edit-profile) vs soft teal (profile overview). */
  variant?: "solid" | "soft";
  showEditBadge?: boolean;
  loading?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
};

const COLORS = {
  teal: "#0F766E",
  white: "#FFFFFF",
  softBg: "#E8F4F8",
  softText: "#0F766E",
  badge: "#0D9488",
  badgeBorder: "#FFFFFF",
};

export function UserAvatar({
  name,
  avatarUrl,
  avatarUpdatedAt,
  size = 72,
  variant = "solid",
  showEditBadge = false,
  loading = false,
  onPress,
  accessibilityLabel = "Change profile photo",
  style,
}: UserAvatarProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const displayUrl = useMemo(
    () => avatarDisplayUrl(avatarUrl, avatarUpdatedAt),
    [avatarUrl, avatarUpdatedAt],
  );

  useEffect(() => {
    setImageFailed(false);
  }, [displayUrl]);

  const showImage = Boolean(displayUrl) && !imageFailed;
  const initial = (name?.trim().charAt(0) || "G").toUpperCase();
  const radius = size / 2;
  const fontSize = Math.round(size * 0.39);
  const badgeSize = Math.max(28, Math.round(size * 0.34));
  // Badge hangs outside the circle; pad the hit box so taps register.
  const badgePad = showEditBadge ? Math.ceil(badgeSize * 0.45) : 0;

  const handlePress = () => {
    if (loading || !onPress) {
      return;
    }
    onPress();
  };

  return (
    <View
      style={[
        styles.outer,
        {
          width: size + badgePad,
          height: size + badgePad,
          paddingRight: badgePad,
          paddingBottom: badgePad,
        },
        style,
      ]}
    >
      <Pressable
        onPress={handlePress}
        disabled={loading || !onPress}
        accessibilityRole={onPress ? "button" : undefined}
        accessibilityLabel={onPress ? accessibilityLabel : undefined}
        hitSlop={8}
        style={({ pressed }) => [
          styles.circle,
          {
            width: size,
            height: size,
            borderRadius: radius,
            backgroundColor: variant === "solid" ? COLORS.teal : COLORS.softBg,
          },
          pressed && onPress ? styles.pressed : null,
        ]}
      >
        {showImage ? (
          <Image
            key={displayUrl ?? undefined}
            source={{ uri: displayUrl! }}
            style={{ width: size, height: size, borderRadius: radius }}
            resizeMode="cover"
            onError={() => setImageFailed(true)}
            accessibilityIgnoresInvertColors
          />
        ) : (
          <Text
            style={{
              color: variant === "solid" ? COLORS.white : COLORS.softText,
              fontSize,
              lineHeight: fontSize + 4,
              fontWeight: "800",
            }}
          >
            {initial}
          </Text>
        )}

        {loading ? (
          <View style={[styles.loadingOverlay, { borderRadius: radius }]}>
            <ActivityIndicator color={COLORS.white} />
          </View>
        ) : null}
      </Pressable>

      {showEditBadge && onPress ? (
        <Pressable
          onPress={handlePress}
          disabled={loading}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          style={({ pressed }) => [
            styles.editBadge,
            {
              width: badgeSize,
              height: badgeSize,
              borderRadius: badgeSize / 2,
            },
            pressed ? styles.pressed : null,
            loading ? styles.badgeDisabled : null,
          ]}
        >
          <Feather
            name="camera"
            size={Math.round(badgeSize * 0.45)}
            color={COLORS.white}
          />
        </Pressable>
      ) : showEditBadge ? (
        <View
          style={[
            styles.editBadge,
            {
              width: badgeSize,
              height: badgeSize,
              borderRadius: badgeSize / 2,
            },
          ]}
          pointerEvents="none"
        >
          <Feather
            name="camera"
            size={Math.round(badgeSize * 0.45)}
            color={COLORS.white}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    position: "relative",
  },
  circle: {
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  pressed: {
    opacity: 0.88,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(6, 95, 91, 0.55)",
    alignItems: "center",
    justifyContent: "center",
  },
  editBadge: {
    position: "absolute",
    right: 0,
    bottom: 0,
    backgroundColor: COLORS.badge,
    borderWidth: 2,
    borderColor: COLORS.badgeBorder,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
    elevation: 4,
  },
  badgeDisabled: {
    opacity: 0.55,
  },
});
