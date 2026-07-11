/**
 * @vibestudio/mobile-webrtc — shared React Native WebRTC shell connection.
 *
 * Resolved to `src/` by `apps/mobile/metro.config.js` (the rule that maps a
 * `@vibestudio/<name>` import to its package source), so both the native host
 * bootstrap and the workspace app bundle it from source. RN-only
 * (`react-native-webrtc` + OS Keychain/Keystore credential storage).
 */

// MUST be first: installs the Hermes web-API polyfills the WebRTC codec needs
// before any `@vibestudio/rpc` module loads (TextDecoder/ReadableStream).
import "./polyfills.js";

export { RN_HOST_ABI, activateApprovedWorkspaceApp } from "./bundleDelivery.js";
export type {
  BundleDeliveryRpc,
  BundleDeliveryTransport,
  NativeBundleHost,
  ActivateWorkspaceAppOptions,
} from "./bundleDelivery.js";
export { createReactNativeWebRtcProvider } from "./reactNativeWebRtcPeer.js";
export { completeFreshMobilePairing } from "./freshPairing.js";
export type { CompleteFreshMobilePairingOptions } from "./freshPairing.js";
export { createStoredShellCredential, parseStoredShellCredential } from "./storedCredential.js";
export {
  randomRequestId,
  makeShellTokenProvider,
  persistShellCredential,
  persistStoredShellCredential,
  loadShellCredential,
  clearShellCredential,
  establishWebRtcConnection,
  reconnectViaWebRtc,
} from "./connect.js";
export { connectMobileHubControl } from "./hubControl.js";
export { createMobileHubControlClient } from "./hubControlClient.js";
export type { MobileHubControlConnection } from "./hubControl.js";
export type {
  MobileHubControlClient,
  MobileHubWorkspace,
  MobileHubWorkspaceRoute,
} from "./hubControlClient.js";
export type {
  ShellPairing,
  StoredShellPairing,
  ShellCredential,
  StoredShellCredential,
  ShellTokenProvider,
  WebRtcConnection,
  WebRtcConnectionHandlers,
} from "./connect.js";
