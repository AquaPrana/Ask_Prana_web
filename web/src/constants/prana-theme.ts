import { Platform } from "react-native";

/**
 * AskPrana cream / teal look (mobile prototype + desktop design).
 * UI colours only — no behaviour lives here.
 */
export const prana = {
  cream: "#F5F5DF",
  page: "#EDF0E4",
  card: "#FFFDF0",
  ink: "#15393A",
  teal: "#008081",
  tealDeep: "#2E6859",
  tealText: "#2D8176",
  green: "#2E7767",
  muted: "#5C7570",
  mutedSoft: "#728B78",
  line: "#D9DDC6",
  lineSoft: "#E0E5D2",
  inputBorder: "#C1D0BC",
  placeholder: "#87968B",
  chip: "#F0F3E4",
  chipBorder: "#C6D6BF",
  chipText: "#397C6A",
  attachBg: "#EDF2E2",
  attachBorder: "#BFCFBA",
  error: "#AD3D31",
  // Header
  headerDark: "#0E3537",
  headerSubtitle: "#D2F3E8",
  // Desktop
  sidebar: "#EDEED9",
  sidebarBorder: "#D9DECA",
  desktopHeader: "#FAFBED",
  desktopHeaderBorder: "#E0E5D1",
  // Chat bubbles
  assistantBubble: "#EEEEDA",
  assistantText: "#286A61",
  userBubble: "#15393A",
} as const;

/** 118° teal gradient used for primary buttons, Send and the mobile chat header. */
export const PRANA_GRADIENT_CSS = "linear-gradient(118deg, #2E6859, #008081)";

/** Background-image style for web; solid teal fallback on native. */
export const pranaGradientStyle = (Platform.OS === "web"
  ? { backgroundImage: PRANA_GRADIENT_CSS }
  : { backgroundColor: prana.teal }) as object;

export const PRANA_FONT =
  Platform.OS === "web"
    ? 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    : undefined;

/** Removes the browser focus outline from text inputs (web only). */
export const noOutline = (Platform.OS === "web"
  ? { outlineStyle: "none", outlineWidth: 0 }
  : {}) as object;
