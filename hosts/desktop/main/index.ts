import { workspaceLabel } from "../../../src/node/workspaceLabel.js";
import { hubControlMethods } from "@vibestudio/service-schemas/hubControl";
import { schemaRpcCaller } from "@vibestudio/rpc/internal";
import { RpcBoundaryError } from "@vibestudio/rpc/errors";
import { CLOSE_TOKEN_REVOKED } from "@vibestudio/rpc/protocol/closeCodes";
import { problemReportingConversation } from "@vibestudio/shared/problemReportingConversation";
import {
  resolveExistingChannelTarget,
  type ChannelDurableObjectEntity,
  type ChannelServiceProvider,
} from "@vibestudio/shared/channelTarget";
import { createAnonymousStartupCounter } from "./anonymousStartup.js";
const countAnonymousStartup = createAnonymousStartupCounter();
import { DisplayCapturePicker } from "./services/displayCapturePicker.js";
import { EventsClient } from "@vibestudio/service-schemas/clients/eventsClient";
import { createNativePanelHost } from "./nativePanelHost.js";
import { closeWorkspaceSession } from "./workspaceSessionShutdown.js";
import { bindProcessLifetimeToParent } from "../../../scripts/owned-process-tree.mjs";
if (process.send) bindProcessLifetimeToParent();
import { parseWorkspaceNativeViewId } from "./workspaceNativeViews.js";
import { nativeViewMayUsePermission } from "./nativeViewPermissionPolicy.js";
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
import { randomUUID } from "node:crypto";
process.env["VIBESTUDIO_HOST_ARTIFACT_ROOT"] = __dirname;
import { EventService } from "@vibestudio/shared/eventsService";
import type { SupervisionChange } from "@vibestudio/shared/events";
import type { ShellSurfaceDescriptor, ShellSurfaceKind } from "@vibestudio/shared/shellSurface";
// Silence Electron security warnings in dev; panels run in isolated webviews.
process.env["ELECTRON_DISABLE_SECURITY_WARNINGS"] = "true";

import { isDev } from "./utils.js";
import { LINUX_DESKTOP_NAME } from "./desktopIdentity.js";
import { SKIP_REMOTE_PAIRING_ARG, parseMainStartupInvocation } from "./startupInvocation.js";
import {
  createStartupErrorReport,
  formatUnknownError,
  resolveStartupErrorPaths,
  startupPathDiagnosticEntries,
} from "./startupDiagnostics.js";
import { spawn, spawnSync } from "node:child_process";
import { hasDeveloperIdSignature } from "@vibestudio/credential-client/macCodeSignature";
import { remoteStartupFailurePresentation } from "./remoteStartupFailure.js";
import { macCaskUpgrade } from "./macCaskUpgrade.js";
import { detectLinuxPackageOwner } from "./linuxPackageOwner.js";
import { installedPackageVersion } from "./installedPackageVersion.js";
import {
  createReleaseUpdateController,
  linuxUpgradeCommandFor,
  type ReleaseUpdateController,
} from "./releaseUpdate.js";
import { createDevLogger } from "@vibestudio/dev-log";
import {
  createConnectDeepLink,
  parseConnectLink,
  type ConnectPairing,
} from "@vibestudio/iroh-transport";
import { validatePanelLocation, type PanelLocation } from "@vibestudio/shared/panelLocation";
import {
  enqueueFirstArgvLink,
  getPendingConnectLink,
  getPendingPanelLocation,
  drainPendingClientLinks,
  onClientLink,
  getPendingShellSurface,
  getPendingConnectLinkError,
  installEarlyOpenUrlBuffer,
  onConnectLink,
  onPanelLocation,
  onShellSurface,
  onConnectLinkError,
  peekPendingConnectLink,
  peekPendingConnectLinkError,
  registerProtocol,
} from "./protocolHandler.js";
import { installRelaunchHandler, relaunchApp, type RelaunchOptions } from "./relaunchApp.js";
import { requestDeveloperRelaunch } from "./developerRelaunch.js";
import {
  startEventLoopResponsivenessMonitor,
  type EventLoopResponsivenessSample,
} from "../../../src/eventLoopResponsiveness.js";
import {
  WorkspaceConnectionStateController,
  type WorkspaceConnectionState,
} from "@vibestudio/shared/workspaceConnection";

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
if (process.platform === "linux") app.setDesktopName(LINUX_DESKTOP_NAME);

import { asPanelSlotId } from "@vibestudio/shared/panel/ids";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { corsApprovalMethods } from "@vibestudio/service-schemas/corsApproval";
import { resolveElectronViewCaller } from "./callerResolution.js";
import { getCentralDataPath } from "@vibestudio/env-paths";
import { ClientMenus, parseClientMenuModel } from "./clientMenu.js";
import { ClientWindows, type ClientWindow } from "./clientWindow.js";
import { createElectronClientWindowFactory } from "./electronClientWindows.js";
import { DesktopClientHost } from "./clientHost.js";
import { ClientHostState } from "./clientHostState.js";
import { SupervisionRelay } from "./supervisionRelay.js";
import { LaunchGate } from "./launchGate.js";
import { ClientBuildCatalog, createVerifiedClientResponder } from "./clientDelivery.js";
import { installClientProtocol, registerClientScheme } from "./clientProtocol.js";
import { NodeArtifactStore } from "@vibestudio/client-host-core/node";
import { gatewayMethods } from "@vibestudio/service-schemas/gateway";
import { PanelHostActions, isPanelHostAction } from "./panelHostActions.js";
import {
  aboutPageWorkspaceRole,
  aboutPanelSource,
} from "@vibestudio/workspace-contracts/aboutNamespace";
import { createPanelCycler } from "./panelCycleController.js";
import { getAppRoot } from "./paths.js";
import { loadCentralEnv } from "@vibestudio/workspace/loader";
import { CentralDataManager } from "@vibestudio/shared/centralData";
import {
  resolveStartupMode,
  shouldRequestSingleInstanceLock,
  getPendingUserDataDir,
  localShellUserDataDir,
  chooseConnectionRelaunchArgs,
  resolveLocalStartupMode,
  workspaceRelaunchArgs,
  type StartupMode,
  type ConnectedStartupMode,
} from "./startupMode.js";
import { establishServerSession, type SessionConnection } from "./serverSession.js";
import { ordinaryQuitServerDecision } from "./quitServerPolicy.js";
import { installProcessSignalShutdown, installSystemShutdown } from "./processSignalShutdown.js";
import type { StartupConnectionProgress } from "../../../src/startupConnectionProgress.js";
import { getLocalHubLogPath } from "./hubProcessManager.js";
import {
  loadStoredRemotePairing,
  clearStoredRemotePairing,
  readPendingPairLabel,
} from "./services/remoteCredService.js";
import { createApprovalAttention, type ApprovalAttention } from "./approvalAttention.js";
import type { PendingApproval } from "@vibestudio/shared/approvals";

import { createVerifiedCaller, ServiceDispatcher } from "@vibestudio/shared/serviceDispatcher";
import { CURRENT_HOST_ABI } from "@vibestudio/workspace-contracts/clients";
import { authorizeVerifiedCaller } from "../../../src/server/services/authorityRuntime.js";
import { setupTestApi } from "./testApi.js";
import { AdBlockManager } from "./adblock/index.js";
import { assertPresent } from "../../../src/lintHelpers";
import { PanelHostWindow } from "./panelHostWindow.js";
import { recordMainProcessError } from "./mainProcessErrorLedger.js";
import {
  clearPanelInitializationFailure,
  recordPanelInitializationFailure,
} from "./panelInitializationFailure.js";

// Native ownership receipts resolve their installed observer from this
// explicit application identity, including in packaged Electron main.
process.env["VIBESTUDIO_APP_ROOT"] ??= getAppRoot();

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
let bootstrapStartupError: {
  message: string;
  detail?: string;
  diagnostics?: string;
  logPath?: string;
} | null = null;
let retryWorkspaceName: string | null = crashLoopWorkspaceName;

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
    message: "Could not initialize the workspace",
    detail: "Review the error details, then retry or choose another workspace.",
    diagnostics: formatUnknownError(error),
  };
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
registerClientScheme();
installEarlyOpenUrlBuffer();
enqueueFirstArgvLink(process.argv);

