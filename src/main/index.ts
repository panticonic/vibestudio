import {
  app,
  dialog,
  nativeTheme,
  Notification,
  session,
  ipcMain,
  powerMonitor,
  shell,
  type Session,
  type WebContents,
} from "electron";
import * as path from "path";
import * as fs from "node:fs";
import { EventService } from "@vibestudio/shared/eventsService";
import { SHELL_SURFACE_KINDS, type ShellSurfaceDescriptor } from "@vibestudio/shared/shellSurface";
// Silence Electron security warnings in dev; panels run in isolated webviews.
process.env["ELECTRON_DISABLE_SECURITY_WARNINGS"] = "true";

import { isDev } from "./utils.js";
import { SKIP_REMOTE_PAIRING_ARG, parseMainStartupInvocation } from "./startupInvocation.js";
import {
  createStartupErrorReport,
  formatUnknownError,
  resolveStartupErrorPaths,
  startupPathDiagnosticEntries,
} from "./startupDiagnostics.js";
import { remoteStartupFailurePresentation } from "./remoteStartupFailure.js";
import { cleanupNodeDatachannel } from "../node/webrtc/nodeDatachannelPeer.js";
import {
  copyPendingNpmUpdateCommand,
  consumeNpmUpdateResult,
  createNpmUpdateController,
  type NpmUpdateController,
} from "./updateCheck.js";
import { NPM_UPDATE_REQUESTED_EXIT_CODE } from "../../scripts/npm-update-contract.mjs";
import { createDevLogger } from "@vibestudio/dev-log";
import {
  createConnectDeepLink,
  parseConnectLink,
  type ConnectPairing,
} from "@vibestudio/shared/connect";
import {
  createPanelDeepLink,
  validatePanelLocation,
  type PanelLocation,
} from "@vibestudio/shared/panelLocation";
import {
  enqueueFirstArgvLink,
  getPendingConnectLink,
  getPendingPanelLocation,
  getPendingShellSurface,
  getPendingConnectLinkError,
  installEarlyOpenUrlBuffer,
  onConnectLink,
  onPanelLocation,
  onShellSurface,
  onConnectLinkError,
  peekPendingConnectLink,
  registerProtocol,
} from "./protocolHandler.js";
import { BrowserEnvironmentReadiness } from "./services/browserEnvironmentReadiness.js";
import { installRelaunchHandler, type RelaunchOptions } from "./relaunchApp.js";
import {
  startEventLoopResponsivenessMonitor,
  type EventLoopResponsivenessSample,
} from "../eventLoopResponsiveness.js";

const log = createDevLogger("App");
const mainEventLoopSamples: EventLoopResponsivenessSample[] = [];
const stopMainEventLoopMonitor = startEventLoopResponsivenessMonitor({
  label: "electron-main",
  onSample: (sample) => {
    mainEventLoopSamples.push(sample);
    if (mainEventLoopSamples.length > 240) mainEventLoopSamples.shift();
  },
});
app.once("quit", stopMainEventLoopMonitor);
const APP_NAME = "Vibestudio";
const APP_SHUTDOWN_TIMEOUT_MS = 30_000;
const startupInvocation = parseMainStartupInvocation(process.argv, process.env);
// Consume one-shot recovery markers so intentional relaunches do not replay them.
process.argv = startupInvocation.argv;
const IS_DEVELOPMENT_CLIENT_EXECUTOR = startupInvocation.isDevelopmentClientExecutor;
// An executor appliance has no presentation surface. Reuse the established
// headless startup containment, then stop initialization immediately after its
// paired executor lease and direct-event subscriptions are live.
const IS_HEADLESS_HOST = startupInvocation.isHeadlessHost || IS_DEVELOPMENT_CLIENT_EXECUTOR;
const {
  recoveredExitCode: recoveredLocalServerCrash,
  crashLoopExitCode: localServerCrashLoopCode,
  crashLoopWorkspaceName,
} = startupInvocation.crashRecovery;
if (startupInvocation.crashRecovery.shouldClearRelaunchState) {
  delete process.env["VIBESTUDIO_LOCAL_CRASH_RELAUNCH_STATE"];
}

function writeHeadlessStartupError(error: unknown, wsDir?: string): void {
  try {
    const paths = resolveStartupErrorPaths(app.getPath("userData"), wsDir);
    fs.mkdirSync(paths.directory, { recursive: true });
    fs.writeFileSync(
      paths.reportPath,
      JSON.stringify(createStartupErrorReport(error, paths, new Date()), null, 2),
      "utf8"
    );
  } catch (writeError) {
    console.error("[headless] Failed to write startup-error.json:", writeError);
  }
}

function cleanupNativeWebRtc(): void {
  try {
    cleanupNodeDatachannel();
  } catch (error) {
    console.error("[App] Native WebRTC cleanup failed:", formatUnknownError(error));
  }
}

function logSuppressedErrorDialog(title: string, content: string): void {
  console.error(`[App] Suppressed error dialog: ${title}\n${content}`);
}

// Initialize the emergency notification bus before installing process-level
// exception handlers. Those handlers can run during later module setup and must
// never touch a not-yet-initialized binding.
const eventService = new EventService();

function surfaceMainProcessFatal(title: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (!app.isReady()) return;
  try {
    eventService.emit("notification:show", {
      id: `main-process-error:${Date.now()}`,
      type: "error",
      title,
      message,
      ttl: 0,
    });
    if (Notification.isSupported()) {
      new Notification({ title, body: message, urgency: "critical" }).show();
    }
  } catch (surfaceError) {
    // An exception reporter must not recursively trigger itself.
    console.error("[App] Failed to surface main-process error:", surfaceError);
  }
}

// Electron's default main-process exception handling can show a blocking
// "A JavaScript Error Occurred in the main process" alert. Vibestudio should log
// these errors instead of interrupting the user with generic native dialogs.
process.on("uncaughtException", (error) => {
  recordMainProcessError("uncaughtException", error);
  console.error("[App] Uncaught exception in main process:", formatUnknownError(error));
  surfaceMainProcessFatal("Vibestudio encountered an internal error", error);
});
process.on("unhandledRejection", (reason) => {
  recordMainProcessError("unhandledRejection", reason);
  console.error("[App] Unhandled rejection in main process:", formatUnknownError(reason));
  surfaceMainProcessFatal("A Vibestudio operation failed", reason);
});
dialog.showErrorBox = logSuppressedErrorDialog;

app.setName(APP_NAME);

import { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import { asPanelSlotId } from "@vibestudio/shared/panel/ids";
import { getPanelSource } from "@vibestudio/shared/panel/accessors";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { panelLogMethods } from "@vibestudio/service-schemas/panelLog";
import { corsApprovalMethods } from "@vibestudio/service-schemas/corsApproval";
import { externalOpenMethods } from "@vibestudio/service-schemas/externalOpen";
import { PanelOrchestrator } from "./panelOrchestrator.js";
import { PanelPinStore } from "./panelPinStore.js";
import { PANEL_UI_IDLE_UNLOAD_MS, PANEL_UI_MAX_LOADED_DESKTOP } from "@vibestudio/shared/constants";
import type { PanelView } from "./panelView.js";
import type { AppAvailableEvent } from "./appOrchestrator.js";
import { HostLaunchClient } from "@vibestudio/service-schemas/clients/hostLaunchClient";
import { resolveElectronViewCaller } from "./callerResolution.js";
import { setMenuPanelLifecycle, setMenuPanelRegistry, setMenuEventService } from "./menu.js";
import { getAppRoot } from "./paths.js";
import { loadCentralEnv } from "@vibestudio/workspace/loader";
import { CentralDataManager } from "@vibestudio/shared/centralData";
import {
  resolveStartupMode,
  shouldRequestSingleInstanceLock,
  getPendingUserDataDir,
  localShellUserDataDir,
  chooseConnectionRelaunchArgs,
  EPHEMERAL_DEV_WORKSPACE_NAME,
  ephemeralWorkspaceRelaunchArgs,
  resolveEphemeralDevStartupMode,
  resolveLocalStartupMode,
  workspaceRelaunchArgs,
  type StartupMode,
  type ConnectedStartupMode,
} from "./startupMode.js";
import { establishServerSession, type SessionConnection } from "./serverSession.js";
import { ordinaryQuitServerDecision } from "./quitServerPolicy.js";
import { installProcessSignalShutdown } from "./processSignalShutdown.js";
import type { StartupConnectionProgress } from "../startupConnectionProgress.js";
import { getLocalHubLogPath } from "./hubProcessManager.js";
import {
  loadStoredRemotePairing,
  clearStoredRemotePairing,
  persistStoredRemoteWorkspaceRoute,
  readPendingPairLabel,
} from "./services/remoteCredService.js";
import type { ServerClient } from "./serverClient.js";
import { CdpHostProvider } from "./cdpHostProvider.js";
import { RemoteCdpHostProviderSocket } from "./remoteCdpHostProviderSocket.js";
import { resolveGatewayRouteUrl } from "@vibestudio/shared/appArtifacts";
import {
  bindHostDirectServerEvents,
  createServerEventBridge,
  notificationAttention,
  type ServerHostTargetChangeEvent,
} from "./serverEventBridge.js";
import { createServerEventSubscriptionBridge } from "./serverEventSubscriptionBridge.js";
import { createApprovalAttention, type ApprovalAttention } from "./approvalAttention.js";
import type { PendingApproval } from "@vibestudio/shared/approvals";
import type { PanelTreeInvalidation } from "@vibestudio/shared/panel/treeIndex";
import { filterBootstrapApprovalsForTarget } from "@vibestudio/shared/bootstrapApprovals";
import { RuntimeDiagnosticsStore } from "../server/runtimeDiagnosticsStore.js";

import {
  createHostCaller,
  createVerifiedCaller,
  ServiceDispatcher,
  parseServiceMethod,
  type ServiceContext,
} from "@vibestudio/shared/serviceDispatcher";
import { authorizeVerifiedCaller } from "../server/services/authorityRuntime.js";
import { ServiceContainer } from "@vibestudio/shared/serviceContainer";
import { setupTestApi } from "./testApi.js";
import { AdBlockManager } from "./adblock/index.js";
import { callerHasPlatformCapability, viewHasAppCapability } from "./services/appCapabilities.js";
import { createAutofillService } from "./services/autofillService.js";
import { assertPresent } from "../lintHelpers";
import { ApplicationWindowController } from "./applicationWindowController.js";
import { AsyncStateConvergenceLoop } from "@vibestudio/shared/asyncStateConvergenceLoop";
import { recordMainProcessError } from "./mainProcessErrorLedger.js";
import {
  clearPanelInitializationFailure,
  recordPanelInitializationFailure,
} from "./panelInitializationFailure.js";

// =============================================================================
// Early Diagnostics (enabled via VIBESTUDIO_DEBUG_PATHS=1)
// =============================================================================

if (process.env["VIBESTUDIO_DEBUG_PATHS"] === "1") {
  console.log("=".repeat(60));
  console.log("[diagnostics] Vibestudio startup diagnostics");
  for (const [label, value] of startupPathDiagnosticEntries({
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd(),
    execPath: process.execPath,
    appPath: app.getAppPath(),
    userDataPath: app.getPath("userData"),
    nodeEnv: process.env["NODE_ENV"],
    isDevelopment: isDev(),
    appRoot: getAppRoot(),
  })) {
    console.log(label, value);
  }
  console.log("=".repeat(60));
}

// =============================================================================
// Configuration Initialization
// =============================================================================

console.log(`[Perf] main module evaluated at ${Math.round(process.uptime() * 1000)}ms uptime`);

// Load central environment variables first (.env from ~/.config/vibestudio/)
loadCentralEnv();

const centralData = new CentralDataManager();
let startupMode: StartupMode;
let workspaceId: string = "unknown";
let bootstrapStartupError: { message: string; detail?: string; logPath?: string } | null = null;
let retryWorkspaceName: string | null = crashLoopWorkspaceName;
let retryWorkspaceIsEphemeral = false;

if (localServerCrashLoopCode) {
  bootstrapStartupError = {
    message: `The local workspace server stopped repeatedly (last exit code ${localServerCrashLoopCode}).`,
    detail:
      "Automatic restart was stopped to avoid a relaunch loop. Inspect the server log, then retry or choose another workspace.",
  };
}

try {
  startupMode = resolveStartupMode(centralData, {
    interactiveDesktop: !startupInvocation.isHeadlessHost,
  });
} catch (error) {
  console.error("[Workspace] Failed to initialize workspace:", error);
  if (startupInvocation.isHeadlessHost) {
    writeHeadlessStartupError(error);
    app.quit();
    process.exit(1);
  }
  startupMode = { kind: "pending" };
  bootstrapStartupError = {
    message: error instanceof Error ? error.message : String(error),
    detail: formatUnknownError(error),
  };
}

if (startupMode.kind === "local" && startupMode.isEphemeral) {
  retryWorkspaceName = startupMode.workspaceName;
  retryWorkspaceIsEphemeral = true;
}

if (
  shouldRequestSingleInstanceLock(startupMode, {
    isHeadlessHost: IS_HEADLESS_HOST,
    isDevelopment: isDev(),
  }) &&
  !app.requestSingleInstanceLock()
) {
  app.exit(0);
  process.exit(0);
}
registerProtocol();
installEarlyOpenUrlBuffer();
enqueueFirstArgvLink(process.argv);

if (startupMode.kind === "local") {
  workspaceId = startupMode.workspaceId;
  app.setPath(
    "userData",
    localShellUserDataDir(startupMode, {
      pendingCreation:
        !startupMode.isEphemeral &&
        centralData.getWorkspaceCreationIntent(startupMode.workspaceName) !== null,
      headless: IS_HEADLESS_HOST,
    })
  );
} else {
  app.setPath(
    "userData",
    IS_DEVELOPMENT_CLIENT_EXECUTOR
      ? path.join(getPendingUserDataDir(), "development-client-executor")
      : getPendingUserDataDir()
  );
}

let cdpHostProvider: CdpHostProvider | null = null;
let panelRegistry: PanelRegistry | null = null;
let panelOrchestrator: PanelOrchestrator | null = null;
let pendingReadyElectronLaunch: AppAvailableEvent | null = null;
let electronHostLaunchBlockedByApproval = false;
let electronHostTargetSyncLoop: AsyncStateConvergenceLoop<ElectronHostTargetSyncResult> | null =
  null;
let bootstrapWorkspaceRpcReady = false;
let bootstrapStartupProgress: StartupConnectionProgress | null = null;
let bootstrapConnectionKind: "local" | "remote" | null =
  startupMode.kind === "local" ? "local" : null;
// True when this launch found a persisted WebRTC remote pairing — the chooser is
// skipped and `establishServerSession` connects to the remote over the pipe.
let remotePairedAtLaunch = false;

/**
 * A returning device's credential was terminally rejected (revoked / reset on the
 * server, or the DTLS cert regenerated so the pinned fingerprint no longer
 * matches) — re-pairing is required. A transient outage reads differently (the
 * transport retries internally; a connect timeout has its own shape), so those do
 * NOT match and the stored pairing is kept for a later retry.
 */
function isTerminalRemoteCredentialFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /credential (expired|revoked|invalid)|re-pair|fingerprint mismatch|invalid token|session (is )?closed|session auth failed|SESSION_AUTH_FAILED/i.test(
    message
  );
}

// The bootstrap chooser resolves IN-PROCESS (no relaunch): when the user picks a
// local workspace or pairs a server, the chooser IPC handler resolves
// `chooserChoice`, the pending startup path awaits it, and we fall through to the
// connected setup in the SAME process. A `local` choice reassigns `startupMode`;
// a `remote` choice sets `pendingRemotePairing` (the fresh pairing IS the session).
type ChooserChoice =
  | { kind: "local"; name: string; ephemeral: boolean }
  | { kind: "remote"; pairing: ConnectPairing };
let chooserChoiceMade = false;
let resolveChooserChoice!: (choice: ChooserChoice) => void;
const chooserChoice = new Promise<ChooserChoice>((resolve) => {
  resolveChooserChoice = (choice) => {
    chooserChoiceMade = true;
    resolve(choice);
  };
});

function shouldAutoPairPendingDevWebRtcLink(): boolean {
  return isDev() && startupInvocation.devWebRtcRemote;
}

let appliedElectronHostTargetKey: string | null = null;
let appliedElectronHostAppId: string | null = null;
let electronHostTargetApplicationTail: Promise<void> = Promise.resolve();
const electronHostTargetApplications = new Map<string, Promise<boolean>>();
let electronHostLaunchLastStatusKey: string | null = null;
let panelTreeInitializationPromise: Promise<void> | null = null;
let latestPanelTreeInvalidation: PanelTreeInvalidation | undefined;
let shellCore: ReturnType<
  typeof import("./shellCore/createElectronShellCore.js").createElectronShellCore
