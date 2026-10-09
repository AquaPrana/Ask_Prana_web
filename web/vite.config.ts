import { readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const root = __dirname;
const shim = (file: string) => path.resolve(root, "src/web/shims", file);

// Web-first resolution, same order Expo/Metro uses for the web platform.
const extensions = [
  ".web.tsx",
  ".web.ts",
  ".web.jsx",
  ".web.js",
  ".tsx",
  ".ts",
  ".jsx",
  ".js",
  ".mjs",
  ".json",
];

/**
 * Metro lets screens do `require("../../assets/images/x.png")` and hands back an
 * asset with its intrinsic size. Vite is ESM-only, so rewrite those calls to
 * `import` + `{ uri, width, height }` (react-native-web uses width/height as the
 * default image size, exactly like the Expo web build).
 */
function requireAssets(): Plugin {
  const pattern = /require\(\s*["']([^"']+\.(?:png|jpe?g|gif|webp|ttf|otf|mp4))["']\s*\)/g;
  const pngSize = (file: string) => {
    try {
      const buf = readFileSync(file);
      if (buf.toString("ascii", 1, 4) === "PNG") {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      }
    } catch {
      // ignore
    }
    return null;
  };
  return {
    name: "ask-prana-require-assets",
    enforce: "pre",
    transform(code, id) {
      if (!/\/src\/.*\.[jt]sx?$/.test(id) || !code.includes("require(")) return null;
      const imports: string[] = [];
      let index = 0;
      const out = code.replace(pattern, (_m, rel: string) => {
        const name = `__asset${index++}`;
        imports.push(`import ${name} from ${JSON.stringify(rel)};`);
        const size = pngSize(path.resolve(path.dirname(id), rel));
        return size
          ? `({ uri: ${name}, width: ${size.width}, height: ${size.height} })`
          : `({ uri: ${name} })`;
      });
      if (!imports.length) return null;
      return { code: `${imports.join("\n")}\n${out}`, map: null };
    },
  };
}

/** Swap react-native-web's BackHandler (logs console.error on web) for a silent no-op. */
function silentBackHandler(): Plugin {
  return {
    name: "ask-prana-silent-back-handler",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer?.includes("react-native-web") && /\/exports\/BackHandler(\/index(\.js)?)?$/.test(source)) {
        return shim("back-handler.ts");
      }
      return null;
    },
  };
}

export default defineConfig(({ mode }) => {
  // Keep the existing EXPO_PUBLIC_* names so the same .env / Vercel env vars work.
  const env = loadEnv(mode, root, ["EXPO_PUBLIC_", "VITE_"]);
  const processEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("EXPO_PUBLIC_")) {
      processEnv[`process.env.${key}`] = JSON.stringify(value);
    }
  }

  if (!env.EXPO_PUBLIC_SUPABASE_URL || !env.EXPO_PUBLIC_SUPABASE_ANON_KEY) {
    console.warn(
      "\n[ask-prana] EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY are missing.\n" +
        "  Create web/.env (copy web/.env.example or frontend/.env) or login, OTP and chat will not work.\n",
    );
  }

  return {
    // Same port as `expo start --web`, so Google sign-in redirect URIs
    // (http://localhost:8081/phone-login) already registered for the app keep working.
    server: { port: 8081, strictPort: true, open: true },
    preview: { port: 8081, strictPort: true, open: true },
    plugins: [silentBackHandler(), requireAssets(), react()],
    envPrefix: ["EXPO_PUBLIC_", "VITE_"],
    define: {
      ...processEnv,
      "process.env.NODE_ENV": JSON.stringify(mode === "production" ? "production" : "development"),
      __DEV__: JSON.stringify(mode !== "production"),
      global: "globalThis",
    },
    resolve: {
      extensions,
      alias: [
        { find: /^react-native$/, replacement: "react-native-web" },
        { find: /^expo-router$/, replacement: shim("expo-router.tsx") },
        { find: /^expo-image$/, replacement: shim("expo-image.tsx") },
        { find: /^expo-audio$/, replacement: shim("expo-audio.ts") },
        { find: /^expo-speech$/, replacement: shim("expo-speech.ts") },
        { find: /^expo-clipboard$/, replacement: shim("expo-clipboard.ts") },
        { find: /^expo-constants$/, replacement: shim("expo-constants.ts") },
        { find: /^expo-image-picker$/, replacement: shim("expo-image-picker.ts") },
        { find: /^expo-image-manipulator$/, replacement: shim("expo-image-manipulator.ts") },
        { find: /^expo-document-picker$/, replacement: shim("expo-document-picker.ts") },
        { find: /^@expo-google-fonts\/geist$/, replacement: shim("geist-fonts.ts") },
        { find: /^@expo\/vector-icons\/Feather$/, replacement: shim("feather.tsx") },
        { find: /^react-native-reanimated$/, replacement: shim("reanimated.tsx") },
        { find: /^@react-native\/assets-registry\/registry$/, replacement: shim("assets-registry.ts") },
        { find: /^react-native-gesture-handler$/, replacement: shim("gesture-handler.tsx") },
        { find: /^@\/assets\/(.*)$/, replacement: path.resolve(root, "assets/$1") },
        { find: /^@\/(.*)$/, replacement: path.resolve(root, "src/$1") },
      ],
    },
    optimizeDeps: {
      esbuildOptions: {
        resolveExtensions: extensions,
        loader: { ".js": "jsx" },
        define: { global: "globalThis", __DEV__: JSON.stringify(mode !== "production") },
      },
    },
    build: {
      outDir: "dist",
      chunkSizeWarningLimit: 2000,
    },
  };
});
