/**
 * Website entry point (replaces Expo Router's `expo-router/entry`).
 * Screens and the root layout are the original files from src/app — only the
 * file-based routing is replaced by this explicit route table.
 */
import { AppRegistry, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { RouterRoot } from "expo-router";
import RootLayout from "./app/_layout";
import StartupScreen from "./app/index";
import PhoneLoginScreen from "./app/phone-login";
import VerifyOtpScreen from "./app/verify-otp";
import VerifyEmailScreen from "./app/verify-email";
import EditProfileScreen from "./app/edit-profile";
import AskPranaScreen from "./app/ask-prana";

const routes = {
  "/": StartupScreen,
  "/phone-login": PhoneLoginScreen,
  "/verify-otp": VerifyOtpScreen,
  "/verify-email": VerifyEmailScreen,
  "/edit-profile": EditProfileScreen,
  "/ask-prana": AskPranaScreen,
};

function App() {
  return (
    <View style={{ flex: 1 }}>
      <SafeAreaProvider>
        <RouterRoot routes={routes} layout={RootLayout} />
      </SafeAreaProvider>
    </View>
  );
}

AppRegistry.registerComponent("main", () => App);
AppRegistry.runApplication("main", { rootTag: document.getElementById("root") });
