/**
 * Minimal web replacement for the react-native-reanimated APIs the app imports.
 * They are only used by the native pinch-zoom image viewer; on web the app
 * uses the ScrollView zoom branch, exactly like the Expo web build.
 */
import { useRef } from "react";
import { View } from "react-native";

export type SharedValue<T> = { value: T };

export function useSharedValue<T>(initial: T): SharedValue<T> {
  const ref = useRef<SharedValue<T> | null>(null);
  if (!ref.current) ref.current = { value: initial };
  return ref.current;
}

export function withTiming<T>(toValue: T, _config?: unknown): T {
  return toValue;
}

export function withSpring<T>(toValue: T, _config?: unknown): T {
  return toValue;
}

export function useAnimatedStyle<T>(updater: () => T, _deps?: unknown[]): T {
  return updater();
}

export function runOnJS<A extends unknown[], R>(fn: (...args: A) => R) {
  return fn;
}

const Animated = { View };
export default Animated;
