/**
 * Voice chat artwork (web): the AP infinity with moving water, a heartbeat
 * line and light flowing through the ribbon, as in the AskPrana prototype.
 * Purely visual: it follows the call state given by the voice chat screen.
 */
import { createElement, useEffect } from "react";
import { Platform, View, type StyleProp, type ViewStyle } from "react-native";

export type PranaVoiceVisualState = "listening" | "speaking" | "thinking" | "muted" | "ready" | "error";

const STYLE_ID = "prana-voice-mark-css";

// Artwork from AskPrana_Prototype-3 / _Dark (base image: /voice-infinity.webp).
const INFINITY_SVG = `<svg class="pvm-svg am-logo" viewBox="0 190 1024 630" aria-hidden="true"><defs><clipPath id="am-water-clip"><path d="M136 452A128 128 0 0 1 392 452L390 497Q342 555 273 578A128 128 0 0 1 136 452Z"/></clipPath><clipPath id="am-pulse-clip"><circle cx="769" cy="453" r="130"/></clipPath><linearGradient id="am-water-fill" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#4adfc5"/><stop offset="1" stop-color="#1a9e91"/></linearGradient></defs><image class="am-base" href="/voice-infinity.webp" width="1024" height="1024"/><g clip-path="url(#am-water-clip)"><rect class="pvm-window" x="133" y="320" width="265" height="265"/><g class="am-water-rise"><path class="am-water-front" fill="url(#am-water-fill)" d="M-140 478Q-105 460-70 478T0 478T70 478T140 478T210 478T280 478T350 478T420 478T490 478T560 478V650H-140Z"/><path class="am-water-back" fill="#8be7d2" opacity=".5" d="M-140 463Q-105 447-70 463T0 463T70 463T140 463T210 463T280 463T350 463T420 463T490 463T560 463V650H-140Z"/><path class="am-water-ripple" fill="none" stroke="#dcfff2" stroke-opacity=".8" stroke-width="4" d="M-140 505Q-105 490-70 505T0 505T70 505T140 505T210 505T280 505T350 505T420 505T490 505T560 505M-140 540Q-105 525-70 540T0 540T70 540T140 540T210 540T280 540T350 540T420 540T490 540T560 540"/></g></g><g clip-path="url(#am-pulse-clip)"><circle class="pvm-window" cx="769" cy="453" r="130"/><g class="am-heart"><path class="am-pulse-base" pathLength="100" d="M625 463H655Q665 463 670 445L677 422L688 495L700 447L714 466H726L739 489L753 362L765 558L780 468L795 460L807 425L819 490L833 449L847 463H913"/><path class="am-pulse-running" pathLength="100" d="M625 463H655Q665 463 670 445L677 422L688 495L700 447L714 466H726L739 489L753 362L765 558L780 468L795 460L807 425L819 490L833 449L847 463H913"/></g></g><defs><mask id="sw-ribbon"><path d="M512 452C405 565 354 635 264 635C161 635 77 554 77 452S161 269 264 269C354 269 405 340 512 452S676 635 766 635C868 635 946 554 946 452S868 269 766 269C676 269 620 340 512 452" fill="none" stroke="white" stroke-width="72" stroke-linejoin="round"/></mask><filter id="sw-diffuse" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="22"></feGaussianBlur></filter></defs><g class="sw-body" mask="url(#sw-ribbon)"><g filter="url(#sw-diffuse)"><path class="sw-pressure sw-out" pathLength="100" d="M512 452C405 565 354 635 264 635C161 635 77 554 77 452S161 269 264 269C354 269 405 340 512 452S676 635 766 635C868 635 946 554 946 452S868 269 766 269C676 269 620 340 512 452"/><path class="sw-pressure sw-return" pathLength="100" d="M512 452C405 565 354 635 264 635C161 635 77 554 77 452S161 269 264 269C354 269 405 340 512 452S676 635 766 635C868 635 946 554 946 452S868 269 766 269C676 269 620 340 512 452"/><path class="sw-water-pressure" pathLength="100" d="M512 452C405 565 354 635 264 635C161 635 77 554 77 452S161 269 264 269C354 269 405 340 512 452S676 635 766 635C868 635 946 554 946 452S868 269 766 269C676 269 620 340 512 452"/></g></g></svg>`;