if (startupMode.kind === "local") {
  if (startupMode.workspaceId) workspaceId = startupMode.workspaceId;
  app.setPath(
    "userData",
    localShellUserDataDir(startupMode, {
      pendingCreation:
        startupMode.workspaceName !== null &&
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

let systemRuntime: import("./workspaceRuntimeController.js").DesktopWorkspaceRuntime | null = null;
let bootstrapWorkspaceRpcReady = false;
let bootstrapStartupProgress: StartupConnectionProgress | null = null;
let bootstrapConnectionKind: "local" | "remote" | null =
  startupMode.kind === "local" ? "local" : null;
// True when this launch found a persisted Iroh remote pairing — the chooser is
// skipped and `establishServerSession` connects to the remote over the pipe.
let remotePairedAtLaunch = false;

/**
 * A returning device's credential was terminally rejected (revoked / reset on the
 * server, or the durable endpoint key changed so the saved Endpoint ID no longer
 * matches) — re-pairing is required. A transient outage reads differently (the
 * transport retries internally; a connect timeout has its own shape), so those do
 * NOT match and the stored pairing is kept for a later retry.
 */
function isTerminalRemoteCredentialFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /credential (expired|revoked|invalid)|re-pair|endpoint id mismatch|invalid token|session (is )?closed|session auth failed|SESSION_AUTH_FAILED/i.test(
    message
  );
}

// The bootstrap chooser resolves IN-PROCESS (no relaunch): when the user picks a
// local workspace or pairs a server, the chooser IPC handler resolves
// `chooserChoice`, the pending startup path awaits it, and we fall through to the
// connected setup in the SAME process. A `local` choice reassigns `startupMode`;
// a `remote` choice sets `pendingRemotePairing` (the fresh pairing IS the session).
type ChooserChoice = { kind: "local"; name: string } | { kind: "remote"; pairing: ConnectPairing };
let chooserChoiceMade = false;
let resolveChooserChoice!: (choice: ChooserChoice) => void;
const chooserChoice = new Promise<ChooserChoice>((resolve) => {
  resolveChooserChoice = (choice) => {
    chooserChoiceMade = true;
    resolve(choice);
  };
});

function shouldAutoPairPendingDevIrohLink(): boolean {
  // A development client is launched by an executor the user already
  // authorized, which hands it a one-time invite for the very server that
  // asked for the launch. Routing that through the chooser would ask the user
  // to confirm a connection they just requested — and nothing can answer it
  // when the launch was unattended, so the run waits out its whole budget and
  // reports that the executor never completed the launch.
  if (process.env["VIBESTUDIO_DEVELOPMENT_LAUNCH_REQUEST"]) return true;
  return isDev() && startupInvocation.devIrohRemote;
}

let activeIpcDispatcher: import("./ipcDispatcher.js").IpcDispatcher | null = null;
let panelCycler: import("./panelCycleController.js").PanelCycler | null = null;
type DesktopUiWorkspaceRuntime = import("./workspaceRuntimeController.js").DesktopWorkspaceRuntime;
const desktopWorkspaceRuntimes = new Map<string, Promise<DesktopUiWorkspaceRuntime>>();
let abortPendingSystemRuntimeStartup: ((error: unknown) => Promise<void>) | null = null;
let closeWorkspaceCatalogWatch: (() => Promise<void>) | null = null;
const openNativeControllers = new Map<string, DesktopUiWorkspaceRuntime>();
let ensureAboutOwnerWorkspace:
  | ((role: "personal" | "system") => Promise<DesktopUiWorkspaceRuntime>)
  | null = null;
const adBlockManager = new AdBlockManager();

let serverSession: SessionConnection | null = null;
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
  | { kind: "relaunch"; exitCode: number };
let quitIntent: QuitIntent = { kind: "ordinary", serverDecision: null };
let releaseUpdateController: ReleaseUpdateController | null = null;
let presentedStartupFinished = false;
let deferredStartupWork: (() => void) | null = null;
/**
 * Open workspaces in the order the chrome stacks their sections.
 *
 * The catalog arrives as an ordered list and the chrome renders it in that
 * order, so cycling panels past the edge of one workspace follows the same
 * sequence a person sees. Before the first catalog arrives, the order the
 * workspaces were opened in is the best available answer.
 */
let workspaceCatalogOrder: readonly string[] = [];

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

/** The Homebrew upgrade for the installed cask, when brew is reachable. */
function brewCaskUpgrade(): { display: string; argv: readonly string[] } | null {
  if (process.platform !== "darwin") return null;
  return macCaskUpgrade(app.getPath("exe"));
}

/** Whether one command can be raised to root with a prompt the user can answer. */
function canRunPrivilegedCommand(): boolean {
  if (process.platform !== "linux") return false;
  try {
    return spawnSync("pkexec", ["--version"], { timeout: 5_000, stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Run one upgrade command, through polkit when it needs root.
 *
 * polkit owns the consent prompt for a system package manager; Homebrew runs as
 * the user who installed it and must not be elevated.
 */
function runUpgradeCommand(
  argv: readonly string[],
  options: { elevate: boolean }
): Promise<{ code: number | null; stderr: string }> {
  const [command, ...rest] = options.elevate ? ["pkexec", ...argv] : argv;
  if (!command) return Promise.resolve({ code: 127, stderr: "no upgrade command" });
  return new Promise((resolve, reject) => {
    const child = spawn(command, rest, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      // Bound what a failing package manager can hand back to a dialog.
      if (stderr.length < 8_192) stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr }));
  });
}

async function relaunchWithIntent(opts: RelaunchOptions = {}): Promise<void> {
  if (process.env["VIBESTUDIO_DEV_RUNNER_IPC"] === "1") {
    await requestDeveloperRelaunch(opts.args ?? process.argv.slice(1));
  } else if (opts.args) app.relaunch({ args: opts.args });
  else app.relaunch();
  quitIntent = { kind: "relaunch", exitCode: opts.exitCode ?? 0 };
  app.quit();
}
installRelaunchHandler(relaunchWithIntent);
function requestUnattendedQuit(): void {
  // OS shutdown, signals, and development-runner stop requests are unattended lifecycle
  // commands, not interactive window closes. Stop the owned hub explicitly so
  // a disposable developer instance cannot leak behind a prompt nobody can
  // answer. Preserve stronger update/relaunch intents if one is already active.
  if (quitIntent.kind === "ordinary") {
    quitIntent = { kind: "ordinary", serverDecision: "stop" };
  }
  app.quit();
}
installProcessSignalShutdown(process, requestUnattendedQuit);

// Client windows, the menus clients contribute, and the host-owned launch gate.
// A client's window and the panel host's window are created only by a launch.
const clientMenus = new ClientMenus({
  deliver: (windowId, actionId) => {
    const window = clientWindows.all().find((candidate) => candidate.windowId === windowId);
    window?.send("vibestudio:menu-action", actionId);
  },
});
const launchGate = new LaunchGate({
  preloadPath: path.join(__dirname, "bootstrapPreload.cjs"),
  htmlPath: path.join(__dirname, "index.html"),
  iconPath: path.join(__dirname, "assets", "brand", "vibestudio-symbol-512.png"),
  title: () =>
    startupMode.kind === "pending" ? "Vibestudio - Connect" : `Vibestudio — ${workspaceId}`,
});
const panelHost = new PanelHostWindow({
  openPanelLocation: sendIncomingPanelLocation,
  getSystemWorkspaceId: () => serverSession?.workspaceId ?? null,
  onCodeIdentityChanged: (nativeId) => {
    void activeIpcDispatcher?.revokeUiCaller(nativeId).catch(console.error);
  },
  eventService,
  isHeadlessHost: IS_HEADLESS_HOST,
  getWindowTitle: () =>
    IS_HEADLESS_HOST ? `Vibestudio Headless Host — ${workspaceId}` : `Vibestudio — ${workspaceId}`,
  getApprovalAttention: () => approvalAttention,
  initializePanelTreeOnce,
  onHostedShellReady: finishPresentedStartup,
  menus: clientMenus,
  onWindowClosed: () => {
    clearPanelInitializationFailure();
    const hosting = clientWindows.panelHost();
    if (hosting) clientWindows.notifyClosed(hosting);
  },
});
const clientWindows: ClientWindows = new ClientWindows(
  createElectronClientWindowFactory({
    preloadPath: path.join(__dirname, "clientPreload.cjs"),
    iconPath: path.join(__dirname, "assets", "brand", "vibestudio-symbol-512.png"),
    menus: clientMenus,
    panelHost,
    partitionFor: (spec) => `persist:vibestudio-client-${spec.clientId}`,
    openExternal: async (url) => {
      const result = await dialog.showMessageBox({
        type: "question",
        title: "Open external application?",
        message: "This link opens outside Vibestudio.",
        detail: url,
        buttons: ["Open", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (result.response === 0) await shell.openExternal(url);
    },
    openSibling: (spec, url) => {
      void clientHost?.openSibling(spec.clientId, url).catch((error: unknown) => {
        log.warn(`Could not open another window of ${spec.clientId}: ${formatUnknownError(error)}`);
      });
    },
    closed: (window) => clientWindows.notifyClosed(window),
    rendererGone: (window, reason) => {
      surfaceMainProcessFatal(
        `${window.spec.title} stopped`,
        new Error(`The window's renderer ended (${reason}).`)
      );
    },
  }),
  {
    closed: (window) => {
      clientMenus.clear(window.windowId);
      void activeIpcDispatcher?.releaseClientWindow(window.callerId).catch((error: unknown) => {
        log.warn(
          `Could not release the sessions of ${window.callerId}: ${formatUnknownError(error)}`
        );
      });
      clientHost?.windowClosed(window);
    },
  }
);
let clientHost: DesktopClientHost | null = null;
const supervisionRelay = new SupervisionRelay();

function broadcastWorkspaceConnectionState(state: WorkspaceConnectionState): void {
  const sent = new Set<number>();
  const send = (contents: WebContents | null | undefined) => {
    if (!contents || contents.isDestroyed() || sent.has(contents.id)) return;
    sent.add(contents.id);
    contents.send("vibestudio:workspace-connection-state", state);
  };
  for (const window of clientWindows.all()) send(window.contents());
  const viewManager = panelHost.viewManager;
  for (const viewId of viewManager?.getViewIds() ?? []) send(viewManager?.getWebContents(viewId));
}

const workspaceConnection = new WorkspaceConnectionStateController(
  startupMode.kind === "local" ? "local" : "remote",
  broadcastWorkspaceConnectionState
);

/** Bring the person to wherever this app has a window: a client's, else the launch gate. */
function showAnyWindow(): void {
  const window = clientWindows.all().at(-1);
  if (window) window.show();
  else if (launchGate.isOpen) launchGate.show();
}

app.on("second-instance", () => {
  showAnyWindow();
});
let personalBrowserServices: import("./personalBrowserServices.js").PersonalBrowserServices | null =
  null;
let personalWorkspaceId: string | null = null;
const corsApprovalCache = new Set<string>();
const pendingCorsApprovals = new Map<string, Promise<{ allowed: boolean; cacheable: boolean }>>();

/**
 * Gate server calls a client relays through main. The approval queue
 * (credential, capability, install, device-code and client-config approvals)
 * is reachable only from a client that holds `approval-surface`: any other
 * client could otherwise enumerate and silently grant or deny another
 * principal's approvals.
 */
function authorizeClientServerCall(callerId: string, service: string): void {
  if (service !== "shellApproval") return;
  if (!clientWindows.byCaller(callerId)?.spec.capabilities.includes("approval-surface")) {
    throw new Error(`shellApproval is only available to an approval surface, not ${callerId}`);
  }
}

/** Windows of running clients that hold `capability`. */
function windowsWithCapability(
  capability: import("@vibestudio/workspace-contracts/clients").ClientCapability
): ClientWindow[] {
  return clientWindows.all().filter((window) => window.spec.capabilities.includes(capability));
}

/** Whether this renderer is a client window holding `capability`. */
function senderHoldsCapability(
  webContentsId: number,
  capability: import("@vibestudio/workspace-contracts/clients").ClientCapability
): boolean {
  return (
    clientWindows.byWebContents(webContentsId)?.spec.capabilities.includes(capability) === true
  );
}

function canAccessIncomingPairLinks(webContentsId: number): boolean {
  return senderHoldsCapability(webContentsId, "hub-control");
}

function sendIncomingPairLink(link: unknown): void {
  for (const window of windowsWithCapability("hub-control")) {
    window.send("vibestudio:incoming-pair-link", link);
  }
}

function canAccessIncomingPanelLocations(webContentsId: number): boolean {
  return senderHoldsCapability(webContentsId, "panel-hosting");
}

/**
 * Surfaces a caller may ask the panel-hosting client to open, and how each
 * reaches it. The relay table is the one list of what this host can open:
 * `app.describeShellSurfaces` reports its keys, and only while a panel-hosting
 * client is running to receive them.
 */
const shellSurfaceRelays: {
  [K in ShellSurfaceKind]: (
    target: Extract<ShellSurfaceDescriptor, { kind: K }>,
    workspaceId: string | null,
    workspaceEvents: import("@vibestudio/shared/eventsService").EventService | undefined
  ) => void;
} = {
  settings: (target, workspaceId) =>
    eventService.emit("open-settings", {
      section: target.section ?? "connection",
      ...((target.workspaceId ?? workspaceId)
        ? { workspaceId: target.workspaceId ?? workspaceId! }
        : {}),
    }),
  "problem-report": (_target, _workspaceId, workspaceEvents) =>
    workspaceEvents?.emit("open-command-agent", { prompt: problemReportingConversation() }),
  "workspace-chooser": (target) =>
    eventService.emit("open-workspace-switcher", {
      ...(target.template ? { template: target.template } : {}),
      ...(target.sourceUrl ? { sourceUrl: target.sourceUrl } : {}),
    }),
  about: (target, workspaceId) => {
    void (async () => {
      const role = aboutPageWorkspaceRole(target.page);
      const runtime = role
        ? await ensureAboutOwnerWorkspace?.(role)
        : workspaceId
          ? openNativeControllers.get(workspaceId)
          : undefined;
      if (!runtime) throw new Error(`The workspace for “${target.page}” is unavailable`);
      if (panelHost.focusedWorkspace !== runtime.workspaceId) {
        panelHost.focusWorkspace(runtime.workspaceId);
        const chromeWorkspaceId = serverSession?.workspaceId;
        if (chromeWorkspaceId) {
          activeIpcDispatcher?.sendEventToShell(chromeWorkspaceId, "workspace-focused", {
            workspaceId: runtime.workspaceId,
          });
        }
      }
      await runtime.orchestrator.createPanel(
        "shell",
        aboutPanelSource(target.page),
        target.page === "new"
          ? {
              isRoot: true,
              slug: `new-${randomUUID().slice(0, 8)}`,
              placement: { disposition: "side-if-room" },
              focus: true,
            }
          : { isRoot: true, focus: true }
      );
    })().catch((error: unknown) => {
      const detail = formatUnknownError(error);
      log.warn(`[shell surface] Could not open about/${target.page}: ${detail}`);
      if (!IS_HEADLESS_HOST && Notification.isSupported()) {
        new Notification({ title: "Couldn't open page", body: detail }).show();
      }
    });
  },
  "command-agent": (target, _workspaceId, workspaceEvents) => {
    const { kind: _kind, ...request } = target;
    workspaceEvents?.emit("open-command-agent", request);
  },
  "panel-command": (target, _workspaceId, workspaceEvents) =>
    workspaceEvents?.emit("run-panel-command", {
      panelId: target.panelId,
      commandId: target.commandId,
    }),
};

/** The surfaces this host can open right now: none unless a panel-hosting client is running. */
function openableShellSurfaces(): readonly ShellSurfaceKind[] {
  return clientWindows.panelHost() ? (Object.keys(shellSurfaceRelays) as ShellSurfaceKind[]) : [];
}

/**
 * Route a validated shell-surface descriptor to the panel-hosting client as
 * the one event that surface already listens for. Every entry point
 * (`app.openShellSurface`, `vibestudio://ask|about|command|surface` deep links)
 * converges here.
 */
function dispatchShellSurface(
  target: ShellSurfaceDescriptor,
  workspaceId = panelHost.focusedWorkspace
): void {
  const workspaceEvents = workspaceId
    ? openNativeControllers.get(workspaceId)?.eventService
    : undefined;
  (
    shellSurfaceRelays[target.kind] as (
      target: ShellSurfaceDescriptor,
      workspaceId: string | null,
      workspaceEvents: import("@vibestudio/shared/eventsService").EventService | undefined
    ) => void
  )(target, workspaceId, workspaceEvents);
}

function sendIncomingPanelLocation(location: unknown): void {
  for (const window of windowsWithCapability("panel-hosting")) {
    window.send("vibestudio:incoming-panel-location", location);
  }
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
  const viewManager = panelHost.viewManager;
  if (!viewManager) return null;
  const webContentsId = details.webContentsId ?? details.webContents?.id;
  if (typeof webContentsId !== "number") return null;
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
    const identity = panelHost.viewManager?.getViewInfo(callerId)?.workspaceIdentity;
    const client = identity ? openNativeControllers.get(identity.workspaceId)?.serverClient : null;
    if (!client) return { allowed: false, requestOrigin };
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
    const personal = personalWorkspaceId ? openNativeControllers.get(personalWorkspaceId) : null;
    const browser = personalBrowserServices;
    if (!personal || !browser) return { error: "Personal browser is unavailable" };
    const panelOrchestrator = personal.orchestrator;
    const personalPanelView = panelHost.getWorkspacePanelView(personal.workspaceId);
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
      if (!browser.browserVault) {
        return { error: "external browser cookie import is unavailable" };
      }
      const browserDataStore = browser.browserVault;
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
    const viewManager = panelHost.viewManager;
    if (!panelOrchestrator || !viewManager) {
      return { error: "internal browser is unavailable" };
    }

    panelHost.focusWorkspace(personal.workspaceId);
    activeIpcDispatcher?.sendEventToShell(
      assertPresent(serverSession).workspaceId,
      "workspace-focused",
      {
        workspaceId: personal.workspaceId,
      }
    );
    const panel = await panelOrchestrator.createBrowserUrlPanel("shell", signInUrl.href, {
      title: "Credential sign-in",
      focus: true,
    });

    try {
      const webContents = personalPanelView?.getWebContents(panel.id);
      if (!webContents || webContents.isDestroyed()) {
        return { error: "failed to create browser panel" };
      }

      const completionPattern =
        typeof msg.completionUrlPattern === "string" ? msg.completionUrlPattern : undefined;

      // Helper to check if cookies are captured
      const tryCaptureCredentials = async (): Promise<Record<string, unknown> | null> => {
        if (!browser.cookieProjection || !browser.browserVault) {
          return null;
        }
        const projection = browser.cookieProjection;
        const browserDataStore = browser.browserVault;
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

        // A person may take as long as they need to sign in; the capture settles
        // on success, a capture error, or the sign-in window closing.
        const cleanup = () => {
          webContents.session.cookies.off("changed", onCookiesChanged);
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

        webContents.session.cookies.on("changed", onCookiesChanged);
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
      // Always close the panel on exit (success, capture error, or user close)
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

/**
 * The server announced a supervised-unit change. Clients follow their own
 * updates and capabilities through the relay; a launch waiting on a build
 * continues now rather than on a timer.
 */
async function handleSupervisionChange(change: SupervisionChange): Promise<void> {
  supervisionRelay.emit(change);
  clientHost?.clientsChanged();
}

function initializePanelTreeOnce(reason: string): Promise<void> {
  const runtime = systemRuntime;
  if (!runtime) return Promise.resolve();
  clearPanelInitializationFailure("panel-tree");
  log.info(`[panels] Initializing panel tree after ${reason}`);
  return runtime
    .initializePanelTree()
    .then(() => clearPanelInitializationFailure("panel-tree"))
    .catch((error) => {
      const failure = recordPanelInitializationFailure(reason, error);
      console.error("[App] Failed to initialize panel tree:", error);
      eventService.emit("panel-initialization-error", {
        path: "",
        error: failure.message,
      });
      throw error;
    });
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
  pairingLinkError: string | null;
  startupError: { message: string; detail?: string; logPath?: string } | null;
  serverLogPath: string | null;
  startupProgress: StartupConnectionProgress | null;
};

const WORKSPACE_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** The launch gate is host UI: only its own renderer may use its channels. */
function requireLaunchGateSender(event: Electron.IpcMainInvokeEvent, channel: string): void {
  if (!launchGate.isSender(event.sender)) {
    console.warn(`[ipc] Rejecting ${channel} from a sender that is not the launch gate`);
    throw new Error(`Channel '${channel}' is launch-gate-only`);
  }
}

function getBootstrapConnectionState(): BootstrapConnectionState {
  // The chooser is shown only while startup is still `pending`, nothing was
  // paired at launch, AND the user has not yet made an in-process choice. A
  // paired Iroh remote (remotePairedAtLaunch) or a resolved chooser choice
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
  const pairingLinkError = peekPendingConnectLinkError();
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
      pairingLinkError,
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
    pairingLinkError,
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
  launchGate.send("vibestudio:bootstrap:state-changed", getBootstrapConnectionState());
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
  ipcMain.handle("vibestudio:workspace-connection-state:get", (event) => {
    if (!clientWindows.byWebContents(event.sender.id)) {
      throw new Error("Workspace connection state is available only to a running client");
    }
    return workspaceConnection.snapshot();
  });

  ipcMain.handle("vibestudio:bootstrap:get-launch-state", (event) => {
    requireLaunchGateSender(event, "vibestudio:bootstrap:get-launch-state");
    return launchGate.launchView;
  });

  ipcMain.handle("vibestudio:bootstrap:resolve-approvals", async (event, decision: unknown) => {
    requireLaunchGateSender(event, "vibestudio:bootstrap:resolve-approvals");
    if (decision !== "once" && decision !== "deny") {
      throw new Error("A launch decision is once or deny");
    }
    if (!clientHost) throw new Error("There is no launch waiting on a decision");
    await clientHost.resolveGateApprovals(decision);
  });

  ipcMain.handle("vibestudio:bootstrap:get-state", (event) => {
    requireLaunchGateSender(event, "vibestudio:bootstrap:get-state");
    return getBootstrapConnectionState();
  });

  ipcMain.handle("vibestudio:bootstrap:retry-startup", (event) => {
    requireLaunchGateSender(event, "vibestudio:bootstrap:retry-startup");
    return relaunchWithIntent({
      args: retryWorkspaceName ? workspaceRelaunchArgs(retryWorkspaceName) : process.argv.slice(1),
    });
  });

  ipcMain.handle("vibestudio:bootstrap:choose-connection", (event) => {
    requireLaunchGateSender(event, "vibestudio:bootstrap:choose-connection");
    return relaunchWithIntent({
      args: [
        ...chooseConnectionRelaunchArgs().filter((arg) => arg !== SKIP_REMOTE_PAIRING_ARG),
        SKIP_REMOTE_PAIRING_ARG,
      ],
    });
  });

  ipcMain.handle("vibestudio:bootstrap:open-log", (event, rawPath: unknown) => {
    requireLaunchGateSender(event, "vibestudio:bootstrap:open-log");
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
    requireLaunchGateSender(event, "vibestudio:bootstrap:launch-local-workspace");
    const name = normalizeBootstrapWorkspaceName(workspaceName);
    const knownWorkspaces = centralData.listWorkspaces();
    if (knownWorkspaces.length > 0 && !centralData.hasWorkspace(name)) {
      throw new Error(
        `No workspace named “${name}”. Pick one from the list; once it is open, create new workspaces from Switch Workspace….`
      );
    }
    log.info(`[bootstrap] Launching local workspace "${name}" by user request`);
    resolveChooserChoice({ kind: "local", name });
    return { ok: true };
  });

  ipcMain.handle("vibestudio:bootstrap:pair-remote", (event, payload: unknown) => {
    requireLaunchGateSender(event, "vibestudio:bootstrap:pair-remote");
    const p = (payload ?? {}) as { link?: unknown };
    const link = typeof p.link === "string" ? p.link : "";
    const parsed = parseConnectLink(link);
    if (parsed.kind === "error") {
      return { ok: false, error: "invalid-url", message: parsed.reason };
    }
    // A valid replacement supersedes any launch-time malformed/expired link.
    // Clear the buffered failure at the same authority boundary that accepts
    // the replacement, so a later chooser can never resurrect stale advice.
    getPendingConnectLinkError();
    // The bootstrap chooser is the owner of a launch-time deep link.  It peeks
    // at that link while rendering the confirmation card, so accepting the
    // card must consume the buffered intent before the hosted shell mounts.
    // Otherwise the hosted shell drains the same one-shot link and opens a
    // second Connections dialog over the already-connected workspace.
    getPendingConnectLink();
    // Hand the parsed pairing to the pending path; establishServerSession dials it
    // over Iroh and keeps the authenticated QUIC connection as the session (the one-time code authenticates
    // it; the issued device credential is persisted for the next launch).
    log.info("[bootstrap] Pairing remote server by user request; connecting in-process");
    resolveChooserChoice({ kind: "remote", pairing: parsed });
    return { ok: true };
  });
}

// =============================================================================
// App Lifecycle
// =============================================================================

// =============================================================================
// Clients
// =============================================================================

/** Verified client bytes live under userData, content-addressed by integrity. */
const clientArtifactStore = new NodeArtifactStore(
  path.join(app.getPath("userData"), "client-artifacts")
);
const clientCatalog = new ClientBuildCatalog();

function showUserNotification(title: string, body: string): void {
  log.warn(`${title}: ${body}`);
  if (!IS_HEADLESS_HOST && Notification.isSupported()) new Notification({ title, body }).show();
}

function createDesktopClientHost(conn: SessionConnection): DesktopClientHost {
  const gateway = createTypedServiceClient("gateway", gatewayMethods, (service, method, args) =>
    conn.serverClient.stream(service, method, args)
  );
  const host = new DesktopClientHost({
    hostVersion: app.getVersion(),
    call: (service, method, args) => conn.serverClient.call(service, method, args),
    fetchArtifact: (route) => gateway.fetch({ path: route, method: "GET" }),
    store: clientArtifactStore,
    catalog: clientCatalog,
    windows: clientWindows,
    supervision: supervisionRelay,
    state: new ClientHostState(path.join(app.getPath("userData"), "client-host-state.json")),
    gate: launchGate,
    workspaceId: () => conn.workspaceId,
    notify: showUserNotification,
    clientStarted: (_client, window) => {
      if (window.hostsPanels) void initializePanelTreeOnce("client-launch").catch(() => undefined);
    },
  });
  // Client sessions are granted by this host for the exact build it verified.
  conn.serverClient.setClientPrincipalSessions(host.principalSessions());
  host.follow();
  onClientLink((link) => {
    void host.openLink(link).catch(() => undefined);
    showAnyWindow();
  });
  return host;
}

/** Launch the default client, or the one a link named when the app was opened by one. */
function launchInitialClient(host: DesktopClientHost): void {
  const [link] = drainPendingClientLinks();
  const launching = link ? host.openLink(link) : host.launch({ default: true });
  // A failed launch is shown on the launch gate; there is no caller left to tell.
  void launching.catch((error: unknown) => {
    log.warn(`Initial client launch failed: ${formatUnknownError(error)}`);
  });
}

app.on("ready", async () => {
  void countAnonymousStartup();
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
  ipcMain.handle("vibestudio:open-panel-location", (event, location: unknown) => {
    if (!canAccessIncomingPanelLocations(event.sender.id)) {
      throw new Error("Panel-location navigation requires the trusted host-chrome surface");
    }
    validatePanelLocation(location as PanelLocation);
    sendIncomingPanelLocation(location);
  });
  onConnectLink((link) => {
    if (IS_HEADLESS_HOST) return;
    sendIncomingPairLink(link);
    panelHost.showAndFocus();
  });
  onPanelLocation((location) => {
    if (IS_HEADLESS_HOST) return;
    sendIncomingPanelLocation(location);
    panelHost.showAndFocus();
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
    panelHost.showAndFocus();
  });
  // A deep link that failed to parse (e.g. a stale old-format link) used to open
  // the app and do nothing. Surface its actionable message instead so the user
  // knows to re-pair with a current link.
  const surfaceConnectLinkError = (reason: string) => {
    if (IS_HEADLESS_HOST) return;
    log.warn(`[pairing] Ignored an invalid pairing link: ${reason}`);
    panelHost.showAndFocus();
    pushBootstrapConnectionState();
    if (Notification.isSupported()) {
      new Notification({ title: "Couldn't open that pairing link", body: reason }).show();
    }
  };
  onConnectLinkError(surfaceConnectLinkError);
  // Notify for any error buffered before this listener registered (launch-time
  // click), but leave it buffered for the bootstrap recovery UI.
  const bufferedLinkError = peekPendingConnectLinkError();
  if (bufferedLinkError) surfaceConnectLinkError(bufferedLinkError);
  // Sleep/wake + screen-unlock recovery: a Iroh pipe can be dead while the
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
  installSystemShutdown(powerMonitor, requestUnattendedQuit);
  powerMonitor.on("resume", () => {
    nudgeServerLiveness("system resume");
  });
  powerMonitor.on("unlock-screen", () => nudgeServerLiveness("screen unlock"));
  // Same recovery, awake path: the shell renderer forwards its `window` `online`
  // event so a network flap (e.g. Wi-Fi reassociate) probes the pipe promptly
  // instead of lingering on a stale "connected". NUDGE ONLY, never a teardown.
  ipcMain.on("vibestudio:shell.network-online", () => {
    nudgeServerLiveness("network online");
  });
  ipcMain.on("vibestudio:shell.chrome-interactive-focus", (event, active: unknown) => {
    panelHost.viewManager?.setShellChromeInteractiveFocus(event.sender.id, active === true);
  });
  ipcMain.on("vibestudio:shell.overlay-active", (event, active: unknown) => {
    panelHost.viewManager?.setShellOverlayActiveFromShell(event.sender.id, active === true);
  });
  const nativePanelHost = createNativePanelHost({
    getViewManager: () => assertPresent(panelHost.viewManager),
    hasWorkspace: (id) => openNativeControllers.has(id),
    openWorkspace: (id) => ensureDesktopWorkspace(id),
    onFocusedWorkspaceChanged: (id) => panelHost.focusWorkspace(id),
    onNativeSlotChanged: (nativeId, declared) => {
      const identity = parseWorkspaceNativeViewId(nativeId);
      if (!identity) throw new Error("Native panel lacks workspace ownership");
      const runtime = openNativeControllers.get(identity.workspaceId);
      if (declared) runtime?.orchestrator.onNativeSlotDeclared(identity.runtimeId);
      else runtime?.orchestrator.onNativeSlotCleared(identity.runtimeId);
    },
  });
  ipcMain.handle("vibestudio:shell.panels-connect", (event, input: unknown) =>
    nativePanelHost.connect(event.sender.id, input)
  );
  ipcMain.handle("vibestudio:shell.workspace-open", (event, input: unknown) =>
    nativePanelHost.openWorkspace(event.sender.id, input)
  );
  ipcMain.handle("vibestudio:shell.panels-apply", (event, input: unknown) =>
    nativePanelHost.apply(event.sender.id, input)
  );
  installBootstrapConnectionHandlers();
  releaseUpdateController = createReleaseUpdateController({
    eventService,
    currentVersion: app.getVersion(),
    packaged: app.isPackaged,
    linuxUpgrade: () => linuxUpgradeCommandFor(detectLinuxPackageOwner(app.getPath("exe"))),
    canElevate: () => canRunPrivilegedCommand(),
    developerIdSigned: () => hasDeveloperIdSignature(app.getPath("exe")),
    brewUpgrade: () => brewCaskUpgrade(),
    openExternal: (url) => shell.openExternal(url),
    restart: () => relaunchWithIntent(),
    installedVersion: async () => {
      if (process.platform === "darwin") {
        const brew = brewCaskUpgrade()?.argv[0];
        return brew
          ? installedPackageVersion({ manager: "brew", name: "vibestudio", executable: brew })
          : null;
      }
      const owner = detectLinuxPackageOwner(app.getPath("exe"));
      return owner ? installedPackageVersion(owner) : null;
    },
    runCommand: (argv, options) => runUpgradeCommand(argv, options),
    prepareInstall: async () => {
      const { retainInstalledWorkspaceHost } = await import("./retainWorkspaceHost.js");
      await retainInstalledWorkspaceHost();
    },
    installer: () => ({
      // electron-updater refuses to download a release it has not resolved
      // itself, so its own check runs here rather than duplicating the feed.
      downloadUpdate: async () => {
        const { autoUpdater } = await import("electron-updater");
        autoUpdater.autoDownload = false;
        await autoUpdater.checkForUpdates();
        return autoUpdater.downloadUpdate();
      },
      quitAndInstall: async () => {
        const { autoUpdater } = await import("electron-updater");
        quitIntent = { kind: "relaunch", exitCode: 0 };
        autoUpdater.quitAndInstall();
      },
    }),
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

  const webContentsMayUseSensitivePermission = (
    contents: WebContents | null | undefined,
    permission: string
  ): boolean => {
    if (!contents) return false;
    // Keep the request and check handlers consistent: Chromium may consult the
    // check handler before it reaches the request handler.
    return nativeViewMayUsePermission(
      panelHost.viewManager,
      clientWindows,
      contents.id,
      permission
    );
  };

  const displayCapturePicker = new DisplayCapturePicker({
    htmlPath: path.join(__dirname, "displayCapture.html"),
    preloadPath: path.join(__dirname, "displayCapturePreload.cjs"),
  });
  const installPermissionHandlers = (targetSession: Session): void => {
    // On macOS 15+, the OS supplies source selection and its live sharing controls.
    // Other systems use trusted native chrome, never an inventory exposed to pages.
    targetSession.setDisplayMediaRequestHandler(displayCapturePicker.handle, {
      useSystemPicker: true,
    });
    targetSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      const nativeId = contents
        ? panelHost.viewManager?.findViewIdByWebContentsId(contents.id)
        : null;
      const ownerId = nativeId
        ? panelHost.viewManager?.getViewInfo(nativeId)?.workspaceIdentity?.workspaceId
        : null;
      const permissions = ownerId ? openNativeControllers.get(ownerId)?.browserPermissions : null;
      if (SENSITIVE_PERMISSIONS.has(permission)) {
        if (
          permissions &&
          (permission === "media" ||
            permission === "display-capture" ||
            permission === "geolocation" ||
            permission === "notifications" ||
            permission === "clipboard-read" ||
            permission === "clipboard-sanitized-write")
        ) {
          permissions.requestPermission(contents, permission, callback, details);
          return;
        }
        const viewManager = panelHost.viewManager;
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
      const nativeId = contents
        ? panelHost.viewManager?.findViewIdByWebContentsId(contents.id)
        : null;
      const ownerId = nativeId
        ? panelHost.viewManager?.getViewInfo(nativeId)?.workspaceIdentity?.workspaceId
        : null;
      const permissions = ownerId ? openNativeControllers.get(ownerId)?.browserPermissions : null;
      if (SENSITIVE_PERMISSIONS.has(permission)) {
        if (
          permissions &&
          (permission === "media" ||
            permission === "display-capture" ||
            permission === "geolocation" ||
            permission === "notifications" ||
            permission === "clipboard-read" ||
            permission === "clipboard-sanitized-write")
        ) {
          return permissions.checkPermission(contents, permission, requestingOrigin, details);
        }
        return webContentsMayUseSensitivePermission(contents, permission);
      }
      return true;
    });
  };

  // Apply to default session up-front, and to every session created later
  // (panel partitions, persist:browser, etc.) via the session-created hook.
  const respondToClientRequest = createVerifiedClientResponder(
    clientCatalog,
    clientArtifactStore,
    (message) => log.error(message)
  );
  installPermissionHandlers(session.defaultSession);
  installClientProtocol(session.defaultSession, respondToClientRequest);
  app.on("session-created", (s) => {
    try {
      installPermissionHandlers(s);
      installClientProtocol(s, respondToClientRequest);
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
  // below). When present, establishServerSession keeps its Iroh pipe as the
  // session rather than spawning a local server or re-dialing a stored pairing.
  let pendingRemotePairing: ConnectPairing | null = null;

  if (startupMode.kind === "pending" && !remotePairedAtLaunch) {
    const devAutoPairing = shouldAutoPairPendingDevIrohLink() ? getPendingConnectLink() : null;
    if (devAutoPairing) {
      resolveChooserChoice({ kind: "remote", pairing: devAutoPairing });
      log.info("[bootstrap] Dev Iroh remote mode: auto-pairing launch deep link");
    } else if (shouldAutoPairPendingDevIrohLink()) {
      log.warn("[bootstrap] Dev Iroh remote mode requested but no pending pairing link was found");
    } else if (IS_HEADLESS_HOST) {
      // No chooser UI on a headless host and nothing paired to connect to —
      // stay alive (a supervisor can pair a remote or select a workspace and
      // restart) rather than opening a window nothing can drive.
      log.error(
        "[headless] No workspace selected and no remote server paired. Pair a server over " +
          "Iroh or select a workspace, then restart the headless host."
      );
      return;
    }
    // Show the chooser, then AWAIT the user's choice in-process. Instead of
    // relaunching, we apply the choice and fall through to the connected setup
    // below in the SAME process.
    performance.mark("startup:window-created");
    launchGate.show();
    const choice = await chooserChoice;
    if (choice.kind === "local") {
      bootstrapConnectionKind = "local";
      // Resolve (creating if missing) the chosen local workspace in-process and
      // promote `startupMode` to local so the connected setup spawns its server.
      retryWorkspaceName = choice.name;
      {
        try {
          startupMode = resolveLocalStartupMode(centralData, choice.name, "local", true);
        } catch (error) {
          bootstrapWorkspaceRpcReady = false;
          bootstrapStartupError = {
            message: `Could not open workspace “${choice.name}”`,
            detail: "Review the error details, then retry or choose another workspace.",
            diagnostics: formatUnknownError(error),
          };
          pushBootstrapConnectionState();
          return;
        }
        workspaceId = assertPresent(startupMode.workspaceId);
        log.info(`[bootstrap] Local workspace chosen: ${workspaceId} (${startupMode.wsDir})`);
      }
    } else {
      // Remote: leave startupMode pending; the fresh pairing becomes the session.
      bootstrapConnectionKind = "remote";
      pendingRemotePairing = choice.pairing;
      log.info("[bootstrap] Remote server chosen; pairing the session over Iroh");
    }
    // Fall through to the connected setup.
  }

  // Idempotent: the chooser path already opened the gate; open it here for
  // the returning-device / direct-local startups that skip the chooser.
  if (!IS_HEADLESS_HOST) {
    performance.mark("startup:window-created");
    launchGate.show();
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
    const window = clientWindows.byCaller(callerId);
    if (window) {
      const { codeIdentity } = window.spec;
      return {
        callerId,
        callerKind: "client",
        repoPath: codeIdentity.source,
        effectiveVersion: codeIdentity.effectiveVersion,
        executionDigest: codeIdentity.executionDigest,
        requested: codeIdentity.requested,
      } as const;
    }
    const viewInfo = panelHost.viewManager?.getViewInfo(callerId);
    if (viewInfo?.type !== "panel") return null;
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

  if (!IS_HEADLESS_HOST) {
    approvalAttention = createApprovalAttention({
      getWindow: () => clientWindows.all().at(-1)?.browserWindow() ?? null,
      listPending: async () => {
        const session = serverSession;
        if (!session) return null;
        const members = (await session.hubControlClient.call(
          "hubControl",
          "listWorkspaces",
          []
        )) as import("@vibestudio/service-schemas/hubControl").HubWorkspaceEntry[];
        return Promise.all(
          members.flatMap((member) => {
            const runtime = openNativeControllers.get(member.workspaceId);
            if (!runtime) return [];
            return [
              runtime.serverClient.call("shellApproval", "listPending", []).then((pending) => ({
                workspaceId: member.workspaceId,
                workspaceLabel: workspaceLabel(member),
                pending: pending as PendingApproval[],
              })),
            ];
          })
        );
      },
      log,
    });
  }

  const handleAttentionRequired = (title: string, message: string) => {
    const focusWindow = () => panelHost.showAndFocus();
    panelHost.requestAttention();
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
  let workspaceCatalogBootstrap: Promise<void> | null = null;
  const ensureDesktopWorkspace = async (id: string): Promise<DesktopUiWorkspaceRuntime> => {
    const sessions = assertPresent(serverSession).workspaceSessions;
    if (!sessions.hasAuthoritativeCatalog) {
      workspaceCatalogBootstrap ??= (async () => {
        const members = (await assertPresent(serverSession).hubControlClient.call(
          "hubControl",
          "listWorkspaces",
          []
        )) as import("@vibestudio/service-schemas/hubControl").HubWorkspaceEntry[];
        // A catalog event received while this read was in flight wins.
        sessions.initializeCatalog(new Set(members.map((entry) => entry.workspaceId)));
      })();
      try {
        await workspaceCatalogBootstrap;
      } catch (error) {
        workspaceCatalogBootstrap = null;
        throw error;
      }
    }
    // Catalog admission is checked even for a cached native runtime. A removal
    // cannot be bypassed by a stale UI selection or delayed list response.
    const connection = sessions.get(id);
    const existing = desktopWorkspaceRuntimes.get(id);
    if (existing) {
      await connection;
      return existing;
    }
    const opening = Promise.resolve().then(async () => {
      const session = assertPresent(serverSession);
      const [workspaceConnection, members] = await Promise.all([
        connection,
        createTypedServiceClient(
          "hubControl",
          hubControlMethods,
          session.hubControlClient.call.bind(session.hubControlClient)
        ).listWorkspaces(),
      ]);
      const membership = members.find((entry) => entry.workspaceId === id);
      if (!membership)
        throw new RpcBoundaryError("Workspace access was removed", "transport", "CONNECTION_LOST");
      const { createDesktopWorkspaceRuntime } = await import("./workspaceRuntimeController.js");
      const runtime = createDesktopWorkspaceRuntime({
        connection: workspaceConnection,
        personal: membership.privateRole === "personal",
        app: {
          shellSurfaces: openableShellSurfaces,
          onOpenShellSurface: (target) => dispatchShellSurface(target, id),
        },
        events: {
          onAttentionRequired: handleAttentionRequired,
          onNotificationAction: (id, actionId) =>
            releaseUpdateController?.handleNotificationAction(id, actionId),
          onApprovalPendingChanged: (pending) =>
            approvalAttention?.handlePendingChanged({
              workspaceId: id,
              workspaceLabel: workspaceLabel(membership),
              pending,
            }),
        },
        adBlockManager,
        ...(membership.privateRole === "personal"
          ? {
              onCredentialCaptureRequest: (payload: Record<string, unknown>) =>
                handleCredentialSessionCaptureRequest(payload as CredentialSessionCaptureRequest),
            }
          : {}),
        window: panelHost,
        clientWindows,
        menus: clientMenus,
        openExternal: (url) => shell.openExternal(url),
        authorize: ({ caller, capability, resourceKey, tier }) =>
          authorizeVerifiedCaller(caller, {
            workspaceId: id,
            workspaceMember: true,
            sessionId: `electron-main:${id}`,
            audience: "electron-main-services",
            capability,
            resourceKey,
            tier,
          }),
      });
      await runtime.start();
      if (desktopWorkspaceRuntimes.get(id) !== opening) {
        await runtime.close();
        throw new RpcBoundaryError(
          "Workspace access was removed during startup",
          "transport",
          "CONNECTION_LOST"
        );
      }
      openNativeControllers.set(id, runtime);
      if (membership.privateRole === "personal") {
        personalWorkspaceId = id;
        personalBrowserServices = runtime.personalBrowser;
      }
      return runtime;
    });
    desktopWorkspaceRuntimes.set(id, opening);
    void opening.catch(() => {
      if (desktopWorkspaceRuntimes.get(id) === opening) desktopWorkspaceRuntimes.delete(id);
    });
    return opening;
  };
  ensureAboutOwnerWorkspace = async (role) => {
    const session = assertPresent(serverSession);
    const members = (await session.hubControlClient.call(
      "hubControl",
      "listWorkspaces",
      []
    )) as import("@vibestudio/service-schemas/hubControl").HubWorkspaceEntry[];
    const owner = members.find((entry) => entry.privateRole === role);
    if (!owner) throw new Error(`This server does not have a ${role} workspace`);
    return ensureDesktopWorkspace(owner.workspaceId);
  };
  const systemEvents: NonNullable<
    Parameters<
      typeof import("./workspaceRuntimeController.js").createDesktopWorkspaceRuntime
    >[0]["events"]
  > = {
    onAttentionRequired: handleAttentionRequired,
    onNotificationAction: (id, actionId) =>
      releaseUpdateController?.handleNotificationAction(id, actionId),
    onSupervisionChanged: handleSupervisionChange,
    onApprovalPendingChanged: (pending) => {
      approvalAttention?.handlePendingChanged({
        workspaceId: assertPresent(serverSession).workspaceId,
        workspaceLabel: "System",
        pending,
      });
    },
    onApprovalResolved: (resolved) => clientHost?.approvalResolved(resolved),
    onClientsChanged: () => clientHost?.clientsChanged(),
  };

  try {
    performance.mark("startup:server-spawn-begin");

    // Emit a synthetic "connecting" sample so the connection badge has a
    // state to render from the very first frame (rather than flickering
    // from empty → connected). This mirrors what ServerClient's own
    // onConnectionStatusChanged callback will emit a few moments later
    // once the WS lifecycle begins.
    const remoteHost = !skipRemotePairingLaunch ? storedRemoteAtLaunch?.serverId : undefined;
    const isRemoteSession = pendingRemotePairing !== null || remotePairedAtLaunch;
    workspaceConnection.begin(isRemoteSession ? "remote" : "local");
    pushBootstrapConnectionState();

    eventService.emit("server-connection-changed", {
      status: "connecting",
      isRemote: isRemoteSession,
      remoteHost,
    });

    // null mode = no local spawn; establishServerSession connects either the
    // fresh pairing (pendingRemotePairing) or a stored pairing over Iroh.
    const connectedStartupMode: ConnectedStartupMode | null =
      startupMode.kind === "local" ? startupMode : null;
    const establish = (mode: ConnectedStartupMode | null) =>
      establishServerSession({
        mode,
        confirmExistingLocalHub: async (lease) => {
          const { response } = await dialog.showMessageBox({
            type: "question",
            buttons: ["Stop it and start over", "Reconnect", "Cancel"],
            defaultId: 1,
            cancelId: 2,
            title: "Vibestudio is already running",
            message: "Vibestudio is still running in the background.",
            detail:
              "Reconnect to pick up where it left off, including any tasks that are still " +
              "running. Stopping it ends those tasks before starting a fresh session. " +
              `(Background process ${lease.pid}, port ${lease.gatewayPort}.)`,
          });
          if (response === 0) return "replace";
          if (response === 1) return "attach";
          return "cancel";
        },
        onInitialWorkspaceResolved: IS_HEADLESS_HOST
          ? undefined
          : (id, prepare) => {
              // The hub remains the owner of child startup. Request the known
              // focus target alongside System, before either desktop is built.
              void prepare().catch((error: unknown) => {
                log.warn(
                  `[workspace] Could not prepare initial workspace ${id}: ${formatUnknownError(error)}`
                );
              });
            },
        onStartupProgress: (progress) => {
          bootstrapStartupProgress = progress;
          pushBootstrapConnectionState();
        },
        pendingPairing: pendingRemotePairing ?? undefined,
        pendingPairLabel: readPendingPairLabel(),
        storedRemote: storedRemoteAtLaunch ?? undefined,
        centralData,
        onLocalRecoveryFailure: (error) => workspaceConnection.failure(error.message),
        onMainSessionTerminalClose: (error) => {
          const message = error.message || "The paired server ended this session.";
          log.error(`[connection] paired workspace session ended: ${message}`);
          workspaceConnection.end();
          // The server revoked this device (from here or from another device):
          // its credential can never authenticate again, so forget it and
          // return to the chooser instead of offering a dead reconnect.
          if ((error as { code?: unknown }).code !== CLOSE_TOKEN_REVOKED) return;
          if (isRemoteSession) clearStoredRemotePairing();
          if (!IS_HEADLESS_HOST) {
            void relaunchApp().catch((relaunchError: unknown) => {
              log.error(
                `[connection] relaunch after device revocation failed: ${formatUnknownError(relaunchError)}`
              );
            });
          }
        },
        onConnectionStatusChanged: (status) => {
          const wasRecovering = workspaceConnection.snapshot().phase === "reconnecting";
          if (!(status === "connected" && wasRecovering)) workspaceConnection.transport(status);
        },
        onTransportDiagnosticsChanged: (remoteTransport) => {
          if (!serverClientRef || !isRemoteSession) return;
          eventService.emit("remote-transport-diagnostics-changed", {
            remoteTransport,
          });
        },
        onReconnectProgress: (progress) => workspaceConnection.reconnect(progress),
        // Workspace runtimes subscribe to recovery on their immutable clients.
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
    workspaceConnection.transport("connected");
    if (!IS_HEADLESS_HOST || IS_DEVELOPMENT_CLIENT_EXECUTOR) {
      const { CurrentHostDevelopmentClientExecutor } =
        await import("./currentHostDevelopmentClientExecutor.js");
      currentHostDevelopmentExecutor = new CurrentHostDevelopmentClientExecutor({
        client: serverClientRef,
        stateRoot: path.join(app.getPath("userData"), "development-clients"),
        log: (message) => log.warn(message),
      });
      serverClientRef.onDirectEvent("development:client-launch-request", (payload) => {
        void currentHostDevelopmentExecutor
          ?.handleLaunchRequest(payload)
          .catch((error: unknown) => {
            log.warn(`[development] client launch receipt failed: ${formatUnknownError(error)}`);
          });
      });
      serverClientRef.onDirectEvent("development:client-stop-request", (payload) => {
        void currentHostDevelopmentExecutor?.handleStopRequest(payload).catch((error: unknown) => {
          log.warn(`[development] client stop failed: ${formatUnknownError(error)}`);
        });
      });
      const developmentLaunchRequest = process.env["VIBESTUDIO_DEVELOPMENT_LAUNCH_REQUEST"];
      // An executor-only client and an attested diagnostic launch are actual
      // consumers of registration. Ordinary desktop presentation is not.
      if (IS_DEVELOPMENT_CLIENT_EXECUTOR || developmentLaunchRequest) {
        await currentHostDevelopmentExecutor.start();
        if (developmentLaunchRequest) {
          await serverClientRef.call("developmentClientExecutor", "attest", [
            { requestId: developmentLaunchRequest },
          ]);
        }
      }
    }
    workspaceId = serverSession.workspaceId;

    // Phone provisioning belongs to the authenticated desktop connection. It
    // must be available even when this client has no presentation runtime.
    const { createPhoneProvisioningService } =
      await import("./services/phoneProvisioningService.js");
    const { getAppUnpackedRoot, getPhysicalAppPath } = await import("./paths.js");
    const desktopPhoneProvider = createPhoneProvisioningService({
      appRoot: getAppUnpackedRoot(),
      appVersion: app.getVersion(),
      resolveScriptPath: (name) => getPhysicalAppPath(path.join("scripts", "cli", name)),
      hubControlClient: serverSession.hubControlClient,
      workspaceName: serverSession.workspaceName,
    });
    dispatcher.registerService(desktopPhoneProvider);
    const { publishHostService } = await import("./hostServicePublisher.js");
    publishHostService(serverClientRef, dispatcher, desktopPhoneProvider);

    if (IS_DEVELOPMENT_CLIENT_EXECUTOR) {
      bootstrapWorkspaceRpcReady = true;
      log.info(
        `[development] executor-only client ready for workspace ${workspaceId}; presentation startup skipped`
      );
      return;
    }

    performance.mark("startup:server-spawned");
    performance.mark("startup:server-connected");

    launchGate.setTitle(`Vibestudio — ${workspaceId}`);

    // The shell always spawns its own loopback server (ServerProcessManager
    // manages its lifecycle), so there is no out-of-process server to /healthz-
    // poll. Remote topology is Iroh, whose own liveness lives in the transport.

    // Create PanelRegistry (pure in-memory — server owns persistence). Its
    // debounced projection notification is the Electron-local presentation
    // signal; the server's lifecycle observer must not be re-entered merely to
    // tell hosted chrome that a native view finished loading.
    // PanelHttpServer is created by serverSession (RPC-backed proxy)
    const conn = assertPresent(serverSession);
    const { createDesktopWorkspaceRuntime, prepareDesktopWorkspaceRuntime } =
      await import("./workspaceRuntimeController.js");
    const workspaceController = createDesktopWorkspaceRuntime({
      connection: conn,
      personal: false,
      app: {
        getClientUpdates: () => clientHost,
        initialFocusedWorkspaceId: conn.initialFocusedWorkspaceId,
        shellSurfaces: openableShellSurfaces,
        onOpenShellSurface: (target) => dispatchShellSurface(target, conn.workspaceId),
      },
      headless: IS_HEADLESS_HOST,
      eventService,
      dispatcher,
      adBlockManager,
      window: panelHost,
      clientWindows,
      menus: clientMenus,
      openExternal: (url) => shell.openExternal(url),
      authorize: ({ caller, capability, resourceKey, tier }) =>
        authorizeVerifiedCaller(caller, {
          workspaceId: conn.workspaceId,
          workspaceMember: true,
          sessionId: `electron-main:${conn.workspaceId}`,
          audience: "electron-main-services",
          capability,
          resourceKey,
          tier,
        }),
      events: systemEvents,
      onRecovered: async () => {
        if (recoveredLocalServerCrash)
          eventService.emit("notification:show", {
            id: "local-server-crash-recovered",
            type: "warning",
            title: "Workspace server recovered",
            message: `The local server stopped unexpectedly (code ${recoveredLocalServerCrash}) and was restarted. Your workspace is available again.`,
            ttl: 0,
          });
        void approvalAttention?.refresh();
        if (serverClientRef?.getConnectionStatus() !== "connected") return;
        workspaceConnection.transport("connected");
      },
    });
    systemRuntime = workspaceController;
    openNativeControllers.set(conn.workspaceId, workspaceController);
    // Compose the complete System service container before publishing runtime
    // readiness. Hosted shell routing must never observe a partially started
    // local dispatcher and fall through to the workspace server.
    const getViewManager = () => assertPresent(panelHost.viewManager);
    const { createAdblockService } = await import("./services/adblockService.js");
    const electronContainer = workspaceController.container;
    const { createRemoteCredService } = await import("./services/remoteCredService.js");
    electronContainer.registerRpc(
      createRemoteCredService({
        getServerClient: () => serverClientRef,
        getConnectionMode: () => conn.connectionMode,
        getViewManager,
      })
    );
    electronContainer.registerRpc(createAdblockService({ adBlockManager }));
    const systemRuntimePublication = prepareDesktopWorkspaceRuntime(
      desktopWorkspaceRuntimes,
      conn.workspaceId,
      workspaceController
    );
    abortPendingSystemRuntimeStartup = systemRuntimePublication.abort;

    // Create IpcDispatcher (replaces Electron-side RpcServer for shell)
    // Forwards server-service calls to the server, dispatches Electron-local
    // services to the local dispatcher.
    const { IpcDispatcher } = await import("./ipcDispatcher.js");
    const { WebsiteWorkspaceBridge } = await import("./websiteWorkspaceBridge.js");
    const websiteWorkspaceBridge = new WebsiteWorkspaceBridge({
      resolve: (contents) => {
        const vm = panelHost.viewManager;
        const nativeId = vm?.findViewIdByWebContentsId(contents.id);
        const info = nativeId ? vm?.getViewInfo(nativeId) : null;
        if (!info?.browser || !info.workspaceIdentity)
          throw new Error("This is not a hosted website");
        const identity = info.workspaceIdentity;
        const owner = openNativeControllers.get(identity.workspaceId);
        if (!owner) throw new Error("Workspace presentation is unavailable");
        const connection = owner.orchestrator.getPanelRuntimeConnection(identity.runtimeId);
        if (!connection) throw new Error("Website presentation has no active runtime lease");
        return {
          runtimeId: connection.runtimeEntityId,
          client: owner.serverClient,
          bootstrap: () => owner.orchestrator.getBootstrapConfig(identity.runtimeId),
        };
      },
      retireTransport: (contents) => {
        const nativeId = panelHost.viewManager?.findViewIdByWebContentsId(contents.id);
        if (nativeId) activeIpcDispatcher?.retirePanelDocument(nativeId);
      },
    });
    ipcMain.handle("vibestudio:website:document", (event) => websiteWorkspaceBridge.begin(event));
    ipcMain.handle("vibestudio:website:connect", (event, documentId: string) =>
      websiteWorkspaceBridge.connect(event, documentId)
    );
    ipcMain.handle("vibestudio:website:disconnect", (event, documentId: string) =>
      websiteWorkspaceBridge.disconnect(event, documentId)
    );
    const ipcDispatcher = new IpcDispatcher({
      retireDocuments: async () => {
        ipcMain.removeHandler("vibestudio:website:document");
        ipcMain.removeHandler("vibestudio:website:connect");
        ipcMain.removeHandler("vibestudio:website:disconnect");
        await websiteWorkspaceBridge.close();
      },
      workspaceId: conn.workspaceId,
      resolveWorkspaceRuntime: ensureDesktopWorkspace,
      resolveUiRuntime: async (caller, destination) => {
        // A client acts as this device in routed workspaces only while it holds
        // `device-session`, which the server grants solely to trusted clients.
        const window = clientWindows.byCaller(caller.callerId);
        if (
          caller.callerKind !== "client" ||
          !window?.spec.capabilities.includes("device-session")
        ) {
          return null;
        }
        const identity = {
          workspaceId: window.spec.workspaceId,
          runtimeId: window.spec.principalId,
        };
        const code = window.spec.codeIdentity;
        const workspaces = (await conn.hubControlClient.call(
          "hubControl",
          "listWorkspaces",
          []
        )) as import("@vibestudio/service-schemas/hubControl").HubWorkspaceEntry[];
        const system = workspaces.find((entry) => entry.privateRole === "system");
        if (
          system?.workspaceId !== identity.workspaceId ||
          identity.workspaceId !== conn.workspaceId
        ) {
          return null;
        }
        if (
          destination.kind === "workspace" &&
          !workspaces.some((entry) => entry.workspaceId === destination.workspaceId)
        ) {
          return null;
        }
        const workspace =
          destination.kind === "workspace"
            ? await ensureDesktopWorkspace(destination.workspaceId)
            : undefined;
        const target = {
          destination,
          serverClient: workspace?.serverClient ?? conn.hubControlClient,
          ...(workspace ? { workspace } : {}),
        };
        const current = clientWindows.byCaller(caller.callerId);
        if (
          !current?.spec.capabilities.includes("device-session") ||
          current.spec.workspaceId !== identity.workspaceId ||
          current.spec.principalId !== identity.runtimeId ||
          current.spec.codeIdentity.executionDigest !== code.executionDigest ||
          current.spec.codeIdentity.effectiveVersion !== code.effectiveVersion
        ) {
          return null;
        }
        const currentMembers = (await conn.hubControlClient.call(
          "hubControl",
          "listWorkspaces",
          []
        )) as import("@vibestudio/service-schemas/hubControl").HubWorkspaceEntry[];
        if (
          currentMembers.find((entry) => entry.privateRole === "system")?.workspaceId !==
          identity.workspaceId
        )
          return null;
        if (
          destination.kind === "workspace" &&
          !currentMembers.some((entry) => entry.workspaceId === destination.workspaceId)
        )
          return null;
        return target;
      },
      dispatcher,
      serverClient: conn.serverClient,
      getChromeWebContents: () => clientWindows.panelHost()?.contents() ?? null,
      resolveCallerForWebContents: (webContentsId) => {
        const clientWindow = clientWindows.byWebContents(webContentsId);
        if (clientWindow) {
          return {
            callerId: clientWindow.callerId,
            callerKind: "client",
            runtimeId: clientWindow.spec.principalId,
            workspaceId: clientWindow.spec.workspaceId,
          };
        }
        const viewManager = panelHost.viewManager;
        if (!viewManager) return null;
        const overlayOwner =
          viewManager.findHostedShellViewIdByContentOverlayWebContentsId(webContentsId);
        const overlayWindow = overlayOwner ? clientWindows.byCaller(overlayOwner) : null;
        if (overlayWindow) {
          return {
            callerId: overlayWindow.callerId,
            callerKind: "client",
            runtimeId: overlayWindow.spec.principalId,
            workspaceId: overlayWindow.spec.workspaceId,
          };
        }
        const callerId = viewManager.findViewIdByWebContentsId(webContentsId);
        if (!callerId) return null;
        const viewInfo = viewManager.getViewInfo(callerId);
        if (viewInfo?.browser) {
          const contents = viewManager.getWebContents(callerId);
          if (!contents || !websiteWorkspaceBridge.connected(contents)) return null;
        }
        const caller = resolveElectronViewCaller(callerId, viewInfo);
        const identity = viewInfo?.workspaceIdentity;
        return caller && identity
          ? {
              ...caller,
              browser: viewInfo?.browser === true,
              documentId: viewInfo?.browser
                ? websiteWorkspaceBridge.documentId(viewManager.getWebContents(callerId)!)
                : undefined,
              runtimeId: identity.runtimeId,
              workspaceId: identity.workspaceId,
            }
          : null;
      },
      getCodeIdentityForCaller: codeIdentityForView,
      getWebContentsForCaller: (callerId) =>
        clientWindows.byCaller(callerId)?.contents() ??
        panelHost.viewManager?.getWebContents(callerId) ??
        null,
      getPanelRuntimeConnection: (nativeId) => {
        const identity = panelHost.viewManager?.getViewInfo(nativeId)?.workspaceIdentity;
        if (!identity) return undefined;
        return openNativeControllers
          .get(identity.workspaceId)
          ?.orchestrator.getPanelRuntimeConnection(identity.runtimeId);
      },
      authorizeClientServerCall: authorizeClientServerCall,
    });
    activeIpcDispatcher = ipcDispatcher;
    // The same workspace runtime owns ordinary native services and presentation
    // for every workspace. System adds only its app/account host services below.
    // Set up test API for E2E testing (only when VIBESTUDIO_TEST_MODE=1)
    const testOwner = (runtime: DesktopUiWorkspaceRuntime) => ({
      panelOrchestrator: runtime.orchestrator,
      panelRegistry: runtime.registry,
      inspectAgentState: async (channelId: string, participantId: string) => {
        if (openNativeControllers.get(runtime.workspaceId) !== runtime)
          throw new Error("Workspace runtime is no longer active");
        if (!channelId || !participantId)
          throw new Error("Agent inspection requires channel and participant IDs");
        const targetId = await resolveExistingChannelTarget(
          {
            listServices: async () =>
              (await runtime.serverClient.call(
                "workers",
                "listServices",
                []
              )) as ChannelServiceProvider[],
            listDurableObjectEntities: async () =>
              (await runtime.serverClient.call("runtime", "listEntities", [
                { kind: "do" },
              ])) as ChannelDurableObjectEntity[],
          },
          channelId
        );
        return runtime.serverClient.callTarget(targetId, "inspectAgent", [
          { participantId, method: "getDebugState" },
        ]);
      },
      getAssetDiagnostics: () => runtime.getAssetDiagnostics(),
      getPanelView: () => {
        if (openNativeControllers.get(runtime.workspaceId) !== runtime)
          throw new Error("Workspace runtime is no longer active");
        return panelHost.getWorkspacePanelView(runtime.workspaceId);
      },
    });
    setupTestApi(testOwner(workspaceController), {
      getActiveWorkspaceAssetDiagnostics: () =>
        [...openNativeControllers.values()].slice(0, 50).map((runtime) => ({
          workspaceId: runtime.workspaceId,
          transfers: runtime.getAssetDiagnostics(),
        })),
      resolveWorkspace: async (id) => testOwner(await ensureDesktopWorkspace(id)),
      getServerConnectionStatus: () => workspaceController.getConnectionStatus(),
      callHostedClient: async (service, method, args) => {
        const window = clientWindows.panelHost();
        if (!window) throw new Error("No panel-hosting client is running");
        const runtime = openNativeControllers.get(window.spec.workspaceId);
        if (!runtime) throw new Error("The client's workspace runtime is unavailable");
        return runtime.dispatcher.dispatch(
          {
            caller: createVerifiedCaller(
              window.callerId,
              "client",
              codeIdentityForView(window.callerId)
            ),
          },
          service,
          method,
          args
        );
      },
      launchGate: {
        view: () => launchGate.launchView,
        resolveApprovals: (decision) => {
          if (!clientHost) throw new Error("The client host is not running");
          return clientHost.resolveGateApprovals(decision);
        },
      },
      listWorkspaces: () =>
        createTypedServiceClient(
          "hubControl",
          hubControlMethods,
          conn.hubControlClient.call.bind(conn.hubControlClient)
        ).listWorkspaces(),
    });
    panelCycler = createPanelCycler({
      orderedWorkspaceIds: () =>
        workspaceCatalogOrder.length > 0
          ? workspaceCatalogOrder
          : [...openNativeControllers.keys()],
      getRegistry: (workspaceId) => openNativeControllers.get(workspaceId)?.registry ?? null,
      focusedWorkspaceId: () => panelHost.focusedWorkspace,
      focusWorkspace: (workspaceId) => {
        panelHost.focusWorkspace(workspaceId);
        // The chrome owns the workspace sections and lives in the System
        // workspace's shell, so that is where the focus change is announced.
        const chromeWorkspaceId = serverSession?.workspaceId;
        if (chromeWorkspaceId) {
          activeIpcDispatcher?.sendEventToShell(chromeWorkspaceId, "workspace-focused", {
            workspaceId,
          });
        }
      },
      presentPanel: (workspaceId, panelId) => {
        openNativeControllers.get(workspaceId)?.eventService.emit("navigate-to-panel", {
          panelId,
        });
      },
    });

    deferredStartupWork = () => {
      // Hosted adapter readiness is not a paint fence. This diagnostic service
      // still uses asynchronous, bounded file reads so it cannot block the
      // renderer's subsequent layout/IPC; its lifetime remains shutdown-owned.
      void currentHostDevelopmentExecutor?.start().catch((error: unknown) => {
        log.warn(`[development] current-device executor unavailable: ${formatUnknownError(error)}`);
      });
      releaseUpdateController?.start();
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

    // Native workspace lifetime follows the authenticated catalog, independently
    // of which UI happens to list or select workspaces.
    const catalogEvents = new EventsClient(
      schemaRpcCaller({
        streamReadable: (_target, method, args, options) => {
          const separator = method.indexOf(".");
          return conn.hubControlClient.streamReadable(
            method.slice(0, separator),
            method.slice(separator + 1),
            args,
            options
          );
        },
      })
    );
    let catalogClosed = false;
    let catalogTail = Promise.resolve();
    const stopCatalog = catalogEvents.on("hub:workspace-catalog-changed", ({ workspaces }) => {
      workspaceCatalogOrder = workspaces.map((entry) => entry.workspaceId);
      const chromeWorkspaceId = serverSession?.workspaceId;
      if (chromeWorkspaceId) {
        activeIpcDispatcher?.sendEventToShell(chromeWorkspaceId, "hub:workspace-catalog-changed", {
          workspaces,
        });
      }
      const reconcile = async () => {
        if (catalogClosed) return;
        await conn.workspaceSessions.reconcile(
          new Set(workspaces.map((entry) => entry.workspaceId)),
          async (id) => {
            const opening = desktopWorkspaceRuntimes.get(id);
            // Remove admission before awaiting cleanup. The session directory
            // retains failed retirement ownership and blocks reuse.
            openNativeControllers.delete(id);
            approvalAttention?.removeWorkspace(id);
            panelHost.detachWorkspace(id);
            if (personalWorkspaceId === id) {
              personalWorkspaceId = null;
              personalBrowserServices = null;
            }
            if (opening) {
              await (await opening).close();
              if (desktopWorkspaceRuntimes.get(id) === opening) desktopWorkspaceRuntimes.delete(id);
            }
          }
        );
      };
      catalogTail = catalogTail.then(reconcile, reconcile).catch((error: unknown) => {
        console.error("Workspace membership cleanup failed:", formatUnknownError(error));
      });
    });
    const stopCatalogRecovery = conn.hubControlClient.onRecovery(() => catalogEvents.recover());
    closeWorkspaceCatalogWatch = async () => {
      catalogClosed = true;
      stopCatalog();
      stopCatalogRecovery();
      await catalogEvents.unsubscribeAll();
      await catalogTail;
    };
    await catalogEvents.subscribe("hub:workspace-catalog-changed");

    // The selected workspace is already known. Prepare it through the same
    // owned, single-flight path while System mounts the desktop application.
    // A failure is surfaced by the shell's ordinary open/retry UI.
    if (
      !IS_HEADLESS_HOST &&
      conn.initialFocusedWorkspaceId &&
      conn.initialFocusedWorkspaceId !== conn.workspaceId
    ) {
      void ensureDesktopWorkspace(conn.initialFocusedWorkspaceId).catch((error: unknown) => {
        log.warn(`[workspace] Initial workspace preparation failed: ${formatUnknownError(error)}`);
      });
    }
    try {
      await systemRuntimePublication.start();
    } finally {
      abortPendingSystemRuntimeStartup = null;
    }
    void approvalAttention?.refresh({ quiet: true });

    // =========================================================================
    // IPC handlers for the client bridge and the panel preload
    // =========================================================================
    // Caller identity is resolved from the sender's web contents: a client
    // window (any client) or a panel view of the panel host. There is no other
    // kind of renderer, and none is a host.

    const resolveCallerId = (event: Electron.IpcMainInvokeEvent): string => {
      const clientWindow = clientWindows.byWebContents(event.sender.id);
      if (clientWindow) return clientWindow.callerId;
      const viewManager = getViewManager();
      const viewId =
        viewManager.findViewIdByWebContentsId(event.sender.id) ??
        viewManager.findHostedShellViewIdByContentOverlayWebContentsId(event.sender.id);
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

    /** The caller id and kind of an IPC sender, from authenticated transport metadata. */
    const resolveCaller = (
      event: Electron.IpcMainInvokeEvent
    ): { callerId: string; callerKind: "panel" | "client" } => {
      const callerId = resolveCallerId(event);
      if (clientWindows.byCaller(callerId)) return { callerId, callerKind: "client" };
      return resolveElectronViewCaller(callerId, getViewManager().getViewInfo(callerId));
    };

    /** The client window an IPC sender is, if it holds `capability`; throws otherwise. */
    const requireClientWindow = (
      event: Electron.IpcMainInvokeEvent,
      capability: import("@vibestudio/workspace-contracts/clients").ClientCapability,
      channel: string
    ): ClientWindow => {
      const window = clientWindows.byWebContents(event.sender.id);
      if (!window?.spec.capabilities.includes(capability)) {
        console.warn(`[ipc] Rejecting ${channel}: the sender does not hold '${capability}'`);
        throw new Error(`Channel '${channel}' requires client capability '${capability}'`);
      }
      return window;
    };

    const owningRuntime = (callerId: string) => {
      const window = clientWindows.byCaller(callerId);
      const identity = window
        ? { workspaceId: window.spec.workspaceId, runtimeId: window.spec.principalId }
        : getViewManager().getViewInfo(callerId)?.workspaceIdentity;
      if (!identity) throw new Error("Native caller has no workspace ownership");
      const runtime = openNativeControllers.get(identity.workspaceId);
      if (!runtime) throw new Error("Workspace runtime is unavailable");
      return { runtime, runtimeId: identity.runtimeId };
    };

    ipcMain.handle("vibestudio:client:describe", (event) => {
      const window = clientWindows.byWebContents(event.sender.id);
      if (!window) throw new Error("Only a client window can describe itself");
      return {
        clientId: window.spec.clientId,
        principalId: window.spec.principalId,
        buildKey: window.spec.buildKey,
        hostAbi: CURRENT_HOST_ABI.web,
        grantedCapabilities: [...window.spec.capabilities],
      };
    });
    ipcMain.handle("vibestudio:menu:set", (event, model: unknown) => {
      const window = requireClientWindow(event, "native-menus", "vibestudio:menu:set");
      clientMenus.set(window.windowId, parseClientMenuModel(model));
      if (window.browserWindow()?.isFocused()) clientMenus.applyFor(window.windowId);
    });
    ipcMain.handle("vibestudio:client-intent:subscribe", (event) => {
      const window = clientWindows.byWebContents(event.sender.id);
      if (!window) throw new Error("Only a client window can receive intents");
      clientHost?.subscribeIntents(window.windowId, (intent) =>
        window.send("vibestudio:client-intent", intent)
      );
    });
    ipcMain.handle("vibestudio:panel-host:run", async (event, action: unknown) => {
      requireClientWindow(event, "panel-hosting", "vibestudio:panel-host:run");
      if (!isPanelHostAction(action)) throw new Error("Unknown panel host action");
      const viewManager = panelHost.viewManager;
      const window = panelHost.window;
      if (!viewManager || !window) throw new Error("The panel host window is closed");
      await new PanelHostActions({
        viewManager,
        window,
        focusedWorkspace: () => {
          const id = panelHost.focusedWorkspace;
          const runtime = id ? openNativeControllers.get(id) : undefined;
          return runtime
            ? {
                workspaceId: runtime.workspaceId,
                registry: runtime.registry,
                orchestrator: runtime.orchestrator,
              }
            : null;
        },
        cycler: () => panelCycler,
      }).run(action);
    });
    ipcMain.handle(
      "vibestudio:client:set-development-mode",
      (event, clientId: unknown, enabled: unknown) => {
        requireClientWindow(event, "device-session", "vibestudio:client:set-development-mode");
        if (typeof clientId !== "string" || typeof enabled !== "boolean") {
          throw new Error("Development mode takes a client id and a boolean");
        }
        if (!clientHost) throw new Error("The client host is not running");
        clientHost.setDevelopmentMode(clientId, enabled);
      }
    );

    ipcMain.handle("vibestudio:getPanelInit", async (event) => {
      const callerId = tryResolveCallerId(event);
      if (!callerId) return null;
      const owner = owningRuntime(callerId);
      return owner.runtime.orchestrator.getBootstrapConfig(owner.runtimeId);
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
      const owner = owningRuntime(panelId);
      if (candidate.runtimeEntityId !== owner.runtimeId) return;
      owner.runtime.orchestrator.onPanelBoot(owner.runtimeId, event.sender.id, normalized);
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
        const caller = resolveCaller(event);
        if (caller.callerKind === "client") {
          requireClientWindow(event, "panel-hosting", "vibestudio:focusPanel");
        }
        const owner = owningRuntime(caller.callerId);
        const result = await owner.runtime.orchestrator.focusPanel(panelId, {
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
      const owner = owningRuntime(callerId);
      return owner.runtime.core.panelManager.getInfo(asPanelSlotId(owner.runtimeId));
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
      const owner = owningRuntime(callerId);
      return owner.runtime.orchestrator.getBootstrapConfig(owner.runtimeId);
    });

    // Electron-native
    ipcMain.handle("vibestudio:openDevtools", async (event) => {
      const caller = resolveCaller(event);
      if (caller.callerKind !== "panel") {
        throw new Error("A client opens developer tools through app.openDevTools");
      }
      getViewManager().openDevTools(caller.callerId);
    });
    ipcMain.handle("vibestudio:inspectWorkspaceFolder", async (event) => {
      requireClientWindow(event, "hub-control", "vibestudio:inspectWorkspaceFolder");
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory"],
        title: "Choose workspace source folder",
      });
      const checkout = result.canceled ? null : (result.filePaths[0] ?? null);
      if (!checkout) return null;
      const { inspectWorkspaceSources, workspaceSourceFromCheckout } =
        await import("../../../src/workspaceTemplateSource.js");
      const [source] = await inspectWorkspaceSources({
        sources: [workspaceSourceFromCheckout(checkout)],
        checkpointRoot: path.join(
          getCentralDataPath(),
          "workspace-source-inspections",
          randomUUID()
        ),
      });
      if (!source?.review) throw new Error("Workspace source inspection produced no review facts");
      if (conn.connectionMode !== "local") {
        throw new Error("Local workspace folders require a local Vibestudio server");
      }
      return assertPresent(serverSession).hubControlClient.call(
        "hubControl",
        "registerLocalTemplateSource",
        [{ pin: source.pin, checkout: source.checkout, review: source.review }]
      );
    });

    // Workspace RPC is now registered; the bootstrap shell may leave its
    // starting state and open the startup approval gate.
    bootstrapWorkspaceRpcReady = true;
    pushBootstrapConnectionState();
    if (IS_HEADLESS_HOST) {
      // A headless host runs no client: it keeps the panel host's compositor
      // for automation, with no client page on top of it.
      performance.mark("startup:window-created");
      panelHost.open("window:headless");
    } else {
      clientHost = createDesktopClientHost(conn);
      launchInitialClient(clientHost);
    }

    performance.mark("startup:workspace-window-attached");
    if (IS_HEADLESS_HOST) finishPresentedStartup();
  } catch (error) {
    console.error("[App] Startup failed:", error);

    // Fail-fast: clean up all partial state, show error, and exit.
    const abortStartup = abortPendingSystemRuntimeStartup;
    abortPendingSystemRuntimeStartup = null;
    if (abortStartup) await abortStartup(error);
    const cleanupPromises: Promise<void>[] = [];
    const closeCatalog = closeWorkspaceCatalogWatch;
    closeWorkspaceCatalogWatch = null;
    if (closeCatalog)
      await closeCatalog().catch((error) => console.error("Catalog cleanup failed", error));
    const runtimes = [...desktopWorkspaceRuntimes.values()];
    desktopWorkspaceRuntimes.clear();
    openNativeControllers.clear();
    await Promise.allSettled(runtimes.map(async (runtime) => (await runtime).close()));
    systemRuntime = null;
    if (activeIpcDispatcher) {
      await activeIpcDispatcher
        .shutdown()
        .catch((error) => console.error("IPC cleanup failed", error));
      activeIpcDispatcher = null;
    }

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
    await Promise.all(cleanupPromises);

    console.error("[App] Startup failed:", formatUnknownError(error));
    if (!IS_HEADLESS_HOST && launchGate.isOpen) {
      const message = error instanceof Error ? error.message : String(error);
      const remoteStartupFailed = remotePairedAtLaunch || pendingRemotePairing !== null;
      const remoteFailure = remoteStartupFailed
        ? remoteStartupFailurePresentation(error, pendingRemotePairing !== null)
        : null;
      bootstrapWorkspaceRpcReady = false;
      bootstrapStartupError = {
        message: remoteStartupFailed ? remoteFailure!.message : "Could not start the workspace",
        detail: remoteStartupFailed
          ? remoteFailure!.detail
          : "Retry the startup, or choose another server or workspace.",
        diagnostics: formatUnknownError(error),
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
          ? (startupMode.wsDir ?? undefined)
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
// `keepServerOnQuit` field). A disposable developer instance's hub always
// stops, because its whole root is about to be removed. Decided here, consumed
// by the will-quit cleanup.

app.on("before-quit", (event) => {
  if (quitIntent.kind === "relaunch") return;
  if (quitIntent.serverDecision !== null || isCleaningUp) return;
  const conn = serverSession;
  const remembered = centralData.getKeepServerOnQuit();
  // A disposable developer instance root is removed when its supervisor exits,
  // so its hub must never be left running behind a prompt.
  const disposableInstance = process.env["VIBESTUDIO_INSTANCE_LIFECYCLE"] === "ephemeral";
  const decision = ordinaryQuitServerDecision({
    ownsLocalHub: conn?.serverOwnership === "desktop-local" && conn.hubProcessManager !== null,
    disposableInstance,
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
      buttons: ["Keep running", "Quit and stop"],
      defaultId: 0,
      // Escape / closing the dialog keeps the server — never kill work on a
      // stray keypress.
      cancelId: 0,
      title: "Quit Vibestudio",
      message: "Keep Vibestudio running in the background?",
      detail:
        "Background tasks, like agent runs, can keep going after you close the window, and " +
        "reopening Vibestudio will be instant. Or stop everything now. You can change this any time.",
      checkboxLabel: "Remember my choice",
    });
    // A system shutdown can supersede an already-open ordinary quit dialog.
    if (quitIntent.kind !== "ordinary" || quitIntent.serverDecision !== null || isCleaningUp)
      return;
    const keep = response === 0;
    if (checkboxChecked) centralData.setKeepServerOnQuit(keep);
    quitIntent = { kind: "ordinary", serverDecision: keep ? "keep" : "stop" };
    app.quit();
  })();
});

// Use will-quit with preventDefault to properly await async shutdown
app.on("will-quit", (event) => {
  releaseUpdateController?.stop();
  // Prevent re-entry. An explicit server stop is fail-closed: a second quit
  // request must not bypass the still-running hub termination proof.
  if (isCleaningUp) {
    if (shutdownRequiresLocalHubStop && !localHubStopConfirmed) {
      event.preventDefault();
      console.warn("[App] Shutdown is still waiting for the local hub to terminate");
    }
    return;
  }

  const relaunchQuit = quitIntent.kind === "relaunch";
  const hasResourcesToClean =
    serverSession ||
    systemRuntime?.cdpHostProvider ||
    currentHostDevelopmentExecutor ||
    relaunchQuit;
  if (!hasResourcesToClean) return;
  isCleaningUp = true;
  event.preventDefault();
  void clientHost?.shutdown();
  approvalAttention?.dispose();
  approvalAttention = null;

  console.log("[App] Shutting down...");

  const stopPromises: Promise<void>[] = [];
  const joinShutdown = (label: string, operation: Promise<void>) => {
    console.log(`[App] Shutdown phase started: ${label}`);
    stopPromises.push(
      operation.then(
        () => console.log(`[App] Shutdown phase completed: ${label}`),
        (error: unknown) => {
          console.error(`[App] Shutdown phase failed: ${label}`, error);
          throw error;
        }
      )
    );
  };
  const closeCatalog = closeWorkspaceCatalogWatch;
  closeWorkspaceCatalogWatch = null;
  const catalogClose = closeCatalog?.();
  if (catalogClose) joinShutdown("workspace catalog", catalogClose);
  const abortStartup = abortPendingSystemRuntimeStartup;
  abortPendingSystemRuntimeStartup = null;
  if (abortStartup)
    joinShutdown("runtime startup", abortStartup(new Error("Application is shutting down")));
  let developmentExecutorClose: Promise<void> | null = null;

  if (activeIpcDispatcher) {
    const ipcDispatcher = activeIpcDispatcher;
    activeIpcDispatcher = null;
    joinShutdown("renderer IPC", ipcDispatcher.shutdown());
  }

  if (currentHostDevelopmentExecutor) {
    const executor = currentHostDevelopmentExecutor;
    currentHostDevelopmentExecutor = null;
    developmentExecutorClose = executor.close();
    joinShutdown("development executor", developmentExecutorClose);
  }

  // Server client (device-paired WS connection) + the detached hub process
  if (serverSession) {
    // Run panel cleanup via server (archive childless shell panels), then
    // stop-or-detach the local server and close the connection.
    const session = serverSession;
    serverSession = null;
    session.hubProcessManager?.beginShutdown();
    const stopServer =
      session.serverOwnership === "desktop-local" &&
      session.hubProcessManager !== null &&
      quitIntent.kind === "ordinary" &&
      quitIntent.serverDecision !== "keep";
    if (stopServer) {
      shutdownRequiresLocalHubStop = true;
      localHubStopConfirmed = false;
    }

    const cleanupThenClose = closeWorkspaceSession({
      // Exit receipts are server RPCs too. Let the executor finish them before
      // the session is closed, otherwise an in-flight heartbeat/receipt races
      // teardown and reports a misleading connection failure.
      joinCatalog: async () => {
        await catalogClose;
      },
      joinExecutor: async () => {
        await developmentExecutorClose;
      },
      closeRuntimes: async () => {
        const runtimes = [...desktopWorkspaceRuntimes.values()];
        desktopWorkspaceRuntimes.clear();
        openNativeControllers.clear();
        const unregister = Promise.allSettled(
          runtimes.map(async (runtime) => (await runtime).close())
        ).then((results) => {
          systemRuntime = null;
          const errors = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : []
          );
          if (errors.length) throw new AggregateError(errors, "Workspace runtime cleanup failed");
        });

        await unregister;
      },

      // All server-side cleanup is complete. Close the transports before
      // stopping or detaching the hub; the producers that could issue new RPCs
      // were stopped above, so this no longer races any required cleanup.
      closeTransport: () => session.close(),
      retireServer: async () => {
        if (stopServer) {
          // No more server RPCs are needed. Stop the owned hub only after the
          // desktop session is closed, while still ensuring a close failure cannot
          // leave the user-requested server alive.
          localHubStopPromise = (async () => {
            const result = await assertPresent(session.hubProcessManager).stopTree();
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
      },
    });
    joinShutdown("workspace sessions", cleanupThenClose);
  }

  Promise.allSettled(stopPromises)
    .then((results) => {
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (errors.length) throw new AggregateError(errors, "Application shutdown failed");
    })
    .then(() => {
      console.log("[App] Shutdown complete");
      app.exit(quitIntent.kind === "relaunch" ? quitIntent.exitCode : 0);
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
      console.error("[App] Shutdown failed:", formatUnknownError(error));
      app.exit(1);
    });
});

app.on("activate", () => {
  if (clientWindows.all().length === 0 && !launchGate.isOpen) {
    if (clientHost) {
      void clientHost.launch({ default: true }).catch(() => undefined);
    } else if (serverSession || startupMode.kind === "pending" || bootstrapStartupError) {
      launchGate.show();
    }
  }
  const focusedRuntime = panelHost.focusedWorkspace
    ? openNativeControllers.get(panelHost.focusedWorkspace)
    : undefined;
  const focusedPanelId = focusedRuntime?.registry.getFocusedPanelId();
  if (focusedPanelId) {
    void focusedRuntime?.core.panelManager
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
  panelHost.repaintChrome(dark);
});
