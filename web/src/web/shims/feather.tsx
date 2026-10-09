/**
 * Web replacement for `@expo/vector-icons/Feather`. Uses the exact same
 * Feather.ttf + glyph map shipped with @expo/vector-icons, rendered the same
 * way (a <Text> glyph), so icons look identical.
 */
import { PureComponent } from "react";
import { Text, type TextProps, type TextStyle, type StyleProp } from "react-native";
import glyphMap from "../fonts/Feather.json";
import featherFont from "../fonts/Feather.ttf";

const FONT_FAMILY = "feather";

if (typeof document !== "undefined" && !document.getElementById("ask-prana-feather-font")) {
  const style = document.createElement("style");
  style.id = "ask-prana-feather-font";
  style.textContent = `@font-face{font-family:"${FONT_FAMILY}";src:url("${featherFont}") format("truetype");font-display:block;}`;
  document.head.appendChild(style);
}

export type FeatherGlyphs = keyof typeof glyphMap;

type Props = TextProps & {
  name: FeatherGlyphs | (string & {});
  size?: number;
  color?: string;
  style?: StyleProp<TextStyle>;
};

export default class Feather extends PureComponent<Props> {
  static glyphMap = glyphMap;
  static getRawGlyphMap = () => glyphMap;
  static getFontFamily = () => FONT_FAMILY;
  static defaultProps = { size: 12, allowFontScaling: false };

  render() {
    const { name, size, color, style, children, ...props } = this.props;
    const code = name ? (glyphMap as Record<string, number>)[name] : undefined;
    const glyph = name ? (code != null ? String.fromCodePoint(code) : "?") : "";
    return (
      <Text
        selectable={false}
        {...props}
        style={[{ fontSize: size, color }, style, { fontFamily: FONT_FAMILY, fontWeight: "normal", fontStyle: "normal" }]}
      >
        {glyph}
        {children}
      </Text>
    );
  }
}
