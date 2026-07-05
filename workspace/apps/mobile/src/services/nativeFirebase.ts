import { NativeModules } from "react-native";

interface VibestudioMobileHostConstants {
  firebaseConfigured?: boolean;
  getConstants?: () => { firebaseConfigured?: boolean };
}

export function isNativeFirebaseConfigured(): boolean {
  const host = NativeModules["VibestudioMobileHost"] as VibestudioMobileHostConstants | undefined;
  const configured = host?.firebaseConfigured ?? host?.getConstants?.()?.firebaseConfigured;
  return configured !== false;
}
