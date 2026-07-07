import { NativeModules } from "react-native";
import {
  activateApprovedWorkspaceApp,
  type BundleDeliveryTransport,
} from "@vibestudio/mobile-webrtc";
import {
  APP_CAPABILITIES_BY_TARGET,
  type AppCapability,
} from "@vibestudio/shared/unitManifest";
import { hasApprovedAppCapability, setApprovedAppCapabilities } from "./appCapabilities";
import { registerBackgroundHandlers } from "./backgroundHandlers";
import type { MobileRpcClient } from "./mobileTransport";

export async function ensureNativeWorkspaceAppBundle(
  transport: MobileRpcClient,
  source?: string | null
): Promise<{ reloading: boolean }> {
  let activated = false;
  const bundleTransport: BundleDeliveryTransport = {
    streamReadable: transport.streamReadable.bind(transport),
  };
  const reactNativeCapabilities = new Set<string>(APP_CAPABILITIES_BY_TARGET["react-native"]);
  await activateApprovedWorkspaceApp(bundleTransport, {
    source,
    nativeHost: NativeModules["VibestudioMobileHost"],
    onCapabilities: (capabilities) =>
      setApprovedAppCapabilities(
        capabilities.filter((capability): capability is AppCapability =>
          reactNativeCapabilities.has(capability)
        )
      ),
  });
  if (hasApprovedAppCapability("notifications")) {
    registerBackgroundHandlers();
  }
  activated = true;
  return { reloading: activated };
}
