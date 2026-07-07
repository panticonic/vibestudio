/**
 * Native host control seam.
 *
 * Pairing, reconnect, and durable refresh credentials live in
 * @vibestudio/mobile-webrtc. The workspace app only needs native reset and
 * bundle activation controls.
 */

import { NativeModules } from "react-native";

export interface ActivatePreparedAppBundleResult {
  activated: boolean;
}

export interface ResetToNativeBootstrapResult {
  reloading: boolean;
}

export function isWorkspaceMobileAppCallerId(callerId: string, deviceId?: string): boolean {
  if (!callerId.startsWith("app:apps/")) return false;
  if (deviceId && !callerId.endsWith(`:${deviceId}`)) return false;
  return callerId.split(":").length >= 3;
}

export function isMobileShellCallerId(callerId: string, deviceId?: string): boolean {
  if (!callerId.startsWith("shell:")) return false;
  if (deviceId && callerId !== `shell:${deviceId}`) return false;
  return callerId.length > "shell:".length;
}

export function isWorkspaceMobileHostCallerId(callerId: string, deviceId?: string): boolean {
  return (
    isMobileShellCallerId(callerId, deviceId) ||
    isWorkspaceMobileAppCallerId(callerId, deviceId)
  );
}

interface VibestudioMobileHostNative {
  clearCredentials(): Promise<void>;
  resetToNativeBootstrap(): Promise<ResetToNativeBootstrapResult>;
  activatePreparedAppBundle(
    localPath: string,
    buildKey: string,
    integrity: string
  ): Promise<ActivatePreparedAppBundleResult>;
}

function nativeHost(): VibestudioMobileHostNative {
  const module = NativeModules["VibestudioMobileHost"] as VibestudioMobileHostNative | undefined;
  if (!module) {
    throw new Error("VibestudioMobileHost native module is unavailable");
  }
  return module;
}

export async function clearCredentials(): Promise<void> {
  await nativeHost().clearCredentials();
}

export async function resetToNativeBootstrap(): Promise<ResetToNativeBootstrapResult> {
  const response = await nativeHost().resetToNativeBootstrap();
  if (!response || typeof response.reloading !== "boolean") {
    throw new Error("Native host returned an invalid bootstrap reset response");
  }
  return response;
}

export async function activatePreparedAppBundle(bundle: {
  localPath: string;
  buildKey: string;
  integrity: string;
}): Promise<ActivatePreparedAppBundleResult> {
  const response = await nativeHost().activatePreparedAppBundle(
    bundle.localPath,
    bundle.buildKey,
    bundle.integrity
  );
  if (typeof response.activated !== "boolean") {
    throw new Error("Native host returned an invalid app bundle activation result");
  }
  return response;
}
