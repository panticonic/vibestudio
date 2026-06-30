import { NativeModules } from "react-native";

interface Vibez1MobileHostConstants {
  firebaseConfigured?: boolean;
  getConstants?: () => { firebaseConfigured?: boolean };
}

export function isNativeFirebaseConfigured(): boolean {
  const host = NativeModules["Vibez1MobileHost"] as Vibez1MobileHostConstants | undefined;
  const configured = host?.firebaseConfigured ?? host?.getConstants?.()?.firebaseConfigured;
  return configured !== false;
}
