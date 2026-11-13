/**
 * Device powers of the client <-> host wire (capability `device-powers`,
 * tendrils plan 4.8): what a page needs from the phone that a WebView does
 * not give it. Keep the screen on, a haptic tap, and speech (Android WebView
 * has no speechSynthesis).
 *
 * Kept in its own module: the capability is additive. A host that predates it
 * never grants `device-powers`, so a client checks the grant and pages fall
 * back to web APIs; no ABI change is needed.
 */
import type { ClientCapability } from "@vibestudio/workspace-contracts/clients";

export type HapticKind = "light" | "medium" | "heavy" | "success" | "warning" | "error";

export interface DevicePowersHostMethods {
  /** Keep the screen on while this client is shown. */
  "devicePowers.setKeepAwake": { args: [on: boolean]; result: void };
  "devicePowers.haptic": { args: [kind: HapticKind]; result: void };
  /** Speak, replacing anything still being spoken; resolves when it ends or is stopped. */
  "devicePowers.speak": { args: [request: { text: string; lang?: string }]; result: void };
  "devicePowers.stopSpeaking": { args: []; result: void };
}

export const DEVICE_POWERS_METHOD_CAPABILITY: Readonly<
  Record<keyof DevicePowersHostMethods, ClientCapability>
> = {
  "devicePowers.setKeepAwake": "device-powers",
  "devicePowers.haptic": "device-powers",
  "devicePowers.speak": "device-powers",
  "devicePowers.stopSpeaking": "device-powers",
};

export const HAPTIC_KINDS: readonly HapticKind[] = [
  "light",
  "medium",
  "heavy",
  "success",
  "warning",
  "error",
];
