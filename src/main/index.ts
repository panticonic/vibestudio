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
import { cleanupNodeDatachannel } from "../node/webrtc/nodeDatachannelPeer.js";
import { maybeNotifyNpmUpdate } from "./updateCheck.js";
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
  getPendingConnectLinkError,
  installEarlyOpenUrlBuffer,
  onConnectLink,
  onPanelLocation,
  onConnectLinkError,
  peekPendingConnectLink,
  registerProtocol,
} from "./protocolHandler.js";

const log = createDevLogger("App");
const APP_NAME = "Vibestudio";
const APP_SHUTDOWN_TIMEOUT_MS = 15_000;
const startupInvocation = parseMainStartupInvocation(process.argv, process.env);
// Consume one-shot recovery markers so intentional relaunches do not replay them.
process.argv = startupInvocation.argv;
const IS_HEADLESS_HOST = startupInvocation.isHeadlessHost;
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
  console.error("[App] Uncaught exception in main process:", formatUnknownError(error));
  surfaceMainProcessFatal("Vibestudio encountered an internal error", error);
});
process.on("unhandledRejection", (reason) => {
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
import { resolveElectronViewCaller } from "./callerResolution.js";
import { setMenuPanelLifecycle, setMenuPanelRegistry, setMenuEventService } from "./menu.js";
import { getAppRoot } from "./paths.js";
import { loadCentralEnv } from "@vibestudio/workspace/loader";
import { resolveLocalWorkspaceStartup } from "@vibestudio/workspace/startup";
import { CentralDataManager } from "@vibestudio/shared/centralData";
import {
  resolveStartupMode,
  shouldRequestSingleInstanceLock,
  getPendingUserDataDir,
  chooseConnectionRelaunchArgs,
  EPHEMERAL_DEV_WORKSPACE_NAME,
  ephemeralWorkspaceRelaunchArgs,
  resolveEphemeralDevStartupMode,
  workspaceRelaunchArgs,
  type StartupMode,
  type ConnectedStartupMode,
} from "./startupMode.js";
import { establishServerSession, type SessionConnection } from "./serverSession.js";
import { getLocalHubLogPath } from "./hubProcessManager.js";
import {
  loadStoredRemotePairing,
  clearStoredRemotePairing,
  persistStoredRemoteWorkspaceRoute,
  readPendingPairLabel,
} from "./services/remoteCredService.js";
import { relaunchApp } from "./relaunchApp.js";
import type { ServerClient } from "./serverClient.js";
import { CdpHostProvider } from "./cdpHostProvider.js";
import { RemoteCdpHostProviderSocket } from "./remoteCdpHostProviderSocket.js";
import { HOST_TARGET_LAUNCH_SESSION_CHANGED_EVENT } from "@vibestudio/shared/hostTargetLaunchGate";
import { resolveGatewayRouteUrl } from "@vibestudio/shared/appArtifacts";
import {
  createServerEventBridge,
  notificationAttention,
  type ServerHostTargetChangeEvent,
} from "./serverEventBridge.js";
import { createServerEventSubscriptionBridge } from "./serverEventSubscriptionBridge.js";
import { createApprovalAttention, type ApprovalAttention } from "./approvalAttention.js";
import type { PendingApproval } from "@vibestudio/shared/approvals";
import { filterBootstrapApprovalsForTarget } from "@vibestudio/shared/bootstrapApprovals";
import { RuntimeDiagnosticsStore } from "../server/runtimeDiagnosticsStore.js";
import { BROWSER_SESSION_PARTITION } from "@vibestudio/shared/panelInterfaces";

import {
  createVerifiedCaller,
  ServiceDispatcher,
  parseServiceMethod,
  type ServiceContext,
} from "@vibestudio/shared/serviceDispatcher";
import { autofillMethods } from "@vibestudio/service-schemas/autofill";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { ServiceContainer } from "@vibestudio/shared/serviceContainer";
import { createEventsServiceDefinition } from "@vibestudio/service-schemas/bindings/eventsServiceDefinition";
import { setupTestApi } from "./testApi.js";
import { AdBlockManager } from "./adblock/index.js";
import { callerHasPlatformCapability, viewHasAppCapability } from "./services/appCapabilities.js";
import { assertPresent } from "../lintHelpers";
import { ApplicationWindowController } from "./applicationWindowController.js";

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
  startupMode = resolveStartupMode(centralData, { interactiveDesktop: !IS_HEADLESS_HOST });
} catch (error) {
  console.error("[Workspace] Failed to initialize workspace:", error);
  if (IS_HEADLESS_HOST) {
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
    path.join(startupMode.wsDir, IS_HEADLESS_HOST ? "state-headless-host" : "state")
  );
} else {
  app.setPath("userData", getPendingUserDataDir());
}

let cdpHostProvider: CdpHostProvider | null = null;
let panelRegistry: PanelRegistry | null = null;
let panelOrchestrator: PanelOrchestrator | null = null;
let pendingReadyElectronLaunch: AppAvailableEvent | null = null;
let electronHostLaunchTimer: ReturnType<typeof setTimeout> | null = null;
let electronHostLaunchBlockedByApproval = false;
let electronHostLaunchInFlight = false;
let bootstrapWorkspaceRpcReady = false;
let bootstrapStartupDetail: string | null = null;
let desktopAutoUpdater: {
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
} | null = null;
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
let electronHostLaunchLastStatusKey: string | null = null;
let panelTreeInitializationStarted = false;
let shellCore: ReturnType<
  typeof import("./shellCore/createElectronShellCore.js").createElectronShellCore
> | null = null;
let serverSession: SessionConnection | null = null;
let panelLocationForWorkspaceRelaunch: PanelLocation | null = null;
let approvalAttention: ApprovalAttention | null = null;
let isCleaningUp = false; // Prevent re-entry in will-quit handler

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
  onWindowClosed: () => {
    panelTreeInitializationStarted = false;
    appliedElectronHostTargetKey = null;
    electronHostLaunchLastStatusKey = null;
  },
});

