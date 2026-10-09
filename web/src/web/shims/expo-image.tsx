/**
 * Web replacement for `expo-image`'s <Image>. Like expo-image's own web build it
 * renders a clipped container sized by `style` with a native <img> inside that
 * uses CSS object-fit for `contentFit`.
 */
import { createElement, useState } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

type ImageSource = string | number | { uri?: string | null; width?: number; height?: number } | null | undefined;

export type ImageContentFit = "cover" | "contain" | "fill" | "none" | "scale-down";

export type ImageProps = {
  source?: ImageSource | ImageSource[];
  style?: StyleProp<ViewStyle>;
  contentFit?: ImageContentFit;
  contentPosition?: string;
  accessibilityLabel?: string;
  alt?: string;
  onError?: (event: { error: string }) => void;
  onLoad?: (event: { source: { url: string; width: number; height: number } }) => void;
  testID?: string;
  [key: string]: unknown;
};

function resolveSource(source: ImageProps["source"]): { uri: string | null; width?: number; height?: number } {
  const first = Array.isArray(source) ? source[0] : source;
  if (!first) return { uri: null };
  if (typeof first === "string") return { uri: first };
  if (typeof first === "number") return { uri: null };
  return { uri: first.uri ?? null, width: first.width, height: first.height };
}

export function Image({
  source,
  style,
  contentFit = "cover",
  contentPosition = "center",
  accessibilityLabel,
  alt,
  onError,
  onLoad,
  testID,
}: ImageProps) {
  const resolved = resolveSource(source);
  const [failed, setFailed] = useState(false);
  const flat = (StyleSheet.flatten(style) ?? {}) as ViewStyle;
  const sizeFallback =
    flat.width == null && flat.height == null && !flat.flex && resolved.width && resolved.height
      ? { width: resolved.width, height: resolved.height }
      : null;

  return (
    <View
      style={[styles.container, sizeFallback, style]}
      testID={testID}
      accessibilityRole={accessibilityLabel ? "image" : undefined}
      accessibilityLabel={accessibilityLabel}
    >
      {resolved.uri && !failed
        ? createElement("img", {
            src: resolved.uri,
            alt: alt ?? accessibilityLabel ?? "",
            draggable: false,
            style: {
              width: "100%",
              height: "100%",
              objectFit: contentFit,
              objectPosition: contentPosition,
              display: "block",
            },
            onError: () => {
              setFailed(true);
              onError?.({ error: `Failed to load image ${resolved.uri}` });
            },
            onLoad: (event: { currentTarget: HTMLImageElement }) =>
              onLoad?.({
                source: {
                  url: resolved.uri as string,
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                },
              }),
          })
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { overflow: "hidden" },
});

export default Image;
