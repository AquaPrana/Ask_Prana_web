/**
 * Minimal web replacement for the react-native-gesture-handler APIs the app
 * imports (native-only pinch/pan image viewer; web uses ScrollView zoom).
 */
import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (...args: any[]) => void;

class GestureBuilder {
  handlers: Record<string, Handler> = {};
  constructor(public children: GestureBuilder[] = []) {}
  onBegin(fn: Handler) {
    this.handlers.onBegin = fn;
    return this;
  }
  onStart(fn: Handler) {
    this.handlers.onStart = fn;
    return this;
  }
  onUpdate(fn: Handler) {
    this.handlers.onUpdate = fn;
    return this;
  }
  onEnd(fn: Handler) {
    this.handlers.onEnd = fn;
    return this;
  }
  onFinalize(fn: Handler) {
    this.handlers.onFinalize = fn;
    return this;
  }
  enabled(_value: boolean) {
    return this;
  }
}

export const Gesture = {
  Pinch: () => new GestureBuilder(),
  Pan: () => new GestureBuilder(),
  Tap: () => new GestureBuilder(),
  Simultaneous: (...gestures: GestureBuilder[]) => new GestureBuilder(gestures),
  Race: (...gestures: GestureBuilder[]) => new GestureBuilder(gestures),
  Exclusive: (...gestures: GestureBuilder[]) => new GestureBuilder(gestures),
};

export function GestureDetector({ children }: { gesture: unknown; children: ReactNode }) {
  return <>{children}</>;
}

export function GestureHandlerRootView({
  style,
  children,
}: {
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  return <View style={style}>{children}</View>;
}