app.on("second-instance", () => {
  applicationWindow.showAndFocus();
});
let autofillManager: import("./autofill/autofillManager.js").AutofillManager | null = null;
const corsApprovalCache = new Set<string>();
const pendingCorsApprovals = new Map<string, Promise<{ allowed: boolean; cacheable: boolean }>>();
let browserDataStoreForCredentialCapture:
  | import("@vibestudio/browser-data").BrowserDataClient
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

function buildCookieHeader(
  cookies: Electron.Cookie[],
  cookieNames: string[]
): {
  header: string;
  expiresAt?: number;
  cookies: Record<string, unknown>[];
} | null {
  const byName = new Map(cookies.map((cookie) => [cookie.name, cookie]));
  const selected: Electron.Cookie[] = [];
  for (const name of cookieNames) {
    const cookie = byName.get(name);
    if (!cookie || !cookie.value) return null;
    selected.push(cookie);
  }
  const expiringCookies = selected
    .map((cookie) =>
      typeof cookie.expirationDate === "number"
        ? Math.floor(cookie.expirationDate * 1000)
        : undefined
    )
    .filter((value): value is number => typeof value === "number" && value > 0);
  return {
    header: selected.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
    expiresAt: expiringCookies.length > 0 ? Math.min(...expiringCookies) : undefined,
    cookies: selected.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      expirationDate: cookie.expirationDate,
      partitionKey:
        typeof (cookie as { partitionKey?: unknown }).partitionKey === "string"
          ? (cookie as { partitionKey?: string }).partitionKey
          : undefined,
    })),
  };
}

function buildImportedCookieHeader(
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expiration_date: number | null;
    secure: number;
    http_only: number;
    same_site: string;
  }>,
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
    .map((cookie) => cookie.expiration_date ?? undefined)
    .filter((value): value is number => typeof value === "number" && value > nowSeconds);
  if (
    selected.some(
      (cookie) => typeof cookie.expiration_date === "number" && cookie.expiration_date <= nowSeconds
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
      secure: cookie.secure === 1,
      httpOnly: cookie.http_only === 1,
      sameSite: cookie.same_site,
      expirationDate: cookie.expiration_date ?? undefined,
    })),
  };
}

