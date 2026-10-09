# Ask Prana — Website (Vite + React)

This is the website version of the Ask Prana app (originally an Expo React Native app). It is built with **Vite + React (React DOM)**.

The screens, components, contexts, services, i18n and locales in `src/` are **unchanged copies** of the Expo app's `src/`. The same layouts, styles, Feather icons, fonts and logic render in the browser through [`react-native-web`](https://necolas.github.io/react-native-web/), the same engine Expo used for its web build. The UI is pixel-identical: a screenshot diff against `expo export --platform web` showed 0 changed pixels on every screen at both mobile and desktop sizes.

## Run locally

Requires **Node.js 20.19+ or 22.12+** (https://nodejs.org).

- **Windows:** double-click `start-windows.bat`.
- **macOS/Linux:** run `./start.sh`.
- **Manual:**
  ```bash
  cd web
  npm install
  npm run dev        # opens http://localhost:8081
  ```

`.env` is included with the live `EXPO_PUBLIC_*` values. It must sit next to `package.json`, and you need to restart `npm run dev` after editing it.

The dev server uses port **8081**, the same port as `expo start --web`. That way the Google sign-in redirect (`http://localhost:8081/phone-login`) matches what is already registered.

Opening `index.html` directly (file://) will not work. Always run it through `npm run dev`, or through `npm run build` and then `npm run preview`.

## What replaced Expo

| Expo / native module | Website replacement (`src/web/shims`) |
| --- | --- |
| `expo-router` (file routes, Stack) | `expo-router.tsx`: History API stack that keeps earlier screens mounted, like Expo's web Stack; routes listed in `src/main.tsx` |
| `expo-image` | `expo-image.tsx`: clipped `<img>` with CSS `object-fit` |
| `@expo/vector-icons/Feather` | `feather.tsx`: same `Feather.ttf` + glyph map |
| `@expo-google-fonts/geist` + `useFonts` | `geist-fonts.ts`: same Geist TTFs via `FontFace` |
| `expo-audio` (voice notes / voice mode / TTS playback) | `expo-audio.ts`: port of expo-audio's web code (MediaRecorder + `<audio>`) |
| `expo-speech` | `expo-speech.ts`: Web Speech Synthesis |
| `expo-image-picker`, `expo-document-picker` | hidden `<input type="file">`, ported from Expo's web modules |
| `expo-image-manipulator` | canvas crop / resize / JPEG |
| `expo-clipboard` | `navigator.clipboard` |
| `expo-constants` | reads `EXPO_PUBLIC_*` env |
| `react-native-reanimated`, `react-native-gesture-handler` | small stubs; only the native image-zoom path used them, and the web path uses ScrollView zoom as before |

Environment variables keep their `EXPO_PUBLIC_*` names, and `process.env.EXPO_PUBLIC_*` is inlined by `vite.config.ts`, so no source file had to change. Supabase, MSG91 OTP, Google sign-in, email-code login and the Ask Prana edge functions are all called exactly as before.

`require("…png")` asset imports are rewritten at build time to `{ uri, width, height }`, which matches Metro.

## Deploy (Vercel)

Set the project root to `web/`, the build command to `npm run build` and the output to `dist`. Add the same `EXPO_PUBLIC_*` env vars. `vercel.json` rewrites every path to `index.html`.
