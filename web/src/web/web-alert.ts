/**
 * react-native-web ships `Alert.alert` as an empty function, so every error
 * and confirmation in the app ("Could not hear that clearly", "Select a pond",
 * "Delete conversation?") silently did nothing in the browser.
 *
 * This installs a web implementation once at start-up:
 * - A message with no buttons, or one plain button, shows a toast at the top
 *   of the screen that fades out on its own (it never blocks Voice Chat).
 * - A message with choices, or a single button with an action, shows a
 *   dialog; each button runs its own onPress, exactly like on the phone app.
 */
import { Alert } from "react-native";
import { pc } from "../constants/prana-theme-mode";

type AlertButton = {
  text?: string;
  onPress?: (value?: string) => void;
  style?: "default" | "cancel" | "destructive";
};
type AlertOptions = { cancelable?: boolean; onDismiss?: () => void };

const TOAST_MS = 4500;
const Z_INDEX = "10000";
const activeToasts = new Map<string, HTMLElement>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css: Partial<CSSStyleDeclaration>, text?: string) {
  const node = document.createElement(tag);
  Object.assign(node.style, css);
  if (text) node.textContent = text;
  return node;
}

function toastHost() {
  let host = document.getElementById("ask-prana-toasts");
  if (!host) {
    host = el("div", {
      position: "fixed",
      top: "16px",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: Z_INDEX,
      display: "flex",
      flexDirection: "column",
      gap: "8px",
      width: "min(92vw, 420px)",
      pointerEvents: "none",
    });
    host.id = "ask-prana-toasts";
    host.setAttribute("aria-live", "assertive");
    document.body.appendChild(host);
  }
  return host;
}

function showToast(title: string, message?: string) {
  const key = `${title}\n${message ?? ""}`;
  // The same message repeated quickly (e.g. while listening) shows once.
  if (activeToasts.has(key)) return;
  const toast = el("div", {
    // Cream / teal theme (light) or dark green (dark), via the theme variables.
    background: pc.bg("#FFFDF0"),
    color: pc.fg("#15393A"),
    border: `1px solid ${pc.bd("#D9DDC6")}`,
    borderLeft: `4px solid ${pc.fg("#AD3D31")}`,
    borderRadius: "12px",
    padding: "12px 14px",
    boxShadow: "0 8px 24px rgba(21,57,58,.18)",
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize: "14px",
    lineHeight: "20px",
    pointerEvents: "auto",
    cursor: "pointer",
    opacity: "0",
    transition: "opacity .2s ease",
  });
  toast.setAttribute("role", "alert");
  if (title) toast.appendChild(el("div", { fontWeight: "600", marginBottom: message ? "2px" : "0" }, title));
  if (message) toast.appendChild(el("div", { color: pc.fg("#5C7570") }, message));
  const remove = () => {
    if (!activeToasts.has(key)) return;
    activeToasts.delete(key);
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 200);
  };
  toast.addEventListener("click", remove);
  toastHost().appendChild(toast);
  activeToasts.set(key, toast);
  requestAnimationFrame(() => { toast.style.opacity = "1"; });
  setTimeout(remove, TOAST_MS);
}

function showDialog(title: string, message: string | undefined, buttons: AlertButton[], options?: AlertOptions) {
  const overlay = el("div", {
    position: "fixed",
    inset: "0",
    zIndex: Z_INDEX,
    background: "rgba(21,57,58,.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "16px",
  });
  const card = el("div", {
    background: pc.bg("#F5F5DF"),
    color: pc.fg("#15393A"),
    border: `1px solid ${pc.bd("#D9DDC6")}`,
    borderRadius: "16px",
    padding: "20px",
    width: "min(100%, 380px)",
    boxShadow: "0 16px 40px rgba(21,57,58,.22)",
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  });
  card.setAttribute("role", "alertdialog");
  card.setAttribute("aria-modal", "true");
  if (title) card.appendChild(el("div", { fontSize: "17px", fontWeight: "600", marginBottom: "8px" }, title));
  if (message) card.appendChild(el("div", { fontSize: "14px", lineHeight: "20px", color: pc.fg("#5C7570"), whiteSpace: "pre-line" }, message));
  const row = el("div", { display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: "8px", marginTop: "18px" });

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey);
    overlay.remove();
  };
  const cancelButton = buttons.find((button) => button.style === "cancel");
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    close();
    cancelButton?.onPress?.();
    options?.onDismiss?.();
  };

  buttons.forEach((button, index) => {
    const primary = index === buttons.length - 1 && button.style !== "cancel";
    const color = button.style === "destructive" ? pc.fg("#9E4B3D") : primary ? "#FFFFFF" : pc.fg("#286C62");
    const node = el("button", {
      background: primary && button.style !== "destructive" ? "#008081" : "transparent",
      color,
      border: button.style === "destructive" ? `1px solid ${pc.bd("#9E4B3D")}` : `1px solid ${pc.bd("#B9CEBC")}`,
      borderRadius: "10px",
      padding: "9px 16px",
      fontSize: "14px",
      fontWeight: "600",
      cursor: "pointer",
      fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }, button.text || "OK");
    node.type = "button";
    node.addEventListener("click", () => {
      close();
      button.onPress?.();
    });
    row.appendChild(node);
  });
  card.appendChild(row);
  overlay.appendChild(card);
  overlay.addEventListener("click", (event) => {
    if (event.target !== overlay || options?.cancelable === false) return;
    close();
    cancelButton?.onPress?.();
    options?.onDismiss?.();
  });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
  (row.lastElementChild as HTMLButtonElement | null)?.focus();
}

export function installWebAlert() {
  if (typeof document === "undefined") return;
  const webAlert = (
    title: string,
    message?: string,
    buttons?: AlertButton[],
    options?: AlertOptions,
  ) => {
    const list = (buttons ?? []).filter(Boolean);
    const needsChoice = list.length > 1 || list.some((button) => typeof button.onPress === "function");
    if (!needsChoice) {
      showToast(String(title ?? ""), message ? String(message) : undefined);
      return;
    }
    showDialog(String(title ?? ""), message ? String(message) : undefined, list, options);
  };
  (Alert as unknown as { alert: typeof webAlert }).alert = webAlert;
}