> | null = null;
let serverSession: SessionConnection | null = null;
let activeBrowserSessionPartition: string | null = null;
const browserEnvironmentReadiness = new BrowserEnvironmentReadiness();
const getBrowserSessionPartition = (): string => {
  return browserEnvironmentReadiness.requireReady();
};
let panelLocationForWorkspaceRelaunch: PanelLocation | null = null;
let approvalAttention: ApprovalAttention | null = null;
let currentHostDevelopmentExecutor:
  | import("./currentHostDevelopmentClientExecutor.js").CurrentHostDevelopmentClientExecutor
  | null = null;
let isCleaningUp = false; // Prevent re-entry in will-quit handler
let shutdownRequiresLocalHubStop = false;
let localHubStopConfirmed = false;
let localHubStopPromise: Promise<void> | null = null;
type QuitIntent =
  | { kind: "ordinary"; serverDecision: "stop" | "keep" | null }
  | { kind: "relaunch"; exitCode: number }
  | { kind: "npm-update"; targetVersion: string };
let quitIntent: QuitIntent = { kind: "ordinary", serverDecision: null };
let npmUpdateController: NpmUpdateController | null = null;
let npmUpdateResultConsumed = false;
let presentedStartupFinished = false;
let deferredStartupWork: (() => void) | null = null;

function finishPresentedStartup(): void {
  if (presentedStartupFinished) return;
  presentedStartupFinished = true;
  performance.mark("startup:desktop-visible");

  if (isDev()) {
    performance.measure("startup:total", "startup:ready", "startup:desktop-visible");
    performance.measure("startup:bootstrap-window", "startup:ready", "startup:window-created");
    performance.measure(
      "startup:server-spawn",
      "startup:server-spawn-begin",
      "startup:server-spawned"
    );
    performance.measure(
      "startup:server-connect",
      "startup:server-spawned",
      "startup:server-connected"
    );
    performance.measure(
      "startup:post-connect",
      "startup:server-connected",
      "startup:workspace-window-attached"
    );
    performance.measure(
      "startup:desktop-mount",
      "startup:workspace-window-attached",
      "startup:desktop-visible"
    );
    const entries = performance
      .getEntriesByType("measure")
      .filter((entry) => entry.name.startsWith("startup:"));
    for (const entry of entries) {
      console.log(`[Perf] ${entry.name}: ${Math.round(entry.duration)}ms`);
    }
    if (process.env["VIBESTUDIO_DEV_RUNNER_IPC"] === "1" && process.send) {
      process.send({ type: "vibestudio:dev-ready" });
    }
  }

  deferredStartupWork?.();
}

function relaunchWithIntent(opts: RelaunchOptions = {}): void {
  quitIntent = { kind: "relaunch", exitCode: opts.exitCode ?? 0 };
  if (opts.args) app.relaunch({ args: opts.args });
  else app.relaunch();
  app.quit();
}
installRelaunchHandler(relaunchWithIntent);
installProcessSignalShutdown(process, () => {
  // Signals and development-runner stop requests are unattended lifecycle
  // commands, not interactive window closes. Stop the owned hub explicitly so
  // an ephemeral development session cannot leak behind a prompt nobody can
  // answer. Preserve stronger update/relaunch intents if one is already active.
  if (quitIntent.kind === "ordinary") {
    quitIntent = { kind: "ordinary", serverDecision: "stop" };
  }
  app.quit();
});

const applicationWindow = new ApplicationWindowController({
  eventService,
  isHeadlessHost: IS_HEADLESS_HOST,
  getWindowTitle: () =>
    startupMode.kind === "pending"
      ? "Vibestudio - Connect"
      : IS_HEADLESS_HOST
        ? `Vibestudio Headless Host — ${workspaceId}`
        : `Vibestudio — ${workspaceId}`,
  getApprovalAttention: () => approvalAttention,
  stopElectronHostTargetLaunchLoop,
  startElectronHostTargetLaunchLoop,
  drainPendingReadyElectronLaunch,
  initializePanelTreeOnce,
  onHostedShellReady: finishPresentedStartup,
  onWindowClosed: () => {
    panelTreeInitializationPromise = null;
    clearPanelInitializationFailure();
    appliedElectronHostTargetKey = null;
    appliedElectronHostAppId = null;
    electronHostTargetApplications.clear();
    electronHostTargetApplicationTail = Promise.resolve();
    electronHostLaunchLastStatusKey = null;
  },
});

app.on("second-instance", () => {
  applicationWindow.showAndFocus();
});
let formFillManager: import("./autofill/formFillManager.js").FormFillManager | null = null;
const corsApprovalCache = new Set<string>();
const pendingCorsApprovals = new Map<string, Promise<{ allowed: boolean; cacheable: boolean }>>();
let browserDataStoreForCredentialCapture:
  | import("./services/browserVaultNativeClient.js").BrowserVaultNativeClient
  | null = null;
let browserCookieProjection:
  | import("./services/browserCookieProjection.js").BrowserCookieProjectionApi
  | null = null;
let browserFaviconObserver:
  | import("./services/browserFaviconObserver.js").BrowserFaviconObserver
  | null = null;
let browserDownloadManager:
  | import("./services/browserDownloadManager.js").BrowserDownloadManager
  | null = null;
let browserPermissionController:
  | import("./services/browserPermissionController.js").BrowserPermissionController
  | null = null;
let releaseBrowserAdBlocking: (() => void) | null = null;
let websiteNotificationBridge:
  | import("./services/websiteNotificationBridge.js").WebsiteNotificationBridge
  | null = null;
let browserImportHostProvider:
  | import("./services/browserImportHostProvider.js").BrowserImportHostProvider
  | null = null;
let browserPrivacyManager:
  | import("./services/browserPrivacyManager.js").BrowserPrivacyManager
  | null = null;

type AppCapability = import("@vibestudio/shared/unitManifest").AppCapability;

const APP_FS_READ_METHODS = new Set([
  "readFile",
  "readdir",
  "stat",
  "lstat",
  "exists",
  "realpath",
  "readlink",
  "handleRead",
  "handleStat",
]);

const APP_FS_WRITE_METHODS = new Set([
  "writeFile",
  "appendFile",
  "mkdir",
  "rmdir",
  "rm",
  "unlink",
  "rename",
  "truncate",
  "chmod",
  "chown",
  "utimes",
  "handleWrite",
  "mktemp",
  "symlink",
]);

function openFlagsRequireWrite(flags: unknown): boolean {
  if (flags === undefined || flags === null) return false;
  if (typeof flags === "number") return true;
  if (typeof flags !== "string") return true;
  return flags.includes("w") || flags.includes("a") || flags.includes("+");
}

function appFsCapabilitiesForMethod(
  method: string,
  args: readonly unknown[]
): readonly AppCapability[] {
  if (APP_FS_READ_METHODS.has(method)) return ["fs-read"];
  if (APP_FS_WRITE_METHODS.has(method)) return ["fs-write"];
  if (method === "copyFile") return ["fs-read", "fs-write"];
  if (method === "handleClose") return [];
  if (method === "access") {
    const mode = typeof args[1] === "number" ? args[1] : 0;
    return mode & 2 ? ["fs-write"] : ["fs-read"];
  }
  if (method === "open") return [openFlagsRequireWrite(args[1]) ? "fs-write" : "fs-read"];
  throw new Error(`Unsupported app fs method: ${method}`);
}

function authorizeAppServerCall(
  callerId: string,
  service: string,
  method: string,
  args: readonly unknown[]
): void {
  // The shell consent queue (credential/capability/install/device-code/client-
  // config approvals) must only be reachable from the trusted host-chrome
  // consent surface — NOT from an ordinary adopted app view, which could
  // otherwise enumerate and silently grant/deny another principal's approvals.
  if (service === "shellApproval") {
    const viewInfo = applicationWindow.viewManager?.getViewInfo(callerId);
    if (!(viewInfo?.type === "app" && viewInfo.hostChrome)) {
      throw new Error(
        `shellApproval is only available to the host-chrome consent surface, not ${callerId}`
      );
    }
    return;
  }
  if (service !== "fs") return;
  const required = appFsCapabilitiesForMethod(method, args);
  if (required.length === 0) return;
  const viewInfo = applicationWindow.viewManager?.getViewInfo(callerId);
  if (viewInfo?.type !== "app") {
    throw new Error(`fs.${method} requires an active app view for ${callerId}`);
  }
  for (const capability of required) {
    if (!viewInfo.capabilities.includes(capability)) {
      throw new Error(`fs.${method} requires app capability '${capability}' for ${callerId}`);
    }
  }
}

const INCOMING_PAIR_LINK_CAPABILITY: AppCapability = "incoming-pair-links";

function canAccessIncomingPairLinks(webContentsId: number): boolean {
  const viewManager = applicationWindow.viewManager;
  if (!viewManager) return false;
  const shellContents = viewManager.getShellWebContents();
  if (shellContents && !shellContents.isDestroyed() && shellContents.id === webContentsId) {
    return true;
  }
  const viewId = viewManager.findViewIdByWebContentsId(webContentsId);
  if (!viewId) return false;
  const viewInfo = viewManager.getViewInfo(viewId);
  return viewInfo?.type === "app" && viewInfo.capabilities.includes(INCOMING_PAIR_LINK_CAPABILITY);
}

function sendIncomingPairLink(link: unknown): void {
  const viewManager = applicationWindow.viewManager;
  if (!viewManager) return;
  const shellContents = viewManager.getShellWebContents();
  if (shellContents && !shellContents.isDestroyed()) {
    shellContents.send("vibestudio:incoming-pair-link", link);
  }
  for (const viewId of viewManager.getViewIds()) {
    if (viewId === "shell") continue;
    const viewInfo = viewManager.getViewInfo(viewId);
    if (
      viewInfo?.type !== "app" ||
      !viewInfo.capabilities.includes(INCOMING_PAIR_LINK_CAPABILITY)
    ) {
      continue;
    }
    const contents = viewManager.getWebContents(viewId);
    if (contents && !contents.isDestroyed()) {
      contents.send("vibestudio:incoming-pair-link", link);
    }
  }
}

function canAccessIncomingPanelLocations(webContentsId: number): boolean {
  const viewManager = applicationWindow.viewManager;
  if (!viewManager) return false;
  const shellContents = viewManager.getShellWebContents();
  if (shellContents && !shellContents.isDestroyed() && shellContents.id === webContentsId) {
    return true;
  }
  const viewId = viewManager.findViewIdByWebContentsId(webContentsId);
  if (!viewId) return false;
  const viewInfo = viewManager.getViewInfo(viewId);
  return viewInfo?.type === "app" && viewInfo.hostChrome === true;
}

/**
 * Route a validated shell-surface descriptor to the shell renderer as the one
 * event that surface already listens for. Every entry point — `app.openShellSurface`,
 * `vibestudio://ask|about|command|surface` deep links, menu items — converges here.
 */
function dispatchShellSurface(target: ShellSurfaceDescriptor): void {
  switch (target.kind) {
    case "settings":
      eventService.emit("open-settings", { section: target.section ?? "connection" });
      return;
    case "workspace-chooser":
      eventService.emit("open-workspace-switcher", undefined);
      return;
    case "about":
      eventService.emit("navigate-about", { page: target.page });
      return;
    case "command-agent": {
      const { kind: _kind, ...request } = target;
      eventService.emit("open-command-agent", request);
      return;
    }
    case "panel-command":
      eventService.emit("run-panel-command", {
        panelId: target.panelId,
        commandId: target.commandId,
      });
      return;
  }
}

function sendIncomingPanelLocation(location: unknown): void {
  const viewManager = applicationWindow.viewManager;
  if (!viewManager) return;
  const shellContents = viewManager.getShellWebContents();
  if (shellContents && !shellContents.isDestroyed()) {
    shellContents.send("vibestudio:incoming-panel-location", location);
  }
  for (const viewId of viewManager.getViewIds()) {
    if (viewId === "shell") continue;
    const viewInfo = viewManager.getViewInfo(viewId);
    if (viewInfo?.type !== "app" || !viewInfo.hostChrome) continue;
    const contents = viewManager.getWebContents(viewId);
    if (contents && !contents.isDestroyed()) {
      contents.send("vibestudio:incoming-panel-location", location);
    }
  }
}

function createCdpRegistrationAdapter() {
  return {
    registerTarget(panelId: string, contentsId: number): void {
      cdpHostProvider?.registerTarget(panelId, contentsId);
    },
    unregisterTarget(panelId: string): void {
      cdpHostProvider?.unregisterTarget(panelId);
    },
    cleanupPanelAccess(panelId: string): void {
      cdpHostProvider?.cleanupPanelAccess(panelId);
    },
    isTargetUnderAutomation(panelId: string): boolean {
      return cdpHostProvider?.isTargetUnderAutomation(panelId) ?? false;
    },
    getAccessibilityTree(panelId: string): Promise<unknown[]> {
      if (cdpHostProvider) return cdpHostProvider.getAccessibilityTree(panelId);
      return Promise.resolve([]);
    },
  };
}

log.info(` Starting in main mode`);

type CredentialSessionCaptureRequest = Record<string, unknown> & {
  kind?: unknown;
  signInUrl?: unknown;
  origins?: unknown;
  cookieNames?: unknown;
  completionUrlPattern?: unknown;
  maxTtlSeconds?: unknown;
  browser?: unknown;
  assertion?: unknown;
};

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

function globMatches(pattern: string, value: string): boolean {
  if (pattern === value) return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function normalizeCaptureOrigins(value: unknown): string[] {
  const origins = toStringArray(value).map((entry) => {
    const url = new URL(entry);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("capture origin must use http or https");
    }
    return url.origin;
  });
  return [...new Set(origins)];
}

function buildCanonicalCookieHeader(
  cookies: import("@vibestudio/browser-data").StoredCookie[],
  cookieNames: string[],
  origins: string[]
): {
  header: string;
  expiresAt?: number;
  cookies: Record<string, unknown>[];
} | null {
  const selected: typeof cookies = [];
  for (const name of cookieNames) {
    const cookie = cookies.find(
      (entry) =>
        entry.name === name &&
        !!entry.value &&
        origins.some((origin) => importedCookieMatchesOrigin(entry, origin))
    );
    if (!cookie) return null;
    selected.push(cookie);
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiringCookies = selected
    .map((cookie) => cookie.expirationDate)
    .filter((value): value is number => typeof value === "number" && value > nowSeconds);
  if (
    selected.some(
      (cookie) => typeof cookie.expirationDate === "number" && cookie.expirationDate <= nowSeconds
    )
  ) {
    return null;
  }
  return {
    header: selected.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
    expiresAt: expiringCookies.length > 0 ? Math.min(...expiringCookies) * 1000 : undefined,
    cookies: selected.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      expirationDate: cookie.expirationDate,
      partitionKey: cookie.partitionKey,
    })),
  };
}

