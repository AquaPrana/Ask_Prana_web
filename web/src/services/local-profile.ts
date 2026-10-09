import AsyncStorage from "@react-native-async-storage/async-storage";

export type FarmerProfile = {
  name: string;
  state: string;
  district: string;
  language: string;
};

const PROFILE_KEY = "farmer_profile";

export const saveFarmerProfile = async (profile: FarmerProfile) => {
  await AsyncStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
};

export const clearFarmerProfile = async () => {
  await AsyncStorage.removeItem(PROFILE_KEY);
};

export const getFarmerProfile = async (): Promise<FarmerProfile | null> => {
  const raw = await AsyncStorage.getItem(PROFILE_KEY);

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as FarmerProfile;
  } catch {
    return null;
  }
};

export const getGreetingKey = () => {
  const hour = new Date().getHours();

  if (hour < 12) {
    return "greetings.morning";
  }

  if (hour < 17) {
    return "greetings.afternoon";
  }

  return "greetings.evening";
};
