import "./polyfills.js";

export { createGatewayArtifactFetch, createMobileArtifactStore } from "./bundleDelivery.js";
export type { NativeArtifactStore } from "./bundleDelivery.js";
export { completeFreshMobilePairing } from "./freshPairing.js";
export { MobileConnectionAggregateError, combineMobileFailures } from "./connectionPair.js";
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
  connectMobileAccount,
} from "./connect.js";
export { MobileWorkspaceAccount } from "./workspaceAccount.js";
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
  AuxiliarySessionOptions,
  IrohConnectionHandlers,
} from "./connect.js";
