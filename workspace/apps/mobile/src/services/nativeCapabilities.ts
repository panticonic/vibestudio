import { Linking, Platform } from "react-native";
import Clipboard from "@react-native-clipboard/clipboard";
import { requireApprovedAppCapability } from "./appCapabilities";

export function copyToClipboard(value: string): void {
  requireApprovedAppCapability("clipboard", "clipboard write");
  Clipboard.setString(value);
}

export async function readClipboardText(): Promise<string> {
  requireApprovedAppCapability("clipboard", "clipboard read");
  return Clipboard.getString();
}

export async function readClipboardImageOrText(): Promise<string> {
  requireApprovedAppCapability("clipboard", "clipboard read");
  if (Platform.OS === "ios" && (await Clipboard.hasImage())) {
    return `data:image/jpeg;base64,${await Clipboard.getImageJPG()}`;
  }
  return (await Clipboard.getString()).trim();
}

export async function openExternalUrl(url: string): Promise<void> {
  requireApprovedAppCapability("open-external", "external URL open");
  await Linking.openURL(url);
}
