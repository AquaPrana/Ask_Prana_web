/** Web replacement for expo-constants: exposes the same `expoConfig.extra` the app reads. */
const supabaseUrl = (process.env.EXPO_PUBLIC_SUPABASE_URL ?? "").trim() || null;

const Constants = {
  expoConfig: {
    name: "AquaPrana",
    slug: "srihitha",
    version: "1.0.1",
    extra: {
      supabaseUrl,
      hasSupabaseAnonKey: Boolean(process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY),
    },
  },
  platform: { web: {} },
};

export default Constants;