function importedCookieMatchesOrigin(
  cookie: { domain: string; path: string; secure: number },
  origin: string
): boolean {
  const url = new URL(origin);
  if (cookie.secure === 1 && url.protocol !== "https:") return false;
  const cookieDomain = cookie.domain.replace(/^\./, "").toLowerCase();
  const host = url.hostname.toLowerCase();
  const domainMatches = cookie.domain.startsWith(".")
    ? host === cookieDomain || host.endsWith(`.${cookieDomain}`)
    : host === cookieDomain;
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
      const imported = await browserDataStoreForCredentialCapture.getCookies();
      const material = buildImportedCookieHeader(imported, cookieNames, origins);
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
      name: "Credential sign-in",
      focus: true,
    });

    try {
      const webContents = viewManager.getWebContents(panel.id);
      if (!webContents || webContents.isDestroyed()) {
        return { error: "failed to create browser panel" };
      }

      const browserSession = session.fromPartition(BROWSER_SESSION_PARTITION);
      const completionPattern =
        typeof msg.completionUrlPattern === "string" ? msg.completionUrlPattern : undefined;
      const timeout = 300_000;

      // Helper to check if cookies are captured
      const tryCaptureCredentials = async (): Promise<Record<string, unknown> | null> => {
        const captured: Electron.Cookie[] = [];
        for (const origin of origins) {
          const originCookies = await browserSession.cookies.get({ url: origin });
          for (const cookie of originCookies) {
            if (cookieNames.includes(cookie.name)) {
              captured.push(cookie);
            }
          }
        }
        const material = buildCookieHeader(captured, cookieNames);
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
          browserSession.cookies.off("changed", onCookiesChanged);
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

        browserSession.cookies.on("changed", onCookiesChanged);
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
      await panelOrchestrator.closePanel(panel.id).catch(() => {});
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function readyElectronLaunchEvent(result: unknown): AppAvailableEvent | null {
  const launch =
    typeof result === "object" && result !== null
      ? (result as {
          status?: unknown;
          appId?: unknown;
          source?: unknown;
          artifactRoute?: unknown;
          capabilities?: unknown;
          buildKey?: unknown;
          effectiveVersion?: unknown;
          adoptionPolicy?: unknown;
        })
      : null;
  if (launch?.status !== "ready") return null;
  if (typeof launch.appId !== "string" || typeof launch.source !== "string") {
    log.warn("[apps] Electron host target is ready but did not include hosted app metadata");
    return null;
  }
  const artifactRoute =
    typeof launch.artifactRoute === "string" && isAppArtifactRoute(launch.artifactRoute)
      ? launch.artifactRoute
      : null;
  if (!artifactRoute) {
    log.warn("[apps] Electron host target is ready but did not include an app artifact route");
    return null;
  }
  const url = resolveElectronAppArtifactRoute(artifactRoute);
  if (!url) {
    return null;
  }
  return {
    appId: launch.appId,
    source: launch.source,
    target: "electron",
    url,
    ...(artifactRoute ? { artifactRoute } : {}),
    capabilities: Array.isArray(launch.capabilities)
      ? (launch.capabilities as import("@vibestudio/shared/unitManifest").AppCapability[])
      : [],
    buildKey: typeof launch.buildKey === "string" ? launch.buildKey : null,
    effectiveVersion: typeof launch.effectiveVersion === "string" ? launch.effectiveVersion : null,
    adoptionPolicy:
      launch.adoptionPolicy === "prompt" || launch.adoptionPolicy === "artifact-only"
        ? launch.adoptionPolicy
        : "immediate",
    selectedForHost: true,
  };
}

async function applyReadyElectronLaunchResult(result: unknown): Promise<boolean> {
  const event = readyElectronLaunchEvent(result);
  if (!event) return false;
  const appOrchestrator = applicationWindow.appOrchestrator;
  if (!appOrchestrator) {
    pendingReadyElectronLaunch = event;
    log.info(
      `[apps] Holding ready Electron host target until app host is initialized: ${event.appId}`
    );
    return false;
  }
  const launchKey = electronHostTargetKey(event);
  if (appliedElectronHostTargetKey === launchKey) {
    return true;
  }
  log.info(`[apps] Applying ready Electron host target: ${event.appId}`);
  await appOrchestrator.applyAppAvailable(event);
  appliedElectronHostTargetKey = launchKey;
  initializePanelTreeOnce("electron-host-ready");
  return true;
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

  if (change.event === "host-targets:changed") {
    const reason = payload?.["reason"];
    if (
      reason === "selection-changed" ||
      reason === "selection-cleared" ||
      reason === "app-removed"
    ) {
      return true;
    }
    return appliedElectronHostTargetKey === null;
  }

  if (change.event === "host-target-launch:session-changed") {
    return appliedElectronHostTargetKey === null;
  }

  return appliedElectronHostTargetKey === null;
}

function electronLaunchFromSessionResult(result: unknown): unknown | null {
  if (!result || typeof result !== "object") return null;
  const session = result as { target?: unknown; status?: unknown; launch?: unknown };
  if (session.target !== "electron" || session.status !== "ready") return null;
  return session.launch ?? null;
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
  log.info(`[apps] Applying held Electron host target: ${event.appId}`);
  await appOrchestrator.applyAppAvailable(event);
  appliedElectronHostTargetKey = launchKey;
  pendingReadyElectronLaunch = null;
  initializePanelTreeOnce("held-electron-host-ready");
}

function initializePanelTreeOnce(reason: string): void {
  if (panelTreeInitializationStarted) return;
  const orchestrator = panelOrchestrator;
  if (!orchestrator) return;
  panelTreeInitializationStarted = true;
  log.info(`[panels] Initializing panel tree after ${reason}`);
  orchestrator.initializePanelTree().catch((error) => {
    panelTreeInitializationStarted = false;
    console.error("[App] Failed to initialize panel tree:", error);
    eventService.emit("panel-initialization-error", {
      path: "",
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

function stopElectronHostTargetLaunchLoop(): void {
  if (!electronHostLaunchTimer) return;
  clearTimeout(electronHostLaunchTimer);
  electronHostLaunchTimer = null;
}

type ElectronHostTargetSyncResult = "adopted" | "blocked-by-approval" | "preparing" | "retry";

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
    const result = await serverClient.call("workspace", "hostTargets.launch", ["electron"]);
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
      return (await applyReadyElectronLaunchResult(result)) ? "adopted" : "retry";
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
    return "retry";
  } catch (error) {
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
  scheduleElectronHostTargetLaunch(serverClient);
}

function scheduleElectronHostTargetLaunch(
  serverClient: Pick<ServerClient, "call">,
  delayMs = 0
): void {
  if (electronHostLaunchTimer) return;
  electronHostLaunchTimer = setTimeout(() => {
    electronHostLaunchTimer = null;
    if (electronHostLaunchInFlight) return;
    electronHostLaunchInFlight = true;
    void syncElectronHostTarget(serverClient).finally(() => {
      electronHostLaunchInFlight = false;
    });
  }, delayMs);
}

function retryElectronHostTargetLaunchAfterApprovalChange(pending: PendingApproval[]): void {
  if (!electronHostLaunchBlockedByApproval) return;
  if (filterBootstrapApprovalsForTarget(pending, "electron").length > 0) return;
  const client = serverSession?.serverClient;
  if (!client) return;
  scheduleElectronHostTargetLaunch(client);
}

function retryElectronHostTargetLaunchAfterAppEvent(change: ServerHostTargetChangeEvent): void {
  if (!shouldSyncElectronHostTargetForChange(change)) return;
  const client = serverSession?.serverClient;
  if (!client) return;
  scheduleElectronHostTargetLaunch(client);
}

type BootstrapWorkspaceEntry = { name: string; lastOpened: number };

type BootstrapConnectionState = {
  mode: "choose-connection" | "starting" | "connected" | "failed";
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
  startupDetail: string | null;
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
      localWorkspaces: [],
      lastLocalWorkspaceName: null,
      isDev: isDev(),
      pendingPairLink,
      pendingPairConfirmed: startupInvocation.pendingPairConfirmed,
      startupError: bootstrapStartupError,
      serverLogPath: startupMode.kind === "local" ? getLocalHubLogPath() : null,
      startupDetail: bootstrapStartupDetail,
    };
  }
  const localWorkspaces = centralData.listWorkspaces().map((entry) => ({
    name: entry.name,
    lastOpened: entry.lastOpened,
  }));
  return {
    mode,
    localWorkspaces,
    lastLocalWorkspaceName: centralData.getLastOpenedWorkspace()?.name ?? null,
    isDev: isDev(),
    pendingPairLink,
    pendingPairConfirmed: startupInvocation.pendingPairConfirmed,
    startupError: bootstrapStartupError,
    serverLogPath: startupMode.kind === "local" ? getLocalHubLogPath() : null,
    startupDetail: bootstrapStartupDetail,
  };
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
    relaunchApp({
      args: retryWorkspaceIsEphemeral
        ? ephemeralWorkspaceRelaunchArgs()
        : retryWorkspaceName
          ? workspaceRelaunchArgs(retryWorkspaceName)
          : process.argv.slice(1),
    });
  });

  ipcMain.handle("vibestudio:bootstrap:choose-connection", (event) => {
    requireBootstrapShellSender(event, "vibestudio:bootstrap:choose-connection");
    relaunchApp({
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
      (startupMode.kind === "local" ? getLocalHubLogPath() : null);
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
  powerMonitor.on("resume", () => nudgeServerLiveness("system resume"));
  powerMonitor.on("unlock-screen", () => nudgeServerLiveness("screen unlock"));
  // Same recovery, awake path: the shell renderer forwards its `window` `online`
  // event so a network flap (e.g. Wi-Fi reassociate) probes the pipe promptly
  // instead of lingering on a stale "connected". NUDGE ONLY, never a teardown.
  ipcMain.on("vibestudio:shell.network-online", () => nudgeServerLiveness("network online"));
  ipcMain.on("vibestudio:shell.chrome-interactive-focus", (event, active: unknown) => {
    applicationWindow.viewManager?.setShellChromeInteractiveFocus(event.sender.id, active === true);
  });
  installBootstrapConnectionHandlers();
  // npm-channel update notice — no-ops unless launched from a global npm install
  // (the launcher sets VIBESTUDIO_NPM_CHANNEL); notification-first, never self-updates.
  void maybeNotifyNpmUpdate();

  // Default to browser CORS. For panel fetch/XHR responses, relax CORS only
  // after the trusted shell approval flow grants that panel access to the
  // target origin. Browser panels use a separate "persist:browser" partition
  // and are unaffected.
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
  ]);

  const capabilityForElectronPermission = (
    permission: string
  ): import("@vibestudio/shared/unitManifest").AppCapability | null => {
    switch (permission) {
      case "notifications":
        return "notifications";
      case "openExternal":
        return "open-external";
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
    const viewInfo = viewId ? viewManager.getViewInfo(viewId) : null;
    // Keep the request and check handlers consistent: Chromium may consult the
    // check handler before it reaches the request handler.
    if (permission === "fullscreen" && viewInfo?.type === "browser") return true;
    return appWebContentsHasPermissionCapability(contents, permission);
  };

  const installPermissionHandlers = (targetSession: Session): void => {
    targetSession.setPermissionRequestHandler((contents, permission, callback) => {
      if (SENSITIVE_PERMISSIONS.has(permission)) {
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
    targetSession.setPermissionCheckHandler((contents, permission) => {
      if (SENSITIVE_PERMISSIONS.has(permission)) {
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

  // Auto-update check (production only)
  if (!isDev()) {
    try {
      // Dynamic import to avoid bundling electron-updater in development
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { autoUpdater } = require("electron-updater") as {
        autoUpdater: {
          logger: unknown;
          autoDownload: boolean;
          autoInstallOnAppQuit: boolean;
          on: (
            event: string,
            callback: (info: { version?: string; message?: string }) => void
          ) => void;
          checkForUpdates: () => Promise<unknown>;
          downloadUpdate: () => Promise<unknown>;
          quitAndInstall: () => void;
        };
      };

      autoUpdater.logger = {
        info: (msg: string) => console.log(`[AutoUpdater] ${msg}`),
        warn: (msg: string) => console.warn(`[AutoUpdater] ${msg}`),
        error: (msg: string) => console.error(`[AutoUpdater] ${msg}`),
        debug: (msg: string) => console.log(`[AutoUpdater:debug] ${msg}`),
      };
      autoUpdater.autoDownload = false; // Don't auto-download, let user decide
      autoUpdater.autoInstallOnAppQuit = true;
      desktopAutoUpdater = autoUpdater;

      autoUpdater.on("update-available", (info: { version?: string }) => {
        console.log(`[AutoUpdater] Update available: ${info.version}`);
        eventService.emit("notification:show", {
          id: "desktop-update-available",
          type: "info",
          title: `Vibestudio ${info.version ?? "update"} is available`,
          message: "Download it now and keep working while it prepares in the background.",
          ttl: 0,
          actions: [
            {
              id: "desktop-update-download",
              label: "Download update",
              variant: "solid",
              command: { type: "desktop.downloadUpdate" },
            },
          ],
        });
      });

      autoUpdater.on("update-downloaded", (info: { version?: string }) => {
        console.log(`[AutoUpdater] Update downloaded: ${info.version}`);
        eventService.emit("notification:show", {
          id: "desktop-update-ready",
          type: "success",
          title: "Update ready to install",
          message: `Restart Vibestudio to install ${info.version ?? "the update"}.`,
          ttl: 0,
          actions: [
            {
              id: "desktop-update-install",
              label: "Restart and install",
              variant: "solid",
              command: { type: "desktop.installUpdate" },
            },
          ],
        });
      });

      autoUpdater.on("error", (error: { message?: string }) => {
        console.warn(`[AutoUpdater] Error: ${error.message}`);
        eventService.emit("notification:show", {
          id: "desktop-update-error",
          type: "error",
          title: "App update failed",
          message: error.message ?? "The update could not be prepared.",
          ttl: 0,
        });
      });

      // Check for updates (non-blocking)
      autoUpdater.checkForUpdates().catch((err: Error) => {
        console.warn(`[AutoUpdater] Failed to check for updates: ${err.message}`);
      });
    } catch {
      // electron-updater not available or failed to load - this is fine in development
      console.log("[AutoUpdater] Not available (this is normal in development)");
    }
  }

  // A persisted WebRTC remote pairing skips the chooser: establishServerSession
  // dials it over the pipe regardless of the (pending/local) startup mode.
  // `--skip-remote-pairing` (set by the recovery chooser) suppresses auto-dial
  // for one launch so a failed remote connect lands on the chooser, not a re-dial loop.
  const skipRemotePairingLaunch = startupInvocation.skipRemotePairing;
  const storedRemoteAtLaunch = loadStoredRemotePairing();
  remotePairedAtLaunch = storedRemoteAtLaunch !== null && !skipRemotePairingLaunch;

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
      // Resolve (creating if missing) the chosen local workspace in-process and
      // promote `startupMode` to local so the connected setup spawns its server.
      retryWorkspaceName = choice.name;
      retryWorkspaceIsEphemeral = choice.ephemeral;
      if (choice.ephemeral) {
        startupMode = resolveEphemeralDevStartupMode();
        workspaceId = startupMode.workspaceId;
        log.info(`[bootstrap] Ephemeral workspace chosen: ${workspaceId}`);
      } else {
        let startup: ReturnType<typeof resolveLocalWorkspaceStartup>;
        try {
          startup = resolveLocalWorkspaceStartup({
            appRoot: getAppRoot(),
            centralData,
            name: choice.name,
            init: true,
          });
        } catch (error) {
          bootstrapWorkspaceRpcReady = false;
          bootstrapStartupError = {
            message: `Could not open workspace “${choice.name}”: ${
              error instanceof Error ? error.message : String(error)
            }`,
            detail: formatUnknownError(error),
          };
          return;
        }
        const autoApproveStartupUnits =
          process.env["VIBESTUDIO_AUTO_APPROVE_STARTUP_UNITS"] === "1" || startup.resolved.created;
        startupMode = {
          kind: "local",
          wsDir: startup.resolved.wsDir,
          workspaceName: startup.resolved.name,
          workspaceId: startup.resolved.workspace.config.id,
          isEphemeral: false,
          autoApproveStartupUnits,
        };
        workspaceId = startupMode.workspaceId;
        log.info(`[bootstrap] Local workspace chosen: ${workspaceId} (${startupMode.wsDir})`);
      }
    } else {
      // Remote: leave startupMode pending; the fresh pairing becomes the session.
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
      relaunchApp({ args });
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
    getAppOrchestrator: () => applicationWindow.appOrchestrator,
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
    resolveAppAvailableEvent: resolveElectronAppAvailablePayload,
    onApprovalPendingChanged: (pending) => {
      approvalAttention?.handlePendingChanged(pending);
      retryElectronHostTargetLaunchAfterApprovalChange(pending);
    },
    onCredentialCaptureRequest: (payload) =>
      handleCredentialSessionCaptureRequest(payload as CredentialSessionCaptureRequest),
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
    bootstrapStartupDetail = isRemoteSession
      ? `Connecting to ${remoteHost || "the paired server"}…`
      : startupMode.kind === "local"
        ? `Starting local workspace “${startupMode.workspaceName}”…`
        : null;

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
        pendingPairing: pendingRemotePairing ?? undefined,
        pendingPairLabel: readPendingPairLabel(),
        skipStoredRemote: skipRemotePairingLaunch,
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
    await serverEventSubscriptions.retainAll([
      "build:complete",
      "apps:available",
      "apps:status",
      "extensions:status",
      "host-targets:changed",
      HOST_TARGET_LAUNCH_SESSION_CHANGED_EVENT,
      "external-open:open",
      "browser-panel:open",
      "panel-tree-updated",
      "panel-title-updated",
      "panel:runtimeLeaseChanged",
      "shell-approval:pending-changed",
      "credential:capture-request",
    ]);
    // Seed badge/seen-set from approvals already pending at launch without
    // firing OS notifications for them — the bar shows them once the shell
    // window is up.
    void approvalAttention?.refresh({ quiet: true });
    workspaceId = serverSession.workspaceId;

    performance.mark("startup:server-spawned");
    performance.mark("startup:server-connected");

    applicationWindow.setTitle(`Vibestudio — ${workspaceId}`);

    // The shell always spawns its own loopback server (ServerProcessManager
    // manages its lifecycle), so there is no out-of-process server to /healthz-
    // poll. Remote topology is WebRTC, whose own liveness lives in the transport.

    // Create PanelRegistry (pure in-memory — server owns persistence)
    panelRegistry = new PanelRegistry({
      onTreeUpdated: (snapshot) => eventService.emit("panel-tree-updated", snapshot),
    });

    const { createElectronShellCore } = await import("./shellCore/createElectronShellCore.js");
    shellCore = createElectronShellCore({
      statePath: serverSession.statePath,
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
      getShellWebContents: () => applicationWindow.viewManager?.getShellWebContents() ?? null,
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
      getCodeIdentityForCaller: (callerId) => {
        const viewInfo = applicationWindow.viewManager?.getViewInfo(callerId);
        if (viewInfo?.type !== "app") return null;
        const identity = viewInfo.appIdentity;
        if (!identity?.source || !identity.effectiveVersion) return null;
        return {
          callerId,
          callerKind: "app",
          repoPath: identity.source,
          effectiveVersion: identity.effectiveVersion,
        };
      },
      getWebContentsForCaller: (callerId) =>
        applicationWindow.viewManager?.getWebContents(callerId) ?? null,
      getPanelRuntimeConnection: (panelId) => panelOrchestrator?.getPanelRuntimeConnection(panelId),
      authorizeAppServerCall,
      onServerRpcResult: async ({ service, method, args, result }) => {
        if (service === "workspace" && method === "hostTargets.launch" && args[0] === "electron") {
          await applyReadyElectronLaunchResult(result);
          return;
        }
        if (
          service === "workspace" &&
          (method === "hostTargets.beginLaunch" ||
            method === "hostTargets.resolveLaunchSessionApproval" ||
            method === "hostTargets.getLaunchSession")
        ) {
          const launch = electronLaunchFromSessionResult(result);
          if (launch) await applyReadyElectronLaunchResult(launch);
        }
      },
    });
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
    const panelPinStore = IS_HEADLESS_HOST
      ? undefined
      : new PanelPinStore(
          path.join(
            startupMode.kind === "local"
              ? path.join(startupMode.wsDir, "state")
              : app.getPath("userData"),
            "panel-pins.json"
          )
        );

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
      sendPanelEvent: (panelId, event, payload) => {
        const wc = applicationWindow.viewManager?.getWebContents(panelId);
        if (wc && !wc.isDestroyed()) {
          wc.send("vibestudio:event", event, payload);
        }
      },
      workspaceConfig: conn.workspaceConfig,
      pinStore: panelPinStore,
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
      void panelLogClient.append(batch).catch(() => {});
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
      authToken: () => conn.getCdpAuthToken(),
      hostConnectionId: cdpHostConnectionId,
      getViewManager: () => applicationWindow.viewManager,
      socketFactory:
        conn.connectionMode === "remote"
          ? () =>
              new RemoteCdpHostProviderSocket({
                serverClient: conn.serverClient,
                hostConnectionId: cdpHostConnectionId,
              })
          : undefined,
      diagnosticsStore: new RuntimeDiagnosticsStore({
        statePath: serverSession.statePath,
      }),
      forwardDiagnostic: forwardPanelDiagnostic,
      onHostCommand: async (panelId, action, args) => {
        if (action === "openDevTools") {
          const viewManager = applicationWindow.viewManager;
          if (!viewManager) throw new Error("ViewManager not initialized");
          const mode = args[0] === "right" || args[0] === "bottom" ? args[0] : "detach";
          viewManager.openDevTools(panelId, mode);
          return null;
        }
        if (action === "rebuildPanel") {
          return panelOrchestrator?.rebuildPanel(panelId) ?? null;
        }
        if (action === "rebuildAndReload") {
          return panelOrchestrator?.rebuildAndReloadPanel(panelId) ?? null;
        }
        if (action === "reloadPanel") {
          return panelOrchestrator?.reloadPanel(panelId) ?? null;
        }
        // navigatePanel / navigatePanelHistory host commands were removed: the
        // server is the sole panel-tree writer (panelManager.navigate /
        // navigateHistory) and broadcasts; the desktop reloads views reactively
        // (panelOrchestrator.applyServerPanelTreeSnapshot reconcile).
        if (action === "accessibilityTree") {
          if (!cdpHostProvider) throw new Error("CDP host provider not initialized");
          return cdpHostProvider.getAccessibilityTree(panelId);
        }
        if (action === "domSnapshot") {
          if (!cdpHostProvider) throw new Error("CDP host provider not initialized");
          return cdpHostProvider.getDomSnapshot(panelId);
        }
        if (action === "consoleHistory") {
          if (!cdpHostProvider) throw new Error("CDP host provider not initialized");
          return cdpHostProvider.getConsoleHistory(
            panelId,
            (args[0] as import("./cdpHostProvider.js").PanelConsoleHistoryOptions | undefined) ??
              undefined
          );
        }
        if (action === "captureScreenshot") {
          if (!cdpHostProvider) throw new Error("CDP host provider not initialized");
          return cdpHostProvider.captureScreenshot(
            panelId,
            (args[0] as { format?: string; quality?: number } | undefined) ?? {}
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

    // Autofill manager — password auto-fill for browser panels
    const { AutofillManager } = await import("./autofill/autofillManager.js");

    // Register all Electron-main RPC services via ServiceContainer. Window-owned
    // hosts are resolved from their lifecycle owner when an RPC is invoked.
    const getPanelView = (): PanelView => {
      const panelView = applicationWindow.panelView;
      if (!panelView) throw new Error("PanelView not initialized yet");
      return panelView;
    };
    const getViewManager = () => assertPresent(applicationWindow.viewManager);

    const { createAppService } = await import("./services/appService.js");
    const { createPanelShellService } = await import("./services/panelShellService.js");
    const { createViewService } = await import("./services/viewService.js");
    const { createPaletteService } = await import("./services/paletteService.js");
    const { createMenuService } = await import("./services/menuService.js");
    const { createNotificationService } = await import("./services/notificationService.js");
    const { createSettingsService } = await import("./services/settingsService.js");
    const { createAdblockService } = await import("./services/adblockService.js");
    // FS and git-local services removed — server owns these via panel service
    const { createBrowserDataClient } = await import("@vibestudio/browser-data");

    const electronContainer = new ServiceContainer(dispatcher);

    const { serverClient: sc } = conn;

    // Shell-only services
    electronContainer.registerRpc(
      createAppService({
        panelOrchestrator,
        serverClient: sc,
        getViewManager,
        getAppOrchestrator: () => applicationWindow.appOrchestrator,
        connectionMode: conn.connectionMode,
        remoteHost: undefined,
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
      createPanelShellService({
        panelOrchestrator,
        panelRegistry,
        get panelView(): PanelView {
          return getPanelView();
        },
        getViewManager,
        serverClient: sc,
      })
    );
    electronContainer.registerRpc(createViewService({ getViewManager }));
    electronContainer.registerRpc(createPaletteService({ panelOrchestrator, getViewManager }));
    electronContainer.registerRpc(
      createMenuService({
        panelOrchestrator,
        panelRegistry,
        getViewManager,
        serverClient: sc,
      })
    );
    electronContainer.registerRpc(
      createNotificationService({
        eventService,
        getViewManager,
        onAction: async (_id, actionId) => {
          if (actionId === "desktop-update-download") {
            if (!desktopAutoUpdater) throw new Error("Desktop updater is unavailable");
            await desktopAutoUpdater.downloadUpdate();
          } else if (actionId === "desktop-update-install") {
            if (!desktopAutoUpdater) throw new Error("Desktop updater is unavailable");
            desktopAutoUpdater.quitAndInstall();
          } else if (actionId.startsWith("oauth-cancel:")) {
            const transactionId = actionId.slice("oauth-cancel:".length);
            const client = serverClientRef;
            if (!client) throw new Error("The server connection is unavailable");
            await client.call("credentials", "cancelOAuth", [{ transactionId }]);
          }
        },
      })
    );
    // Current-workspace operations route to the selected child. Server-wide
    // catalog/account control routes to the stable hub through the host service
    // above; the child is never a control-plane deputy.
    electronContainer.registerRpc(createSettingsService({ serverClient: sc, getViewManager }));
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
    electronContainer.registerRpc(
      createPhoneProvisioningService({
        appRoot: getAppUnpackedRoot(),
        appVersion: app.getVersion(),
        resolveScriptPath: (name) => getPhysicalAppPath(path.join("scripts", "cli", name)),
      })
    );
    electronContainer.registerRpc(createAdblockService({ adBlockManager }));
    // Browser-data persistence lives on the server; Electron keeps only the
    // host-bound autofill adapter.
    {
      electronContainer.registerManaged({
        name: "browser-data-host",
        async start() {
          const browserDataClient = createBrowserDataClient(sc);
          browserDataStoreForCredentialCapture = browserDataClient;
          autofillManager = new AutofillManager({
            passwordStore: browserDataClient,
            eventService,
            getViewManager,
            autofillOverlayPreloadPath: path.join(__dirname, "autofillOverlayPreload.cjs"),
          });
          return browserDataClient;
        },
        async stop() {
          browserDataStoreForCredentialCapture = null;
          if (autofillManager) {
            autofillManager.destroy();
            autofillManager = null;
          }
        },
      });
      const { createBrowserSessionSyncService } = await import("./services/browserSessionSync.js");
      electronContainer.registerManaged(
        createBrowserSessionSyncService({
          serverClient: sc,
          browserDataClient: createBrowserDataClient(sc),
        })
      );
    }

    // Register autofill service (uses lazy resolution since autofillManager is created in browser-data start)
    const invokeAutofill = (
      ctx: ServiceContext,
      method: keyof typeof autofillMethods,
      args: unknown[]
    ): Promise<unknown> => {
      if (
        ctx.caller.runtime.kind === "panel" &&
        ctx.caller.code?.repoPath !== "about/credentials"
      ) {
        throw new Error("Only the trusted Credentials page may manage browser passwords");
      }
      if (!autofillManager) throw new Error("Autofill not initialized");
      return autofillManager.getServiceDefinition().handler(ctx, method, args);
    };
    electronContainer.registerRpc({
      name: "autofill",
      description: "Password autofill management",
      policy: { allowed: ["shell", "panel"] },
      methods: autofillMethods,
      handler: defineServiceHandler("autofill", autofillMethods, {
        confirmSave: (ctx, args) => invokeAutofill(ctx, "confirmSave", args),
        listSavedPasswords: (ctx, args) => invokeAutofill(ctx, "listSavedPasswords", args),
        deleteSavedPassword: (ctx, args) => invokeAutofill(ctx, "deleteSavedPassword", args),
        listNeverSaveOrigins: (ctx, args) => invokeAutofill(ctx, "listNeverSaveOrigins", args),
        removeNeverSaveOrigin: (ctx, args) => invokeAutofill(ctx, "removeNeverSaveOrigin", args),
      }),
    });
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
        createEventsServiceDefinition(eventService, {
          snapshots: {
            "panel-tree-updated": () => panelRegistry?.getPanelTreeSnapshot(),
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

    const codeIdentityForCallerId = (callerId: string) => {
      const viewInfo = applicationWindow.viewManager?.getViewInfo(callerId);
      if (viewInfo?.type !== "app") return null;
      const identity = viewInfo.appIdentity;
      if (!identity?.source || !identity.effectiveVersion) return null;
      return {
        callerId,
        callerKind: "app" as const,
        repoPath: identity.source,
        effectiveVersion: identity.effectiveVersion,
      };
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

    ipcMain.handle("vibestudio:focusPanel", async (event, panelId: string) => {
      requireAppCapabilityForIpc(event, "panel-hosting", "vibestudio:focusPanel");
      assertPresent(panelOrchestrator).focusPanel(panelId);
    });
    ipcMain.handle("vibestudio:bridge.getInfo", async (event) => {
      const callerId = resolveCallerId(event);
      return shellCore?.panelManager.getInfo(asPanelSlotId(callerId));
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
      return dispatcher.dispatch(
        { caller: createVerifiedCaller(callerId, callerKind, codeIdentityForCallerId(callerId)) },
        parsed.service,
        parsed.method,
        args
      );
    });
    ipcMain.handle("vibestudio:isLocalService", (event, service: unknown) => {
      const { callerKind } = resolveCaller(event);
      if (callerKind !== "shell" && callerKind !== "app" && callerKind !== "panel") return false;
      return typeof service === "string" && dispatcher.routesToHost(service, callerKind);
    });

    // Workspace RPC is now registered; the bootstrap shell may leave its
    // starting state and open the startup approval gate.
    bootstrapWorkspaceRpcReady = true;
    applicationWindow.attachWorkspaceServices({
      panelRegistry,
      panelOrchestrator,
      serverSession: conn,
      cdpHost: createCdpRegistrationAdapter(),
      autofillManager,
    });
    if (IS_HEADLESS_HOST) {
      performance.mark("startup:window-created");
    }
    applicationWindow.create();

    performance.mark("startup:workspace-window-attached");

    // Log startup timing in dev mode
    if (isDev()) {
      performance.measure("startup:total", "startup:ready", "startup:window-created");
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
        "startup:window-created"
      );
      const entries = performance
        .getEntriesByType("measure")
        .filter((e) => e.name.startsWith("startup:"));
      for (const entry of entries) {
        console.log(`[Perf] ${entry.name}: ${Math.round(entry.duration)}ms`);
      }
    }

    // Defer ad-block initialization (non-critical, ~500-1000ms).
    // The onBeforeRequest handler has a !this.engine fast path that passes requests through.
    setTimeout(async () => {
      try {
        await adBlockManager.initialize();
        adBlockManager.enableForSession(session.defaultSession);
        console.log("[AdBlock] Initialized and enabled for default session");
      } catch (error) {
        console.warn("[AdBlock] Failed to initialize (non-fatal):", error);
      }
    }, 100);
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
      bootstrapWorkspaceRpcReady = false;
      bootstrapStartupError = {
        message: remoteStartupFailed
          ? `Could not connect to the paired server: ${message}`
          : `Could not start the workspace: ${message}`,
        detail: remoteStartupFailed
          ? "The saved pairing was kept unless the server rejected it. Check the server or choose another workspace."
          : "Retry the startup, or choose another server or workspace.",
        ...(startupMode.kind === "local" ? { logPath: getLocalHubLogPath() } : {}),
      };
      remotePairedAtLaunch = false;
      log.error(`[bootstrap] Startup failed; keeping recovery window open: ${message}`);
      return;
    }
    if (IS_HEADLESS_HOST) {
      writeHeadlessStartupError(
        error,
        startupMode.kind === "local" ? startupMode.wsDir : undefined
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
// `keepServerOnQuit` field). Decided here, consumed by the will-quit cleanup.
let serverQuitDecision: "stop" | "keep" | null = null;

app.on("before-quit", (event) => {
  if (serverQuitDecision !== null || isCleaningUp) return;
  const conn = serverSession;
  if (!conn || conn.serverOwnership !== "desktop-local" || !conn.hubProcessManager) {
    // Remote/external server: nothing desktop-owned to stop.
    serverQuitDecision = "keep";
    return;
  }
  // Remembered choice: honor it. With no preference, keep the detached server;
  // its idle monitor reaps it automatically when no clients or work remain.
  const remembered = centralData.getKeepServerOnQuit();
  if (remembered !== null) {
    serverQuitDecision = remembered ? "keep" : "stop";
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
    serverQuitDecision = keep ? "keep" : "stop";
    app.quit();
  })();
});

// Use will-quit with preventDefault to properly await async shutdown
app.on("will-quit", (event) => {
  // Prevent re-entry - if we're already cleaning up, let the app exit
  if (isCleaningUp) {
    return;
  }

  const hasResourcesToClean = serverSession || cdpHostProvider;
  if (!hasResourcesToClean) return;
  isCleaningUp = true;
  event.preventDefault();

  console.log("[App] Shutting down...");

  const stopPromises: Promise<void>[] = [];

  // Server client (device-paired WS connection) + the detached hub process
  if (serverSession) {
    // Run panel cleanup via server (archive childless shell panels), then
    // stop-or-detach the local server and close the connection.
    const session = serverSession;
    serverSession = null;
    const stopServer =
      session.serverOwnership === "desktop-local" &&
      session.hubProcessManager !== null &&
      serverQuitDecision !== "keep";

    const cleanupThenClose = (async () => {
      if (panelRegistry && shellCore) {
        const livePanelIds = panelRegistry.listPanels().map((p) => asPanelSlotId(p.panelId));
        await shellCore.panelManager
          .shutdownCleanup(livePanelIds)
          .catch((e: unknown) => console.error("[App] Failed to run shutdown cleanup:", e));
      }
      await panelOrchestrator
        ?.unregisterRuntimeClient()
        .catch((e: unknown) => console.error("[App] Failed to unregister runtime client:", e));
      if (stopServer) {
        await assertPresent(session.hubProcessManager)
          .stop()
          .then(() => console.log("[App] Hub stopped"))
          .catch((e) => console.error("[App] Hub stop error:", e));
      } else {
        // Keep: leave the detached process running; the attachment record stays
        // so the next launch reattaches instantly.
        session.hubProcessManager?.detach();
        if (session.hubProcessManager) console.log("[App] Hub left running (detached)");
      }
      await session.close().catch((e) => console.error("[App] Session close error:", e));
    })();
    stopPromises.push(cleanupThenClose);
  }

  if (cdpHostProvider) {
    cdpHostProvider.stop();
    cdpHostProvider = null;
  }

  // Add a timeout to ensure we exit even if cleanup hangs
  const shutdownTimeout = setTimeout(() => {
    console.warn("[App] Shutdown timeout - forcing exit");
    app.exit(1);
  }, APP_SHUTDOWN_TIMEOUT_MS);

  Promise.all(stopPromises).finally(() => {
    shellCore?.shutdown?.();
    shellCore = null;
    cleanupNativeWebRtc();
    clearTimeout(shutdownTimeout);
    console.log("[App] Shutdown complete");
    app.exit(0);
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
    void shellCore?.panelManager.notifyFocused(asPanelSlotId(focusedPanelId)).catch(() => {});
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