function importedCookieMatchesOrigin(
  cookie: { domain: string; path: string; secure: boolean; hostOnly: boolean },
  origin: string
): boolean {
  const url = new URL(origin);
  if (cookie.secure && url.protocol !== "https:") return false;
  const cookieDomain = cookie.domain.replace(/^\./, "").toLowerCase();
  const host = url.hostname.toLowerCase();
  const domainMatches = cookie.hostOnly
    ? host === cookieDomain
    : host === cookieDomain || host.endsWith(`.${cookieDomain}`);
  if (!domainMatches) return false;
  const cookiePath = cookie.path || "/";
  return (
    url.pathname === cookiePath ||
    url.pathname.startsWith(cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`)
  );
}

function getHttpOrigin(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function getWebRequestPanelCallerId(
  details: Electron.OnHeadersReceivedListenerDetails
): string | null {
  const viewManager = applicationWindow.viewManager;
  if (!viewManager) return null;
  const webContentsId = details.webContentsId ?? details.webContents?.id;
  if (typeof webContentsId !== "number") return null;
  const shellContents = viewManager.getShellWebContents();
  if (shellContents && !shellContents.isDestroyed() && shellContents.id === webContentsId) {
    return null;
  }
  return viewManager.findViewIdByWebContentsId(webContentsId);
}

function getCorsRequestOrigin(details: Electron.OnHeadersReceivedListenerDetails): string | null {
  const referrerOrigin = details.referrer ? getHttpOrigin(details.referrer) : null;
  if (referrerOrigin) return referrerOrigin;
  const currentUrl =
    details.webContents && !details.webContents.isDestroyed() ? details.webContents.getURL() : "";
  return currentUrl ? getHttpOrigin(currentUrl) : null;
}

async function authorizeCorsResponseAccess(
  details: Electron.OnHeadersReceivedListenerDetails
): Promise<{ allowed: boolean; requestOrigin: string | null }> {
  if (details.resourceType !== "xhr") {
    return { allowed: false, requestOrigin: null };
  }
  const targetOrigin = getHttpOrigin(details.url);
  const requestOrigin = getCorsRequestOrigin(details);
  if (!targetOrigin || !requestOrigin || targetOrigin === requestOrigin) {
    return { allowed: false, requestOrigin };
  }

  const callerId = getWebRequestPanelCallerId(details);
  if (!callerId || !serverSession?.serverClient) {
    return { allowed: false, requestOrigin };
  }

  const cacheKey = `${callerId}\x00${targetOrigin}`;
  if (corsApprovalCache.has(cacheKey)) {
    return { allowed: true, requestOrigin };
  }

  let pending = pendingCorsApprovals.get(cacheKey);
  if (!pending) {
    const client = serverSession.serverClient;
    pending = createTypedServiceClient("corsApproval", corsApprovalMethods, (svc, m, a) =>
      client.call(svc, m, a)
    )
      .authorize({ targetUrl: details.url, requestOrigin })
      .then((response) => {
        const allowed = response.allowed === true;
        const cacheable = allowed && response.decision !== "once";
        if (cacheable) corsApprovalCache.add(cacheKey);
        return { allowed, cacheable };
      })
      .catch((error: unknown) => {
        log.warn(`CORS approval failed: ${error instanceof Error ? error.message : String(error)}`);
        return { allowed: false, cacheable: false };
      })
      .finally(() => {
        pendingCorsApprovals.delete(cacheKey);
      });
    pendingCorsApprovals.set(cacheKey, pending);
  }

  const result = await pending;
  return { allowed: result.allowed, requestOrigin };
}

function withCorsRelaxedHeaders(
  responseHeaders: Record<string, string[]> | undefined,
  requestOrigin: string
): Record<string, string[]> {
  const strippedCorsHeaderNames = new Set([
    "access-control-allow-origin",
    "access-control-allow-headers",
    "access-control-allow-methods",
    "access-control-allow-credentials",
    "access-control-expose-headers",
  ]);
  const headers: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(responseHeaders ?? {})) {
    const lower = key.toLowerCase();
    if (!strippedCorsHeaderNames.has(lower)) {
      headers[key] = value;
    }
  }
  headers["access-control-allow-origin"] = [requestOrigin];
  headers["access-control-allow-headers"] = ["*"];
  headers["access-control-allow-methods"] = ["GET, POST, PUT, PATCH, DELETE, OPTIONS"];
  headers["access-control-allow-credentials"] = ["true"];
  headers["access-control-expose-headers"] = ["*"];
  return headers;
}

async function handleCredentialSessionCaptureRequest(
  msg: CredentialSessionCaptureRequest
): Promise<Record<string, unknown>> {
  try {
    if (msg.kind !== "cookies" && msg.kind !== "saml") {
      return { error: "unsupported session capture kind" };
    }
    if (typeof msg.signInUrl !== "string") {
      return { error: "missing signInUrl" };
    }
    const signInUrl = new URL(msg.signInUrl);
    if (signInUrl.protocol !== "https:" && signInUrl.protocol !== "http:") {
      return { error: "signInUrl must use http or https" };
    }
    const cookieNames = toStringArray(msg.cookieNames);
    if (cookieNames.length === 0) {
      return { error: "cookie capture requires declared cookie names" };
    }
    const origins =
      msg.kind === "cookies" ? normalizeCaptureOrigins(msg.origins) : [signInUrl.origin];
    if (msg.kind === "saml" && msg.assertion && cookieNames.length === 0) {
      return { error: "raw SAML assertion capture is not supported by this host adapter" };
    }
    if (msg.browser === "external") {
      if (!browserDataStoreForCredentialCapture) {
        return { error: "external browser cookie import is unavailable" };
      }
      const browserDataStore = browserDataStoreForCredentialCapture;
      const imported = (
        await Promise.all(origins.map((origin) => browserDataStore.getCookiesForOrigin(origin)))
      ).flat();
      const material = buildCanonicalCookieHeader(imported, cookieNames, origins);
      if (!material) {
        return {
          error: "external browser cookie import did not contain the declared session cookies",
        };
      }
      const maxTtlSeconds =
        typeof msg.maxTtlSeconds === "number" && msg.maxTtlSeconds > 0
          ? Math.floor(msg.maxTtlSeconds)
          : undefined;
      const maxExpiresAt = maxTtlSeconds ? Date.now() + maxTtlSeconds * 1000 : undefined;
      return {
        cookieHeader: material.header,
        cookieSession: {
          origins,
          cookies: material.cookies,
        },
        expiresAt:
          material.expiresAt && maxExpiresAt
            ? Math.min(material.expiresAt, maxExpiresAt)
            : (material.expiresAt ?? maxExpiresAt),
      };
    }
    const viewManager = applicationWindow.viewManager;
    if (!panelOrchestrator || !viewManager) {
      return { error: "internal browser is unavailable" };
    }

    const panel = await panelOrchestrator.createBrowserUrlPanel("shell", signInUrl.href, {
      title: "Credential sign-in",
      focus: true,
    });

    try {
      const webContents = viewManager.getWebContents(panel.id);
      if (!webContents || webContents.isDestroyed()) {
        return { error: "failed to create browser panel" };
      }

      const completionPattern =
        typeof msg.completionUrlPattern === "string" ? msg.completionUrlPattern : undefined;
      const timeout = 300_000;

      // Helper to check if cookies are captured
      const tryCaptureCredentials = async (): Promise<Record<string, unknown> | null> => {
        if (!browserCookieProjection || !browserDataStoreForCredentialCapture) {
          return null;
        }
        const projection = browserCookieProjection;
        const browserDataStore = browserDataStoreForCredentialCapture;
        await projection.flush(origins);
        const captured = (
          await Promise.all(origins.map((origin) => browserDataStore.getCookiesForOrigin(origin)))
        ).flat();
        const material = buildCanonicalCookieHeader(captured, cookieNames, origins);
        if (material) {
          const maxTtlSeconds =
            typeof msg.maxTtlSeconds === "number" && msg.maxTtlSeconds > 0
              ? Math.floor(msg.maxTtlSeconds)
              : undefined;
          const maxExpiresAt = maxTtlSeconds ? Date.now() + maxTtlSeconds * 1000 : undefined;
          return {
            cookieHeader: material.header,
            cookieSession: {
              origins,
              cookies: material.cookies,
            },
            expiresAt:
              material.expiresAt && maxExpiresAt
                ? Math.min(material.expiresAt, maxExpiresAt)
                : (material.expiresAt ?? maxExpiresAt),
          };
        }
        return null;
      };

      type CaptureResult = Record<string, unknown> | { error: string };
      type CookieChangeCause =
        | "explicit"
        | "inserted"
        | "inserted-no-change-overwrite"
        | "inserted-no-value-change-overwrite"
        | "overwrite"
        | "expired"
        | "evicted"
        | "expired-overwrite";

      const immediate = await tryCaptureCredentials();
      if (immediate && !completionPattern) return immediate;

      const captureResult = await new Promise<CaptureResult>((resolve) => {
        let settled = false;
        let completionReached =
          !completionPattern ||
          (!!webContents.getURL() && globMatches(completionPattern, webContents.getURL()));
        let captureInFlight: Promise<void> | null = null;

        const cleanup = () => {
          clearTimeout(timeoutId);
          session
            .fromPartition(getBrowserSessionPartition())
            .cookies.off("changed", onCookiesChanged);
          webContents.off("did-navigate", onNavigate);
          webContents.off("did-navigate-in-page", onNavigate);
          webContents.off("did-redirect-navigation", onRedirect);
          webContents.off("destroyed", onDestroyed);
        };

        const finish = (result: CaptureResult) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        };

        const attemptCapture = () => {
          if (settled || !completionReached || captureInFlight) return;
          captureInFlight = tryCaptureCredentials()
            .then((result) => {
              if (result) finish(result);
            })
            .catch((error: unknown) => {
              finish({ error: error instanceof Error ? error.message : String(error) });
            })
            .finally(() => {
              captureInFlight = null;
            });
        };

        const markCompletionIfMatched = (url: string) => {
          if (completionPattern && globMatches(completionPattern, url)) {
            completionReached = true;
          }
          attemptCapture();
        };

        const onCookiesChanged = (
          _event: Electron.Event,
          cookie: Electron.Cookie,
          _cause: CookieChangeCause,
          removed: boolean
        ) => {
          if (removed || !cookieNames.includes(cookie.name)) return;
          attemptCapture();
        };
        const onNavigate = (_event: Electron.Event, url: string) => markCompletionIfMatched(url);
        const onRedirect = (
          details: Electron.Event<Electron.WebContentsDidRedirectNavigationEventParams>
        ) => markCompletionIfMatched(details.url);
        const onDestroyed = () => finish({ error: "user closed sign-in window" });
        const timeoutId = setTimeout(() => finish({ error: "session capture timed out" }), timeout);

        session.fromPartition(getBrowserSessionPartition()).cookies.on("changed", onCookiesChanged);
        webContents.on("did-navigate", onNavigate);
        webContents.on("did-navigate-in-page", onNavigate);
        webContents.on("did-redirect-navigation", onRedirect);
        webContents.on("destroyed", onDestroyed);

        if (immediate && completionReached) {
          finish(immediate);
          return;
        }

        attemptCapture();
      });

      return captureResult;
    } finally {
      // Always close the panel on exit (success, timeout, or user close)
      await panelOrchestrator
        .closePanel(panel.id)
        .catch((error: unknown) =>
          console.warn(`[App] Failed to close captured panel ${panel.id}:`, error)
        );
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function applyReadyElectronLaunchEvent(event: AppAvailableEvent): Promise<boolean> {
  const appOrchestrator = applicationWindow.appOrchestrator;
  if (!appOrchestrator || !panelOrchestrator) {
    pendingReadyElectronLaunch = event;
    log.info(
      `[apps] Holding ready Electron host target until app and panel hosts are initialized: ${event.appId}`
    );
    return false;
  }
  const launchKey = electronHostTargetKey(event);
  if (appliedElectronHostTargetKey === launchKey) {
    return true;
  }
  const existing = electronHostTargetApplications.get(launchKey);
  if (existing) return existing;

  const application = electronHostTargetApplicationTail
    .catch(() => undefined)
    .then(async () => {
      if (appliedElectronHostTargetKey === launchKey) return true;
      // Panel-tree preparation and shell navigation are independent. The shell
      // reads the durable tree and subscribes to a replayable invalidation
      // snapshot, so preparation may populate panels before or after that read
      // without losing state. Do not hold the entire desktop behind worker or
      // storage latency encountered while preparing panels.
      const panelTreeInitialization = initializePanelTreeOnce("electron-host-ready", {
        callerId: event.appId,
        callerKind: "app",
      });
      log.info(`[apps] Applying ready Electron host target: ${event.appId}`);
      await appOrchestrator.applyAppAvailable(event);
      appliedElectronHostTargetKey = launchKey;
      appliedElectronHostAppId = event.appId;
      void panelTreeInitialization.catch(() => undefined);
      return true;
    });
  electronHostTargetApplications.set(launchKey, application);
  electronHostTargetApplicationTail = application.then(
    () => undefined,
    () => undefined
  );
  try {
    return await application;
  } finally {
    if (electronHostTargetApplications.get(launchKey) === application) {
      electronHostTargetApplications.delete(launchKey);
    }
  }
}

function electronHostTargetKey(event: AppAvailableEvent): string {
  return [
    event.appId,
    event.source,
    event.url,
    event.buildKey ?? "",
    event.effectiveVersion ?? "",
  ].join("\u001f");
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function isAppArtifactRoute(value: string): boolean {
  return value === "/_a" || value.startsWith("/_a/");
}

function resolveElectronAppArtifactRoute(route: string): string | null {
  if (!serverSession) return null;
  try {
    return resolveGatewayRouteUrl(serverSession.gatewayConfig.serverUrl, route);
  } catch (error) {
    log.warn(
      `[apps] Failed to resolve app artifact route ${route}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
}

function resolveElectronAppAvailablePayload(payload: unknown): unknown | null {
  const record = recordFromUnknown(payload);
  if (!record) return payload;
  const target = record["target"];
  if (target !== undefined && target !== "electron") return payload;
  if (target !== "electron") {
    log.warn("[apps] Ignoring app availability without an explicit Electron target");
    return null;
  }
  const artifactRoute =
    typeof record["artifactRoute"] === "string" && isAppArtifactRoute(record["artifactRoute"])
      ? record["artifactRoute"]
      : null;
  if (!artifactRoute) {
    log.warn("[apps] Ignoring Electron app availability without an app artifact route");
    return null;
  }
  const resolvedUrl = resolveElectronAppArtifactRoute(artifactRoute);
  if (!resolvedUrl) return null;
  const resolved: Record<string, unknown> = {
    ...record,
    url: resolvedUrl,
    artifactRoute,
  };
  const artifacts = record["artifacts"];
  if (Array.isArray(artifacts)) {
    resolved["artifacts"] = artifacts.map((artifact) => {
      const artifactRecord = recordFromUnknown(artifact);
      if (!artifactRecord) return artifact;
      const route = typeof artifactRecord["route"] === "string" ? artifactRecord["route"] : null;
      if (!route) return artifactRecord;
      const url = resolveElectronAppArtifactRoute(route);
      return url ? { ...artifactRecord, url } : artifactRecord;
    });
  }
  return resolved;
}

function electronHostTargetKeyFromPayload(payload: unknown): string | null {
  const record = recordFromUnknown(payload);
  if (!record) return null;
  if (record["target"] !== undefined && record["target"] !== "electron") return null;
  if (record["selectedForHost"] === false) return null;
  const appId = record["appId"];
  const source = record["source"];
  const url = record["url"];
  if (typeof appId !== "string" || typeof source !== "string" || typeof url !== "string") {
    return null;
  }
  return [
    appId,
    source,
    url,
    typeof record["buildKey"] === "string" ? record["buildKey"] : "",
    typeof record["effectiveVersion"] === "string" ? record["effectiveVersion"] : "",
  ].join("\u001f");
}

function shouldSyncElectronHostTargetForChange(change: ServerHostTargetChangeEvent): boolean {
  const payload = recordFromUnknown(change.payload);
  const target = payload?.["target"];
  if (target !== undefined && target !== "electron") return false;

  if (change.event === "apps:available") {
    const launchKey = electronHostTargetKeyFromPayload(change.payload);
    if (launchKey) return appliedElectronHostTargetKey !== launchKey;
    return appliedElectronHostTargetKey === null;
  }

  return appliedElectronHostTargetKey === null;
}

async function drainPendingReadyElectronLaunch(): Promise<void> {
  const appOrchestrator = applicationWindow.appOrchestrator;
  if (!pendingReadyElectronLaunch || !appOrchestrator) return;
  const event = pendingReadyElectronLaunch;
  const launchKey = electronHostTargetKey(event);
  if (appliedElectronHostTargetKey === launchKey) {
    pendingReadyElectronLaunch = null;
    return;
  }
  log.info(`[apps] Releasing held Electron host target: ${event.appId}`);
  await applyReadyElectronLaunchEvent(event);
  pendingReadyElectronLaunch = null;
}

function initializePanelTreeOnce(
  reason: string,
  caller?: import("./serverClient.js").ScopedServerCaller
): Promise<void> {
  if (panelTreeInitializationPromise) return panelTreeInitializationPromise;
  const orchestrator = panelOrchestrator;
  if (!orchestrator) return Promise.resolve();
  clearPanelInitializationFailure();
  log.info(`[panels] Initializing panel tree after ${reason}`);
  panelTreeInitializationPromise = orchestrator
    .initializePanelTree({ seedInitialPanels: !IS_HEADLESS_HOST }, caller)
    .then(() => clearPanelInitializationFailure())
    .catch((error) => {
      panelTreeInitializationPromise = null;
      const failure = recordPanelInitializationFailure(reason, error);
      console.error("[App] Failed to initialize panel tree:", error);
      eventService.emit("panel-initialization-error", {
        path: "",
        error: failure.message,
      });
      throw error;
    });
  return panelTreeInitializationPromise;
}

function stopElectronHostTargetLaunchLoop(): void {
  electronHostTargetSyncLoop?.stop();
  electronHostTargetSyncLoop = null;
}

type ElectronHostTargetSyncResult =
  | "adopted"
  | "blocked-by-approval"
  | "preparing"
  | "waiting-for-change"
  | "retry";

function rememberElectronHostLaunchStatus(
  status: string,
  launch: Record<string, unknown> | null
): boolean {
  const rawDetails = launch?.["details"];
  const details = Array.isArray(rawDetails) ? rawDetails.join("\n") : "";
  const key = [
    status,
    typeof launch?.["reason"] === "string" ? launch["reason"] : "",
    details,
    typeof launch?.["appId"] === "string" ? launch["appId"] : "",
    typeof launch?.["buildKey"] === "string" ? launch["buildKey"] : "",
    typeof launch?.["effectiveVersion"] === "string" ? launch["effectiveVersion"] : "",
  ].join("\u001f");
  if (electronHostLaunchLastStatusKey === key) return false;
  electronHostLaunchLastStatusKey = key;
  return true;
}

async function syncElectronHostTarget(
  serverClient: Pick<ServerClient, "call">
): Promise<ElectronHostTargetSyncResult> {
  try {
    const result = await new HostLaunchClient((service, method, args) =>
      serverClient.call(service, method, args)
    ).launch("electron");
    const launch = recordFromUnknown(result);
    const status = launch?.["status"] ?? null;
    if (status === "approval-required") {
      const statusChanged = rememberElectronHostLaunchStatus("approval-required", launch);
      if (!electronHostLaunchBlockedByApproval || statusChanged) {
        log.info("[apps] Electron host target launch is waiting for startup approval");
      }
      electronHostLaunchBlockedByApproval = true;
      return "blocked-by-approval";
    }
    if (status === "ready") {
      electronHostLaunchBlockedByApproval = false;
      rememberElectronHostLaunchStatus("ready", launch);
      return "adopted";
    }
    if (status === "preparing") {
      electronHostLaunchBlockedByApproval = false;
      if (rememberElectronHostLaunchStatus("preparing", launch)) {
        log.info("[apps] Electron host target is approved and preparing");
      }
      return "preparing";
    }
    electronHostLaunchBlockedByApproval = false;
    if (status !== "ready") {
      if (rememberElectronHostLaunchStatus("unavailable", launch)) {
        log.warn("[apps] No launchable Electron host target is selected");
      }
    }
    return "waiting-for-change";
  } catch (error) {
    if (isCleaningUp) return "waiting-for-change";
    log.warn(
      `[apps] Failed to synchronize Electron host target: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return "retry";
  }
}

function startElectronHostTargetLaunchLoop(serverClient: Pick<ServerClient, "call">): void {
  stopElectronHostTargetLaunchLoop();
  electronHostLaunchBlockedByApproval = false;
  electronHostLaunchLastStatusKey = null;
  electronHostTargetSyncLoop = new AsyncStateConvergenceLoop(
    () => syncElectronHostTarget(serverClient),
    (result) => result === "preparing" || result === "retry",
    1_000
  );
  electronHostTargetSyncLoop.start();
}

function retryElectronHostTargetLaunchAfterApprovalChange(pending: PendingApproval[]): void {
  if (!electronHostLaunchBlockedByApproval) return;
  if (filterBootstrapApprovalsForTarget(pending, "electron").length > 0) return;
  electronHostTargetSyncLoop?.request();
}

function retryElectronHostTargetLaunchAfterAppEvent(change: ServerHostTargetChangeEvent): void {
  if (!shouldSyncElectronHostTargetForChange(change)) return;
  electronHostTargetSyncLoop?.request();
}

type BootstrapWorkspaceEntry = { name: string; lastOpened: number };

type BootstrapConnectionState = {
  mode: "choose-connection" | "starting" | "connected" | "failed";
  connectionKind: "local" | "remote" | null;
  localWorkspaces: BootstrapWorkspaceEntry[];
  lastLocalWorkspaceName: string | null;
  isDev: boolean;
  /**
   * The `vibestudio://connect` link the app was opened with (deep link / argv), if
   * any — so the chooser can auto-pair instead of waiting for a paste+click.
   */
  pendingPairLink: string | null;
  pendingPairConfirmed: boolean;
  startupError: { message: string; detail?: string; logPath?: string } | null;
  serverLogPath: string | null;
  startupProgress: StartupConnectionProgress | null;
};

const WORKSPACE_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function requireBootstrapShellSender(event: Electron.IpcMainInvokeEvent, channel: string): void {
  const shellContents = applicationWindow.viewManager?.getShellWebContents();
  if (!shellContents || shellContents.isDestroyed() || shellContents.id !== event.sender.id) {
    console.warn(`[ipc] Rejecting ${channel} from non-bootstrap sender`);
    throw new Error(`Channel '${channel}' is bootstrap-shell-only`);
  }
}

function getBootstrapConnectionState(): BootstrapConnectionState {
  // The chooser is shown only while startup is still `pending`, nothing was
  // paired at launch, AND the user has not yet made an in-process choice. A
  // paired WebRTC remote (remotePairedAtLaunch) or a resolved chooser choice
  // (chooserChoiceMade) flips the launch gate forward to connect rather than
  // offering a choice.
  const mode = bootstrapStartupError
    ? "failed"
    : startupMode.kind === "pending" && !remotePairedAtLaunch && !chooserChoiceMade
      ? "choose-connection"
      : bootstrapWorkspaceRpcReady
        ? "connected"
        : "starting";
  // The deep link the app was opened with (room/fp/code/sig) — rebuilt so the
  // chooser can auto-pair. Peeked (non-draining) so a getState poll is idempotent.
  const pending = peekPendingConnectLink();
  const pendingPairLink = pending ? createConnectDeepLink(pending) : null;
  // Only the chooser reads localWorkspaces. The renderer polls getState every 500ms
  // while "starting", so computing the workspace scan on every tick is pure waste —
  // the poll only watches for the mode flip. Compute the heavy fields only when shown.
  if (mode !== "choose-connection" && mode !== "failed") {
    return {
      mode,
      connectionKind: bootstrapConnectionKind,
      localWorkspaces: [],
      lastLocalWorkspaceName: null,
      isDev: isDev(),
      pendingPairLink,
      pendingPairConfirmed: startupInvocation.pendingPairConfirmed,
      startupError: bootstrapStartupError,
      serverLogPath:
        bootstrapConnectionKind === "local" && startupMode.kind === "local"
          ? getLocalHubLogPath()
          : null,
      startupProgress: bootstrapStartupProgress,
    };
  }
  const localWorkspaces = centralData.listWorkspaces().map((entry) => ({
    name: entry.name,
    lastOpened: entry.lastOpened,
  }));
  return {
    mode,
    connectionKind: bootstrapConnectionKind,
    localWorkspaces,
    lastLocalWorkspaceName: centralData.getLastOpenedWorkspace()?.name ?? null,
    isDev: isDev(),
    pendingPairLink,
    pendingPairConfirmed: startupInvocation.pendingPairConfirmed,
    startupError: bootstrapStartupError,
    serverLogPath:
      bootstrapConnectionKind === "local" && startupMode.kind === "local"
        ? getLocalHubLogPath()
        : null,
    startupProgress: bootstrapStartupProgress,
  };
}

/**
 * Push the current bootstrap connection state to the launch-gate renderer.
 * Event-driven complement to the pull `get-state` IPC: the renderer applies
 * pushes immediately and keeps a slow poll only as a liveness fallback.
 */
function pushBootstrapConnectionState(): void {
  const shellContents = applicationWindow.viewManager?.getShellWebContents();
  if (!shellContents || shellContents.isDestroyed()) return;
  shellContents.send("vibestudio:bootstrap:state-changed", getBootstrapConnectionState());
}

function normalizeBootstrapWorkspaceName(rawName: unknown): string {
  if (typeof rawName !== "string" || rawName.trim().length === 0) {
    throw new Error("Workspace name is required");
  }
  const name = rawName.trim();
  if (!WORKSPACE_NAME_RE.test(name)) {
    throw new Error("Workspace name must contain only letters, numbers, hyphens, and underscores");
  }
  return name;
}

function installBootstrapConnectionHandlers(): void {
  ipcMain.handle("vibestudio:bootstrap:get-state", (event) => {
    requireBootstrapShellSender(event, "vibestudio:bootstrap:get-state");
    return getBootstrapConnectionState();
  });

  ipcMain.handle("vibestudio:bootstrap:retry-startup", (event) => {
    requireBootstrapShellSender(event, "vibestudio:bootstrap:retry-startup");
    relaunchWithIntent({
      args: retryWorkspaceIsEphemeral
        ? ephemeralWorkspaceRelaunchArgs()
        : retryWorkspaceName
          ? workspaceRelaunchArgs(retryWorkspaceName)
          : process.argv.slice(1),
    });
  });

  ipcMain.handle("vibestudio:bootstrap:choose-connection", (event) => {
    requireBootstrapShellSender(event, "vibestudio:bootstrap:choose-connection");
    relaunchWithIntent({
      args: [
        ...chooseConnectionRelaunchArgs().filter((arg) => arg !== SKIP_REMOTE_PAIRING_ARG),
        SKIP_REMOTE_PAIRING_ARG,
      ],
    });
  });

  ipcMain.handle("vibestudio:bootstrap:open-log", (event, rawPath: unknown) => {
    requireBootstrapShellSender(event, "vibestudio:bootstrap:open-log");
    const expectedPath =
      bootstrapStartupError?.logPath ??
      (bootstrapConnectionKind === "local" && startupMode.kind === "local"
        ? getLocalHubLogPath()
        : null);
    if (typeof rawPath !== "string" || !expectedPath) return;
    if (path.resolve(rawPath) !== path.resolve(expectedPath)) return;
    // Opening a file may outlive the bootstrap renderer: a successful startup
    // replaces that renderer while the OS opener is still pending. Reply now
    // and keep the host-owned action independent of that handoff.
    void shell
      .openPath(rawPath)
      .then((message) => {
        if (message) log.warn(`[bootstrap] Could not open server log: ${message}`);
      })
      .catch((error) => {
        log.warn(`[bootstrap] Could not open server log: ${formatUnknownError(error)}`);
      });
    return { ok: true };
  });

  // The chooser handlers resolve the in-process choice instead of relaunching.
  // The pending startup path (app.on("ready")) awaits `chooserChoice` and falls
  // through to the connected setup in the SAME process — no app.relaunch, no
  // throwaway exchange, no orphan windows.
  ipcMain.handle("vibestudio:bootstrap:launch-local-workspace", (event, workspaceName?: string) => {
    requireBootstrapShellSender(event, "vibestudio:bootstrap:launch-local-workspace");
    const name = normalizeBootstrapWorkspaceName(workspaceName);
    const knownWorkspaces = centralData.listWorkspaces();
    if (knownWorkspaces.length > 0 && !centralData.hasWorkspace(name)) {
      throw new Error(
        `No workspace named “${name}”. Choose an existing workspace; create new workspaces from the workspace manager.`
      );
    }
    log.info(`[bootstrap] Launching local workspace "${name}" by user request`);
    resolveChooserChoice({ kind: "local", name, ephemeral: false });
    return { ok: true };
  });

  ipcMain.handle("vibestudio:bootstrap:launch-ephemeral-workspace", (event) => {
    requireBootstrapShellSender(event, "vibestudio:bootstrap:launch-ephemeral-workspace");
    if (!isDev()) {
      throw new Error("Ephemeral workspaces are only available in development mode");
    }
    log.info(
      `[bootstrap] Launching hub-owned ephemeral dev workspace "${EPHEMERAL_DEV_WORKSPACE_NAME}" by user request`
    );
    resolveChooserChoice({
      kind: "local",
      name: EPHEMERAL_DEV_WORKSPACE_NAME,
      ephemeral: true,
    });
    return { ok: true };
  });

  ipcMain.handle("vibestudio:bootstrap:pair-remote", (event, payload: unknown) => {
    requireBootstrapShellSender(event, "vibestudio:bootstrap:pair-remote");
    const p = (payload ?? {}) as { link?: unknown };
    const link = typeof p.link === "string" ? p.link : "";
    const parsed = parseConnectLink(link);
    if (parsed.kind === "error") {
      return { ok: false, error: "invalid-url", message: parsed.reason };
    }
    // The bootstrap chooser is the owner of a launch-time deep link.  It peeks
    // at that link while rendering the confirmation card, so accepting the
    // card must consume the buffered intent before the hosted shell mounts.
    // Otherwise the hosted shell drains the same one-shot link and opens a
    // second Connections dialog over the already-connected workspace.
    getPendingConnectLink();
    // Hand the parsed pairing to the pending path; establishServerSession dials it
    // over WebRTC and KEEPS the pipe as the session (the one-time code authenticates
    // it; the issued device credential is persisted for the next launch).
    log.info("[bootstrap] Pairing remote server by user request; connecting in-process");
    resolveChooserChoice({ kind: "remote", pairing: parsed });
    return { ok: true };
  });
}

// =============================================================================
// App Lifecycle
// =============================================================================

app.on("ready", async () => {
  performance.mark("startup:ready");
  console.log(`[Perf] app ready at ${Math.round(process.uptime() * 1000)}ms uptime`);

  ipcMain.handle("vibestudio:drain-pair-link", (event) => {
    if (!canAccessIncomingPairLinks(event.sender.id)) {
      throw new Error("Incoming pairing links require app capability 'incoming-pair-links'");
    }
    return getPendingConnectLink();
  });
  ipcMain.handle("vibestudio:drain-panel-location", (event) => {
    if (!canAccessIncomingPanelLocations(event.sender.id)) {
      throw new Error("Incoming panel locations require the trusted host-chrome surface");
    }
    return getPendingPanelLocation();
  });
  ipcMain.handle("vibestudio:prepare-panel-location-relaunch", (event, location: unknown) => {
    if (!canAccessIncomingPanelLocations(event.sender.id)) {
      throw new Error("Panel-location relaunch requires the trusted host-chrome surface");
    }
    if (location === null) {
      panelLocationForWorkspaceRelaunch = null;
      return;
    }
    validatePanelLocation(location as PanelLocation);
    panelLocationForWorkspaceRelaunch = location as PanelLocation;
  });
  onConnectLink((link) => {
    if (IS_HEADLESS_HOST) return;
    sendIncomingPairLink(link);
    applicationWindow.showAndFocus();
  });
  onPanelLocation((location) => {
    if (IS_HEADLESS_HOST) return;
    sendIncomingPanelLocation(location);
    applicationWindow.showAndFocus();
  });
  // Surface deep links: while the shell is up, dispatch straight to it (and
  // consume the buffered copy so a later drain cannot replay it); a link that
  // arrived before the shell mounted is drained by the shell on mount via
  // `vibestudio:drain-shell-surface` and re-enters through `app.openShellSurface`.
  ipcMain.handle("vibestudio:drain-shell-surface", (event) => {
    if (!canAccessIncomingPanelLocations(event.sender.id)) {
      throw new Error("Incoming shell surfaces require the trusted host-chrome surface");
    }
    return getPendingShellSurface();
  });
  onShellSurface((target) => {
    if (IS_HEADLESS_HOST) return;
    // The shell subscribes to `navigate-about` on mount; once it has, it is
    // listening for every surface event and the live path is safe to take.
    if (eventService.getSubscriberCount("navigate-about") > 0) {
      getPendingShellSurface();
      dispatchShellSurface(target);
    }
    applicationWindow.showAndFocus();
  });
  // A deep link that failed to parse (e.g. a stale old-format link) used to open
  // the app and do nothing. Surface its actionable message instead so the user
  // knows to re-pair with a current link.
  const surfaceConnectLinkError = (reason: string) => {
    if (IS_HEADLESS_HOST) return;
    log.warn(`[pairing] Ignored an invalid pairing link: ${reason}`);
    applicationWindow.showAndFocus();
    if (Notification.isSupported()) {
      new Notification({ title: "Couldn't open that pairing link", body: reason }).show();
    }
  };
  onConnectLinkError(surfaceConnectLinkError);
  // Drain any error buffered before this listener registered (launch-time click).
  const bufferedLinkError = getPendingConnectLinkError();
  if (bufferedLinkError) surfaceConnectLinkError(bufferedLinkError);
  // Sleep/wake + screen-unlock recovery: a WebRTC pipe can be dead while the
  // transport still reports "connected" for up to ~45s after the machine wakes.
  // NUDGE ONLY (never a forced teardown): the transport probes the pipe and a
  // healthy one answers untouched; a dead one is torn down promptly so reconnect
  // kicks in. The loopback client has no nudge() (optional) and is skipped.
  const nudgeServerLiveness = (reason: string) => {
    const client = serverSession?.serverClient;
    if (client?.nudge) {
      log.info(`[recovery] nudging server pipe liveness after ${reason}`);
      client.nudge();
    }
  };
  powerMonitor.on("resume", () => {
    nudgeServerLiveness("system resume");
    npmUpdateController?.triggerIfStale("resume");
  });
  powerMonitor.on("unlock-screen", () => nudgeServerLiveness("screen unlock"));
  // Same recovery, awake path: the shell renderer forwards its `window` `online`
  // event so a network flap (e.g. Wi-Fi reassociate) probes the pipe promptly
  // instead of lingering on a stale "connected". NUDGE ONLY, never a teardown.
  ipcMain.on("vibestudio:shell.network-online", () => {
    nudgeServerLiveness("network online");
    npmUpdateController?.triggerIfStale("network");
  });
  ipcMain.on("vibestudio:shell.chrome-interactive-focus", (event, active: unknown) => {
    applicationWindow.viewManager?.setShellChromeInteractiveFocus(event.sender.id, active === true);
  });
  installBootstrapConnectionHandlers();
  npmUpdateController = createNpmUpdateController({
    eventService,
    ownsLocalHub: () =>
      serverSession?.serverOwnership === "desktop-local" &&
      serverSession.hubProcessManager !== null,
    requestUpdateQuit: (targetVersion) => {
      quitIntent = { kind: "npm-update", targetVersion };
      app.quit();
    },
  });

  // Default to browser CORS. For panel fetch/XHR responses, relax CORS only
  // after the trusted shell approval flow grants that panel access to the
  // target origin. Browser panels use their workspace browser-environment
  // partition and are unaffected.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    void authorizeCorsResponseAccess(details)
      .then(({ allowed, requestOrigin }) => {
        callback({
          responseHeaders:
            allowed && requestOrigin
              ? withCorsRelaxedHeaders(details.responseHeaders, requestOrigin)
              : details.responseHeaders,
        });
      })
      .catch((error: unknown) => {
        log.warn(
          `CORS header handling failed: ${error instanceof Error ? error.message : String(error)}`
        );
        callback({ responseHeaders: details.responseHeaders });
      });
  });

  // -------------------------------------------------------------------------
  // Default-deny permission handlers (audit finding #37 / 01-MEDIUM-4).
  //
  // Without these, Electron grants panel webContents the ability to request
  // geolocation, notifications, microphone, camera, mediaKeySystem, midi,
  // pointerLock, display-capture, etc. Browser panels load arbitrary external
  // URLs, so unknown/panel senders stay denied. App senders are allowed only
  // when their active app manifest declared the matching capability.
  // -------------------------------------------------------------------------
  const SENSITIVE_PERMISSIONS = new Set<string>([
    "geolocation",
    "notifications",
    "media",
    "mediaKeySystem",
    "midi",
    "midiSysex",
    "pointerLock",
    "fullscreen",
    "openExternal",
    "display-capture",
    "clipboard-read",
    "clipboard-sanitized-write",
  ]);

  const capabilityForElectronPermission = (
    permission: string
  ): import("@vibestudio/shared/unitManifest").AppCapability | null => {
    switch (permission) {
      case "notifications":
        return "notifications";
      case "openExternal":
        return "open-external";
      case "clipboard-read":
      case "clipboard-sanitized-write":
        return "clipboard";
      case "fullscreen":
      case "pointerLock":
      case "display-capture":
        return "window-management";
      default:
        return null;
    }
  };

  const appWebContentsHasPermissionCapability = (
    contents: WebContents | null | undefined,
    permission: string
  ): boolean => {
    const viewManager = applicationWindow.viewManager;
    if (!contents || !viewManager) return false;
    const capability = capabilityForElectronPermission(permission);
    if (!capability) return false;
    const viewId = viewManager.findViewIdByWebContentsId(contents.id);
    if (!viewId) return false;
    const viewInfo = viewManager.getViewInfo(viewId);
    return viewInfo?.type === "app" && viewInfo.capabilities.includes(capability);
  };

  const webContentsMayUseSensitivePermission = (
    contents: WebContents | null | undefined,
    permission: string
  ): boolean => {
    const viewManager = applicationWindow.viewManager;
    if (!contents || !viewManager) return false;
    const viewId = viewManager.findViewIdByWebContentsId(contents.id);
    // Keep the request and check handlers consistent: Chromium may consult the
    // check handler before it reaches the request handler.
    if (
      permission === "fullscreen" &&
      viewId &&
      activeBrowserSessionPartition &&
      viewManager.getViewPartition(viewId) === activeBrowserSessionPartition
    ) {
      return true;
    }
    return appWebContentsHasPermissionCapability(contents, permission);
  };

  const installPermissionHandlers = (targetSession: Session): void => {
    targetSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      if (SENSITIVE_PERMISSIONS.has(permission)) {
        if (
          browserPermissionController &&
          (permission === "media" ||
            permission === "geolocation" ||
            permission === "notifications" ||
            permission === "clipboard-read" ||
            permission === "clipboard-sanitized-write")
        ) {
          browserPermissionController.requestPermission(contents, permission, callback, details);
          return;
        }
        const viewManager = applicationWindow.viewManager;
        const viewId = contents ? viewManager?.findViewIdByWebContentsId(contents.id) : null;
        const viewInfo = viewId ? viewManager?.getViewInfo(viewId) : null;
        // Native fullscreen is a reversible presentation action and is expected
        // to work for videos in ordinary browser panels.
        if (webContentsMayUseSensitivePermission(contents, permission)) {
          callback(true);
          return;
        }
        console.warn(`[permissions] denied request for '${permission}'`);
        const label = permission === "media" ? "Camera or microphone" : permission;
        eventService.emit("notification:show", {
          id: `permission-blocked:${viewId ?? "unknown"}:${permission}`,
          type: "warning",
          title: `${label} access blocked`,
          message: `This ${viewInfo?.type ?? "panel"} is not allowed to use ${label.toLowerCase()}.`,
          ttl: 8_000,
        });
        callback(false);
        return;
      }
      // Permissive default for non-sensitive permissions (clipboard read/etc.)
      callback(true);
    });
    targetSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
      if (SENSITIVE_PERMISSIONS.has(permission)) {
        if (
          browserPermissionController &&
          (permission === "media" ||
            permission === "geolocation" ||
            permission === "notifications" ||
            permission === "clipboard-read" ||
            permission === "clipboard-sanitized-write")
        ) {
          return browserPermissionController.checkPermission(
            contents,
            permission,
            requestingOrigin,
            details
          );
        }
        return webContentsMayUseSensitivePermission(contents, permission);
      }
      return true;
    });
  };

  // Apply to default session up-front, and to every session created later
  // (panel partitions, persist:browser, etc.) via the session-created hook.
  installPermissionHandlers(session.defaultSession);
  app.on("session-created", (s) => {
    try {
      installPermissionHandlers(s);
    } catch (err) {
      console.warn(
        `[permissions] failed to install handlers on session: ${(err as Error).message}`
      );
    }
  });

  // A saved remote is resumed only for an ordinary interactive "continue where
  // I left off" launch. Development's ephemeral default, an explicit workspace,
  // a headless host, a pairing link, and the chooser are authoritative intents:
  // credential-store state must not silently replace any of them.
  const skipRemotePairingLaunch = startupInvocation.skipRemotePairing;
  const shouldResumeSavedRemote =
    startupMode.kind === "local" &&
    startupMode.connectionIntent === "resume-saved-remote" &&
    !skipRemotePairingLaunch;
  const storedRemoteAtLaunch = shouldResumeSavedRemote ? loadStoredRemotePairing() : null;
  remotePairedAtLaunch = storedRemoteAtLaunch !== null;
  bootstrapConnectionKind = remotePairedAtLaunch
    ? "remote"
    : startupMode.kind === "local"
      ? "local"
      : null;

  // A FRESH pairing the chooser redeems THIS launch (set from a remote choice
  // below). When present, establishServerSession keeps its WebRTC pipe as the
  // session rather than spawning a local server or re-dialing a stored pairing.
  let pendingRemotePairing: ConnectPairing | null = null;

  if (startupMode.kind === "pending" && !remotePairedAtLaunch) {
    const devAutoPairing = shouldAutoPairPendingDevWebRtcLink() ? getPendingConnectLink() : null;
    if (devAutoPairing) {
      resolveChooserChoice({ kind: "remote", pairing: devAutoPairing });
      log.info("[bootstrap] Dev WebRTC remote mode: auto-pairing launch deep link");
    } else if (shouldAutoPairPendingDevWebRtcLink()) {
      log.warn(
        "[bootstrap] Dev WebRTC remote mode requested but no pending pairing link was found"
      );
    } else if (IS_HEADLESS_HOST) {
      // No chooser UI on a headless host and nothing paired to connect to —
      // stay alive (a supervisor can pair a remote or select a workspace and
      // restart) rather than opening a window nothing can drive.
      log.error(
        "[headless] No workspace selected and no remote server paired. Pair a server over " +
          "WebRTC or select a workspace, then restart the headless host."
      );
      return;
    }
    // Show the chooser, then AWAIT the user's choice in-process. Instead of
    // relaunching, we apply the choice and fall through to the connected setup
    // below in the SAME process.
    performance.mark("startup:window-created");
    applicationWindow.create();
    const choice = await chooserChoice;
    if (choice.kind === "local") {
      bootstrapConnectionKind = "local";
      // Resolve (creating if missing) the chosen local workspace in-process and
      // promote `startupMode` to local so the connected setup spawns its server.
      retryWorkspaceName = choice.name;
      retryWorkspaceIsEphemeral = choice.ephemeral;
      if (choice.ephemeral) {
        startupMode = resolveEphemeralDevStartupMode();
        workspaceId = startupMode.workspaceId;
        log.info(`[bootstrap] Ephemeral workspace chosen: ${workspaceId}`);
      } else {
        try {
          startupMode = resolveLocalStartupMode(centralData, choice.name, "local", true);
        } catch (error) {
          bootstrapWorkspaceRpcReady = false;
          bootstrapStartupError = {
            message: `Could not open workspace “${choice.name}”: ${
              error instanceof Error ? error.message : String(error)
            }`,
            detail: formatUnknownError(error),
          };
          pushBootstrapConnectionState();
          return;
        }
        workspaceId = startupMode.workspaceId;
        log.info(`[bootstrap] Local workspace chosen: ${workspaceId} (${startupMode.wsDir})`);
      }
    } else {
      // Remote: leave startupMode pending; the fresh pairing becomes the session.
      bootstrapConnectionKind = "remote";
      pendingRemotePairing = choice.pairing;
      log.info("[bootstrap] Remote server chosen; pairing the session over WebRTC");
    }
    // Fall through to the connected setup.
  }

  // Idempotent: the chooser path already created the window; create it here for
  // the returning-device / direct-local startups that skip the chooser.
  if (!IS_HEADLESS_HOST && !applicationWindow.isOpen) {
    performance.mark("startup:window-created");
    applicationWindow.create();
  }

  const dispatcher = new ServiceDispatcher();
  dispatcher.setAuthorityResolver(({ caller, capability, resourceKey, tier }) =>
    authorizeVerifiedCaller(caller, {
      workspaceId,
      workspaceMember: true,
      sessionId: `electron-main:${workspaceId}`,
      audience: "electron-main-services",
      capability,
      resourceKey,
      tier,
    })
  );

  const codeIdentityForView = (callerId: string) => {
    const viewInfo = applicationWindow.viewManager?.getViewInfo(callerId);
    if (viewInfo?.type !== "app" && viewInfo?.type !== "panel") return null;
    const identity = viewInfo.codeIdentity;
    if (
      !identity?.source ||
      !identity.effectiveVersion ||
      !identity.executionDigest ||
      !identity.requested
    ) {
      return null;
    }
    return {
      callerId,
      callerKind: viewInfo.type,
      repoPath: identity.source,
      effectiveVersion: identity.effectiveVersion,
      executionDigest: identity.executionDigest,
      requested: identity.requested,
    } as const;
  };

  performance.mark("startup:services-registered");

  let serverClientRef: import("./serverClient.js").ServerClient | null = null;
  const recoverShellStateFromServer = async (_kind: "resubscribe" | "cold-recover") => {
    await serverEventSubscriptions.recover();
    if (recoveredLocalServerCrash) {
      eventService.emit("notification:show", {
        id: "local-server-crash-recovered",
        type: "warning",
        title: "Workspace server recovered",
        message: `The local server stopped unexpectedly (code ${recoveredLocalServerCrash}) and was restarted. Your workspace is available again.`,
        ttl: 0,
      });
    }
    // Catch up on approvals that arrived while the event stream was down.
    void approvalAttention?.refresh();
    if (!panelOrchestrator) return;
    await panelOrchestrator
      .recoverShellSnapshot({ loadFocusedView: false })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`[recovery] shell snapshot failed: ${msg}`);
      });
  };

  if (!IS_HEADLESS_HOST) {
    approvalAttention = createApprovalAttention({
      getWindow: () => applicationWindow.window,
      listPending: async () => {
        const client = serverClientRef;
        if (!client) return null;
        return (await client.call("shellApproval", "listPending", [])) as PendingApproval[];
      },
      log,
    });
  }

  const handleAttentionRequired = (title: string, message: string) => {
    const focusWindow = () => applicationWindow.showAndFocus();
    applicationWindow.requestAttention();
    app.setBadgeCount(1);
    if (Notification.isSupported()) {
      const nativeNotification = new Notification({
        title,
        body: message,
        urgency: "critical",
      });
      nativeNotification.on("click", focusWindow);
      nativeNotification.show();
    }
  };
  const handleWorkspaceRoute = (
    route: import("@vibestudio/service-schemas/hubControl").HubWorkspaceRoute
  ) => {
    const name = route.workspace;
    try {
      persistStoredRemoteWorkspaceRoute(route);
      log.info(`[App] Relaunching into workspace "${name}"`);
      const args = workspaceRelaunchArgs(name);
      const location = panelLocationForWorkspaceRelaunch;
      panelLocationForWorkspaceRelaunch = null;
      if (location?.workspace === name) {
        args.push(createPanelDeepLink(location));
      } else if (location) {
        log.warn(
          `[App] Dropping stale panel-location relaunch for "${location.workspace ?? "unknown"}" while switching to "${name}"`
        );
      }
      relaunchWithIntent({ args });
    } catch (error) {
      panelLocationForWorkspaceRelaunch = null;
      log.error(
        `[App] Refusing workspace relaunch before its route is durable: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  };
  const handleServerEvent = createServerEventBridge({
    eventService,
    getPanelOrchestrator: () => panelOrchestrator,
    applyAppAvailable: applyReadyElectronLaunchEvent,
    getServerClient: () => serverClientRef,
    openExternal: (url) => shell.openExternal(url),
    warn: (message) => log.warn(message),
    notifyError: (title, message) => {
      eventService.emit("notification:show", {
        id: `oauth-handoff-error-${Date.now()}`,
        type: "error",
        title,
        message,
        ttl: 0,
      });
    },
    onAttentionRequired: handleAttentionRequired,
    onAppHostTargetChanged: retryElectronHostTargetLaunchAfterAppEvent,
    onPanelTreeInvalidated: (event) => {
      latestPanelTreeInvalidation = event;
    },
    resolveAppAvailableEvent: resolveElectronAppAvailablePayload,
    onApprovalPendingChanged: (pending) => {
      approvalAttention?.handlePendingChanged(pending);
      retryElectronHostTargetLaunchAfterApprovalChange(pending);
    },
    onCredentialCaptureRequest: (payload) =>
      handleCredentialSessionCaptureRequest(payload as CredentialSessionCaptureRequest),
    onNotificationAction: async (_id, actionId) => {
      websiteNotificationBridge?.handleAction(_id, actionId);
      if (actionId === "desktop-npm-update-install") {
        if (!npmUpdateController) throw new Error("The npm updater is unavailable");
        await npmUpdateController.requestInstall().catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          eventService.emit("notification:show", {
            id: "desktop-npm-update-action-error",
            type: "error",
            title: "Vibestudio update could not start",
            message,
            ttl: 0,
          });
          throw error;
        });
      } else if (actionId === "desktop-npm-update-copy") {
        if (npmUpdateController) npmUpdateController.copyUpdateCommand();
        else copyPendingNpmUpdateCommand();
      } else if (actionId === "desktop-npm-update-copy-result") {
        copyPendingNpmUpdateCommand();
      } else if (actionId.startsWith("oauth-cancel:")) {
        const transactionId = actionId.slice("oauth-cancel:".length);
        const client = serverClientRef;
        if (!client) throw new Error("The server connection is unavailable");
        await client.call("credentials", "cancelOAuth", [{ transactionId }]);
      }
    },
  });
  const serverEventSubscriptions = createServerEventSubscriptionBridge({
    getServerClient: () => serverClientRef,
    onEvent: handleServerEvent,
    log,
  });

  try {
    performance.mark("startup:server-spawn-begin");

    // Emit a synthetic "connecting" sample so the connection badge has a
    // state to render from the very first frame (rather than flickering
    // from empty → connected). This mirrors what ServerClient's own
    // onConnectionStatusChanged callback will emit a few moments later
    // once the WS lifecycle begins.
    const remoteHost = !skipRemotePairingLaunch ? storedRemoteAtLaunch?.workspaceName : undefined;
    const isRemoteSession = pendingRemotePairing !== null || remotePairedAtLaunch;
    pushBootstrapConnectionState();

    eventService.emit("server-connection-changed", {
      status: "connecting",
      isRemote: isRemoteSession,
      remoteHost,
    });

    // null mode = no local spawn; establishServerSession connects either the
    // fresh pairing (pendingRemotePairing) or a stored pairing over WebRTC.
    const connectedStartupMode: ConnectedStartupMode | null =
      startupMode.kind === "local" ? startupMode : null;
    const establish = (mode: ConnectedStartupMode | null) =>
      establishServerSession({
        mode,
        confirmExistingLocalHub: async (lease) => {
          const { response } = await dialog.showMessageBox({
            type: "question",
            buttons: ["Start fresh", "Connect to existing", "Cancel"],
            defaultId: mode?.isEphemeral ? 0 : 1,
            cancelId: 2,
            title: "A Vibestudio server is already running",
            message: "Choose which local server this session should use.",
            detail:
              `A detached Vibestudio hub is already running (PID ${lease.pid}, ` +
              `port ${lease.gatewayPort}). Connecting to it may reuse its workspace ` +
              "and loaded builds. Start fresh to terminate its complete process tree.",
          });
          if (response === 0) return "replace";
          if (response === 1) return "attach";
          return "cancel";
        },
        onStartupProgress: (progress) => {
          bootstrapStartupProgress = progress;
          pushBootstrapConnectionState();
        },
        pendingPairing: pendingRemotePairing ?? undefined,
        pendingPairLabel: readPendingPairLabel(),
        storedRemote: storedRemoteAtLaunch ?? undefined,
        centralData,
        onMainSessionTerminalClose: (error) => {
          const message = error.message || "The paired server ended this session.";
          eventService.emit("server-connection-changed", {
            status: "disconnected",
            isRemote: true,
            remoteHost,
          });
          eventService.emit("notification:show", {
            id: "remote-main-session-ended",
            type: "error",
            title: "Paired server session ended",
            message: `${message} Re-pair this device or relaunch Vibestudio.`,
            ttl: 0,
          });
        },
        onConnectionStatusChanged: (status) => {
          // The selected ICE path (host/srflx/prflx = direct, relay = TURN) is
          // additive observability the WebRTC ServerClient exposes; the loopback
          // WS client has no `candidateType()`, so read it defensively. `null`
          // (unknown / not settled / local) omits the hint from the badge.
          const withCandidate = serverClientRef as {
            candidateType?: () => "host" | "srflx" | "prflx" | "relay" | null;
          } | null;
          const candidateType =
            typeof withCandidate?.candidateType === "function"
              ? (withCandidate.candidateType() ?? undefined)
              : undefined;
          eventService.emit("server-connection-changed", {
            status,
            isRemote: isRemoteSession,
            remoteHost,
            ...(candidateType ? { candidateType } : {}),
          });
          if (status === "disconnected") {
            for (const entry of panelRegistry?.listPanels() ?? []) {
              const wc = applicationWindow.viewManager?.getWebContents(entry.panelId);
              if (wc && !wc.isDestroyed()) {
                wc.send("vibestudio:event", "runtime:connection-error", {
                  code: 1006,
                  reason:
                    "The workspace server connection closed. Reconnect, then retry this panel.",
                  source: "server",
                });
              }
            }
          }
        },
        onReconnectProgress: (progress) => {
          eventService.emit("server-connection-changed", {
            status: "connecting",
            isRemote: true,
            remoteHost,
            reconnect: progress,
          });
        },
        onRecovery: (kind) => {
          // Panel sessions share the recovered host transport, but each panel
          // owns its own durable subscriptions and replay cursors. Tell every
          // live panel to replace those subscriptions and catch up; recovering
          // only the shell leaves a long-lived panel half-connected.
          for (const entry of panelRegistry?.listPanels() ?? []) {
            const wc = applicationWindow.viewManager?.getWebContents(entry.panelId);
            if (wc && !wc.isDestroyed()) {
              wc.send("vibestudio:rpc:recovery", kind);
            }
          }
          void recoverShellStateFromServer(kind).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn(`[recovery] ${kind} failed: ${msg}`);
          });
        },
      });

    // Phase 1: Establish server session (spawn the local child server)
    try {
      serverSession = await establish(connectedStartupMode);
    } catch (error) {
      if (remotePairedAtLaunch) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn(`[remote] establish failed during a paired launch: ${message}`);
        // Drop the stored pairing only if it was terminally rejected. The outer
        // startup recovery handler keeps the bootstrap window open with the
        // reason and explicit Retry / choose-another-workspace actions.
        if (isTerminalRemoteCredentialFailure(error)) clearStoredRemotePairing();
      }
      throw error;
    }
    serverClientRef = serverSession.serverClient;
    bindHostDirectServerEvents(serverClientRef, handleServerEvent);
    if (!IS_HEADLESS_HOST || IS_DEVELOPMENT_CLIENT_EXECUTOR) {
      const { CurrentHostDevelopmentClientExecutor } =
        await import("./currentHostDevelopmentClientExecutor.js");
      currentHostDevelopmentExecutor = new CurrentHostDevelopmentClientExecutor({
        client: serverClientRef,
        stateRoot: path.join(app.getPath("userData"), "development-clients"),
        log: (message) => log.warn(message),
      });
      serverClientRef.onDirectEvent("development:client-launch-request", (payload) => {
        void currentHostDevelopmentExecutor?.handleLaunchRequest(payload);
      });
      serverClientRef.onDirectEvent("development:client-stop-request", (payload) => {
        void currentHostDevelopmentExecutor?.handleStopRequest(payload);
      });
      await currentHostDevelopmentExecutor.start().catch((error: unknown) => {
        log.warn(`[development] current-device executor unavailable: ${formatUnknownError(error)}`);
        currentHostDevelopmentExecutor = null;
      });
      const developmentLaunchRequest = process.env["VIBESTUDIO_DEVELOPMENT_LAUNCH_REQUEST"];
      if (developmentLaunchRequest) {
        await serverClientRef.call("developmentClientExecutor", "attest", [
          { requestId: developmentLaunchRequest },
        ]);
      }
    }
    await serverEventSubscriptions.retainAll([
      "build:complete",
      "apps:available",
      "apps:status",
      "extensions:status",
      "external-open:open",
      "browser-panel:open",
      "panel-tree-invalidated",
      "panel-presentation-changed",
      "panel:runtimeLeaseChanged",
      "shell-approval:pending-changed",
      "credential:capture-request",
      "notification:action",
      "development:client-launch-request",
      "development:client-stop-request",
    ]);
    // Seed badge/seen-set from approvals already pending at launch without
    // firing OS notifications for them — the bar shows them once the shell
    // window is up.
    void approvalAttention?.refresh({ quiet: true });
    workspaceId = serverSession.workspaceId;

    if (IS_DEVELOPMENT_CLIENT_EXECUTOR) {
      bootstrapWorkspaceRpcReady = true;
      log.info(
        `[development] executor-only client ready for workspace ${workspaceId}; presentation startup skipped`
      );
      return;
    }

    performance.mark("startup:server-spawned");
    performance.mark("startup:server-connected");

    applicationWindow.setTitle(`Vibestudio — ${workspaceId}`);

    // The shell always spawns its own loopback server (ServerProcessManager
    // manages its lifecycle), so there is no out-of-process server to /healthz-
    // poll. Remote topology is WebRTC, whose own liveness lives in the transport.

    // Create PanelRegistry (pure in-memory — server owns persistence). Its
    // debounced projection notification is the Electron-local presentation
    // signal; the server's lifecycle observer must not be re-entered merely to
    // tell hosted chrome that a native view finished loading.
    let forwardPanelProjectionChange = (
      _payload: import("@vibestudio/shared/events").EventPayloads["panel-presentation-changed"]
    ): void => {};
    panelRegistry = new PanelRegistry({
      onPresentationUpdated: (update) => forwardPanelProjectionChange(update),
    });

    const { createElectronShellCore } = await import("./shellCore/createElectronShellCore.js");
    shellCore = createElectronShellCore({
      workspaceId: serverSession.workspaceId,
      workspacePath: serverSession.workspacePath,
      // A LOCAL server owns the workspace tree on this host (manifests present, so
      // fail loud on a genuinely-missing one). A REMOTE server owns the tree on the
      // other host, so the local manifest resolve misses at bootstrap — tolerate
      // that rather than hard-failing the whole startup.
      allowMissingManifests: remotePairedAtLaunch || pendingRemotePairing !== null,
      registry: panelRegistry,
      serverClient: serverSession.serverClient,
      gatewayConfig: serverSession.gatewayConfig,
      workspaceConfig: serverSession.workspaceConfig,
    });

    // PanelHttpServer is created by serverSession (RPC-backed proxy)
    const conn = assertPresent(serverSession);

    // Create IpcDispatcher (replaces Electron-side RpcServer for shell)
    // Forwards server-service calls to the server, dispatches Electron-local
    // services to the local dispatcher.
    const { IpcDispatcher } = await import("./ipcDispatcher.js");
    const ipcDispatcher = new IpcDispatcher({
      dispatcher,
      serverClient: conn.serverClient,
      getShellWebContents: () => {
        const viewManager = applicationWindow.viewManager;
        return (
          viewManager?.getHostedShellWebContents() ?? viewManager?.getShellWebContents() ?? null
        );
      },
      resolveCallerForWebContents: (webContentsId) => {
        const viewManager = applicationWindow.viewManager;
        if (!viewManager) return null;
        const shellContents = viewManager.getShellWebContents();
        if (shellContents && !shellContents.isDestroyed() && shellContents.id === webContentsId) {
          return { callerId: "shell", callerKind: "shell" };
        }
        const callerId = viewManager.findViewIdByWebContentsId(webContentsId);
        if (!callerId) return null;
        const viewInfo = viewManager.getViewInfo(callerId);
        return resolveElectronViewCaller(callerId, viewInfo);
      },
      getCodeIdentityForCaller: codeIdentityForView,
      getWebContentsForCaller: (callerId) =>
        applicationWindow.viewManager?.getWebContents(callerId) ?? null,
      getPanelRuntimeConnection: (panelId) => panelOrchestrator?.getPanelRuntimeConnection(panelId),
      authorizeAppServerCall,
    });
    forwardPanelProjectionChange = (payload) => {
      ipcDispatcher.sendEventToShell("panel-presentation-changed", payload);
    };
    // Account- and caller-addressed events arrive on the authenticated server
    // session, independently of the response-owned server watch. Preserve that
    // addressing across Electron IPC; the renderer binds them with rpc.on().
    for (const event of [
      "user-notifications-changed",
      "notification:show",
      "notification:dismiss",
    ] as const) {
      conn.serverClient.onDirectEvent(event, (payload) => {
        const attention = notificationAttention(event, payload);
        if (attention) handleAttentionRequired(attention.title, attention.message);
        ipcDispatcher.sendEventToShell(event, payload);
      });
    }
    log.info(`[PanelHTTP] Using server's panel HTTP via gateway port ${conn.gatewayPort}`);

    const gatewayBasePath = (() => {
      const pathname = new URL(conn.gatewayConfig.serverUrl).pathname.replace(/\/+$/, "");
      return pathname === "/" ? "" : pathname;
    })();

    // A workspace selected in-process cannot safely repoint Electron's userData
    // directory, so derive the pin path from the resolved workspace itself.
    const clientLocalStateDir =
      startupMode.kind === "local"
        ? path.join(startupMode.wsDir, "state")
        : app.getPath("userData");
    const panelPinStore = IS_HEADLESS_HOST
      ? undefined
      : new PanelPinStore(path.join(clientLocalStateDir, "panel-pins.json"));

    // Create PanelOrchestrator
    panelOrchestrator = new PanelOrchestrator({
      registry: panelRegistry,
      eventService,
      serverClient: conn.serverClient,
      shellCore: shellCore.panelManager,
      cdpHost: createCdpRegistrationAdapter(),
      getPanelView: () => applicationWindow.panelView,
      panelHttpServer: conn.panelHttpServer,
      externalHost: conn.externalHost,
      protocol: conn.protocol,
      gatewayPort: conn.gatewayPort,
      gatewayBasePath,
      waitForBrowserSessionPartition: () => browserEnvironmentReadiness.wait(),
      sendPanelEvent: (panelId, event, payload) => {
        const wc = applicationWindow.viewManager?.getWebContents(panelId);
        if (wc && !wc.isDestroyed()) {
          wc.send("vibestudio:event", event, payload);
        }
      },
      workspaceConfig: conn.workspaceConfig,
      pinStore: panelPinStore,
      // Resident-set GC protection (§5.3) follows shell-declared presentation
      // demand, including the interval before native attachment commits.
      getResidentPanelIds: () => applicationWindow.viewManager?.getDeclaredPanelSlotIds() ?? [],
      getNativeBinding: (panelId) =>
        applicationWindow.viewManager?.getNativePanelSlotBinding(panelId) ?? null,
      attachNativeBinding: (panelId) =>
        applicationWindow.viewManager?.attachDeclaredPanelSlot(panelId) ?? null,
      publishPresentation: (snapshot) => {
        ipcDispatcher.sendEventToShell("panel-local-presentation-changed", snapshot);
      },
      runtimeClient: IS_HEADLESS_HOST
        ? {
            label: "Headless",
            platform: "headless",
            supportsCdp: true,
            loadOnLeaseAssignment: true,
            restorePolicy: "none",
          }
        : {
            label: "Desktop",
            platform: "desktop",
            supportsCdp: true,
            loadOnLeaseAssignment: true,
            maxAssignedPanelViews: PANEL_UI_MAX_LOADED_DESKTOP,
            uiIdleUnloadMs: PANEL_UI_IDLE_UNLOAD_MS,
          },
    });

    await panelOrchestrator.registerRuntimeClient();
    if (IS_HEADLESS_HOST) {
      await initializePanelTreeOnce("panel-orchestrator-ready");
    } else if (pendingReadyElectronLaunch) {
      await drainPendingReadyElectronLaunch();
    } else if (appliedElectronHostAppId) {
      await initializePanelTreeOnce("panel-orchestrator-ready", {
        callerId: appliedElectronHostAppId,
        callerKind: "app",
      });
    }

    // Batch panel warn/error + lifecycle diagnostics into `panelLog.append`
    // so panel failures land in the server's per-unit diagnostics store
    // (queryable by workspace agents). Best-effort: drops on send failure.
    const panelLogClient = createTypedServiceClient("panelLog", panelLogMethods, (svc, m, a) =>
      conn.serverClient.call(svc, m, a)
    );
    const panelLogQueue: import("@vibestudio/service-schemas/panelLog").PanelLogRecord[] = [];
    let panelLogFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushPanelLog = () => {
      panelLogFlushTimer = null;
      const batch = panelLogQueue.splice(0, panelLogQueue.length);
      if (batch.length === 0) return;
      void panelLogClient
        .append(batch)
        .catch((error: unknown) =>
          console.warn("[App] Failed to persist panel diagnostics:", error)
        );
    };
    const forwardPanelDiagnostic = (
      panelId: string,
      entry: import("./cdpHostProvider.js").PanelConsoleHistoryEntry
    ) => {
      const panel = panelRegistry?.getPanel(panelId);
      if (!panel) return;
      const rawSource = getPanelSource(panel);
      // Browser panels aren't workspace units; their console isn't unit health.
      if (rawSource.startsWith("browser:")) return;
      const unitSource = rawSource.split(/[?#]/)[0];
      if (!unitSource) return;
      panelLogQueue.push({
        unitSource,
        panelId,
        timestamp: entry.timestamp,
        level:
          entry.level === "warning" ? "warn" : entry.level === "unknown" ? "info" : entry.level,
        message: entry.message,
        source: entry.source === "lifecycle" ? "lifecycle" : "console",
        fields: entry.fields,
        url: entry.url || undefined,
        line: entry.line || undefined,
      });
      if (panelLogQueue.length >= 50) {
        if (panelLogFlushTimer) clearTimeout(panelLogFlushTimer);
        flushPanelLog();
      } else if (!panelLogFlushTimer) {
        panelLogFlushTimer = setTimeout(flushPanelLog, 500);
      }
    };

    const cdpHostConnectionId = panelOrchestrator.getRuntimeClientSessionId();
    cdpHostProvider = new CdpHostProvider({
      serverUrl: conn.gatewayConfig.serverUrl,
      transport:
        conn.connectionMode === "remote"
          ? {
              kind: "preauthenticated",
              createSocket: () =>
                new RemoteCdpHostProviderSocket({
                  serverClient: conn.serverClient,
                  hostConnectionId: cdpHostConnectionId,
                }),
            }
          : {
              kind: "authenticated-websocket",
              authToken: () => conn.getCdpAuthToken(),
            },
      hostConnectionId: cdpHostConnectionId,
      getViewManager: () => applicationWindow.viewManager,
      diagnosticsStore: new RuntimeDiagnosticsStore({
        statePath: serverSession.statePath,
      }),
      forwardDiagnostic: forwardPanelDiagnostic,
      onHostCommand: async (panelId, action) => {
        if (action === "rebuildPanel") {
          return panelOrchestrator?.rebuildPanel(panelId) ?? null;
        }
        if (action === "reloadPanel") {
          return panelOrchestrator?.reloadPanel(panelId) ?? null;
        }
        // navigatePanel / navigatePanelHistory host commands were removed: the
        // server is the sole panel-tree writer (panelManager.navigate /
        // navigateHistory) and broadcasts; the desktop reloads views reactively
        // (panel-tree invalidation reconcile).
        if (action === "panelObservation") {
          if (!cdpHostProvider) throw new Error("CDP host provider not initialized");
          if (!panelOrchestrator) throw new Error("Panel orchestrator not initialized");
          const { observeDesktopPanelHost } = await import("./panelHostObservation.js");
          return observeDesktopPanelHost(
            {
              getBootObservation: (id) => cdpHostProvider!.getBootObservation(id),
              getPanelHostObservation: (id, boot) =>
                panelOrchestrator!.getPanelHostObservation(id, boot),
            },
            panelId
          );
        }
        throw new Error(`Unknown host command: ${action}`);
      },
    });
    cdpHostProvider.start();

    // Set up test API for E2E testing (only when VIBESTUDIO_TEST_MODE=1)
    setupTestApi(panelOrchestrator, panelRegistry, null);
    setMenuPanelLifecycle(panelOrchestrator);
    setMenuPanelRegistry(panelRegistry);
    setMenuEventService(eventService);

    const adBlockManager = new AdBlockManager();
    deferredStartupWork = () => {
      npmUpdateController?.start();
      if (!npmUpdateResultConsumed) {
        npmUpdateResultConsumed = true;
        consumeNpmUpdateResult(eventService);
      }

      // These are useful background services, but neither belongs on the path
      // to the first usable workspace frame.
      setTimeout(async () => {
        try {
          await adBlockManager.initialize();
          console.log("[AdBlock] Initialized for active browser environments");
        } catch (error) {
          console.warn("[AdBlock] Failed to initialize (non-fatal):", error);
        }
      }, 100);
    };

    // Autofill manager — password auto-fill for browser panels
    const { FormFillManager } = await import("./autofill/formFillManager.js");

    // Register all Electron-main RPC services via ServiceContainer. Window-owned
    // hosts are resolved from their lifecycle owner when an RPC is invoked.
    const getPanelView = (): PanelView => {
      const panelView = applicationWindow.panelView;
      if (!panelView) throw new Error("PanelView not initialized yet");
      return panelView;
    };
    const getViewManager = () => assertPresent(applicationWindow.viewManager);

    const { createAppService } = await import("./services/appService.js");
    const { createViewService } = await import("./services/viewService.js");
    const { createMenuService } = await import("./services/menuService.js");
    const { createAdblockService } = await import("./services/adblockService.js");
    const { createDesktopEventsService } = await import("./services/desktopEventsService.js");
    // FS and git-local services removed — server owns these via panel service
    const { createBrowserDataClient } = await import("@vibestudio/browser-data");

    const electronContainer = new ServiceContainer(dispatcher);

    const { serverClient: sc } = conn;
    const browserDataClient = createBrowserDataClient({
      callService: (service, method, args) => sc.call(service, method, args),
    });
    const { createBrowserVaultNativeClient } =
      await import("./services/browserVaultNativeClient.js");
    const browserVault = createBrowserVaultNativeClient(sc);
    const { BrowserPermissionController } =
      await import("./services/browserPermissionController.js");
    const workspacePermissionController = new BrowserPermissionController({
      serverClient: sc,
      eventService,
      getViewManager: () => applicationWindow.viewManager,
      isTargetUnderAutomation: (targetId) =>
        cdpHostProvider?.isTargetUnderAutomation(targetId) ?? false,
    });
    browserPermissionController?.stop();
    browserPermissionController = workspacePermissionController;
    electronContainer.registerManaged({
      name: "browser-permissions-host",
      async start() {
        try {
          const partition = await workspacePermissionController.attachBrowserEnvironment();
          activeBrowserSessionPartition = partition;
          browserEnvironmentReadiness.ready(partition);
        } catch (error) {
          browserEnvironmentReadiness.unavailable(error);
          throw error;
        }
        return workspacePermissionController;
      },
      async stop() {
        browserEnvironmentReadiness.stopped(
          new Error("Browser environment stopped with the workspace")
        );
        activeBrowserSessionPartition = null;
        workspacePermissionController.stop();
        if (browserPermissionController === workspacePermissionController) {
          browserPermissionController = null;
        }
      },
    });

    // Shell-only services
    electronContainer.registerRpc(
      createAppService({
        panelOrchestrator,
        serverClient: sc,
        getViewManager,
        getAppOrchestrator: () => applicationWindow.appOrchestrator,
        connectionMode: conn.connectionMode,
        remoteHost: undefined,
        shellSurfaces: () => (IS_HEADLESS_HOST ? [] : SHELL_SURFACE_KINDS),
        onOpenShellSurface: dispatchShellSurface,
      })
    );
    const { createHubControlHostService } = await import("./services/hubControlService.js");
    electronContainer.registerRpc(
      createHubControlHostService({
        client: conn.hubControlClient,
        getViewManager,
        onWorkspaceRoute: handleWorkspaceRoute,
      })
    );
    electronContainer.registerRpc(
      createViewService({
        panelOrchestrator,
        panelRegistry,
        get panelView(): PanelView {
          return getPanelView();
        },
        browserVault,
        getViewManager,
      })
    );
    electronContainer.registerRpc(
      createMenuService({
        panelOrchestrator,
        panelRegistry,
        getViewManager,
        serverClient: sc,
      })
    );
    // Current-workspace operations route to the selected child. Server-wide
    // catalog/account control routes to the stable hub through the host service
    // above; the child is never a control-plane deputy.
    const { createRemoteCredService } = await import("./services/remoteCredService.js");
    electronContainer.registerRpc(
      createRemoteCredService({
        getServerClient: () => serverClientRef,
        getConnectionMode: () => conn.connectionMode,
        getViewManager,
      })
    );
    const { createPhoneProvisioningService } =
      await import("./services/phoneProvisioningService.js");
    const { getAppUnpackedRoot, getPhysicalAppPath } = await import("./paths.js");
    const desktopPhoneProvider = createPhoneProvisioningService({
      appRoot: getAppUnpackedRoot(),
      appVersion: app.getVersion(),
      resolveScriptPath: (name) => getPhysicalAppPath(path.join("scripts", "cli", name)),
      hubControlClient: conn.hubControlClient,
      workspaceName: conn.workspaceName,
    });
    electronContainer.registerRpc(desktopPhoneProvider);
    electronContainer.registerRpc(createAdblockService({ adBlockManager }));
    // Browser-data persistence lives on the server; Electron keeps only the
    // host-bound autofill adapter.
    {
      electronContainer.registerManaged({
        name: "browser-data-host",
        async start() {
          const { BrowserImportHostProvider } =
            await import("./services/browserImportHostProvider.js");
          const { SensitiveBrowserImportLedger } =
            await import("./services/sensitiveBrowserImportLedger.js");
          const { BrowserPrivacyManager } = await import("./services/browserPrivacyManager.js");
          browserPrivacyManager = new BrowserPrivacyManager({
            vault: browserVault,
            getProjection: () => browserCookieProjection,
            preloadPath: path.join(__dirname, "browserPrivacyPreload.cjs"),
            htmlPath: path.join(__dirname, "browserPrivacy.html"),
          });
          browserImportHostProvider = new BrowserImportHostProvider(
            {
              hostId: `desktop:${cdpHostConnectionId}`,
              displayName: "This device",
            },
            {
              browserVault,
              sensitiveImportLedger: new SensitiveBrowserImportLedger(
                path.join(
                  app.getPath("userData"),
                  "browser-import",
                  "sensitive-operation-ledger.json"
                )
              ),
            }
          );
          browserDataStoreForCredentialCapture = browserVault;
          formFillManager = new FormFillManager({
            formFillStore: browserVault,
            eventService,
            getViewManager,
            autofillOverlayPreloadPath: path.join(__dirname, "autofillOverlayPreload.cjs"),
            requestSiteCapability: (contents, capability) =>
              browserPermissionController?.requestSiteCapability(contents, capability) ??
              Promise.resolve(false),
          });
          const { CanonicalBrowserFaviconObserver } =
            await import("./services/browserFaviconObserver.js");
          browserFaviconObserver = new CanonicalBrowserFaviconObserver(browserDataClient);
          return browserDataClient;
        },
        async stop() {
          browserImportHostProvider?.stop();
          browserImportHostProvider = null;
          browserPrivacyManager?.destroy();
          browserPrivacyManager = null;
          browserDataStoreForCredentialCapture = null;
          if (formFillManager) {
            formFillManager.destroy();
            formFillManager = null;
          }
          browserFaviconObserver = null;
        },
      });
      const { createBrowserCookieProjectionService } =
        await import("./services/browserCookieProjection.js");
      electronContainer.registerManaged(
        createBrowserCookieProjectionService({
          browserDataClient,
          browserVault,
          serverClient: sc,
          hostId: `desktop:${conn.workspaceId}`,
          outboxRoot: app.getPath("userData"),
          async onReady(api) {
            if (api.partition !== activeBrowserSessionPartition) {
              throw new Error("Browser cookie projection resolved a different environment");
            }
            browserCookieProjection = api;
            const browserSession = session.fromPartition(api.partition);
            releaseBrowserAdBlocking?.();
            releaseBrowserAdBlocking = adBlockManager.attachToSession(browserSession);

            // Browser views need the session partition and nothing else. The
            // subsystems below enrich the environment — site permissions, web
            // notifications, download tracking — and each can fail on its own
            // without making the browser unusable. Letting one rejection escape
            // marked the whole environment unavailable, which left every
            // browser panel with no view at all and an empty pane.
            const attach = async (label: string, start: () => Promise<void> | void) => {
              try {
                await start();
              } catch (error) {
                log.error(
                  `Browser environment: ${label} unavailable; continuing without it: ${
                    error instanceof Error ? error.message : String(error)
                  }`
                );
              }
            };

            await attach("site permissions", async () => {
              // The notification bridge routes through permission decisions, so
              // it only exists when those are available.
              const { WebsiteNotificationBridge } =
                await import("./services/websiteNotificationBridge.js");
              websiteNotificationBridge = new WebsiteNotificationBridge({
                permissions: workspacePermissionController,
                eventService,
                getViewManager: () => applicationWindow.viewManager,
              });
              websiteNotificationBridge.start();
            });

            await attach("downloads", async () => {
              const { BrowserDownloadManager } =
                await import("./services/browserDownloadManager.js");
              const manager = new BrowserDownloadManager({
                browserSession,
                environmentKey: api.identity.environmentKey,
                hostId: `desktop:${cdpHostConnectionId}`,
                downloadsDirectory: app.getPath("downloads"),
                browserData: browserDataClient,
                eventService,
                getViewManager: () => applicationWindow.viewManager,
                requestSiteCapability: (contents, capability) =>
                  browserPermissionController?.requestSiteCapability(contents, capability) ??
                  Promise.resolve(false),
              });
              await manager.start();
              browserDownloadManager = manager;
            });
          },
          async onStopped() {
            websiteNotificationBridge?.stop();
            websiteNotificationBridge = null;
            await browserDownloadManager?.stop();
            browserDownloadManager = null;
            releaseBrowserAdBlocking?.();
            releaseBrowserAdBlocking = null;
            browserCookieProjection = null;
          },
        })
      );
    }

    // Register autofill service (uses lazy resolution since formFillManager is created in browser-data start)
    electronContainer.registerRpc(
      createAutofillService({
        invoke: (ctx, method, args) => {
          if (!formFillManager) throw new Error("Autofill not initialized");
          return formFillManager.getServiceDefinition().handler(ctx, method, args);
        },
      })
    );
    const { createBrowserEnvironmentService } =
      await import("./services/browserEnvironmentService.js");
    const { workspaceProviderExtensionRepoPath } =
      await import("@vibestudio/workspace/configParser");
    electronContainer.registerRpc(
      createBrowserEnvironmentService({
        getDownloads: () => browserDownloadManager,
        getImportProvider: () => browserImportHostProvider,
        browserDataBrokerRepoPath: workspaceProviderExtensionRepoPath(
          conn.workspaceConfig,
          "browserData"
        ),
      })
    );
    const { createDesktopBrowserPrivacyPresentation } =
      await import("./services/desktopBrowserPrivacyPresentation.js");
    const desktopBrowserPrivacyPresentation = createDesktopBrowserPrivacyPresentation({
      getPrivacyManager: () => browserPrivacyManager,
    });
    electronContainer.registerRpc(desktopBrowserPrivacyPresentation);
    // Each local watch retains its server topics for exactly the lifetime of
    // its response. The bridge folds all retained topics into one server watch.
    {
      const shouldForwardServerEvents = (caller: ServiceContext["caller"]): boolean => {
        if (callerHasPlatformCapability(caller.runtime.id, caller.runtime.kind, "panel-hosting")) {
          return true;
        }
        if (caller.runtime.kind !== "app") return false;
        const viewInfo = applicationWindow.viewManager?.getViewInfo(caller.runtime.id) ?? null;
        return viewHasAppCapability(caller.runtime.id, viewInfo, "panel-hosting");
      };
      electronContainer.registerRpc(
        createDesktopEventsService({
          eventService,
          // Tree invalidation is level-triggered state, not an edge. A shell
          // can render and issue its first empty query while the host seeds the
          // manifest roots. Replaying the latest reset when its watch opens
          // closes that startup race without duplicating tree state in main.
          snapshots: {
            "panel-tree-invalidated": () => latestPanelTreeInvalidation,
          },
          onWatchOpened: (events, ctx) => {
            if (!shouldForwardServerEvents(ctx.caller)) return undefined;
            return serverEventSubscriptions.retainMany(events);
          },
        })
      );
    }

    await electronContainer.startAll();

    dispatcher.markInitialized();
    const { publishHostService } = await import("./hostServicePublisher.js");
    publishHostService(sc, dispatcher, desktopPhoneProvider);
    publishHostService(sc, dispatcher, desktopBrowserPrivacyPresentation);

    // =========================================================================
    // Register ipcMain.handle handlers for __vibestudioShell (panel preload)
    // =========================================================================
    // These handlers service panel IPC calls. Caller identity is resolved
    // via ViewManager's findViewIdByWebContentsId (which tracks the
    // webContents.id → viewId mapping for all created views).
    // The shell webContents is registered as viewId "shell".

    const resolveCallerId = (event: Electron.IpcMainInvokeEvent): string => {
      const viewManager = getViewManager();
      // Check if it's the shell
      const shellContents = viewManager.getShellWebContents();
      if (shellContents && !shellContents.isDestroyed() && shellContents.id === event.sender.id) {
        return "shell";
      }
      const viewId = viewManager.findViewIdByWebContentsId(event.sender.id);
      if (!viewId) throw new Error("Unknown caller webContents");
      return viewId;
    };

    const tryResolveCallerId = (event: Electron.IpcMainInvokeEvent): string | null => {
      try {
        return resolveCallerId(event);
      } catch {
        return null;
      }
    };

    /**
     * Resolve both the caller id and caller kind from an IPC event sender.
     * Audit findings #19 / #43 / #44: handlers must derive callerKind from
     * authenticated transport metadata, not assume "shell". The shell
     * webContents has a known id; everything else is a panel/browser view.
     */
    const resolveCaller = (
      event: Electron.IpcMainInvokeEvent
    ): { callerId: string; callerKind: "shell" | "panel" | "app" } => {
      const callerId = resolveCallerId(event);
      return resolveElectronViewCaller(callerId, getViewManager().getViewInfo(callerId));
    };

    /**
     * Reject if the sender is not the shell webContents. Used for IPC
     * channels that should only be reachable from the trusted shell UI
     * (native dialogs, etc.). Audit finding #43.
     */
    const requireShellSender = (event: Electron.IpcMainInvokeEvent, channel: string): void => {
      const { callerKind, callerId } = resolveCaller(event);
      if (callerKind !== "shell") {
        console.warn(`[ipc] Rejecting ${channel} from non-shell sender (callerId=${callerId})`);
        throw new Error(`Channel '${channel}' is shell-only`);
      }
    };

    const requireAppCapabilityForIpc = (
      event: Electron.IpcMainInvokeEvent,
      capability: AppCapability,
      channel: string
    ): { callerId: string; callerKind: "shell" | "panel" | "app" } => {
      const caller = resolveCaller(event);
      if (caller.callerKind !== "app") return caller;
      const viewInfo = applicationWindow.viewManager?.getViewInfo(caller.callerId) ?? null;
      if (viewHasAppCapability(caller.callerId, viewInfo, capability)) {
        return caller;
      }
      console.warn(
        `[ipc] Rejecting ${channel} from app ${caller.callerId} without capability '${capability}'`
      );
      throw new Error(`Channel '${channel}' requires app capability '${capability}'`);
    };

    ipcMain.handle("vibestudio:getPanelInit", async (event) => {
      const callerId = tryResolveCallerId(event);
      if (!callerId) return null;
      return panelOrchestrator?.getBootstrapConfig(callerId);
    });

    ipcMain.on("vibestudio:panel-boot", (event, observation: unknown) => {
      const panelId = getViewManager().findViewIdByWebContentsId(event.sender.id);
      if (!panelId || !observation || typeof observation !== "object") return;
      const candidate = observation as {
        phase?: unknown;
        runtimeEntityId?: unknown;
        source?: unknown;
        contextId?: unknown;
        effectiveVersion?: unknown;
        buildKey?: unknown;
        message?: unknown;
        errorName?: unknown;
        stack?: unknown;
        failureStage?: unknown;
        updatedAt?: unknown;
      };
      if (
        !["loading", "booting", "ready", "failed"].includes(String(candidate.phase)) ||
        typeof candidate.runtimeEntityId !== "string"
      ) {
        return;
      }
      const optionalString = (value: unknown) => (typeof value === "string" ? value : undefined);
      const normalized: import("@vibestudio/shared/panel/observation").PanelBootObservation = {
        phase: candidate.phase as "loading" | "booting" | "ready" | "failed",
        runtimeEntityId: candidate.runtimeEntityId,
        source: optionalString(candidate.source),
        contextId: optionalString(candidate.contextId),
        effectiveVersion: optionalString(candidate.effectiveVersion),
        buildKey: optionalString(candidate.buildKey),
        message: optionalString(candidate.message),
        errorName: optionalString(candidate.errorName),
        stack: optionalString(candidate.stack),
        failureStage: ["config", "bundle-load", "entry"].includes(String(candidate.failureStage))
          ? (candidate.failureStage as "config" | "bundle-load" | "entry")
          : undefined,
        updatedAt: typeof candidate.updatedAt === "number" ? candidate.updatedAt : undefined,
      };
      panelOrchestrator?.onPanelBoot(panelId, event.sender.id, normalized);
    });

    ipcMain.handle(
      "vibestudio:focusPanel",
      async (
        event,
        panelId: string,
        options?: {
          anchorPanelId?: string;
          placement?: import("@vibestudio/shared/types").PanelPlacementHint;
        }
      ) => {
        requireAppCapabilityForIpc(event, "panel-hosting", "vibestudio:focusPanel");
        const result = await assertPresent(panelOrchestrator).focusPanel(panelId, {
          loadIfNeeded: true,
          ...options,
        });
        // `preparing`, `leased_elsewhere`, and build failures are part of the
        // typed panel-focus protocol. In particular, callers such as
        // PanelHandle.focus() continue observing a preparing panel until its
        // execution becomes ready. Turning that state into an IPC rejection
        // tears down the native slot and strands the late readiness update.
        return result;
      }
    );
    ipcMain.handle("vibestudio:bridge.getInfo", async (event) => {
      const callerId = resolveCallerId(event);
      return shellCore?.panelManager.getInfo(asPanelSlotId(callerId));
    });
    ipcMain.handle("vibestudio:performance.snapshot", (event) => {
      resolveCaller(event);
      return {
        ...getViewManager().getProcessPerformanceSnapshot(),
        eventLoop: { samples: mainEventLoopSamples.slice(-60) },
      };
    });
    ipcMain.handle("vibestudio:getBootstrapConfig", async (event) => {
      const callerId = tryResolveCallerId(event);
      if (!callerId) return null;
      return panelOrchestrator?.getBootstrapConfig(callerId);
    });

    // Electron-native
    ipcMain.handle("vibestudio:openDevtools", async (event) => {
      const callerId = resolveCallerId(event);
      getViewManager().openDevTools(callerId);
    });
    ipcMain.handle("vibestudio:openFolderDialog", async (event, opts?: { title?: string }) => {
      requireShellSender(event, "vibestudio:openFolderDialog");
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
        title: opts?.title ?? "Select Folder",
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    });
    ipcMain.handle(
      "vibestudio:openFileDialog",
      async (
        event,
        opts?: { title?: string; filters?: { name: string; extensions: string[] }[] }
      ) => {
        requireShellSender(event, "vibestudio:openFileDialog");
        const result = await dialog.showOpenDialog({
          properties: ["openFile"],
          title: opts?.title ?? "Select File",
          filters: opts?.filters,
        });
        return result.canceled ? null : (result.filePaths[0] ?? null);
      }
    );
    ipcMain.handle("vibestudio:openExternal", async (event, url: string, options?: unknown) => {
      const caller = resolveCaller(event);
      if (caller.callerKind === "shell") {
        const externalOpen = createTypedServiceClient(
          "externalOpen",
          externalOpenMethods,
          (svc, m, a) => sc.call(svc, m, a)
        );
        await externalOpen.openExternal(
          url,
          options as import("@vibestudio/shared/externalOpen").OpenExternalOptions | undefined
        );
      } else {
        throw new Error("Panel openExternal must use its authenticated RPC transport");
      }
    });

    // Generic Electron service dispatch — lets panels call Electron-local
    // services (browser-data, autofill, etc.) directly via IPC instead of
    // going through the server, which may be remote.
    ipcMain.handle("vibestudio:serviceCall", async (event, method: string, args: unknown[]) => {
      // CallerKind is derived from the IPC sender's webContents id (shell vs
      // panel), and ServiceDispatcher.dispatch now enforces the per-service
      // policy at the choke point — see audit findings #3 / #18 / #19.
      const { callerId, callerKind } = resolveCaller(event);
      const parsed = parseServiceMethod(method);
      if (!parsed) throw new Error(`Invalid method format: "${method}". Expected "service.method"`);
      if (callerKind === "app" && parsed.service === "fs") {
        authorizeAppServerCall(callerId, parsed.service, parsed.method, args);
        return sc.callAs({ callerId, callerKind }, parsed.service, parsed.method, args);
      }
      const caller =
        callerKind === "shell"
          ? createHostCaller(callerId, "shell")
          : createVerifiedCaller(callerId, callerKind, codeIdentityForView(callerId));
      return dispatcher.dispatch({ caller }, parsed.service, parsed.method, args);
    });
    ipcMain.handle("vibestudio:isLocalService", (event, service: unknown) => {
      const { callerKind } = resolveCaller(event);
      if (callerKind !== "shell" && callerKind !== "app" && callerKind !== "panel") return false;
      return typeof service === "string" && dispatcher.hasService(service);
    });

    // Workspace RPC is now registered; the bootstrap shell may leave its
    // starting state and open the startup approval gate.
    bootstrapWorkspaceRpcReady = true;
    pushBootstrapConnectionState();
    applicationWindow.attachWorkspaceServices({
      panelRegistry,
      panelOrchestrator,
      serverSession: conn,
      cdpHost: createCdpRegistrationAdapter(),
      formFillManager,
      browserFaviconObserver,
      getBrowserPermissionController: () => browserPermissionController,
    });
    if (IS_HEADLESS_HOST) {
      performance.mark("startup:window-created");
    }
    applicationWindow.create();

    performance.mark("startup:workspace-window-attached");
    if (IS_HEADLESS_HOST) finishPresentedStartup();
  } catch (error) {
    console.error("[App] Startup failed:", error);

    // Fail-fast: clean up all partial state, show error, and exit.
    const cleanupPromises: Promise<void>[] = [];

    if (serverSession) {
      cleanupPromises.push(
        serverSession.close().catch((e) => console.error("[App] session cleanup error:", e))
      );
    }
    // Leave the local hub running: it is detached by design, the
    // next launch reattaches to it, and the idle-exit monitor reaps it if no
    // client ever comes back.
    serverSession?.hubProcessManager?.detach();
    serverSession = null;
    if (cdpHostProvider) {
      cdpHostProvider.stop();
      cdpHostProvider = null;
    }
    await Promise.all(cleanupPromises);
    cleanupNativeWebRtc();

    console.error("[App] Startup failed:", formatUnknownError(error));
    if (!IS_HEADLESS_HOST && applicationWindow.isOpen) {
      const message = error instanceof Error ? error.message : String(error);
      const remoteStartupFailed = remotePairedAtLaunch || pendingRemotePairing !== null;
      const remoteFailure = remoteStartupFailed
        ? remoteStartupFailurePresentation(error, pendingRemotePairing !== null)
        : null;
      bootstrapWorkspaceRpcReady = false;
      bootstrapStartupError = {
        message: remoteStartupFailed
          ? remoteFailure!.message
          : `Could not start the workspace: ${message}`,
        detail: remoteStartupFailed
          ? remoteFailure!.detail
          : "Retry the startup, or choose another server or workspace.",
        ...(bootstrapConnectionKind === "local" && startupMode.kind === "local"
          ? { logPath: getLocalHubLogPath() }
          : {}),
      };
      remotePairedAtLaunch = false;
      pushBootstrapConnectionState();
      log.error(`[bootstrap] Startup failed; keeping recovery window open: ${message}`);
      return;
    }
    if (IS_HEADLESS_HOST) {
      writeHeadlessStartupError(
        error,
        bootstrapConnectionKind === "local" && startupMode.kind === "local"
          ? startupMode.wsDir
          : undefined
      );
    }
    app.exit(1);
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

// ── Quit policy for the desktop-owned local hub ──
// The local hub is a detached process that can outlive the app. On quit we
// simply ASK whether to keep it running (so background work — e.g. an agent
// mid-turn — finishes and the next launch reattaches instantly) or stop it.
// No activity guessing: the user decides, and can persist that choice with
// "Remember my choice" (cleared by re-toggling in Settings / deleting the
// `keepServerOnQuit` field). Ephemeral development hubs always stop because
// their workspace is command-owned disposable state. Decided here, consumed by
// the will-quit cleanup.

app.on("before-quit", (event) => {
  if (quitIntent.kind === "npm-update" || quitIntent.kind === "relaunch") return;
  if (quitIntent.serverDecision !== null || isCleaningUp) return;
  const conn = serverSession;
  const remembered = centralData.getKeepServerOnQuit();
  const ephemeralLocalHub = startupMode.kind === "local" && startupMode.isEphemeral;
  const decision = ordinaryQuitServerDecision({
    ownsLocalHub: conn?.serverOwnership === "desktop-local" && conn.hubProcessManager !== null,
    ephemeralWorkspace: ephemeralLocalHub,
    rememberedKeepServer: remembered,
  });
  if (decision !== "prompt") {
    quitIntent = { kind: "ordinary", serverDecision: decision };
    return;
  }
  event.preventDefault();
  void (async () => {
    const { response, checkboxChecked } = await dialog.showMessageBox({
      type: "question",
      buttons: ["Keep running", "Stop server"],
      defaultId: 0,
      // Escape / closing the dialog keeps the server — never kill work on a
      // stray keypress.
      cancelId: 0,
      title: "Quit Vibestudio",
      message: "Keep the Vibestudio hub running in the background?",
      detail:
        "The hub and its workspace children can keep running after you close the app so background " +
        "tasks (like agent runs) finish and the next launch reattaches instantly — " +
        "or stop it now. You can change this any time.",
      checkboxLabel: "Remember my choice",
    });
    const keep = response === 0;
    if (checkboxChecked) centralData.setKeepServerOnQuit(keep);
    quitIntent = { kind: "ordinary", serverDecision: keep ? "keep" : "stop" };
    app.quit();
  })();
});

// Use will-quit with preventDefault to properly await async shutdown
app.on("will-quit", (event) => {
  // Prevent re-entry. An explicit server stop is fail-closed: a second quit
  // request must not bypass the still-running hub termination proof.
  if (isCleaningUp) {
    if (shutdownRequiresLocalHubStop && !localHubStopConfirmed) {
      event.preventDefault();
      console.warn("[App] Shutdown is still waiting for the local hub to terminate");
    }
    return;
  }

  const updateQuit = quitIntent.kind === "npm-update";
  const relaunchQuit = quitIntent.kind === "relaunch";
  const hasResourcesToClean =
    serverSession ||
    cdpHostProvider ||
    currentHostDevelopmentExecutor ||
    updateQuit ||
    relaunchQuit;
  if (!hasResourcesToClean) return;
  isCleaningUp = true;
  event.preventDefault();
  npmUpdateController?.stop();
  stopElectronHostTargetLaunchLoop();
  approvalAttention?.dispose();
  approvalAttention = null;

  console.log("[App] Shutting down...");

  const stopPromises: Promise<void>[] = [];
  let developmentExecutorClose: Promise<void> | null = null;

  if (currentHostDevelopmentExecutor) {
    const executor = currentHostDevelopmentExecutor;
    currentHostDevelopmentExecutor = null;
    developmentExecutorClose = executor.close();
    stopPromises.push(developmentExecutorClose);
  }

  // Server client (device-paired WS connection) + the detached hub process
  if (serverSession) {
    // Run panel cleanup via server (archive childless shell panels), then
    // stop-or-detach the local server and close the connection.
    const session = serverSession;
    serverSession = null;
    const stopServer =
      session.serverOwnership === "desktop-local" &&
      session.hubProcessManager !== null &&
      (updateQuit || (quitIntent.kind === "ordinary" && quitIntent.serverDecision !== "keep"));
    if (stopServer) {
      shutdownRequiresLocalHubStop = true;
      localHubStopConfirmed = false;
    }

    const cleanupThenClose = (async () => {
      // Exit receipts are server RPCs too. Let the executor finish them before
      // the session is closed, otherwise an in-flight heartbeat/receipt races
      // teardown and reports a misleading connection failure.
      await developmentExecutorClose;

      const unregister = panelOrchestrator?.unregisterRuntimeClient();

      let unregisterFailure: unknown = null;
      try {
        await unregister;
      } catch (error) {
        unregisterFailure = error;
        if (!updateQuit) {
          console.error("[App] Failed to unregister runtime client:", error);
        }
      }

      // All server-side cleanup is complete. Close the transports before
      // stopping or detaching the hub; the producers that could issue new RPCs
      // were stopped above, so this no longer races any required cleanup.
      const close = session.close();
      let closeFailure: unknown = null;
      try {
        await close;
      } catch (error) {
        closeFailure = error;
        if (!updateQuit) console.error("[App] Session close error:", error);
      }

      if (stopServer) {
        // No more server RPCs are needed. Stop the owned hub only after the
        // desktop session is closed, while still ensuring a close failure cannot
        // leave the user-requested server alive.
        localHubStopPromise = (async () => {
          const result = await assertPresent(session.hubProcessManager).stopUntilGone();
          if (!result.gone) throw new Error("The local hub process tree is still running");
          localHubStopConfirmed = true;
          console.log(
            result.escalated
              ? "[App] Hub process tree stopped after escalation"
              : "[App] Hub stopped"
          );
        })();
        await assertPresent(localHubStopPromise);
      } else {
        // Keep: leave the detached process running; the attachment record stays
        // so the next launch reattaches instantly.
        session.hubProcessManager?.detach();
        if (session.hubProcessManager) console.log("[App] Hub left running (detached)");
      }

      if (updateQuit && unregisterFailure) throw unregisterFailure;
      if (updateQuit && closeFailure) throw closeFailure;
    })();
    stopPromises.push(cleanupThenClose);
  }

  if (cdpHostProvider) {
    cdpHostProvider.stop();
    cdpHostProvider = null;
  }

  // Add a timeout to ensure we exit even if cleanup hangs
  const shutdownTimeout = setTimeout(() => {
    if (shutdownRequiresLocalHubStop && !localHubStopConfirmed) {
      // Never force-exit after an explicit stop request until the owned hub
      // tree has been proven gone. stopUntilGone continues retrying; this
      // warning is intentionally non-terminal.
      console.error(
        "[App] Shutdown still waiting for local hub termination; refusing to force exit"
      );
      return;
    }
    console.warn("[App] Shutdown timeout - forcing exit");
    app.exit(1);
  }, APP_SHUTDOWN_TIMEOUT_MS);

  Promise.all(stopPromises)
    .then(() => {
      const core = shellCore;
      shellCore = null;
      core?.shutdown?.();
      cleanupNativeWebRtc();
      clearTimeout(shutdownTimeout);
      console.log("[App] Shutdown complete");
      app.exit(
        updateQuit
          ? NPM_UPDATE_REQUESTED_EXIT_CODE
          : quitIntent.kind === "relaunch"
            ? quitIntent.exitCode
            : 0
      );
    })
    .catch((error: unknown) => {
      if (shutdownRequiresLocalHubStop && !localHubStopConfirmed) {
        // A different cleanup failure must not turn into an app exit while
        // the explicit server-stop proof is still pending.
        void (async () => {
          try {
            await localHubStopPromise;
          } catch (stopError) {
            console.error("[App] Local hub termination failed:", formatUnknownError(stopError));
          }
          if (!localHubStopConfirmed) {
            console.error(
              "[App] Shutdown blocked: refusing to exit while the local hub may still be running"
            );
            return;
          }
          console.error(
            `[App] Shutdown failed after the local hub stopped: ${formatUnknownError(error)}`
          );
          app.exit(1);
        })();
        return;
      }
      const core = shellCore;
      shellCore = null;
      try {
        core?.shutdown?.();
      } catch (cleanupError) {
        console.error("[App] Shell cleanup also failed:", formatUnknownError(cleanupError));
      }
      cleanupNativeWebRtc();
      clearTimeout(shutdownTimeout);
      console.error(
        `[App] Shutdown failed${updateQuit ? "; update cancelled" : ""}:`,
        formatUnknownError(error)
      );
      app.exit(1);
    });
});

app.on("activate", () => {
  if (
    !applicationWindow.isOpen &&
    (serverSession || startupMode.kind === "pending" || bootstrapStartupError)
  ) {
    applicationWindow.create();
  }
  const focusedPanelId = panelRegistry?.getFocusedPanelId();
  if (focusedPanelId) {
    void shellCore?.panelManager
      .notifyFocused(asPanelSlotId(focusedPanelId))
      .catch((error: unknown) =>
        console.warn(`[App] Failed to restore focus for panel ${focusedPanelId}:`, error)
      );
  }
});

// Listen for system theme changes and notify subscribers. Also repaint the
// native window chrome so the backdrop + caption buttons track the appearance
// (this fires for in-app theme switches too, which set nativeTheme.themeSource).
nativeTheme.on("updated", () => {
  const dark = nativeTheme.shouldUseDarkColors;
  eventService.emit("system-theme-changed", dark ? "dark" : "light");
  applicationWindow.repaintChrome(dark);
});
