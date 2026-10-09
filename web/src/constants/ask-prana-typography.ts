import { Platform } from "react-native";

export const ASK_PRANA_FONT_FAMILY =
  Platform.OS === "web"
    ? 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
    : undefined;
