/**
 * Static contract for the EvalDO-injected runtime module.
 *
 * Eval library builds resolve `@workspace/runtime` through the
 * `vibestudio-eval` package condition so TypeScript and esbuild see the exact
 * rich surface available to evaluated code. The module is deliberately not a
 * second runtime bootstrap: EvalDO keeps this specifier external from retained
 * bundles and supplies a per-object `WorkspaceRuntime` facade whose RPC
 * transport resolves the currently active invocation credential at call time.
 *
 * Reaching this module at runtime means a sandbox host failed to inject the
 * canonical facade. Fail immediately instead of creating an authority-free or
 * accidentally ambient fallback path.
 */

import type { WorkspaceRuntime } from "../shared/hostedRuntime.js";

export * from "../shared/portable.js";
export type * from "../core/types.js";
export type * from "../shared/gad.js";
export type * from "../shared/git.js";

export type {
  RuntimeFs,
  FileStats,
  MkdirOptions,
  RmOptions,
  ThemeAppearance,
  ThemeConfig,
  PaletteCommand,
} from "../types.js";
export type {
  WorkspaceClient,
  WorkspaceEntry,
  WorkspaceConfig,
  WorkspaceUnitLogRecord,
  WorkspaceUnitStatus,
  WorkspaceUnitsClient,
} from "../shared/workspace.js";
export type {
  ClientConfigStatus,
  ConfigureClientRequest,
  ConnectCredentialRequest,
  CredentialClient,
  CredentialAccessGrantSummary,
  CredentialAccessSubjectSummary,
  ManagedCredentialSummary,
  StoredCredentialSummary,
  StoreUrlBoundCredentialRequest,
  GrantUrlBoundCredentialRequest,
  ResolveUrlBoundCredentialRequest,
  DeleteClientConfigRequest,
  GetClientConfigStatusRequest,
  RequestCredentialInputRequest,
  GitHttpClient,
} from "../shared/credentials.js";
export type { VcsClient, VcsStatusResult } from "../shared/vcsClient.js";
export type {
  CreateWebhookIngressSubscriptionRequest,
  RotateWebhookIngressSecretRequest,
  RotateWebhookIngressSecretResult,
  WebhookDeliveredPayload,
  WebhookDeliveryConfig,
  WebhookDeliveryEvent,
  WebhookIngressClient,
  WebhookIngressSubscriptionSummary,
  WebhookPayloadFormat,
  WebhookReplayConfig,
  WebhookResponsePolicy,
  WebhookTarget,
  WebhookVerifierConfig,
} from "../shared/webhooks.js";
export type {
  Disposable,
  ExtensionName,
  ExtensionSource,
  ExtensionsClient,
  RegistryEntry,
  WorkspaceExtensions,
} from "../shared/extensions.js";
export type { NotificationClient } from "../shared/notifications.js";
export type {
  DurableObjectServiceClient,
  ResolvedUserlandService,
  UserlandServiceInfo,
  WorkerSourceInfo,
} from "../shared/workerd.js";

// These declarations intentionally have no usable fallback implementation; the
// initializer makes an injection failure explicit. Its non-`never` return type
// keeps the static declarations available to TypeScript without marking them as
// unreachable. Their types are
// sourced from the one portable runtime contract used by panel, worker, and eval.
function missingHostInjection(): WorkspaceRuntime {
  throw new Error(
    "@workspace/runtime's eval entry is host-injected and cannot execute outside EvalDO"
  );
}

const injected = missingHostInjection();

export const id = injected.id;
export const contextId = injected.contextId;
export const rpc = injected.rpc;
export const fs = injected.fs;
export const callMain = injected.callMain;
export const parent = injected.parent;
export const getParent = injected.getParent;
export const getParentWithContract = injected.getParentWithContract;
export const gad = injected.gad;
export const blobstore = injected.blobstore;
export const workspace = injected.workspace;
export const credentials = injected.credentials;
export const browserData = injected.browserData;
export const git = injected.git;
export const vcs = injected.vcs;
export const webhooks = injected.webhooks;
export const extensions = injected.extensions;
export const approvals = injected.approvals;
export const notifications = injected.notifications;
export const workers = injected.workers;
export const doTargetId = injected.doTargetId;
export const createDurableObjectServiceClient = injected.createDurableObjectServiceClient;
export const gatewayConfig = injected.gatewayConfig;
export const gatewayFetch = injected.gatewayFetch;
export const openExternal = injected.openExternal;
export const openPanel = injected.openPanel;
export const listPanels = injected.listPanels;
export const getPanelHandle = injected.getPanelHandle;
export const panelTree = injected.panelTree;
