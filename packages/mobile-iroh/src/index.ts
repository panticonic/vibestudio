import "./polyfills.js";

export { RN_HOST_ABI, activateApprovedWorkspaceApp } from "./bundleDelivery.js";
export type {
  BundleDeliveryRpc,
  BundleDeliveryTransport,
  NativeBundleHost,
  ActivateWorkspaceAppOptions,
} from "./bundleDelivery.js";
export { completeFreshMobilePairing } from "./freshPairing.js";
export { MobileConnectionAggregateError } from "./connectionPair.js";
export {
  createPairedMobileConnection,
  createRoutedMobileConnection,
  selectMobileConnectionWorkspace,
  parseStoredMobileConnection,
  replaceMobileConnectionCredential,
} from "./storedCredential.js";
export {
  randomRequestId,
  makeFreshShellTokenProvider,
  makeReturningShellTokenProvider,
  persistStoredMobileConnection,
  loadShellCredential,
  clearShellCredential,
  createMobileIrohIdentity,
  deleteMobileIrohIdentity,
  establishIrohConnection,
  reconnectViaIroh,
  reconnectMobileSession,
} from "./connect.js";
export { createMobileHubControlClient } from "./hubControlClient.js";
export type {
  MobileHubControlClient,
  MobileHubWorkspace,
  MobileHubWorkspaceRoute,
} from "./hubControlClient.js";
export { isTransientConnectionError, retryAfterConnectionLoss } from "./connectionRecovery.js";
export type {
  FreshShellPairing,
  StoredShellPairing,
  ShellCredential,
  StoredMobileConnection,
  StoredPairedMobileConnection,
  StoredRoutedMobileConnection,
  ShellTokenProvider,
  IrohConnection,
  IrohConnectionHandlers,
} from "./connect.js";