const CSS = `
.pvm{position:relative;width:100%;height:100%;display:flex;align-items:center;justify-content:center;isolation:isolate}
.pvm:before{content:'';position:absolute;inset:-16%;border-radius:50%;background:radial-gradient(ellipse,#b6dfd450,transparent 68%);opacity:.55;filter:blur(10px);animation:pvm-breathe 4s ease-in-out infinite}
.pvm-svg{position:relative;width:100%;height:100%;overflow:hidden;opacity:.86;mix-blend-mode:multiply}
.pvm-window{fill:var(--bg-f5f5df,#F5F5DF)}
.pvm .am-base{opacity:.76}
.pvm .am-water-front{animation:am-water-drift 2s linear infinite}
.pvm .am-water-back{animation:am-water-drift 3.4s linear infinite reverse}
.pvm .am-water-ripple{animation:am-water-drift 2.8s linear infinite reverse}
.pvm .am-water-rise{animation:am-tide 2.6s ease-in-out infinite alternate}
.pvm .am-heart{transform-origin:769px 453px;animation:am-heartbeat 1.5s ease-in-out infinite}
.pvm .am-pulse-base,.pvm .am-pulse-running{fill:none;stroke-linejoin:round;stroke-linecap:round;stroke-width:7}
.pvm .am-pulse-base{stroke:#4aaf9e;opacity:.23}
.pvm .am-pulse-running{stroke:#16b49c;stroke-dasharray:42 58;animation:am-pulse 2.2s linear infinite}
.pvm .sw-pressure,.pvm .sw-water-pressure{fill:none;stroke-linecap:round;stroke-linejoin:round;stroke-width:95}
.pvm .sw-out{stroke:#067f79;stroke-opacity:.47;stroke-dasharray:12 88;animation:sw-outward 4.8s ease-in-out infinite alternate}
.pvm .sw-return{stroke:#b3f6db;stroke-opacity:.88;stroke-dasharray:17 83;animation:sw-inward 4.8s ease-in-out infinite alternate}
.pvm .sw-water-pressure{stroke:#21c9af;stroke-opacity:.6;stroke-dasharray:9 91;animation:sw-water 4.8s ease-in-out infinite alternate}
.pvm .sw-body{opacity:.8}
.pvm-state-speaking .am-water-rise{animation-duration:1.6s}
.pvm-state-speaking .am-heart{animation-duration:1s}
.pvm-state-speaking .sw-body path{animation-duration:3.2s}
.pvm-state-muted .pvm-svg *,.pvm-state-ready .pvm-svg *,.pvm-state-error .pvm-svg *,.pvm-state-thinking .pvm-svg *{animation-play-state:paused!important}
.pvm-state-muted:before,.pvm-state-ready:before{animation:none}
.pvm-state-muted{opacity:.8}
.pvm-state-error{opacity:.6}
html[data-theme="dark"] .pvm:before{background:radial-gradient(ellipse,#55b88c18,transparent 68%)}
html[data-theme="dark"] .pvm-svg{mix-blend-mode:normal;opacity:.9}
html[data-theme="dark"] .pvm .am-base{opacity:.9}
html[data-theme="dark"] .pvm .am-pulse-base{stroke:#5dc8a5;opacity:.3}
html[data-theme="dark"] .pvm .am-pulse-running{stroke:#62dcba}
html[data-theme="dark"] .pvm .sw-out{stroke:#016a53;stroke-opacity:.6}
html[data-theme="dark"] .pvm .sw-return{stroke:#8cebd0;stroke-opacity:.8}
html[data-theme="dark"] .pvm .sw-water-pressure{stroke:#39d4a8}
.pvm-bars{display:flex;align-items:center;justify-content:center;gap:3px;height:26px;width:100%;overflow:hidden}
.pvm-bars i{flex:none;width:3px;height:4px;border-radius:4px;background:var(--fg-9bb4a3,#9BB4A3)}
.pvm-bars-listening i,.pvm-bars-speaking i{background:var(--fg-008081,#008081);animation:pvm-bars .8s ease-in-out infinite alternate;animation-delay:calc(var(--i)*-.17s)}
.pvm-bars-muted{opacity:.45}
@keyframes pvm-breathe{50%{transform:scale(1.2);opacity:.6}}
@keyframes pvm-bars{to{height:22px}}
@keyframes am-water-drift{to{transform:translateX(140px)}}
@keyframes am-tide{from{transform:translateY(-17px)}to{transform:translateY(18px)}}
@keyframes am-pulse{to{stroke-dashoffset:-100}}
@keyframes am-heartbeat{0%,100%{transform:scaleY(.85)}38%{transform:scaleY(1.08)}58%{transform:scaleY(.96)}}
@keyframes sw-outward{0%{stroke-dashoffset:6;stroke-width:65;opacity:.45}50%{stroke-width:115;opacity:.95}100%{stroke-dashoffset:-43;stroke-width:80;opacity:.6}}
@keyframes sw-inward{0%{stroke-dashoffset:-48;stroke-width:85;opacity:.65}50%{stroke-width:110;opacity:.95}100%{stroke-dashoffset:0;stroke-width:70;opacity:.5}}
@keyframes sw-water{0%{stroke-dashoffset:0;opacity:.4}50%{opacity:.8}100%{stroke-dashoffset:-50;opacity:.5}}
@media (prefers-reduced-motion: reduce){.pvm *,.pvm:before,.pvm-bars i{animation:none!important}}
`;

function useMarkStyles() {
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }, []);
}

/** The animated AP infinity. Sized by its container (aspect about 1.6 : 1). */
export function PranaVoiceMark({ state, style }: { state: PranaVoiceVisualState; style?: StyleProp<ViewStyle> }) {
  useMarkStyles();
  if (Platform.OS !== "web") return <View style={style} />;
  return (
    <View style={style} pointerEvents="none">
      {createElement("div", {
        className: `pvm pvm-state-${state}`,
        "aria-hidden": true,
        dangerouslySetInnerHTML: { __html: INFINITY_SVG },
      })}
    </View>
  );
}

const BAR_COUNT = 25;
const BARS_HTML = Array.from({ length: BAR_COUNT }, (_, i) => `<i style="--i:${i}"></i>`).join("");

/** Small voice waveform for the bottom bar; it moves while listening or speaking. */
export function PranaVoiceBars({ state, style }: { state: PranaVoiceVisualState; style?: StyleProp<ViewStyle> }) {
  useMarkStyles();
  if (Platform.OS !== "web") return <View style={style} />;
  return (
    <View style={style} pointerEvents="none">
      {createElement("div", {
        className: `pvm-bars pvm-bars-${state}`,
        "aria-hidden": true,
        dangerouslySetInnerHTML: { __html: BARS_HTML },
      })}
    </View>
  );
}
