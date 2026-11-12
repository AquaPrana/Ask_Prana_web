/**
 * Light / dark theme for the AskPrana web app (UI only).
 *
 * Every themed colour in the screens is written as `pc.bg("#FFFDF0")`,
 * `pc.fg(...)` or `pc.bd(...)`. Each returns a CSS variable whose fallback is
 * that same light colour, so light mode is exactly the original design. In dark
 * mode `<html data-theme="dark">` switches the variables to the dark colours
 * below (from AskPrana_Prototype_Dark, derived for the rest).
 *
 * The choice is saved in localStorage; index.html applies it before the app
 * loads so the page never flashes the other theme.
 */
import { Platform } from "react-native";
import { useEffect, useState } from "react";

export type PranaThemeMode = "light" | "dark";
type Role = "bg" | "fg" | "bd";

export const PRANA_THEME_STORAGE_KEY = "askprana-theme";
const STYLE_ELEMENT_ID = "prana-theme-vars";
const isWeb = Platform.OS === "web" && typeof document !== "undefined";

// ---- Dark colours ----------------------------------------------------------

/** Exact dark values for the main colours (from the dark prototype). */
const DARK_OVERRIDES: Record<Role, Record<string, string>> = {
  bg: {
    "#F5F5DF": "#101010", // page
    "#FFFDF0": "#1C211F", // cards, inputs, composer
    "#FFFFFF": "#1C211F",
    "#FAFBED": "#141917", // desktop header
    "#EDEED9": "#141A17", // desktop sidebar
    "#EEEEDA": "#202B23", // Ask Prana answer bubble
    "#15393A": "#285E4B", // farmer bubble, dark pills
    "#F0F3E4": "#152B20", // chips
    "#EDF2E2": "#203A2B", // attach tile
    "#E6EBD8": "#223E30", // close buttons
    "#DCE9D6": "#1D3A2C", // new chat
    "#E0E8D3": "#264A36", // active conversation
    "#E1E8D5": "#22402F", // hover
    "#DCEFE2": "#2B5941", // selected option
    "#DCEEE1": "#244731",
    "#E8EDDA": "#1E2B24", // table header
    "#F2F4E6": "#18221D",
    "#F5F6E7": "#1C211F", // desktop compose box
    "#F8F8E9": "#18201C", // sidebar search
    "#F8F9ED": "#152B20", // desktop voice tile
    "#F2F2DE": "#171C1A", // disabled input
    "#EEF4E7": "#1A2E24", // pending file
    // Brand colours stay the same.
    "#008081": "#008081",
    "#2E6859": "#2E6859",
    "#0F766E": "#0F766E",
    "#0E3537": "#0E3537",
    "#9E4B3D": "#9E4B3D",
    "#B45309": "#B45309",
    "#000000": "#000000",
    "#0B0F15": "#0B0F15",
  },
  fg: {
    "#15393A": "#E8F2ED", // main text
    "#5C7570": "#AFBBB4", // muted text
    "#008081": "#6DD4BD", // teal accents
    "#217C73": "#9BD8B9", // links
    "#2D8176": "#8CC5A5", // kickers
    "#286A61": "#C8E2CF",
    "#AD3D31": "#F6A696", // errors
    "#9E4B3D": "#EDA28E",
    "#A06A1B": "#E8C27A",
    "#FFFFFF": "#FFFFFF",
    "#111111": "#111111",
  },
  bd: {
    "#D9DDC6": "#3B4941", // hairlines
    "#C1D0BC": "#3D5B4C", // input borders
    "#008081": "#2FA58A",
    "#9E4B3D": "#C9786A",
    "#AD3D31": "#E08A7B",
  },
};

function hexToRgb(hex: string) {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value.slice(0, 6);
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255);
}

function rgbToHsl([r, g, b]: number[]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hsl(h: number, s: number, l: number) {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return `hsl(${Math.round(h)}, ${Math.round(clamp(s) * 100)}%, ${Math.round(clamp(l) * 100)}%)`;
}

/** Dark-theme colour for a light colour used as background, text or border. */
export function darkColorFor(role: Role, lightHex: string): string {
  const hex = lightHex.toUpperCase();
  const exact = DARK_OVERRIDES[role][hex.slice(0, 7)];
  if (exact) return exact;
  const [h, s, l] = rgbToHsl(hexToRgb(hex));
  if (role === "bg") {
    // Light tints become dark green surfaces; slightly darker tints (selected,
    // hover) become slightly lighter surfaces so states stay visible.
    if (l > 0.6) return hsl(h, Math.min(s, 0.32), 0.1 + (0.97 - l) * 0.9);
    return hex;
  }
  if (role === "fg") {
    // Dark text becomes light text; muted text stays muted.
    if (l < 0.62) return hsl(h, Math.min(s, 0.45), Math.max(0.72, 1 - l * 0.55));
    return hex;
  }
  // Borders: light hairlines become dark green hairlines.
  if (l > 0.55) return hsl(h, Math.min(s, 0.25), 0.2 + (0.92 - l) * 0.6);
  return hsl(h, Math.min(s, 0.4), Math.max(0.45, 1 - l));
}

// ---- CSS variables -----------------------------------------------------------

const registered = new Map<string, string>();
let styleElement: HTMLStyleElement | null = null;
let flushQueued = false;

function flushStyle() {
  flushQueued = false;
  if (!isWeb) return;
  if (!styleElement) {
    styleElement = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
    if (!styleElement) {
      styleElement = document.createElement("style");
      styleElement.id = STYLE_ELEMENT_ID;
      document.head.appendChild(styleElement);
    }
  }
  const rules = Array.from(registered.entries()).map(([name, value]) => `${name}:${value}`).join(";");
  styleElement.textContent = `html[data-theme="dark"]{color-scheme:dark;${rules}}`;
}

function themed(role: Role, color: string): string {
  if (typeof color !== "string" || !/^#[0-9a-f]{3,8}$/i.test(color)) return color;
  const name = `--${role}-${color.slice(1).toLowerCase()}`;
  if (!registered.has(name)) {
    registered.set(name, darkColorFor(role, color));
    if (isWeb && !flushQueued) {
      flushQueued = true;
      queueMicrotask(flushStyle);
    }
  }
  return isWeb ? `var(${name}, ${color})` : color;
}

/** Themed colours: background, text/icon, border. Light = the colour given. */
export const pc = {
  bg: (color: string) => themed("bg", color),
  fg: (color: string) => themed("fg", color),
  bd: (color: string) => themed("bd", color),
};

// ---- Switching ---------------------------------------------------------------

const listeners = new Set<(mode: PranaThemeMode) => void>();

export function getPranaThemeMode(): PranaThemeMode {
  if (!isWeb) return "light";
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function setPranaThemeMode(mode: PranaThemeMode) {
  if (!isWeb) return;
  document.documentElement.dataset.theme = mode;
  try {
    localStorage.setItem(PRANA_THEME_STORAGE_KEY, mode);
  } catch {
    // Private mode etc.: the theme still applies for this visit.
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute("content", mode === "dark" ? "#0E3537" : "#2E6859");
  listeners.forEach((listener) => listener(mode));
}

/** Current theme, re-rendering when it changes. */
export function usePranaThemeMode(): [PranaThemeMode, (mode: PranaThemeMode) => void] {
  const [mode, setMode] = useState<PranaThemeMode>(getPranaThemeMode);
  useEffect(() => {
    listeners.add(setMode);
    return () => {
      listeners.delete(setMode);
    };
  }, []);
  return [mode, setPranaThemeMode];
}
