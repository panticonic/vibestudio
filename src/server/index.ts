/**
 * vibestudio-server — the standalone Vibestudio server entry point.
 *
 * Starts all headless-capable services (Build V2, Git, workspace services, RPC).
 * Parses CLI args (config may also arrive via env vars from a spawning desktop
 * shell), reports readiness to stdout + an optional --ready-file, and shuts
 * down on SIGTERM/SIGINT (or the shell-gated hostLifecycle.shutdown RPC).
 *
 * Two-phase bootstrap: env vars are set synchronously first, then app
 * modules are loaded inside an async main() to avoid top-level await
 * (which conflicts with bundled CJS __dirname references in Node ≥25).
 */

import * as path from "path";
import * as fs from "fs";
import { execFile } from "node:child_process";
import { createServerLogStore } from "./services/serverLogStore.js";
import type { AppCapability } from "@vibestudio/shared/unitManifest";
import { GIT_INTEROP_PROVIDER_METHOD_NAMES } from "@vibestudio/shared/serviceSchemas/gitInterop";
import { createHash, randomBytes } from "crypto";
import { canonicalEntityId, type EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { registerBuildProvider, unregisterBuildProvider } from "./buildV2/buildProviderRegistry.js";
import { RuntimeDiagnosticsStore } from "./runtimeDiagnosticsStore.js";
import { assertPresent, deleteDynamicProperty } from "../lintHelpers";
import { resolveHeadlessHostAutospawn } from "./headlessHostAutospawn.js";
import { resolveDependencyWorkspaceRoot } from "./dependencyWorkspaceRoot.js";
import { createGitInteropProviderInvoker } from "./gitInteropProviderInvoker.js";

// __filename is available natively in CJS and via the esbuild banner shim in ESM.
declare const __filename: string;

type HeartbeatRegistryControlRow = {
  name: string;
  source: string;
  className: string;
  objectKey: string;
  channelId?: string | null;
  participantHandle?: string | null;
};

type HeartbeatControlSelector =
  | string
  | {
      name?: string;
      target?: { source?: string; className?: string; objectKey?: string };
      channelId?: string;
      participantHandle?: string;
    };

function resolveHeartbeatRegistryRow(
  rows: HeartbeatRegistryControlRow[],
  selector: HeartbeatControlSelector
): HeartbeatRegistryControlRow | null {
  if (typeof selector === "string") {
    const matches = rows.filter((row) => row.name === selector);
    if (matches.length > 1) {
      throw new Error(`Ambiguous heartbeat selector: ${JSON.stringify(selector)}`);
    }
    return matches[0] ?? null;
  }
  const matches = rows.filter((row) => {
    if (selector.name && row.name !== selector.name) return false;
    if (selector.channelId && row.channelId !== selector.channelId) return false;
    if (selector.participantHandle && row.participantHandle !== selector.participantHandle) {
      return false;
    }
    const target = selector.target;
    if (target?.source && row.source !== target.source) return false;
    if (target?.className && row.className !== target.className) return false;
    if (target?.objectKey && row.objectKey !== target.objectKey) return false;
    return true;
  });
  if (matches.length > 1) {
    throw new Error(`Ambiguous heartbeat selector: ${JSON.stringify(selector)}`);
  }
  return matches[0] ?? null;
}

// =============================================================================
// Phase A: Synchronous preamble — parse CLI args OR inherit env vars
// =============================================================================

interface CliArgs {
  workspaceName?: string;
  workspaceDir?: string;
  appRoot?: string;
  logLevel?: string;
  readyFile?: string;
  ephemeral?: boolean;
  servePanels?: boolean;
  gatewayPort?: number;
  panelPort?: number;
  init?: boolean;
  host?: string;
  bindHost?: string;
  printCredentials?: boolean;
  requireMobileReady?: boolean;
  requireElectronReady?: boolean;
  headlessHostAutospawn?: boolean;
  help?: boolean;
}

function printHelp(): void {
  console.log(`
vibestudio-server — Headless and standalone Vibestudio server

Usage:
  vibestudio-server [options]
  pnpm server:live [options]
  node dist/server.mjs [options]

Options:
  --app-root <path>        Application root directory (default: cwd)
  --ready-file <path>      Write structured readiness JSON to this file
  --ephemeral              Use a disposable dev workspace (deleted on shutdown)
  --host <hostname>        External hostname (also sets bind to 0.0.0.0)
  --bind-host <addr>       Explicit bind address (default: 127.0.0.1, or 0.0.0.0 with --host)
  --serve-panels           Enable panel HTTP serving
  --gateway-port <port>    Port for the gateway HTTP/WS ingress (default: auto-assigned)
  --panel-port <port>      Port for panel HTTP (default: auto-assigned)
  --log-level <level>      Log verbosity
  --print-credentials      Print VIBESTUDIO_ADMIN_TOKEN and VIBESTUDIO_PAIRING_CODE for scripting
  --require-mobile-ready   Fail startup unless the workspace React Native app can be
                           built and served to native mobile clients.
  --require-electron-ready Fail startup unless the workspace Electron shell app can be
                           built and served to desktop clients.
  --help                   Show this help message and exit

Environment variables:
  VIBESTUDIO_ADMIN_TOKEN     Use a stable admin token instead of generating a random one
  VIBESTUDIO_HOST            External hostname (same as --host)
  VIBESTUDIO_BIND_HOST       Explicit bind address (same as --bind-host)
  VIBESTUDIO_GATEWAY_PORT    Gateway ingress port (same as --gateway-port)
  VIBESTUDIO_APP_ROOT        Application root (same as --app-root)
  VIBESTUDIO_LOG_LEVEL       Log verbosity (same as --log-level)
`);
}

function parsePort(value: string | undefined, label: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`${label} must be an integer from 1 to 65535`);
    process.exit(1);
  }
  return port;
}

function parseEnvPort(name: string): number | undefined {
  const value = process.env[name];
  if (value == null || value === "") return undefined;
  return parsePort(value, name);
}

function printReadinessActionBlock(title: string, lines: string[]): void {
  const divider = "=".repeat(72);
  console.log("");
  console.log(divider);
  console.log(`  ACTION NEEDED — ${title}`);
  console.log(divider);
  for (const line of lines) {
    console.log(line ? `  ${line}` : "");
  }
  console.log(`${divider}\n`);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  const known = new Set([
    "workspace",
    "workspace-dir",
    "app-root",
    "ready-file",
    "ephemeral",
    "log-level",
    "serve-panels",
    "gateway-port",
    "panel-port",
    "init",
    "host",
    "bind-host",
    "print-credentials",
    "require-mobile-ready",
    "require-electron-ready",
    "headless-host-autospawn",
    "help",
  ]);
  /** Flags that don't take a value */
  const booleanFlags = new Set([
    "serve-panels",
    "ephemeral",
    "init",
    "print-credentials",
    "require-mobile-ready",
    "require-electron-ready",
    "headless-host-autospawn",
    "help",
  ]);

  for (let i = 0; i < argv.length; i++) {
    const arg = assertPresent(argv[i]);
    let key: string;
    let value: string | undefined;

    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        key = arg.slice(2, eqIdx);
        value = arg.slice(eqIdx + 1);
      } else {
        key = arg.slice(2);
        if (booleanFlags.has(key)) {
          // Boolean flag: no value consumed
          value = undefined;
        } else {
          value = argv[i + 1];
          if (value !== undefined && !value.startsWith("--")) {
            i++;
          } else {
            console.error(`Missing value for --${key}`);
            process.exit(1);
          }
        }
      }
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }

    if (!known.has(key)) {
      console.error(`Unknown flag: --${key}`);
      process.exit(1);
    }

    switch (key) {
      case "workspace":
        args.workspaceName = value;
        break;
      case "workspace-dir":
        args.workspaceDir = value;
        break;
      case "app-root":
        args.appRoot = value;
        break;
      case "ready-file":
        args.readyFile = value;
        break;
      case "log-level":
        args.logLevel = value;
        break;
      case "serve-panels":
        args.servePanels = true;
        break;
      case "ephemeral":
        args.ephemeral = true;
        break;
      case "init":
        args.init = true;
        break;
      case "gateway-port":
        args.gatewayPort = parsePort(value, "--gateway-port");
        break;
      case "panel-port":
        args.panelPort = parsePort(value, "--panel-port");
        break;
      case "host":
        args.host = value;
        break;
      case "bind-host":
        args.bindHost = value;
        break;
      case "print-credentials":
        args.printCredentials = true;
        break;
      case "require-mobile-ready":
        args.requireMobileReady = true;
        break;
      case "headless-host-autospawn":
        args.headlessHostAutospawn = value !== "off" && value !== "0" && value !== "false";
        break;
      case "require-electron-ready":
        args.requireElectronReady = true;
        break;
      case "help":
        args.help = true;
        break;
    }
  }

  return args;
}

const args: CliArgs = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}
// Capture the host's own log stream from the very start (before main() loads
// app modules) so startup logs land in the serverLog service's ring buffer.
const serverLogStore = createServerLogStore();
const serverLogStartedAt = Date.now();
serverLogStore.installConsoleCapture();
process.env["VIBESTUDIO_APP_ROOT"] =
  args.appRoot ?? process.env["VIBESTUDIO_APP_ROOT"] ?? process.cwd();
if (args.logLevel) process.env["VIBESTUDIO_LOG_LEVEL"] = args.logLevel;

// =============================================================================
// Phase B: Async main — load app modules, initialize services
// =============================================================================

async function main() {
  const { getUserDataPath, setUserDataPath } = await import("@vibestudio/env-paths");
  const { loadCentralEnv, deleteWorkspaceDir } =
    await import("@vibestudio/shared/workspace/loader");
  const { loadPersistedAdminToken, savePersistedAdminToken, getAdminTokenPath } =
    await import("@vibestudio/shared/centralAuth");
  const { resolveLocalWorkspaceStartup } = await import("@vibestudio/shared/workspace/startup");
  const { CentralDataManager } = await import("@vibestudio/shared/centralData");
  const { TokenManager } = await import("@vibestudio/shared/tokenManager");
  const { ServiceDispatcher } = await import("@vibestudio/shared/serviceDispatcher");
  const { EventService, createEventsServiceDefinition } =
    await import("@vibestudio/shared/eventsService");
  const { getExistingAppNodeModulesRoots } = await import("@vibestudio/shared/runtimePaths");
  const eventService = new EventService();
  const { RpcServer } = await import("./rpcServer.js");
  const { ServiceContainer } = await import("@vibestudio/shared/serviceContainer");
  const { initBuildSystemV2 } = await import("./buildV2/index.js");

  loadCentralEnv();

  // ===========================================================================
  // Internal workspace runtime resolution
  // ===========================================================================
  // Public standalone startup always runs the server hub. Workspace selection
  // happens through paired clients. The flags below are a private contract for
  // Electron and hub-managed child runtimes after a workspace has been selected.

  const appRoot = process.env["VIBESTUDIO_APP_ROOT"] ?? process.cwd();
  // The server always owns workspace metadata (~/.config/vibestudio/data.json).
  // The desktop shell also writes it (chooser bookkeeping, attachment records);
  // whole-file last-writer-wins is accepted for this single-user product.
  const centralData = new CentralDataManager();
  const isWorkspaceServer = process.env["VIBESTUDIO_FORCE_WORKSPACE_SERVER"] === "1";

  if (!isWorkspaceServer) {
    const forbiddenWorkspaceSelection =
      args.workspaceName ||
      args.workspaceDir ||
      args.init ||
      process.env["VIBESTUDIO_WORKSPACE"] ||
      process.env["VIBESTUDIO_WORKSPACE_DIR"];
    if (forbiddenWorkspaceSelection) {
      throw new Error(
        "Public vibestudio-server starts the server hub only. Pair with the server, then choose or create a workspace from the client."
      );
    }
    const { runHubServer } = await import("./hubServer.js");
    await runHubServer({ args, appRoot });
    return;
  }

  const wsDir = args.workspaceDir ?? process.env["VIBESTUDIO_WORKSPACE_DIR"];
  const wsName = args.workspaceName ?? process.env["VIBESTUDIO_WORKSPACE"];

  let workspace: import("@vibestudio/shared/workspace/types").Workspace;
  let workspaceName: string;
  let workspaceIsEphemeral = false;
  try {
    const startup = resolveLocalWorkspaceStartup({
      appRoot,
      centralData,
      wsDir,
      name: wsName,
      init: args.init,
      isDev: !!args.ephemeral,
      requireExplicitSelection: isWorkspaceServer,
    });
    workspace = startup.resolved.workspace;
    workspaceName = startup.resolved.name;
    workspaceIsEphemeral =
      startup.isEphemeral || process.env["VIBESTUDIO_WORKSPACE_EPHEMERAL"] === "1";
  } catch (error) {
    console.error(`Workspace resolution failed: ${error}`);
    if (!args.init) console.error("  Use --init to auto-create from template.");
    process.exit(1);
  }

  // Set user data path to workspace state dir for env-paths compatibility
  setUserDataPath(workspace.statePath);
  // Structured host-log persistence next to the spawn-time stdout log.
  serverLogStore.attachJsonlSink(path.join(workspace.statePath, "logs"));

  // Aliases — used throughout service init below
  const workspacePath = workspace.path;
  const workspaceConfig = workspace.config;
  const statePath = workspace.statePath;

  // Parse workspace declarations (singletonObjects + services + routes).
  // Validation (every DO-backed service/route has a matching singleton row)
  // runs eagerly here — bad workspaces fail fast at startup with a clear msg.
  const { buildWorkspaceDeclarations } =
    await import("@vibestudio/shared/workspace/singletonRegistry");
  const workspaceDecls = buildWorkspaceDeclarations(workspaceConfig);
  // The gad-store DO backing the userland `vcs` service — the ONE manifest
  // declaration (services[] row + its singletonObjects row) that names the
  // durable VCS store. The host's attach/follower and workerd's bootstrap
  // main-binding resolve through it; there is no separate provider slot.
  const { resolveVcsStoreBinding } = await import("./userlandServices.js");
  const {
    resolveWorkspaceTrustGrants,
    resolveHostTargetDecl,
    WORKSPACE_EXTENSION_PROVIDER_NAMES,
    workspaceProviderExtensionPackageName,
  } = await import("@vibestudio/shared/workspace/configParser");
  const { setWorkspaceAppTrust } = await import("@vibestudio/shared/chromeTrust");
  const restartBoundManifestChanges = (
    previousConfig: typeof workspaceConfig,
    nextConfig: typeof workspaceConfig,
    previousDecls: typeof workspaceDecls,
    nextDecls: typeof workspaceDecls
  ): string[] => {
    const changes: string[] = [];
    const compare = (field: string, previousValue: unknown, nextValue: unknown): void => {
      if (JSON.stringify(previousValue ?? null) === JSON.stringify(nextValue ?? null)) return;
      changes.push(
        `${field} changed from ${formatManifestValue(previousValue)} to ${formatManifestValue(
          nextValue
        )}; existing static workerd/internal-DO bindings keep the previous value until restart`
      );
    };

    compare(
      "providers.evalEngine.source",
      previousConfig.providers?.evalEngine?.source?.trim(),
      nextConfig.providers?.evalEngine?.source?.trim()
    );
    compare(
      "providers.evalRuntime.source",
      previousConfig.providers?.evalRuntime?.source?.trim(),
      nextConfig.providers?.evalRuntime?.source?.trim()
    );
    compare(
      "providers.cdpClient.source",
      previousConfig.providers?.cdpClient?.source?.trim(),
      nextConfig.providers?.cdpClient?.source?.trim()
    );
    compare(
      "providers.browserData.extension",
      workspaceProviderExtensionPackageName(previousConfig, "browserData"),
      workspaceProviderExtensionPackageName(nextConfig, "browserData")
    );

    const previousVcs = resolveVcsStoreBinding(previousDecls);
    const nextVcs = resolveVcsStoreBinding(nextDecls);
    if (JSON.stringify(previousVcs ?? null) !== JSON.stringify(nextVcs ?? null)) {
      changes.push(
        "vibestudio.vcs.v1 service binding changed; the running server keeps the existing VCS store attachment until restart or explicit migration"
      );
    }

    return changes;
  };
  const applyWorkspaceConfigReload = (
    nextConfig: typeof workspaceConfig,
    opts: { warnRestartBoundChanges?: boolean } = {}
  ): { routeSources: string[] } => {
    const routeSources = new Set(workspaceDecls.routes.map((route) => route.source));
    const nextDecls = buildWorkspaceDeclarations(nextConfig);
    const restartBoundChanges = restartBoundManifestChanges(
      workspaceConfig,
      nextConfig,
      workspaceDecls,
      nextDecls
    );
    for (const route of nextDecls.routes) routeSources.add(route.source);
    replaceWorkspaceConfig(workspaceConfig, nextConfig);
    workspaceDecls.singletons.replaceAll(nextDecls.singletons.all());
    workspaceDecls.services = nextDecls.services;
    workspaceDecls.routes = nextDecls.routes;
    setWorkspaceAppTrust(resolveWorkspaceTrustGrants(nextConfig));
    if (opts.warnRestartBoundChanges !== false) {
      for (const change of restartBoundChanges) {
        console.warn(`[WorkspaceConfig] ${change}`);
      }
    }
    return { routeSources: Array.from(routeSources).sort() };
  };

  // Manifest-declared host contracts (meta/vibestudio.yml `trust`/`providers`/
  // `hostTargets`). Loading the disk config seeds trust once; the startup
  // protected-main sync below re-seeds it before RPC/container services start.
  const warnMissingWorkspaceTrust = (): void => {
    const trustGrants = resolveWorkspaceTrustGrants(workspaceConfig);
    if (trustGrants.chromeApps.length === 0) {
      console.warn(
        "[Trust] meta/vibestudio.yml declares no `trust.chromeApps` — no workspace app may render host chrome"
      );
    }
    if (trustGrants.connectionManagementApps.length === 0) {
      console.warn(
        "[Trust] meta/vibestudio.yml declares no `trust.connectionManagementApps` — no workspace app may manage connections"
      );
    }
  };
  /** Manifest `providers.*` env bindings for internal DO classes (workerdManager). */
  const internalDoProviderEnv = (className: string): Record<string, string> => {
    if (className === "EvalDO") {
      const env: Record<string, string> = {};
      const providers = workspaceConfig.providers;
      if (providers?.evalEngine?.source)
        env["EVAL_ENGINE_SOURCE"] = providers.evalEngine.source.trim();
      if (providers?.evalRuntime?.source)
        env["EVAL_RUNTIME_SOURCE"] = providers.evalRuntime.source.trim();
      if (providers?.cdpClient?.source)
        env["EVAL_CDP_CLIENT_SOURCE"] = providers.cdpClient.source.trim();
      return env;
    }
    if (className === "BrowserDataDO") {
      const broker = workspaceProviderExtensionPackageName(workspaceConfig, "browserData");
      return broker ? { BROWSER_DATA_BROKER_ID: broker } : {};
    }
    return {};
  };
  // ===========================================================================
  // App node_modules resolution (for @vibestudio/* platform packages)
  // ===========================================================================

  const appNodeModules = getExistingAppNodeModulesRoots(appRoot);
  if (appNodeModules.length === 0) {
    console.warn("[Server] Could not find app node_modules — panel builds may fail");
  }

  // ===========================================================================
  // Service initialization
  // ===========================================================================

  const tokenManager = new TokenManager();
  const { EntityCache } = await import("@vibestudio/shared/runtime/entityCache");
  const { ConnectionGrantService } = await import("@vibestudio/shared/connectionGrants");
  const entityCache = new EntityCache();
  entityCache.registerBootstrap({ id: "server", kind: "server" });
  entityCache.registerBootstrap({ id: "electron-main", kind: "shell" });
  // Reap a connectionless DO/worker's event-push subscriptions when its entity is
  // retired/deleted. WS panels/shells self-reap on socket close; a DoPushSubscriber
  // has no socket, so without this the server would keep re-waking a torn-down DO on
  // every matching emit. (resolve() is null post-delete — the preceding retire reaped.)
  entityCache.onChange((id, change) => {
    if (change === "activate") return;
    const kind = entityCache.resolve(id)?.kind;
    if (kind === "do" || kind === "worker") eventService.unsubscribeAll(id);
  });
  // The single owner of WorkspaceDO entity state: pairs every durable
  // activate/retire with the hot-cache mirror so they can't drift. The
  // write-owners (runtime + eval services) receive this instead of raw entity
  // dispatch. Lazily built once doDispatch is resolvable (registered later).
  const { WorkspaceEntityStore } = await import("./workspaceEntityStore.js");
  let entityStoreInstance: import("./workspaceEntityStore.js").WorkspaceEntityStore | null = null;
  const ensureEntityStore = (
    doDispatch: import("./doDispatch.js").DODispatch
  ): import("./workspaceEntityStore.js").WorkspaceEntityStore =>
    (entityStoreInstance ??= new WorkspaceEntityStore({
      doDispatch,
      workspaceId: workspace.config.id,
      entityCache,
    }));
  const connectionGrants = new ConnectionGrantService({ entityCache });
  const serverBootId = `boot_${randomBytes(18).toString("base64url")}`;
  // Build version this server was launched from. The desktop spawner stamps
  // VIBESTUDIO_APP_VERSION; attach-or-spawn compares it against the current app
  // build and stops-and-respawns on mismatch (converge to current version).
  const serverVersion = process.env["VIBESTUDIO_APP_VERSION"] ?? "0.1.0";
  // Host-wide background-work registry (eval runs) — read by the idle-exit
  // monitor so a detached server won't self-reap while work is in flight.
  const { createActivityRegistry } = await import("./services/activityRegistry.js");
  const activityRegistry = createActivityRegistry();
  // Forward ref: the graceful shutdown fn is defined at the end of main();
  // hostLifecycle.shutdown and the idle-exit monitor call through this.
  let requestShutdown: () => void = () => process.exit(0);
  const { DEFAULT_PAIRING_CODE_TTL_MS, DeviceAuthStore } =
    await import("./services/deviceAuthStore.js");
  const authStorePath =
    process.env["VIBESTUDIO_AUTH_STORE_PATH"] ?? path.join(statePath, "auth", "devices.json");
  const deviceAuthStore = new DeviceAuthStore(authStorePath);
  // Startup pairing invites are minted AFTER the WebRTC ingress pool starts
  // (post-startAll) so each invite gets a real per-invite room + deep link.

  const workerdGatewayToken = randomBytes(32).toString("hex");
  serverLogStore.addSecret(workerdGatewayToken);
  const { CredentialStore } = await import("../../packages/shared/src/credentials/store.js");
  const { ClientConfigStore } =
    await import("../../packages/shared/src/credentials/clientConfigStore.js");
  const { AuditLog } = await import("../../packages/shared/src/credentials/audit.js");
  const { createEgressProxy } = await import("./services/egressProxy.js");
  const { CredentialLifecycle } = await import("./services/credentialLifecycle.js");
  const { CredentialSessionGrantStore } = await import("./services/credentialSessionGrants.js");

  const credentialStore = new CredentialStore();
  const clientConfigStore = new ClientConfigStore();
  const auditLog = new AuditLog({ logDir: path.join(statePath, "credentials-audit") });
  const credentialSessionGrantStore = new CredentialSessionGrantStore();
  const { CapabilityGrantStore } = await import("./services/capabilityGrantStore.js");
  const capabilityGrantStore = new CapabilityGrantStore({ statePath });
  const { UserlandApprovalGrantStore } = await import("./services/userlandApprovalGrantStore.js");
  const userlandApprovalGrantStore = new UserlandApprovalGrantStore({ statePath });
  // EntityTitleService: source-of-truth for display titles lives in the
  // WorkspaceDO (entities.display_title). The cache here is populated at
  // boot via `hydrate()` and updated on every write. The lazy doDispatch
  // resolver lets approval-queue consumers read the cache immediately,
  // while DO writes only start landing once the container has spun up
  // `doDispatch` (registered alongside workerdManager).
  const { createEntityTitleService } = await import("./services/entityTitleService.js");
  const { INTERNAL_DO_SOURCE: ENTITY_TITLE_INTERNAL_DO_SOURCE } =
    await import("./internalDOs/internalDoLoader.js");
  let resolvedDoDispatchForTitles: import("./doDispatch.js").DODispatch | null = null;
  const entityTitleService = createEntityTitleService({
    getDoDispatch: () => resolvedDoDispatchForTitles,
    workspaceRef: {
      source: ENTITY_TITLE_INTERNAL_DO_SOURCE,
      className: "WorkspaceDO",
      objectKey: workspace.config.id,
    },
  });
  const { createApprovalQueue } = await import("./services/approvalQueue.js");
  const { resolveApprovalCallerTitle, resolveApprovalRequester } =
    await import("./services/approvalCallerTitle.js");
  const approvalRequesterDeps = {
    entityCache,
    getTitle: (id: string) => entityTitleService.getTitle(id),
  };
  const approvalQueue = createApprovalQueue({
    eventService,
    resolveTitle: (entityId) => resolveApprovalCallerTitle(approvalRequesterDeps, entityId),
    resolveRequester: (input) => resolveApprovalRequester(approvalRequesterDeps, input),
    autoApprove:
      process.env["NODE_ENV"] === "development" && process.env["VIBESTUDIO_AUTO_APPROVE"] === "1",
  });
  const { ServerUnitApprovalCoordinator } = await import("./unitApprovalCoordinator.js");
  const unitApprovalCoordinator = new ServerUnitApprovalCoordinator({
    approvalQueue,
    delayMs: 250,
    autoApproveStartupUnits: process.env["VIBESTUDIO_AUTO_APPROVE_STARTUP_UNITS"] === "1",
  });
  const requireMobileReady =
    args.requireMobileReady || process.env["VIBESTUDIO_REQUIRE_MOBILE_READY"] === "1";
  const requireElectronReady =
    args.requireElectronReady || process.env["VIBESTUDIO_REQUIRE_ELECTRON_READY"] === "1";
  const credentialLifecycle = new CredentialLifecycle({
    credentialStore,
    clientConfigStore,
  });

  const egressProxy = createEgressProxy({
    credentialStore,
    auditLog,
    approvalQueue,
    grantStore: capabilityGrantStore,
    sessionGrantStore: credentialSessionGrantStore,
    credentialLifecycle,
  });
  let panelRuntimeCoordinatorForCleanup:
    | import("./panelRuntimeCoordinator.js").PanelRuntimeCoordinator
    | null = null;
  const cleanupRuntimeEntityRecord = async (
    record: import("@vibestudio/shared/runtime/entitySpec").EntityRecord
  ) => {
    const { cleanupRuntimeEntity } = await import("./runtimeEntityCleanup.js");
    await cleanupRuntimeEntity(record, {
      panelRuntimeCoordinator: panelRuntimeCoordinatorForCleanup,
      egressProxy,
      approvalQueue,
      credentialSessionGrantStore,
      tokenManager,
      connectionGrants,
      entityTitleService,
      getFsService: () => {
        try {
          return container.get<import("@vibestudio/shared/fsService").FsService>("fsService");
        } catch {
          return null;
        }
      },
      getWebhookIngress: () => {
        try {
          return container.get<{
            internal?: {
              revokeForCaller?: (callerId: string) => Promise<number>;
            };
          }>("webhookIngress");
        } catch {
          return null;
        }
      },
      getWorkerdManager: () => {
        try {
          return container.get<import("./workerdManager.js").WorkerdManager>("workerdManager");
        } catch {
          return null;
        }
      },
    });
  };
  // In pnpm dev mode, the app runs from a throwaway workspace copied from
  // `<appRoot>/workspace`. Mirror committed workspace changes back to that
  // template so edits made in the generated workspace persist into the source
  // checkout.
  const templateDir = path.join(appRoot, "workspace");
  const isPnpmDevMode = process.env["NODE_ENV"] === "development";
  const hasDevTemplate = fs.existsSync(path.join(templateDir, "meta", "vibestudio.yml"));
  const templateDiffersFromActive =
    templateDir !== workspacePath && !workspacePath.startsWith(templateDir + path.sep);
  // pnpm dev mode: mirror committed workspace changes back to the template
  // checkout so edits persist. Hooked onto vcs state advances (see below).
  const devTemplateMirrorDir =
    isPnpmDevMode && workspaceIsEphemeral && hasDevTemplate && templateDiffersFromActive
      ? templateDir
      : null;
  const buildDependencyWorkspaceRoot = resolveDependencyWorkspaceRoot(appRoot, workspacePath);
  if (process.env["VIBESTUDIO_DOGFOOD"] === "1") {
    console.warn(
      "[Dogfood] VIBESTUDIO_DOGFOOD git-fast-forward mirroring is unavailable under the GAD vcs; " +
        "commit and push changes from the source workspace instead."
    );
  }
  const requestedGatewayPort = args.gatewayPort ?? parseEnvPort("VIBESTUDIO_GATEWAY_PORT");
  const configuredProtocol = "http" as const;
  let extensionHostForGateway: import("@vibestudio/extension-host").ExtensionHost | null = null;
  let appHostForGateway: import("./appHost.js").AppHost | null = null;
  let workerdManagerForGateway: import("./workerdManager.js").WorkerdManager | null = null;
  type TrustedUnitHostInstance =
    | import("@vibestudio/extension-host").ExtensionHost
    | import("./appHost.js").AppHost;
  const trustedUnitHosts = (): TrustedUnitHostInstance[] =>
    [extensionHostForGateway, appHostForGateway].filter(
      (host): host is TrustedUnitHostInstance => host !== null
    );
  let startupWorkspaceUnitReconcile: Promise<void> | null = null;
  // Resolved once startup unit reconcile AND any approval-gated applies have
  // settled (or startup fails); holds the build system's background prewarm
  // pool off the CPUs while launch-critical unit builds run.
  let releaseStartupUnitsSettled: () => void = () => {};
  const startupUnitsSettled = new Promise<void>((resolve) => {
    releaseStartupUnitsSettled = resolve;
  });
  const { HostTargetLaunchCoordinator } = await import("./hostTargetLaunchCoordinator.js");
  // Launch/session state only needs declared units to be CLASSIFIED (pending
  // entries upserted, approval batches staged with the coordinator) — waiting
  // for the whole startup reconcile made the launch gate sit behind every unit
  // build. Race against the reconcile promise so a pass that fails before
  // staging still releases the gate (with its error surfaced by resolveLaunch).
  const startupUnitDeclarationsStaged = (): Promise<void> => {
    if (!startupWorkspaceUnitReconcile) return Promise.resolve();
    const staged = Promise.all(
      trustedUnitHosts().map((host) => host.whenDeclarationsStaged())
    ).then(() => {});
    return Promise.race([staged, startupWorkspaceUnitReconcile]);
  };
  const hostTargetLaunchCoordinator = new HostTargetLaunchCoordinator({
    approvalQueue,
    eventService,
    startupApprovals: unitApprovalCoordinator,
    awaitStartupUnitReconcile: startupUnitDeclarationsStaged,
    getAppHost: () => appHostForGateway,
    getTrustedUnitHosts: trustedUnitHosts,
  });
  // Protected server refs (repo → main): the single main-head authority.
  // Constructed BEFORE WorkspaceVcs (which routes every main read/advance
  // through it); the approval gate is late-bound below once the main-advance
  // approval machinery exists — advances before that point fail closed.
  const { createRefService } = await import("./services/refService.js");
  const { collectTreeReachableDigests } = await import("./services/blobstoreService.js");
  const { VcsInvocationTable } = await import("./services/vcsInvocationTable.js");
  const vcsInvocationTable = new VcsInvocationTable();
  let mainRefGate: import("./services/refService.js").RefGate | null = null;
  const refService = createRefService({
    statePath: path.join(getUserDataPath(), "refs"),
    gate: async (batch) => {
      if (!mainRefGate) {
        throw new Error("Protected-ref gate not initialized yet (server still starting)");
      }
      await mainRefGate(batch);
    },
    // Validity check BEFORE approval (§2.1): every candidate `main` state must
    // be a well-formed tree fully present in the content store — userland can
    // never pin a hash the store cannot expand. Fails closed before any prompt.
    assertTreeComplete: async (stateHash) => {
      const reachable = await collectTreeReachableDigests(
        path.join(getUserDataPath(), "blobs"),
        stateHash
      );
      if (!reachable) {
        throw new Error(
          `updateMains: candidate main ${stateHash} is not fully present in the content store`
        );
      }
    },
  });
  // Workspace VCS (GAD-native): starts local-first (no DO needed), attaches
  // to the DO backing the manifest-declared userland `vcs` service (protocol
  // vibestudio.vcs.v1) once workerd is up (see "vcsAttach" below).
  const { WorkspaceVcs } = await import("./vcsHost/workspaceVcs.js");
  const workspaceVcs = new WorkspaceVcs({
    blobsDir: path.join(getUserDataPath(), "blobs"),
    workspaceRoot: workspacePath,
    contextsRoot: path.join(statePath, ".contexts"),
    buildSourcesRoot: path.join(getUserDataPath(), "build-sources"),
    refs: refService,
    // Per-context marker bookkeeping (§6.2): stamp the workspace id and the
    // loopback HTTP(S) server base URL into `.vibestudio-context.json` at folder
    // materialization. `getServerUrl` is a getter because the gateway port is
    // only finalized post-listen (getResolvedGatewayPort throws until then);
    // ensureContextFolder always runs well after startup, so it resolves.
    workspaceId: workspace.config.id,
    getServerUrl: () => {
      try {
        return `${gatewayProtocol()}://127.0.0.1:${getResolvedGatewayPort("context marker")}`;
      } catch {
        return undefined;
      }
    },
    // Dev extraction gate (Phase-2 revision §3): project a push-to-`main` OUT to
    // the source dir only when there is a persistent dev source to extract to.
    // `devTemplateMirrorDir` is the existing signal (pnpm dev + a real
    // `<appRoot>/workspace` template); the rsync mirror below then bridges the
    // exported source dir to that checkout. Off in production ephemeral
    // workspaces, which have no source dir. Computed just above this block.
    extractMainToSource: devTemplateMirrorDir !== null,
    // On-behalf-of attribution for chrome merge-to-main (register row 12): the
    // host mints an invocation record and threads it to the DO's `vcsMerge`.
    vcsInvocations: vcsInvocationTable,
    getVcsWriterIdentity: () => {
      const binding = resolveVcsStoreBinding(workspaceDecls);
      return binding ? `do:${binding.source}:${binding.className}:${binding.objectKey}` : null;
    },
  });
  const readWorkspaceFileAtCommit = async (
    commit: string,
    filePath: string
  ): Promise<string | null> => {
    const ref = commit.startsWith("state:")
      ? commit
      : /^[0-9a-f]{64}$/i.test(commit)
        ? `state:${commit}`
        : commit;
    const file = await workspaceVcs.readFile(ref, filePath);
    if (!file || file.content.kind !== "text") return null;
    return file.content.text;
  };
  const { createRecurringMetaChangeProvider } = await import("./services/recurringRegistry.js");
  const recurringMetaChangeProvider = createRecurringMetaChangeProvider({
    workspaceId: workspace.config.id,
    getCurrentRecurring: () => workspaceConfig.recurring ?? [],
    getCurrentHeartbeats: () => workspaceConfig.heartbeats ?? [],
    readWorkspaceFileAtCommit,
  });
  // Create ContextFolderManager before core services. Context folders are
  // GAD branch forks of the workspace main head, materialized from the CAS.
  const { ContextFolderManager } = await import("@vibestudio/shared/contextFolderManager");
  const contextFolderManager = new ContextFolderManager({
    contextsRoot: path.join(statePath, ".contexts"),
    materialize: (contextId) => workspaceVcs.ensureContextFolder(contextId),
  });

  // Shared deps for the single context-boundary gate (runtime + panel layers).
  // A context "exists" (holds state to intrude on) if it has an active entity
  // or a materialized folder; owner label feeds the approval copy.
  const contextBoundaryDeps = {
    approvalQueue,
    grantStore: capabilityGrantStore,
    contextExists: (contextId: string): boolean => {
      if (entityCache.listActive().some((e) => e.contextId === contextId)) return true;
      try {
        return contextFolderManager.getContextRoot(contextId) != null;
      } catch {
        return false;
      }
    },
    resolveContextOwnerLabel: (contextId: string): string | undefined => {
      const active = entityCache.listActive().filter((e) => e.contextId === contextId);
      const owner =
        active.find((e) => e.kind === "panel") ?? active.find((e) => e.kind === "app") ?? active[0];
      if (!owner) return undefined;
      return entityTitleService.getTitle(owner.id) ?? owner.source.repoPath ?? owner.id;
    },
  };

  const { isDeclaredRemoteRepoPath, syncDeclaredRemoteForRepo } =
    await import("@vibestudio/shared/workspace/remotes");
  const { resolveDeclaredApps, resolveDeclaredExtensions } =
    await import("@vibestudio/shared/workspace/loader");
  const { readStartupWorkspaceConfig, readWorkspaceConfigFromState } =
    await import("./workspaceConfigSource.js");
  const loadWorkspaceConfigFromState = async (
    stateHash: string
  ): Promise<typeof workspaceConfig> => {
    return readWorkspaceConfigFromState(workspaceVcs, workspacePath, stateHash);
  };
  try {
    const startupConfig = await readStartupWorkspaceConfig(workspaceVcs, refService, workspacePath);
    applyWorkspaceConfigReload(startupConfig.config, { warnRestartBoundChanges: false });
    if (startupConfig.source === "protected-main") {
      console.log(
        `[WorkspaceConfig] Loaded startup manifest from protected main ${startupConfig.stateHash}`
      );
    }
    warnMissingWorkspaceTrust();
  } catch (err) {
    console.warn("[WorkspaceConfig] Failed to load startup manifest from workspace state:", err);
    throw err;
  }
  const reconcileDeclaredWorkspaceUnits = async (
    nextConfig: typeof workspaceConfig,
    trigger: "startup" | "meta-change"
  ): Promise<void> => {
    const reconcile = async (): Promise<void> => {
      const tasks: Array<Promise<void>> = [];
      if (extensionHostForGateway) {
        tasks.push(
          extensionHostForGateway
            .reconcileDeclared(resolveDeclaredExtensions(nextConfig), { trigger })
            .then(() => extensionHostForGateway?.whenReconciled())
            .then(() => import("@vibestudio/shared/workspace/extensionRegistry"))
            .then(({ writeExtensionRegistry }) => {
              writeExtensionRegistry(workspacePath);
            })
            .catch((err: unknown) =>
              console.warn("[Extensions] Failed to reconcile declared workspace units:", err)
            )
        );
      }
      if (appHostForGateway) {
        if (trigger === "startup") {
          tasks.push(
            appHostForGateway
              .reconcileDeclared(resolveDeclaredApps(nextConfig), { trigger })
              .then(() => appHostForGateway?.whenReconciled())
              .catch((err: unknown) =>
                console.warn("[Apps] Failed to reconcile declared workspace app units:", err)
              )
          );
        } else {
          try {
            appHostForGateway.setDeclared(resolveDeclaredApps(nextConfig), { trigger });
          } catch (err) {
            console.warn("[Apps] Failed to update declared workspace app units:", err);
          }
        }
      }
      await Promise.all(tasks);
    };
    await reconcile();
  };

  const { WorkspaceTreeScanner } = await import("./vcsHost/workspaceTreeScanner.js");
  const treeScanner = new WorkspaceTreeScanner(workspacePath);
  const skippedDeclaredRemoteRepoWarnings = new Set<string>();
  const syncDeclaredRemotesForSource = async (repoPath?: string): Promise<void> => {
    const repos = repoPath
      ? [repoPath]
      : collectWorkspaceUnitPaths((await treeScanner.getSourceTree()).children);
    await Promise.all(
      repos.map((repo) => {
        if (!isDeclaredRemoteRepoPath(repo)) {
          if (!skippedDeclaredRemoteRepoWarnings.has(repo)) {
            skippedDeclaredRemoteRepoWarnings.add(repo);
            console.log(
              `[GitRemotes] Skipping declared remote sync for non-declarable workspace repo path ${repo}`
            );
          }
          return Promise.resolve();
        }
        return syncDeclaredRemoteForRepo({
          config: workspaceConfig,
          workspaceRoot: workspacePath,
          repoPath: repo,
        }).catch((err: unknown) => {
          console.warn(`[GitRemotes] Failed to sync declared remote for ${repo}:`, err);
        });
      })
    );
  };
  // Workspace state advances drive source-side reactions:
  //  - meta/ changes reload the workspace config from the advanced VCS state
  //    and reconcile declared units
  //  - any change invalidates the tree scanner cache
  //  - pnpm dev mode mirrors the committed tree back to the template checkout
  let devMirrorTimer: NodeJS.Timeout | null = null;
  let initialWorkspaceUnitReconcileComplete = false;
  let pendingStartupMetaConfigReload = false;
  let latestMetaConfigReloadSeq = 0;
  // Bridge every head advance to the client event bus so subscribers (panels)
  // can react incrementally: `vcs.subscribeHead(head)` listens on this topic.
  workspaceVcs.onStateAdvanced((event) => {
    eventService.emit(`vcs:head:${event.head}`, event);
  });
  // Working (uncommitted) edits ride a distinct topic so reactive editors can
  // reflect them — and apply a `vcs.revert` (now a working edit) into the view —
  // without conflating them with committed head advances. `vcs.subscribeWorking`
  // listens here. The build trigger deliberately does NOT.
  workspaceVcs.onWorkingAdvanced((event) => {
    eventService.emit(`vcs:working:${event.head}`, event);
  });
  workspaceVcs.onStateAdvanced((event) => {
    if (event.head !== "main") return;
    treeScanner.invalidate();
    if (event.changedPaths.some((changed) => changed.startsWith("meta/"))) {
      const reloadSeq = ++latestMetaConfigReloadSeq;
      queueMicrotask(() => {
        void (async () => {
          try {
            const nextConfig = await loadWorkspaceConfigFromState(event.stateHash);
            if (reloadSeq !== latestMetaConfigReloadSeq) return;
            const reload = applyWorkspaceConfigReload(nextConfig);
            workerdManagerForGateway?.reconcileManifestRoutes(reload.routeSources);
            if (!initialWorkspaceUnitReconcileComplete) {
              pendingStartupMetaConfigReload = true;
              return;
            }
            void reconcileDeclaredWorkspaceUnits(nextConfig, "meta-change");
            recurringRegistryInstance?.notifyChanged();
            heartbeatDeclarationRegistryInstance?.notifyChanged();
            syncDeclaredRemotesForSource().catch((err: unknown) =>
              console.warn("[GitRemotes] Failed to sync declared remotes after meta change:", err)
            );
          } catch (err) {
            console.warn(
              "[WorkspaceConfig] Failed to reload workspace config after meta change:",
              err
            );
          }
        })();
      });
    }
    if (devTemplateMirrorDir) {
      // Debounced non-destructive rsync — state advances can arrive in bursts
      // during agent commit loops; mirror once things settle.
      if (devMirrorTimer) clearTimeout(devMirrorTimer);
      devMirrorTimer = setTimeout(() => {
        devMirrorTimer = null;
        execFile(
          "rsync",
          [
            "-a",
            "--exclude=.git",
            "--exclude=node_modules",
            "--exclude=.contexts",
            "--exclude=.gad",
            "--exclude=.cache",
            "--exclude=.databases",
            `${workspacePath}/`,
            `${devTemplateMirrorDir}/`,
          ],
          (err) => {
            if (err) console.warn("[DevMirror] rsync to template failed:", err.message);
          }
        );
      }, 500);
    }
  });
  // Configure declared remotes for repos already present at startup — without
  // this, remotes are only synced when a later state advance touches meta/.
  syncDeclaredRemotesForSource().catch((err: unknown) =>
    console.warn("[GitRemotes] Failed to sync declared remotes at startup:", err)
  );

  // ===========================================================================
  // Unified ServiceContainer — lifecycle + RPC services in one container
  // ===========================================================================

  const dispatcher = new ServiceDispatcher();
  const container = new ServiceContainer(dispatcher);
  const getEntityStore = (): import("./workspaceEntityStore.js").WorkspaceEntityStore =>
    ensureEntityStore(container.get<import("./doDispatch.js").DODispatch>("doDispatch"));

  // Route registry — shared across workerdManager (registers manifest-declared
  // worker routes) and the gateway (dispatches `/_r/` requests). Constructed
  // early so both consumers can wire it without awaiting other services.
  const { RouteRegistry } = await import("./routeRegistry.js");
  const routeRegistry = new RouteRegistry();

  // ── Lifecycle services ──

  // Foundation: pre-created instances wrapped for container participation
  container.registerManaged({
    name: "tokenManager",
    async start() {
      return tokenManager;
    },
  });
  container.registerManaged({
    name: "workspaceVcs",
    async start() {
      return workspaceVcs;
    },
  });

  // Build system
  container.registerManaged({
    name: "buildSystem",
    dependencies: ["workspaceVcs"],
    async start() {
      return await initBuildSystemV2(
        workspacePath,
        workspaceVcs,
        appNodeModules.length > 0 ? appNodeModules : [path.join(appRoot, "node_modules")],
        {
          appRoot,
          dependencyWorkspaceRoot: buildDependencyWorkspaceRoot,
          holdInitialPrewarm: () => startupUnitsSettled,
        }
      );
    },
    async stop(instance: import("./buildV2/index.js").BuildSystemV2) {
      await instance?.shutdown();
    },
  });

  // Pre-warm the manifest-declared eval engine + runtime bundles at boot so the
  // first interactive `eval.run` doesn't pay the cold esbuild compiles (the bulk
  // of the EvalDO cold start). The units come from meta/vibestudio.yml
  // (`providers.evalEngine` / `providers.evalRuntime`) — no declaration means
  // eval is disabled, so there is nothing to warm (logged once). Fire-and-forget:
  // `buildUnit` caches + coalesces, so the EvalDO's identical getBuild later hits
  // the warm cache (or awaits this in-flight build). Externals `[]` matches a
  // fresh isolate's first builds. cdp-client is intentionally NOT pre-warmed —
  // it's lazily built only when an eval actually references CDP.
  container.registerManaged({
    name: "evalEnginePrewarm",
    dependencies: ["buildSystem"],
    async start(resolve) {
      const buildSystem = assertPresent(
        resolve<import("./buildV2/index.js").BuildSystemV2>("buildSystem")
      );
      const engineSource = workspaceConfig.providers?.evalEngine?.source?.trim();
      const runtimeSource = workspaceConfig.providers?.evalRuntime?.source?.trim();
      if (!engineSource || !runtimeSource) {
        console.warn(
          "[eval] meta/vibestudio.yml declares no `providers.evalEngine`/`providers.evalRuntime` — eval is disabled (pre-warm skipped)"
        );
        return;
      }
      const prewarm = (specifier: string): void => {
        void buildSystem
          .getBuild(specifier, undefined, {
            library: true,
            externals: [],
            libraryTarget: "worker",
          })
          .then(() => console.log(`[eval] pre-warmed ${specifier} bundle`))
          .catch((err) =>
            console.warn(
              `[eval] ${specifier} pre-warm failed (first eval will cold-build): ${
                err instanceof Error ? err.message : String(err)
              }`
            )
          );
      };
      prewarm(engineSource);
      // The EvalDO loads these three runtime subpaths (see ensureRuntimeSupport).
      prewarm(`${runtimeSource}/hosted`);
      prewarm(`${runtimeSource}/panel-runtime`);
      prewarm(`${runtimeSource}/portable`);
    },
  });

  // ── RPC-only services (replacing serverServiceRegistry.ts) ──

  const { createBuildService } = await import("./services/buildService.js");
  const { createTokensService } = await import("./services/tokensService.js");
  const { createPresenceService, createPresenceTracker } =
    await import("./services/presenceService.js");
  const { createGitInteropService } = await import("./services/gitInteropService.js");
  const { createWorkerService } = await import("./services/workerService.js");

  let buildSystemInstance: import("./buildV2/index.js").BuildSystemV2 | null = null;
  {
    container.registerManaged({
      name: "build",
      dependencies: ["buildSystem"],
      start: async (resolve) => {
        buildSystemInstance = assertPresent(
          resolve<import("./buildV2/index.js").BuildSystemV2>("buildSystem")
        );
      },
      getServiceDefinition() {
        return createBuildService({ buildSystem: assertPresent(buildSystemInstance) });
      },
    });
  }
  const presence = createPresenceTracker({ eventService });
  container.registerRpc(createPresenceService({ presence }));

  {
    let tokensDefinition: import("@vibestudio/shared/serviceDefinition").ServiceDefinition | null =
      null;
    container.registerManaged({
      name: "tokens",
      dependencies: ["tokenManager", "fsService"],
      async start() {
        tokensDefinition = createTokensService({
          tokenManager,
          persistAdminToken: (token: string) => savePersistedAdminToken(token),
        });
      },
      getServiceDefinition() {
        if (!tokensDefinition) throw new Error("tokens service not initialized");
        return tokensDefinition;
      },
    });
  }
  // Git interchange semantics live behind the manifest-declared
  // providers.gitInterop extension. The host keeps only this policy/dispatch
  // service (approvals, config writes, and provider invocation).
  const { createWorkspaceConfigMainWriter } = await import("./workspaceConfigWriter.js");
  const workspaceConfigWriter = createWorkspaceConfigMainWriter({
    workspacePath,
    blobsDir: path.join(getUserDataPath(), "blobs"),
    refs: refService,
    vcs: workspaceVcs,
  });
  const invokeGitInteropProvider = createGitInteropProviderInvoker(() => extensionHostForGateway);
  const gitInteropDefinition = createGitInteropService({
    treeScanner,
    workspacePath,
    workspaceConfig,
    invokeGitProvider: invokeGitInteropProvider,
    approvalQueue,
    grantStore: capabilityGrantStore,
    hasAppCapability: (callerId, capability) =>
      appHostForGateway?.hasAppCapability(callerId, capability) ?? false,
    workspaceConfigMutationWouldChange: (mutate) => workspaceConfigWriter.wouldMutate(mutate),
    persistWorkspaceConfigMutation: (input) => workspaceConfigWriter.applyMutation(input),
    onWorkspaceSourceChanged: async (_ctx, _summary) => {
      // The extension-owned clone path imports the checkout into GAD itself.
      // The host only refreshes source-tree bookkeeping so a freshly cloned
      // dependency is visible to existing workspace-unit queries.
      await workspaceVcs.ensureRepoLogsFromDisk();
    },
  });
  container.registerRpc(gitInteropDefinition);
  refService.onRefsChanged((changes) => {
    const repos = changes
      .filter((change) => change.stateHash !== null)
      .map((change) => change.repoPath);
    if (repos.length === 0) return;
    if (!extensionHostForGateway) return;
    void invokeGitInteropProvider(
      { caller: createVerifiedCaller("server", "server") },
      "onMainAdvanced",
      [repos]
    ).catch((err) => console.warn("[GitUpstream] forward failed:", err));
  });
  const completeConfiguredWorkspaceDependenciesAtStartup = async (): Promise<void> => {
    try {
      const result = (await gitInteropDefinition.handler(
        { caller: createVerifiedCaller("server", "server") },
        "completeWorkspaceDependencies",
        []
      )) as {
        imported: Array<{ path: string }>;
        failed: Array<{ path: string; error: string }>;
      };
      if (result.imported.length > 0) {
        console.log(
          `[GitRemotes] Imported configured workspace dependencies: ${result.imported
            .map((entry) => entry.path)
            .join(", ")}`
        );
      }
      for (const failure of result.failed) {
        console.warn(
          `[GitRemotes] Failed to import configured workspace dependency ${failure.path}: ${failure.error}`
        );
      }
    } catch (err) {
      console.warn("[GitRemotes] Failed to import configured workspace dependencies:", err);
    }
  };
  {
    const { createVcsService } = await import("./services/vcsService.js");
    const { createMainAdvanceApprovalGate, createMainRefAdvanceGate, FileMetaApprovalGrantStore } =
      await import("./services/mainAdvanceApproval.js");
    const mainAdvanceGate = createMainAdvanceApprovalGate({
      approvalQueue,
      grantStore: new FileMetaApprovalGrantStore({ statePath }),
      grantTtlMs: 4 * 60 * 60 * 1000,
      capabilityGrantStore,
      hasAppCapability: (callerId, capability) =>
        appHostForGateway?.hasAppCapability(callerId, capability) ?? false,
      getProviders: () => [...trustedUnitHosts(), recurringMetaChangeProvider],
      // Host-sourced build-status line for the approval prompt (§5):
      // `build.statusAt` is a PURE per-view cache read and MUST NEVER trigger
      // a build. `buildSystemForVcs` (declared below in this block) is assigned
      // lazily when the vcs service starts, so read it at call time; before it
      // exists the prompt truthfully renders "not validated".
      getBuildStatusAt: (viewHash: string) => buildSystemForVcs?.statusAt(viewHash) ?? null,
    });
    // The ONE approval path for protected main-ref advances: the server
    // computes the authoritative diff (content-store diffTrees over the CAS'd
    // trees) inside the gate; the meta repo additionally derives its semantic
    // unit-change prompt from the candidate workspace view.
    mainRefGate = createMainRefAdvanceGate({
      blobsDir: path.join(getUserDataPath(), "blobs"),
      approvalGate: mainAdvanceGate,
      ensureStateMirrored: (stateHash) => workspaceVcs.worktrees.ensureStateMirrored(stateHash),
      workspaceViewWithReposAt: (overrides) => workspaceVcs.workspaceViewWithReposAt(overrides),
      computeDeleteDependents: (repoPath) => workspaceVcs.deleteDependents(repoPath),
    });
    // Protected refs exposed to userland (P5b): reads plus a gated
    // compare-and-swap advance. This is how a userland VCS implementation
    // requests `main` advancement — the advance flows through the SAME
    // mainRefGate wired above, with the verified caller as the gate context.
    const { createRefsService } = await import("./services/refsService.js");
    container.registerRpc(
      createRefsService({
        refs: refService,
        invocations: vcsInvocationTable,
        // Single-writer identity (§3): the DO backing the workspace `vcs`
        // service declaration, matched by target identity — recomputed per call
        // so a re-declared/fake `vcs` service never matches.
        getVcsWriterIdentity: () => {
          const binding = resolveVcsStoreBinding(workspaceDecls);
          return binding ? `do:${binding.source}:${binding.className}:${binding.objectKey}` : null;
        },
      })
    );
    // Disk-scan primitive (narrow-host boundary refactor P1): the pure
    // `worktree.scan` RPC the gad-store DO drives to read a working tree into
    // the CAS. Semantics-free (no commit/ref-advance/log) — a sibling of the
    // blobstore/refs primitives, additive infra with no consumer yet.
    const { createWorktreeService } = await import("./services/worktreeService.js");
    container.registerRpc(
      createWorktreeService({
        scan: (repoPath, head) => workspaceVcs.scanWorktree(repoPath, head),
        project: (repoPath, head, stateHash) =>
          workspaceVcs.projectWorktree(repoPath, head, stateHash),
        dependentRepos: (repoPath) => workspaceVcs.deleteDependents(repoPath),
        getVcsWriterIdentity: () => {
          const binding = resolveVcsStoreBinding(workspaceDecls);
          return binding ? `do:${binding.source}:${binding.className}:${binding.objectKey}` : null;
        },
      })
    );
    // Remote context mirrors (plan §6.5): read-side of the projector over the
    // wire. `targets` reads a context's per-repo states; `objects` streams the
    // CAS tree content in size-bounded pages. Backed by the same WorkspaceVcs +
    // WorktreeStore + blobstore the projector uses — no new write semantics.
    {
      const { createMirrorService } = await import("./services/mirrorService.js");
      const { getBytes: readMirrorBlob } = await import("./services/blobstoreService.js");
      const mirrorBlobsDir = path.join(getUserDataPath(), "blobs");
      container.registerRpc(
        createMirrorService({
          contextRepoTargets: (contextId) => workspaceVcs.contextRepoTargets(contextId),
          listStateFiles: async (stateHash) =>
            (await workspaceVcs.worktrees.listStateFiles(stateHash)).map((file) => ({
              path: file.path,
              contentHash: file.content_hash,
              mode: file.mode,
            })),
          readBlob: (contentHash) => readMirrorBlob(mirrorBlobsDir, contentHash),
        })
      );
    }
    let buildSystemForVcs: import("./buildV2/index.js").BuildSystemV2 | null = null;
    container.registerManaged({
      name: "vcsService",
      dependencies: ["buildSystem"],
      async start(resolve) {
        buildSystemForVcs = assertPresent(
          resolve<import("./buildV2/index.js").BuildSystemV2>("buildSystem")
        );
      },
      getServiceDefinition() {
        return createVcsService({
          workspaceVcs,
          entityCache,
          getBuildSystem: () => buildSystemForVcs,
          mainAdvanceGate,
          hasAppCapability: (callerId, capability) =>
            appHostForGateway?.hasAppCapability(callerId, capability) ?? false,
          // Cross-context READ authz (throw-not-prompt): back it with WS-3's
          // relationship registry so a caller may inspect only the contexts it
          // owns (lifecycle) or forked (lineage). Resolved lazily per call — the
          // entity store needs the DO dispatch, wired by the time reads run.
          listOwnedContexts: async ({ contextId }) => {
            const doDispatch = container.get<import("./doDispatch.js").DODispatch>("doDispatch");
            const contexts = await ensureEntityStore(doDispatch).listContextEdgesByOwner({
              ownerContextId: contextId,
            });
            return { contexts };
          },
        });
      },
    });
  }
  const runtimeDiagnostics = new RuntimeDiagnosticsStore({ statePath });
  // Bridge state-triggered build failures (and completions) into the per-unit
  // diagnostics store so `workspace.units.diagnostics` surfaces build errors
  // alongside runtime logs. Keyed the same way unitDiagnostics resolves
  // entities: workers by source path, everything else by package name.
  container.registerManaged({
    name: "buildDiagnosticsBridge",
    dependencies: ["buildSystem"],
    start: async (resolve) => {
      const buildSystem = assertPresent(
        resolve<import("./buildV2/index.js").BuildSystemV2>("buildSystem")
      );
      const kindMap: Record<string, import("./runtimeDiagnosticsStore.js").RuntimeDiagnosticKind> =
        {
          panel: "panel",
          worker: "worker",
          extension: "extension",
          app: "app",
        };
      return buildSystem.onBuildEvent((event) => {
        if (event.type === "build-started") return;
        const node = buildSystem.getGraph().tryGet(event.name);
        const kind = kindMap[node?.kind ?? ""] ?? "worker";
        const entityId = node?.kind === "worker" ? (node.relativePath ?? event.name) : event.name;
        runtimeDiagnostics.record({
          workspaceId: workspace.config.id,
          entityId,
          kind,
          level: event.type === "build-error" ? "error" : "info",
          message:
            event.type === "build-error"
              ? `Build failed: ${event.error ?? "unknown error"}`
              : `Build complete (${event.buildKey ?? "no key"})`,
          source: "lifecycle",
          fields: {
            buildEvent: event.type,
            ...(event.buildKey ? { buildKey: event.buildKey } : {}),
            ...(event.trigger
              ? { head: event.trigger.head, stateHash: event.trigger.stateHash }
              : {}),
          },
        });
      });
    },
    stop: async (unsubscribe: () => void) => {
      unsubscribe?.();
    },
  });
  {
    const { createWorkerLogService } = await import("./services/workerLogService.js");
    container.registerRpc(
      createWorkerLogService({
        onLog: (entry) => {
          if (!entry.source) return;
          runtimeDiagnostics.record({
            workspaceId: workspace.config.id,
            entityId: entry.callerId,
            kind: entry.callerId.startsWith("do:") ? "do" : "worker",
            timestamp: entry.timestamp,
            level: entry.level === "warn" ? "warn" : entry.level,
            message: entry.message,
            source: "console",
            fields: entry.source ? { source: entry.source } : undefined,
          });
          runtimeDiagnostics.record({
            workspaceId: workspace.config.id,
            entityId: entry.source,
            kind: "worker",
            timestamp: entry.timestamp,
            level: entry.level === "warn" ? "warn" : entry.level,
            message: entry.message,
            source: "console",
            fields: { callerId: entry.callerId },
          });
          eventService.emit("workspace:unit-log", {
            workspaceId: workspace.config.id,
            unitName: entry.source,
            kind: "worker",
            timestamp: entry.timestamp,
            level: entry.level,
            message: entry.message,
            source: "console",
          } satisfies import("./services/workspaceService.js").WorkspaceUnitLogRecord);
        },
      })
    );
  }
  {
    const { createPanelLogService } = await import("./services/panelLogService.js");
    container.registerRpc(
      createPanelLogService({
        onRecords: (records) => {
          const buildSystem = container.has("buildSystem")
            ? container.get<import("./buildV2/index.js").BuildSystemV2>("buildSystem")
            : null;
          for (const entry of records) {
            // Diagnostics for panels are keyed by package name (matching
            // unitDiagnostics' entity resolution); fall back to the source
            // path when the unit isn't in the graph.
            const node = buildSystem
              ?.getGraph()
              .allNodes()
              .find((candidate) => candidate.relativePath === entry.unitSource);
            const entityId = node?.name ?? entry.unitSource;
            runtimeDiagnostics.record({
              workspaceId: workspace.config.id,
              entityId,
              kind: "panel",
              timestamp: entry.timestamp,
              level: entry.level,
              message: entry.message,
              source: entry.source,
              fields: { panelId: entry.panelId, ...entry.fields },
              url: entry.url,
              line: entry.line,
            });
            eventService.emit("workspace:unit-log", {
              workspaceId: workspace.config.id,
              unitName: entityId,
              kind: "panel",
              timestamp: entry.timestamp,
              level: entry.level,
              message: entry.message,
              source: entry.source === "lifecycle" ? "console" : entry.source,
            });
          }
        },
      })
    );
  }
  container.registerRpc(
    createEventsServiceDefinition(eventService, {
      snapshots: {
        "shell-approval:pending-changed": () => ({ pending: approvalQueue.listPending() }),
        "apps:status": () => ({
          snapshot: true,
          apps:
            appHostForGateway?.listWorkspaceUnits().map((entry) => ({
              name: entry.name,
              status: entry.status,
              error: entry.lastError,
              errorDetails: entry.lastErrorDetails ?? null,
              buildKey: entry.activeBundleKey ?? null,
              effectiveVersion: entry.activeEv ?? null,
              canRollback: entry.canRollback,
              target: entry.target,
            })) ?? [],
        }),
      },
    })
  );

  // ── Approval-gated host capabilities ──
  {
    const { createExternalOpenService } = await import("./services/externalOpenService.js");
    container.registerRpc(
      createExternalOpenService({
        eventService,
        approvalQueue,
        grantStore: capabilityGrantStore,
      })
    );
  }

  // ── Notification service ──
  const { createNotificationService } = await import("./services/notificationService.js");
  const notificationResult = createNotificationService({ eventService });
  container.registerRpc(notificationResult.definition);

  // ── Push + shell presence services ──
  {
    const { createPushService } = await import("./services/pushService.js");
    const pushResult = createPushService();
    container.registerManaged({
      name: "push",
      start: async () => pushResult,
      getServiceDefinition: () => pushResult.definition,
    });
  }
  {
    const { createShellPresenceService } = await import("./services/shellPresenceService.js");
    const shellPresenceResult = createShellPresenceService();
    container.registerManaged({
      name: "shellPresence",
      start: async () => shellPresenceResult,
      getServiceDefinition: () => shellPresenceResult.definition,
    });
  }
  {
    const { createApprovalPushBridge } = await import("./services/approvalPushBridge.js");
    container.registerManaged({
      name: "approvalPushBridge",
      dependencies: ["push", "shellPresence"],
      start: async (resolve) => {
        const push = assertPresent(
          resolve<import("./services/pushService.js").PushServiceResult>("push")
        );
        const shellPresence = assertPresent(
          resolve<import("./services/shellPresenceService.js").ShellPresenceServiceResult>(
            "shellPresence"
          )
        );
        return createApprovalPushBridge({
          approvalQueue,
          push: push.internal,
          shellPresence: shellPresence.internal,
        });
      },
      stop: async (bridge: import("./services/approvalPushBridge.js").ApprovalPushBridge) => {
        bridge.stop();
      },
    });
  }

  // ── Shell approval service (consent bar queue) ──
  const { createShellApprovalService } = await import("./services/shellApprovalService.js");
  container.registerRpc(createShellApprovalService({ approvalQueue, capabilityGrantStore }));
  const { createPermissionsService } = await import("./services/permissionsService.js");
  container.registerRpc(
    createPermissionsService({
      capabilityGrants: capabilityGrantStore,
      userlandGrants: userlandApprovalGrantStore,
    })
  );
  const { createCorsApprovalService } = await import("./services/corsApprovalService.js");
  container.registerRpc(
    createCorsApprovalService({
      approvalQueue,
      grantStore: capabilityGrantStore,
    })
  );
  const { createUserlandApprovalService } = await import("./services/userlandApprovalService.js");
  container.registerRpc(
    createUserlandApprovalService({
      approvalQueue,
      grantStore: userlandApprovalGrantStore,
      resolveRuntimeEntity: (id) => getEntityStore().resolveRecord(id),
      onExternalApprovalExpired: ({ operation }) => {
        eventService.emit("notification:show", {
          id: `external-approval-expired-${Date.now()}`,
          type: "warning",
          title: "Claude Code request expired",
          message: `${operation} was denied because no answer was received within 10 minutes.`,
          ttl: 0,
        });
      },
    })
  );

  // ── Relay backhaul: OAuth callbacks + third-party webhooks ride one
  // authenticated server→relay pipe (the home server has no public endpoint).
  // Inert until start(); returns null when no relay is configured. Created
  // before the credential/webhook services so its client can be their
  // registrar, with handlers that close over the refs assigned below. ──
  const { startRelayBackhaul, getRelayOrigin } = await import("./services/relayBackhaulClient.js");
  // Holder (not bare `let`s) so the backhaul handler closures can read the
  // service refs without TypeScript narrowing them to null across the closure
  // boundary; both are filled once the container builds the services.
  const relayServices: {
    credential: {
      resolveRelayOAuthCallback: (frame: {
        transactionId: string;
        state?: string;
        code?: string;
        error?: string;
      }) => Promise<void>;
    } | null;
    webhook: {
      internal: {
        deliverRelayWebhook: (
          frame: import("./services/relayBackhaulClient.js").RelayWebhookFrame
        ) => Promise<import("./services/relayBackhaulClient.js").WebhookAck>;
        reannounceRelaySubscriptions: () => Promise<void>;
      };
    } | null;
  } = { credential: null, webhook: null };
  const relayBackhaul = startRelayBackhaul({
    serverId: deviceAuthStore.getServerId(),
    onWebhook: async (frame) => {
      if (!relayServices.webhook) {
        return { ok: false, permanent: false, reason: "webhook ingress not ready" };
      }
      return relayServices.webhook.internal.deliverRelayWebhook(frame);
    },
    onOAuthCallback: async (frame) => {
      await relayServices.credential?.resolveRelayOAuthCallback(frame);
    },
  });
  // The credential registrar wants `.register`; the client exposes
  // `.registerOAuth`. Adapt (client is const, so the narrowing survives here).
  const relayOAuthRegistrar = relayBackhaul
    ? {
        register: (id: string, platform: "mobile" | "desktop") =>
          relayBackhaul.client.registerOAuth(id, platform),
      }
    : undefined;

  // ── Credential service ──
  {
    const { createCredentialService } = await import("./services/credentialService.js");
    const { serviceWithHttpRoutes } = await import("./serviceWithHttpRoutes.js");
    // Server→shell capture roundtrip over the RPC plane: emit a
    // credential:capture-request event to the attached shell, await its
    // credentials.completeCapture. Fails fast when no shell is attached.
    const { createCredentialCaptureBridge } = await import("./services/credentialCaptureBridge.js");
    const captureBridge = createCredentialCaptureBridge({
      eventService,
      hasConnectedShell: () => (rpcServerForGateway?.countConnectedClients(["shell"]) ?? 0) > 0,
    });
    const captureSessionCredential = <T extends Record<string, unknown>>(
      payload: Record<string, unknown>,
      signal?: AbortSignal
    ): Promise<T> => captureBridge.captureSessionCredential<T>(payload, signal);
    const credentialService = createCredentialService({
      completeCapture: (captureId, response) => captureBridge.completeCapture(captureId, response),
      credentialStore,
      clientConfigStore,
      auditLog,
      eventService,
      relayOAuthRegistrar,
      connectionLookup: {
        getAuthorizingShell: (principalId: string) =>
          rpcServerForGateway?.getAuthorizingShell(principalId) ?? null,
      },
      egressProxy,
      approvalQueue,
      sessionGrantStore: credentialSessionGrantStore,
      credentialLifecycle,
      hasAppCapability: (callerId, capability) =>
        appHostForGateway?.hasAppCapability(callerId, capability) ?? false,
      runtimeInspector: {
        listActiveEntities: () => entityCache.listActive(),
        resolvePanelSlotByEntity: async (entityId: string) =>
          (await dispatcher.dispatch(
            { caller: createVerifiedCaller("server", "server") },
            "workspace-state",
            "slot.resolveByEntity",
            [entityId]
          )) as string | null,
        listPanels: async () =>
          (await dispatcher.dispatch(
            { caller: createVerifiedCaller("server", "server") },
            "panelTree",
            "list",
            [null]
          )) as Array<{
            panelId: string;
            title?: string;
            source?: string;
            kind?: "workspace" | "browser";
            parentId?: string | null;
            contextId?: string;
            runtimeEntityId?: string | null;
            effectiveVersion?: string | null;
          }>,
      },
      sessionCredentialCapture: {
        captureCookies: async (params) => {
          const response = await captureSessionCredential<{
            cookieHeader?: string;
            cookieSession?: {
              origins?: unknown;
              cookies?: unknown;
            };
            expiresAt?: number;
            accountIdentity?: Record<string, string>;
          }>(
            {
              kind: "cookies",
              signInUrl: params.signInUrl,
              origins: params.origins,
              cookieNames: params.cookieNames,
              completionUrlPattern: params.completionUrlPattern,
              maxTtlSeconds: params.maxTtlSeconds,
              browser: params.browser,
            },
            params.signal
          );
          if (!response.cookieHeader) {
            throw new Error("Session credential capture returned no cookies");
          }
          return {
            cookieHeader: response.cookieHeader,
            cookieSession: response.cookieSession as never,
            expiresAt: response.expiresAt,
            accountIdentity: response.accountIdentity,
          };
        },
        captureSamlSession: async (params) => {
          const response = await captureSessionCredential<{
            cookieHeader?: string;
            cookieSession?: {
              origins?: unknown;
              cookies?: unknown;
            };
            assertion?: string;
            expiresAt?: number;
            accountIdentity?: Record<string, string>;
          }>(
            {
              kind: "saml",
              signInUrl: params.signInUrl,
              spAudience: params.spAudience,
              cookieNames: params.cookieNames,
              assertion: params.assertion,
              completionUrlPattern: params.completionUrlPattern,
              maxTtlSeconds: params.maxTtlSeconds,
              browser: params.browser,
            },
            params.signal
          );
          return {
            cookieHeader: response.cookieHeader,
            cookieSession: response.cookieSession as never,
            assertion: response.assertion,
            expiresAt: response.expiresAt,
            accountIdentity: response.accountIdentity,
          };
        },
      },
    }) as ReturnType<typeof createCredentialService> & {
      routes?: import("./routeRegistry.js").ServiceRouteDecl[];
    };
    relayServices.credential = credentialService;
    container.registerManaged(
      serviceWithHttpRoutes(
        {
          definition: credentialService,
          routes: credentialService.routes,
        },
        routeRegistry
      )
    );
  }

  // ── serverLog service (host log inspection + live tail) ──
  {
    const { createServerLogService } = await import("./services/serverLogService.js");
    container.registerRpc(
      createServerLogService({
        store: serverLogStore,
        eventService,
        workspaceId: workspace.config.id,
        serverBootId,
        startedAt: serverLogStartedAt,
      })
    );
  }

  // ── hostLifecycle service (shell-gated graceful shutdown) ──
  {
    const { createHostLifecycleService } = await import("./services/hostLifecycleService.js");
    container.registerRpc(
      createHostLifecycleService({
        shutdown: () => requestShutdown(),
      })
    );
  }

  // ── eval.* service (owner-scoped sandbox eval backed by per-owner EvalDO) ──
  {
    const { createEvalService } = await import("./services/evalService.js");
    let evalDefinition: import("@vibestudio/shared/serviceDefinition").ServiceDefinition | null =
      null;
    container.registerManaged({
      name: "eval",
      dependencies: ["doDispatch"],
      async start(resolve) {
        const doDispatch = assertPresent(
          resolve<import("./doDispatch.js").DODispatch>("doDispatch")
        );
        evalDefinition = createEvalService({
          doDispatch,
          entityStore: ensureEntityStore(doDispatch),
          tokenManager,
          activity: activityRegistry,
        });
      },
      getServiceDefinition() {
        if (!evalDefinition) throw new Error("eval service not initialized");
        return evalDefinition;
      },
    });
  }

  // Server-driven DO alarms (workerd lacks SQLite/facet alarms). Created as a
  // managed service below; the workspace-state `onAlarmChanged` hook pokes it.
  let alarmDriverInstance: import("./services/alarmDriver.js").AlarmDriver | null = null;

  // Slot-tree change fan-out: the workspace-state service pokes this after any
  // mutating slot.* method; the panel-tree bridge subscribes (registerSlotStateListener)
  // to self-heal its mirror + re-broadcast. Decoupled via a Set so the bridge
  // (created later in registerPanelServices) can register lazily.
  const slotStateListeners = new Set<() => void>();
  const notifySlotStateListeners = () => {
    for (const listener of slotStateListeners) {
      try {
        listener();
      } catch (error) {
        console.warn(
          `[server] slot-state listener failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  };

  // Declarative scheduled jobs from vibestudio.yml `recurring:`. Managed service
  // below; the meta-change reload hook pokes it after approved config changes.
  let recurringRegistryInstance:
    | import("./services/recurringRegistry.js").RecurringRegistry
    | null = null;
  let heartbeatDeclarationRegistryInstance:
    | import("./services/recurringRegistry.js").HeartbeatDeclarationRegistry
    | null = null;

  {
    const { createWorkspaceStateService } = await import("./services/workspaceStateService.js");
    let workspaceStateDefinition:
      | import("@vibestudio/shared/serviceDefinition").ServiceDefinition
      | null = null;
    container.registerManaged({
      name: "workspace-state",
      dependencies: ["doDispatch"],
      async start(resolve) {
        const doDispatch = assertPresent(
          resolve<import("./doDispatch.js").DODispatch>("doDispatch")
        );
        // Now that doDispatch is up, the title cache can talk to the DO.
        // Hydrate so synchronous getTitle() lookups (used by approvalQueue
        // when building a PendingApproval) see existing titles from previous
        // sessions. Best-effort — failures keep an empty cache until the
        // first explicit write.
        resolvedDoDispatchForTitles = doDispatch;
        void entityTitleService.hydrate();
        workspaceStateDefinition = createWorkspaceStateService({
          doDispatch,
          workspaceId: workspace.config.id,
          // The DO already writes display_title in the same transaction as
          // searchable_title (see workspaceDO.panelIndex / panelUpdateTitle),
          // so the callback only needs to mirror into the in-memory cache.
          onPanelTitleChanged: (entityId, title) => {
            entityTitleService.mirrorCachedTitle(entityId, title);
          },
          onAlarmChanged: () => alarmDriverInstance?.notifyChanged(),
          onHeartbeatRegistryChanged: () => {
            setTimeout(() => heartbeatDeclarationRegistryInstance?.notifyChanged(), 0);
          },
          onSlotStateChanged: notifySlotStateListeners,
        });
      },
      getServiceDefinition() {
        if (!workspaceStateDefinition) {
          throw new Error("workspace-state service not initialized");
        }
        return workspaceStateDefinition;
      },
    });
  }

  // ── runtime.* service ──
  // runtime.createEntity / retireEntity is the only path that
  // mints or retires entity rows. Cleanup hooks fire post-retire (see §10).
  {
    const { createRuntimeService } = await import("./services/runtimeService.js");
    let runtimeDefinition: import("@vibestudio/shared/serviceDefinition").ServiceDefinition | null =
      null;
    container.registerManaged({
      name: "runtime",
      dependencies: ["doDispatch", "workerdManager", "buildSystem"],
      async start(resolve) {
        const doDispatch = assertPresent(
          resolve<import("./doDispatch.js").DODispatch>("doDispatch")
        );
        const workerdManager = assertPresent(
          resolve<import("./workerdManager.js").WorkerdManager>("workerdManager")
        );
        const buildSystem = assertPresent(
          resolve<import("./buildV2/index.js").BuildSystemV2>("buildSystem")
        );
        runtimeDefinition = createRuntimeService({
          entityStore: ensureEntityStore(doDispatch),
          contextFolders: contextFolderManager,
          // VCS branch lifecycle for full-workspace contexts.
          vcsContexts: {
            pinContext: (contextId) => workspaceVcs.pinContext(contextId),
            dropContext: (contextId) => workspaceVcs.dropContext(contextId),
            forkContext: (sourceContextId, targetContextId) =>
              workspaceVcs.forkContext(sourceContextId, targetContextId),
          },
          hooks: {
            prepareDurableObject: (args) => workerdManager.ensureDurableObjectEntity(args),
            prepareWorker: (args) => workerdManager.startWorker(args),
            // Server-internal DO-storage primitives for cloneContext/destroyContext.
            // cloneDO/destroyDO are NOT exposed to userland — only the runtime
            // service (here) drives them, behind the context-boundary gate.
            cloneDurableStorage: async ({ source, className, fromKey, toKey }) => {
              await workerdManager.cloneDO({ source, className, objectKey: fromKey }, toKey);
            },
            destroyDurableStorage: async ({ source, className, key }) => {
              await workerdManager.destroyDO({ source, className, objectKey: key });
            },
            resolvePanelEffectiveVersion: async ({ source, ref }) => {
              if (source.startsWith("browser:")) return "";
              void ref;
              return buildSystem.getEffectiveVersion(source) ?? "";
            },
            resolveAppEffectiveVersion: async ({ source, ref }) => {
              void ref;
              return buildSystem.getEffectiveVersion(source) ?? "";
            },
            onRetire: async (record) => {
              await cleanupRuntimeEntityRecord(record);
            },
          },
          contextBoundary: contextBoundaryDeps,
          hasAppCapability: (callerId, capability) =>
            appHostForGateway?.hasAppCapability(callerId, capability) ?? false,
          setEntityTitle: (entityId, title, options) =>
            entityTitleService.setTitle(entityId, title, options),
          // Agent credentials follow the entity (§3.2): on retire, revoke all
          // outstanding agent credentials and the live `agent:<entityId>` token.
          revokeAgentCredentials: (entityId) => {
            deviceAuthStore.revokeAgentCredentialsForEntity(entityId);
            // Matches auth/model.ts agentCallerId(entityId).
            tokenManager.revokeToken(`agent:${entityId}`);
          },
        });
      },
      getServiceDefinition() {
        if (!runtimeDefinition) {
          throw new Error("runtime service not initialized");
        }
        return runtimeDefinition;
      },
    });
  }

  // browser-data is an extension at workspace/extensions/browser-data. Callers
  // reach its declared namespace through `extensions.invokeProvider`; direct
  // package invocation is not a provider route. The extension proxies to the
  // BrowserDataDO via unified RPC, so storage stays in workerd unchanged.

  // ── Generic public webhook ingress ──
  {
    const { createWebhookIngressService } = await import("./services/webhookIngressService.js");
    let webhookIngress: ReturnType<typeof createWebhookIngressService> | null = null;
    container.registerManaged({
      name: "webhookIngress",
      dependencies: ["rpcServer"],
      async start(resolve) {
        const rpcServer = assertPresent(
          resolve<{ server: import("./rpcServer.js").RpcServer }>("rpcServer")
        );
        webhookIngress = createWebhookIngressService({
          relaySigningSecret: process.env["VIBESTUDIO_RELAY_SIGNING_SECRET"],
          relayOrigin: getRelayOrigin(),
          relayRegistrar: relayBackhaul?.client,
          // No public ingress: direct-mode webhooks only resolve co-located (loopback).
          // Remote webhooks ride the multi-tenant callback relay over the backhaul.
          directPublicBaseUrl: getLocalGatewayUrl("webhook direct base URL"),
          rpc: {
            call: (targetId, method, ...args) =>
              rpcServer.server.callTarget(targetId, method, ...args),
          },
          hasAppCapability: (callerId, capability) =>
            appHostForGateway?.hasAppCapability(callerId, capability) ?? false,
          dispatchToTarget: async (target, event) => {
            await rpcServer.server.callTarget(
              `do:${target.source}:${target.className}:${target.objectKey}`,
              target.method,
              event
            );
          },
        });
        relayServices.webhook = webhookIngress;
        if (webhookIngress.routes.length > 0) {
          routeRegistry.registerHttpServiceRoutes(webhookIngress.routes);
        }
        return webhookIngress;
      },
      async stop() {
        routeRegistry.unregisterHttpServiceRoutes("webhookIngress");
      },
      getServiceDefinition() {
        if (!webhookIngress) throw new Error("webhookIngress service not initialized");
        return webhookIngress.definition;
      },
    });
  }

  // Admin token resolution (first hit wins):
  //   1. VIBESTUDIO_ADMIN_TOKEN env var (always overrides)
  //   2. Persisted token at ~/.config/vibestudio/admin-token (survives restarts)
  //   3. Generate a random one and persist it so remote clients can save it
  let adminToken: string;
  let tokenSource: "env" | "persisted" | "generated" = "generated";
  if (process.env["VIBESTUDIO_ADMIN_TOKEN"]) {
    adminToken = assertPresent(process.env["VIBESTUDIO_ADMIN_TOKEN"]);
    tokenSource = "env";
  } else {
    const persisted = loadPersistedAdminToken();
    if (persisted) {
      adminToken = persisted;
      tokenSource = "persisted";
    } else {
      adminToken = randomBytes(32).toString("hex");
      try {
        savePersistedAdminToken(adminToken);
      } catch (err) {
        console.warn(`[Server] Failed to persist admin token at ${getAdminTokenPath()}:`, err);
      }
    }
  }
  tokenManager.setAdminToken(adminToken);
  // Host logs echo the admin token (token file line, --print-credentials);
  // keep it out of the userland-visible serverLog surface.
  serverLogStore.addSecret(adminToken);
  let gatewayPortResolved: number | null = null;
  function getResolvedGatewayPort(context: string): number {
    if (!gatewayPortResolved) {
      throw new Error(`Gateway port not finalized before ${context}`);
    }
    return gatewayPortResolved;
  }
  // Public TLS ingress is decommissioned — the gateway is loopback HTTP only.
  // Remote reach is the WebRTC pipe (DTLS-encrypted); there is no public URL.
  function gatewayProtocol(): "http" {
    return "http";
  }
  function getLocalGatewayUrl(context: string): string {
    return `${gatewayProtocol()}://127.0.0.1:${getResolvedGatewayPort(context)}`;
  }
  function getExternalGatewayUrl(context: string): string {
    return `${gatewayProtocol()}://${hostConfig.externalHost}:${getResolvedGatewayPort(context)}`;
  }
  // Single advertised loopback origin for auth connection info and native React
  // Native bundle bootstrap. (The public/QR pairing origin is gone — pairing is
  // the WebRTC room+fp link minted by the answerer; see the seam below.)
  function getConnectUrl(context: string): string {
    return getExternalGatewayUrl(context);
  }
  const { PanelRuntimeCoordinator } = await import("./panelRuntimeCoordinator.js");
  const panelRuntimeCoordinator = new PanelRuntimeCoordinator({ eventService });
  panelRuntimeCoordinatorForCleanup = panelRuntimeCoordinator;

  // ── RPC server (always present) ──
  let rpcServerForGateway: import("./rpcServer.js").RpcServer | null = null;

  container.registerManaged({
    name: "rpcServer",
    dependencies: ["tokenManager", "fsService"],
    async start(resolve) {
      const fsService = assertPresent(
        resolve<import("@vibestudio/shared/fsService").FsService>("fsService")
      );
      const { createPairingRedeemer } = await import("./services/authService.js");
      const server = new RpcServer({
        tokenManager,
        dispatcher,
        eventService,
        egressProxy,
        fsService,
        entityCache,
        connectionGrants,
        runtimeCoordinator: panelRuntimeCoordinator,
        // Let a fresh/returning device authenticate its shell session over the
        // WebRTC pipe by redeeming a QR pairing code / refresh credential (the
        // loopback HTTP /complete-pairing + /refresh-shell are unreachable remotely).
        redeemPairingCredential: createPairingRedeemer({ deviceAuthStore, tokenManager }),
        resolveExtensionInvocation: (extensionName, invocationToken) =>
          extensionHostForGateway?.resolveActiveInvocation(extensionName, invocationToken) ?? null,
        resolveExtensionCodeIdentity: (extensionName) =>
          extensionHostForGateway?.resolveCodeIdentity(extensionName) ?? null,
        // On-behalf-of tokens for userland vcs-DO dispatches (§4): the relay
        // mints one per dispatch to the single-writer DO; refs.updateMains
        // resolves it against the SAME table.
        vcsInvocations: vcsInvocationTable,
        getVcsWriterIdentity: () => {
          const binding = resolveVcsStoreBinding(workspaceDecls);
          return binding ? `do:${binding.source}:${binding.className}:${binding.objectKey}` : null;
        },
      });
      server.initHandlers();
      // Wire server→DO event push so connectionless DOs receive real
      // `events.subscribe` deliveries (e.g. vcs.subscribeHead on an EvalDO).
      eventService.setDoPushDelivery((callerId, channel, payload) =>
        server.pushEventToCaller(callerId, channel, payload)
      );
      rpcServerForGateway = server;
      return { server };
    },
    async stop(instance: { server: import("./rpcServer.js").RpcServer }) {
      await instance?.server?.stop();
    },
  });
  {
    const { createPanelRuntimeService } = await import("./services/panelRuntimeService.js");
    let panelRuntimeDefinition: import("@vibestudio/shared/serviceDefinition").ServiceDefinition;
    container.registerManaged({
      name: "panelRuntime",
      async start() {
        panelRuntimeDefinition = createPanelRuntimeService({
          coordinator: panelRuntimeCoordinator,
        });
        return panelRuntimeDefinition;
      },
      getServiceDefinition() {
        if (!panelRuntimeDefinition) throw new Error("panelRuntime service not initialized");
        return panelRuntimeDefinition;
      },
    });
  }

  // ── Extension host RPC service ──
  container.registerManaged({
    name: "extensionHost",
    dependencies: ["buildSystem", "tokenManager"],
    async start(resolve) {
      const { ExtensionHost } = await import("@vibestudio/extension-host");
      const buildSystemInst = assertPresent(
        resolve<import("./buildV2/index.js").BuildSystemV2>("buildSystem")
      );
      const tokenManagerInst = assertPresent(
        resolve<import("@vibestudio/shared/tokenManager").TokenManager>("tokenManager")
      );
      const host = new ExtensionHost({
        statePath,
        workspacePath,
        workspaceId: workspace.config.id,
        buildSystem: buildSystemInst,
        tokenManager: tokenManagerInst,
        eventService,
        approvalQueue,
        approvalCoordinator: unitApprovalCoordinator,
        notificationService: notificationResult.internal,
        recordUnitLog: (record) => {
          runtimeDiagnostics.record({
            workspaceId: record.workspaceId,
            entityId: record.unitName,
            kind: "extension",
            timestamp: record.timestamp,
            level: record.level,
            message: record.message,
            source: record.source ?? "ctx.log",
            fields: record.fields,
          });
        },
        readWorkspaceFileAtCommit,
        getContextIdForCaller: (callerId) => entityCache.resolveContext(callerId),
        getGatewayUrl: () => getLocalGatewayUrl("extension startup"),
        resolveProviderExtensionName: (provider) =>
          workspaceProviderExtensionPackageName(workspaceConfig, provider),
        providerSlots: WORKSPACE_EXTENSION_PROVIDER_NAMES,
        hostProviderContracts: {
          gitInterop: GIT_INTEROP_PROVIDER_METHOD_NAMES,
        },
        onWorkspaceUnitsChanged: (reason) =>
          hostTargetLaunchCoordinator.notifyAllTargetsChanged(reason),
        extensionTransport: {
          call(name, method, ...args) {
            const rpcServer = rpcServerForGateway;
            if (!rpcServer) throw new Error("RPC server is not initialized");
            return rpcServer.callTarget(name, method, ...args);
          },
          streamCallTarget(name, method, ...args) {
            const rpcServer = rpcServerForGateway;
            if (!rpcServer) throw new Error("RPC server is not initialized");
            return rpcServer.streamCallTarget(name, method, ...args);
          },
        },
        registerBuildProvider,
        unregisterBuildProvider,
      });
      extensionHostForGateway = host;
      return host;
    },
    async stop(instance: import("@vibestudio/extension-host").ExtensionHost) {
      await instance?.shutdown();
    },
    getServiceDefinition(instance?: import("@vibestudio/extension-host").ExtensionHost) {
      if (!instance) {
        instance =
          container.get<import("@vibestudio/extension-host").ExtensionHost>("extensionHost");
      }
      return instance.createServiceDefinition();
    },
  });

  // ── Workers RPC service ──

  // ── App host (workspace-owned privileged frontend apps) ──
  container.registerManaged({
    name: "appHost",
    dependencies: ["buildSystem"],
    async start(resolve) {
      const { AppHost } = await import("./appHost.js");
      const buildSystemInst = assertPresent(
        resolve<import("./buildV2/index.js").BuildSystemV2>("buildSystem")
      );
      const host = new AppHost({
        statePath,
        workspacePath,
        workspaceId: workspace.config.id,
        buildSystem: buildSystemInst,
        eventService,
        approvalQueue,
        approvalCoordinator: unitApprovalCoordinator,
        notificationService: notificationResult.internal,
        entityCache,
        connectionGrants,
        readWorkspaceFileAtCommit,
        getGatewayUrl: () => getLocalGatewayUrl("app startup"),
        getReactNativeAppArtifactBaseUrl: () => getConnectUrl("React Native app artifact"),
        getTerminalAppArtifactBaseUrl: () => getLocalGatewayUrl("Terminal app artifact"),
        onHostTargetChanged: (target, reason) =>
          hostTargetLaunchCoordinator.notifyTargetChanged(target, reason),
        // Manifest-declared preferred app per host target (meta/vibestudio.yml
        // hostTargets.*). Read live from workspaceConfig so meta-change
        // reloads are reflected without an AppHost restart.
        getHostTargetDecl: (target) => resolveHostTargetDecl(workspaceConfig, target),
      });
      appHostForGateway = host;
      return host;
    },
    async stop(instance: import("./appHost.js").AppHost) {
      await instance?.shutdown();
    },
  });

  // Activate a Durable Object's entity record (idempotent). A DO that calls
  // back into the server (runtime.*, console bridge) is attributed through the
  // entity cache — without a record its principal kind is unknown and every
  // call 403s. Service resolution activates on demand (workersRpc below);
  // server-dispatched singletons (vcsAttach → gad-store) activate explicitly.
  const activateDurableObjectEntity = async (
    doDispatch: import("./doDispatch.js").DODispatch,
    workerdManagerInst: import("./workerdManager.js").WorkerdManager,
    ref: {
      source: string;
      className: string;
      objectKey: string;
      contextId?: string;
      buildRef?: string;
    }
  ): Promise<void> => {
    const { source, className, objectKey, buildRef } = ref;
    const targetId = canonicalEntityId({ kind: "do", source, className, key: objectKey });
    const active = entityCache.resolveActive(targetId);
    if (active) {
      if (ref.contextId && active.contextId !== ref.contextId) {
        throw new Error(
          `Durable Object ${targetId} is already active in context ${active.contextId}; cannot resolve it from context ${ref.contextId}`
        );
      }
      return;
    }
    const { INTERNAL_DO_SOURCE } = await import("./internalDOs/internalDoLoader.js");
    const workspaceDORef: import("./doDispatch.js").DORef = {
      source: INTERNAL_DO_SOURCE,
      className: "WorkspaceDO",
      objectKey: workspace.config.id,
    };
    const existing = (await doDispatch.dispatch(
      workspaceDORef,
      "entityResolve",
      targetId
    )) as EntityRecord | null;
    if (existing?.status === "active") {
      if (ref.contextId && existing.contextId !== ref.contextId) {
        throw new Error(
          `Durable Object ${targetId} is already registered in context ${existing.contextId}; cannot resolve it from context ${ref.contextId}`
        );
      }
      entityCache._onActivate(existing);
      return;
    }
    const contextId =
      ref.contextId ??
      existing?.contextId ??
      createHash("sha256")
        .update(`${workspace.config.id}\x00${source}\x00${className}\x00${objectKey}`)
        .digest("hex");
    const prepared = await workerdManagerInst.ensureDurableObjectEntity({
      source,
      className,
      key: objectKey,
      contextId,
      ref: buildRef,
    });
    const record = (await doDispatch.dispatch(workspaceDORef, "entityActivate", {
      kind: "do",
      source: {
        repoPath: source,
        effectiveVersion: existing?.source.effectiveVersion ?? prepared.effectiveVersion,
      },
      contextId,
      className,
      key: objectKey,
    })) as EntityRecord;
    entityCache._onActivate(record);
  };

  {
    let workerServiceDef: import("@vibestudio/shared/serviceDefinition").ServiceDefinition;
    container.registerManaged({
      name: "workersRpc",
      dependencies: ["buildSystem", "workerdManager", "doDispatch"],
      async start(resolve) {
        const buildSystemInst = assertPresent(
          resolve<import("./buildV2/index.js").BuildSystemV2>("buildSystem")
        );
        const workerdManagerInst = assertPresent(
          resolve<import("./workerdManager.js").WorkerdManager>("workerdManager")
        );
        const doDispatch = assertPresent(
          resolve<import("./doDispatch.js").DODispatch>("doDispatch")
        );
        workerServiceDef = createWorkerService({
          buildSystem: buildSystemInst,
          workspaceDecls,
          getCallerContextId: (callerId) => entityCache.resolveContext(callerId),
          loadContextDeclarations: async (contextId) => {
            const stateHash = await workspaceVcs.resolveContextView(contextId);
            const config = await readWorkspaceConfigFromState(
              workspaceVcs,
              workspacePath,
              stateHash
            );
            return buildWorkspaceDeclarations(config);
          },
          activateDurableObject: ({ source, className, objectKey, contextId, buildRef }) => {
            return activateDurableObjectEntity(doDispatch, workerdManagerInst, {
              source,
              className,
              objectKey,
              ...(contextId ? { contextId } : {}),
              ...(buildRef ? { buildRef } : {}),
            });
          },
        });
      },
      getServiceDefinition() {
        return workerServiceDef;
      },
    });
  }

  // ===========================================================================
  // Shared services needed in both standalone and Electron modes
  // ===========================================================================

  // Filesystem service (used internally by workerdManager; in Electron mode
  // the main process has its OWN FsService for panel-facing FS RPC)
  {
    const { FsService } = await import("@vibestudio/shared/fsService");
    const { isWritableVcsPath, vcsContextHead } = await import("./vcsHost/paths.js");
    // Reroute: sandboxed context mutations to GAD-tracked paths commit through
    // GAD (edit-first) instead of writing the worktree projection directly.
    //
    // Per-repo routing. fsService routes each workspace-relative edit to its
    // owning repo by section taxonomy, strips the repo prefix, and records a
    // working edit on that repo's `ctx:{contextId}` head.
    const vcsBridge: import("@vibestudio/shared/fsService").FsVcsBridge = {
      isTracked: (relPath) => isWritableVcsPath(relPath),
      // fs writes of tracked paths are WORKING edits (recordEdit): tracked
      // durably with provenance, projected to disk, but NOT a commit — no head
      // advance, no build. The user/agent commits deliberately via vcs.commit.
      edit: async (contextId, repoPath, edits, actor) => {
        const head = vcsContextHead(contextId);
        await workspaceVcs.recordEdit({
          head,
          repoPath,
          edits,
          actor,
        });
      },
      // Read from the context's composed view: each repo's `ctx` head if it has
      // been edited, else that repo's pinned-`baseView` state. The composed view
      // is a workspace-rooted state, so address it by the full workspace path.
      readFile: async (contextId, repoPath, relPath) => {
        const view = await workspaceVcs.resolveContextView(contextId);
        const wsPath = `${repoPath}/${relPath}`;
        const file = await workspaceVcs.readFile(view, wsPath);
        return file ? file.content : null;
      },
      // Workspace-relative listing of the whole composed context view (all repos:
      // edited ones at their ctx head, the rest at the pinned base).
      listFiles: async (contextId) => {
        const view = await workspaceVcs.resolveContextView(contextId);
        return (await workspaceVcs.listFiles(view)).map((f) => f.path);
      },
      // Sparse demand-materialize: write only the requested repos' subtrees to
      // the context folder (intelligent — a repo-scoped grep materializes one repo).
      ensureMaterialized: (contextId, repos) =>
        workspaceVcs.materializeContextRepos(contextId, repos),
      isMaterialized: async (contextId, repoPath) =>
        workspaceVcs.isContextRepoMaterialized(contextId, repoPath),
    };
    container.registerManaged({
      name: "fsService",
      async start() {
        return new FsService(contextFolderManager, entityCache, { vcsBridge });
      },
    });
  }

  // WorkerdManager — manages workerd process and worker instances
  //
  // Workers POST back through the gateway. The gateway starts before
  // container.startAll(), so this URL is stable by the time workerd boots.
  // Live worker → VerifiedCaller registry for attributed egress through the
  // shared listener. Populated by WorkerdManager on worker create/destroy.
  const egressCallers = new Map<
    string,
    import("@vibestudio/shared/serviceDispatcher").VerifiedCaller
  >();
  {
    let workerdManagerInstance: import("./workerdManager.js").WorkerdManager | null = null;
    let buildSystemForWorkerd: import("./buildV2/index.js").BuildSystemV2 | null = null;
    container.registerManaged({
      name: "workerdManager",
      dependencies: ["buildSystem", "fsService"],
      async start(resolve) {
        const { WorkerdManager } = await import("./workerdManager.js");
        buildSystemForWorkerd = assertPresent(
          resolve<import("./buildV2/index.js").BuildSystemV2>("buildSystem")
        );
        const fsServiceInst = assertPresent(
          resolve<import("@vibestudio/shared/fsService").FsService>("fsService")
        );

        workerdManagerInstance = new WorkerdManager({
          tokenManager,
          fsService: fsServiceInst,
          getServerUrl: () => {
            if (!gatewayPortResolved) {
              throw new Error("Gateway port not finalized before workerd startup");
            }
            return `http://127.0.0.1:${gatewayPortResolved}`;
          },
          getServerAliasUrls: () => {
            if (!gatewayPortResolved) return [];
            const aliases = new Set<string>();
            const configuredAliases = process.env["VIBESTUDIO_GATEWAY_ALIASES"];
            if (configuredAliases) {
              for (const alias of parseGatewayAliases(configuredAliases)) {
                aliases.add(alias);
              }
            }
            aliases.add(
              `${configuredProtocol}://${hostConfig.externalHost}:${gatewayPortResolved}`
            );
            return [...aliases];
          },
          bindRuntimeImage: (unitPath, ref) =>
            assertPresent(buildSystemForWorkerd).bindRuntimeImage(unitPath, ref),
          getBuildByKey: (key) => assertPresent(buildSystemForWorkerd).getBuildByKey(key),
          workspacePath,
          statePath,
          routeRegistry,
          getManifestRoutes: (source) => workspaceDecls.routes.filter((r) => r.source === source),
          getManifestDoClasses: (source) => {
            const node = assertPresent(buildSystemForWorkerd)
              .getGraph()
              .allNodes()
              .find((n) => n.kind === "worker" && n.relativePath === source);
            return node?.manifest.durable?.classes ?? [];
          },
          singletonRegistry: workspaceDecls.singletons,
          getProxyPort: (caller) => egressProxy.startForCaller(caller),
          getSharedEgressPort: () =>
            egressProxy.startShared(assertPresent(workerdManagerInstance).getEgressSecret()),
          registerEgressCaller: (callerId, caller) => egressCallers.set(callerId, caller),
          unregisterEgressCaller: (callerId) => egressCallers.delete(callerId),
          getWorkerdGatewayToken: () => workerdGatewayToken,
          // Manifest-declared wiring: the DO backing the userland `vcs`
          // service (vibestudio.vcs.v1) stays main-bound during bootstrap — the
          // host's provenance follower records into it, so it must never be
          // rebound to a synthetic ctx-head scope. Internal DO classes receive
          // their provider identities as env bindings.
          getBootstrapMainBoundDos: () => {
            const binding = resolveVcsStoreBinding(workspaceDecls);
            return binding ? [{ source: binding.source, className: binding.className }] : [];
          },
          getInternalDoEnv: internalDoProviderEnv,
          recordLifecycleEvent: (event) => {
            runtimeDiagnostics.record({
              workspaceId: workspace.config.id,
              entityId: event.source,
              kind: "worker",
              level: event.level,
              message: event.message,
              source: "lifecycle",
              fields: { callerId: event.callerId, ...event.fields },
            });
            eventService.emit("workspace:unit-log", {
              workspaceId: workspace.config.id,
              unitName: event.source,
              kind: "worker",
              timestamp: Date.now(),
              level: event.level,
              message: event.message,
              source: "console",
            } satisfies import("./services/workspaceService.js").WorkspaceUnitLogRecord);
          },
        });
        workerdManagerForGateway = workerdManagerInstance;
        // Resolve attributed egress (shared listener) → live worker VerifiedCaller.
        egressProxy.setCallerResolver((callerId) => egressCallers.get(callerId) ?? null);

        // Wire source rebuilds to restart workers.
        //
        // Always pass an explicit array (possibly empty) so onSourceRebuilt
        // can reconcile removals: if a manifest edit DROPS a DO class, the
        // array reflects that absence and the stale DO service gets torn
        // down. Passing `undefined` would leave stale services bound forever.
        buildSystemForWorkerd.onPushBuild((source, trigger, buildKey) => {
          const head = trigger?.head ?? "main";
          if (head !== "main") {
            workerdManagerInstance
              ?.onSourceRebuilt(source, undefined, trigger, buildKey)
              .catch((err) => {
                console.error(
                  `[WorkerdManager] Failed to handle rebuilt source ${source}@${head}:`,
                  err
                );
              });
            return;
          }

          const node = buildSystemForWorkerd
            ?.getGraph()
            .allNodes()
            .find((n) => n.relativePath === source);
          const manifest = node?.manifest as Record<string, unknown> | undefined;
          const durable = manifest?.["durable"] as
            | { classes?: Array<{ className: string }> }
            | undefined;
          const doClasses = durable?.classes ?? [];

          workerdManagerInstance
            ?.onSourceRebuilt(source, doClasses, trigger, buildKey)
            .catch((err) => {
              console.error(`[WorkerdManager] Failed to handle rebuilt source ${source}:`, err);
            });
        });

        // Start static internal DO services before readiness, then publish
        // manifest-declared userland DO route metadata. Userland DO code is
        // still built lazily on first resolve/request by the gateway's
        // ensureDORoute hook, so declared routes exist at readiness without
        // turning background build prewarm into startup latency.
        {
          const { INTERNAL_DO_CLASSES, INTERNAL_DO_SOURCE } =
            await import("./internalDOs/internalDoLoader.js");
          const internalDoClasses = INTERNAL_DO_CLASSES.map((className) => ({
            source: INTERNAL_DO_SOURCE,
            className,
          }));
          if (internalDoClasses.length > 0) {
            console.log(
              `[WorkerdManager] Pre-registering internal DO classes:`,
              internalDoClasses.map((c) => `${c.source}:${c.className}`).join(", ")
            );
            await workerdManagerInstance.registerAllDOClasses(internalDoClasses);
          }

          if (workspaceDecls.routes.some((route) => route.durableObject)) {
            const graph = buildSystemForWorkerd.getGraph();
            for (const node of graph.allNodes()) {
              if (node.kind !== "worker") continue;
              if (!node.manifest.durable) continue;
              for (const cls of node.manifest.durable.classes) {
                try {
                  const sourceRoutes = workspaceDecls.routes.filter(
                    (route) => route.source === node.relativePath
                  );
                  routeRegistry.registerDoRoutes(
                    node.relativePath,
                    cls.className,
                    sourceRoutes,
                    workspaceDecls.singletons
                  );
                } catch (err) {
                  console.warn(
                    `[WorkerdManager] Failed to register DO routes for ${node.relativePath}:${cls.className}:`,
                    err instanceof Error ? err.message : err
                  );
                }
              }
            }
          }
        }

        return workerdManagerInstance;
      },
      async stop(instance: import("./workerdManager.js").WorkerdManager | null) {
        await instance?.shutdown();
      },
      // No RPC service: workerd's only userland-facing methods were the DO-storage
      // primitives cloneDO/destroyDO, now closed off. They live on as plain
      // WorkerdManager methods that the runtime service calls server-internally
      // (cloneContext/destroyContext), behind the context-boundary gate.
    });
  }

  {
    container.registerManaged({
      name: "doDispatch",
      dependencies: ["workerdManager"],
      async start(resolve) {
        const { DODispatch } = await import("./doDispatch.js");
        const workerdManager = assertPresent(
          resolve<import("./workerdManager.js").WorkerdManager>("workerdManager")
        );
        const doDispatch = new DODispatch();
        doDispatch.setTokenManager(tokenManager);
        doDispatch.setGetWorkerdGatewayToken(() => workerdGatewayToken);
        doDispatch.setGetWorkerdUrl(() => {
          const port = workerdManager.getPort();
          if (!port) throw new Error("workerd not running");
          return `http://127.0.0.1:${port}`;
        });
        doDispatch.setGetDispatchSecret(() => workerdManager.getDispatchSecret());
        doDispatch.setEnsureDO((source, className, objectKey) => {
          const targetId = canonicalEntityId({ kind: "do", source, className, key: objectKey });
          const record = entityCache.resolveActive(targetId);
          return workerdManager.ensureDO(source, className, objectKey, {
            contextId: record?.contextId,
          });
        });
        return doDispatch;
      },
    });
  }

  {
    // Attach the workspace vcs to the DO backing the manifest-declared
    // userland `vcs` service (meta/vibestudio.yml services[] row for protocol
    // vibestudio.vcs.v1, resolved with its singletonObjects row — the SAME
    // declaration userland dispatch resolves): ingest the bootstrap local
    // state (same state hash — no EV churn) and enable durable commits,
    // context forks, and the builds provenance log. No such service ⇒ the
    // durable store stays disabled with a loud diagnostic — the host never
    // falls back to a hardcoded worker name.
    container.registerManaged({
      name: "vcsAttach",
      dependencies: ["doDispatch", "workerdManager"],
      async start(resolve) {
        const binding = resolveVcsStoreBinding(workspaceDecls);
        if (!binding) {
          console.error(
            "[Vcs] meta/vibestudio.yml declares no singleton-DO-backed `vcs` service " +
              "(protocol vibestudio.vcs.v1 with a matching singletonObjects row) — durable VCS " +
              "store disabled (no durable commits, context forks, or builds provenance)"
          );
          return workspaceVcs;
        }
        const { source, className } = binding;
        const doDispatch = assertPresent(
          resolve<import("./doDispatch.js").DODispatch>("doDispatch")
        );
        const workerdManagerInst = assertPresent(
          resolve<import("./workerdManager.js").WorkerdManager>("workerdManager")
        );
        const gadRef = {
          source,
          className,
          objectKey: binding.objectKey,
          buildRef: "main",
        };
        // Entity record first: the DO's callbacks into the server (setTitle,
        // console bridge) resolve their principal through the entity cache.
        await activateDurableObjectEntity(doDispatch, workerdManagerInst, gadRef);
        // attachGad bootstraps per-repo logs from disk (snapshot each on-disk
        // repo subtree into `vcs:repo:<path>` at `main` if missing) AND seeds
        // every repo main into the protected-ref store (idempotent set-if-
        // absent on every startup).
        await workspaceVcs.attachGad({
          call: <T>(
            method: string,
            input: unknown,
            opts?: { invocationToken?: string }
          ): Promise<T> =>
            (opts?.invocationToken
              ? doDispatch.dispatchOnBehalf(gadRef, method, [input], opts.invocationToken)
              : doDispatch.dispatch(gadRef, method, input)) as Promise<T>,
        });
        workspaceVcs.enableMemoryIndexing();
        console.log(`[Vcs] Attached to VCS store DO (${source}:${className})`);
        return workspaceVcs;
      },
    });
  }

  {
    container.registerManaged({
      name: "lifecycleDriver",
      dependencies: ["workerdManager", "doDispatch"],
      async start(resolve) {
        const { LifecycleDriver } = await import("./services/lifecycleDriver.js");
        const driver = new LifecycleDriver({
          workerdManager: assertPresent(
            resolve<import("./workerdManager.js").WorkerdManager>("workerdManager")
          ),
          doDispatch: assertPresent(resolve<import("./doDispatch.js").DODispatch>("doDispatch")),
          workspaceId: workspace.config.id,
        });
        driver.start();
        return driver;
      },
      async stop(instance: import("./services/lifecycleDriver.js").LifecycleDriver | null) {
        instance?.stop();
      },
    });
  }

  {
    container.registerManaged({
      name: "vcsGcScheduler",
      dependencies: ["vcsAttach"],
      async start(resolve) {
        const { VcsGcScheduler } = await import("./services/vcsGcScheduler.js");
        const attachedVcs = assertPresent(
          resolve<import("./vcsHost/workspaceVcs.js").WorkspaceVcs>("vcsAttach")
        );
        const scheduler = new VcsGcScheduler({ workspaceVcs: attachedVcs });
        scheduler.start();
        return scheduler;
      },
      async stop(instance: import("./services/vcsGcScheduler.js").VcsGcScheduler | null) {
        instance?.stop();
      },
    });
  }

  {
    container.registerManaged({
      name: "alarmDriver",
      dependencies: ["doDispatch"],
      async start(resolve) {
        const { AlarmDriver } = await import("./services/alarmDriver.js");
        const driver = new AlarmDriver({
          doDispatch: assertPresent(resolve<import("./doDispatch.js").DODispatch>("doDispatch")),
          workspaceId: workspace.config.id,
        });
        alarmDriverInstance = driver;
        driver.start();
        return driver;
      },
      async stop(instance: import("./services/alarmDriver.js").AlarmDriver | null) {
        instance?.stop();
        alarmDriverInstance = null;
      },
    });
  }

  {
    container.registerManaged({
      name: "recurringRegistry",
      dependencies: ["doDispatch"],
      async start(resolve) {
        const { RecurringRegistry } = await import("./services/recurringRegistry.js");
        const registry = new RecurringRegistry({
          doDispatch: assertPresent(resolve<import("./doDispatch.js").DODispatch>("doDispatch")),
          workspaceId: workspace.config.id,
          loadRecurring: () => workspaceConfig.recurring ?? [],
        });
        recurringRegistryInstance = registry;
        await registry.start();
        return registry;
      },
      async stop(instance: import("./services/recurringRegistry.js").RecurringRegistry | null) {
        instance?.stop();
        recurringRegistryInstance = null;
      },
    });
  }

  {
    container.registerManaged({
      name: "heartbeatDeclarationRegistry",
      dependencies: ["doDispatch"],
      async start(resolve) {
        const { HeartbeatDeclarationRegistry } = await import("./services/recurringRegistry.js");
        const registry = new HeartbeatDeclarationRegistry({
          doDispatch: assertPresent(resolve<import("./doDispatch.js").DODispatch>("doDispatch")),
          workspaceId: workspace.config.id,
          loadHeartbeats: () => workspaceConfig.heartbeats ?? [],
        });
        heartbeatDeclarationRegistryInstance = registry;
        await registry.start();
        return registry;
      },
      async stop(
        instance: import("./services/recurringRegistry.js").HeartbeatDeclarationRegistry | null
      ) {
        instance?.stop();
        heartbeatDeclarationRegistryInstance = null;
      },
    });
  }

  // ===========================================================================
  // Panel services, workspace info, PanelHttpServer, FS RPC
  // (extracted to panelRuntimeRegistration.ts)
  // ===========================================================================

  // Resolve host configuration from CLI args / env vars
  const { resolveHostConfig } = await import("@vibestudio/shared/hostConfig");
  const hostConfig = resolveHostConfig({
    workerdPort: 0, // ports filled later
    gatewayPort: requestedGatewayPort ?? 0,
    host: args.host,
    bindHost: args.bindHost,
  });

  const { registerPanelServices } = await import("./panelRuntimeRegistration.js");
  // Set once the container constructs the manager (registered before
  // startAll below); the commonDeps closure resolves it lazily.
  let headlessHostManager: import("./headlessHostManager.js").HeadlessHostManager | null = null;
  const getHeadlessHostManager = () => headlessHostManager;
  const commonDeps = {
    container,
    dispatcher,
    entityCache,
    connectionGrants,
    workspace,
    workspacePath,
    workspaceConfig,
    treeScanner,
    adminToken,
    centralData,
    args,
    hostConfig,
    tokenManager,
    grantStore: capabilityGrantStore,
    hasAppCapability: (callerId: string, capability: AppCapability) =>
      appHostForGateway?.hasAppCapability(callerId, capability) ?? false,
    contextExists: contextBoundaryDeps.contextExists,
    resolveContextOwnerLabel: contextBoundaryDeps.resolveContextOwnerLabel,
    panelRuntimeCoordinator,
    ensureDefaultHeadlessHost: async () => {
      const manager = getHeadlessHostManager();
      if (!manager) return false;
      return Boolean(await manager.ensureDefaultHost());
    },
    getGatewayPort: () => gatewayPortResolved,
    eventService,
    // Backs `workspace.ensureContextFolder` — launch orchestrators materialize a
    // context's working folder to place context-scoped terminal sessions in it.
    ensureContextFolder: async (contextId: string) => ({
      dir: await contextFolderManager.ensureContextFolder(contextId),
    }),
    resolveCallerContext: (callerId: string) => getEntityStore().resolveContext(callerId),
    listWorkspaceUnits: () => {
      const buildSystem = container.get<import("./buildV2/index.js").BuildSystemV2>("buildSystem");
      type WorkspaceUnitStatus = import("./services/workspaceService.js").WorkspaceUnitStatus;
      const trustedRows: WorkspaceUnitStatus[] = trustedUnitHosts().flatMap(
        (host) => host.listWorkspaceUnits() as WorkspaceUnitStatus[]
      );
      const trustedRowsBySource = new Map<string, WorkspaceUnitStatus>(
        trustedRows.map((row) => [row.source, row])
      );
      const workerInstances = new Map(
        workerdManagerForGateway?.listInstances().map((instance) => [instance.source, instance]) ??
          []
      );
      const rows: import("./services/workspaceService.js").WorkspaceUnitStatus[] = [
        ...trustedRows.filter((row) => row.kind === "app"),
      ];
      for (const node of buildSystem?.getGraph().allNodes() ?? []) {
        if (node.kind !== "panel" && node.kind !== "worker" && node.kind !== "extension") continue;
        if (node.kind === "extension") {
          rows.push(
            trustedRowsBySource.get(node.relativePath) ?? {
              name: node.name,
              kind: "extension",
              source: node.relativePath,
              displayName: node.manifest.displayName ?? node.name,
              status: "stopped",
              ev: buildSystem?.getEffectiveVersion(node.name) ?? null,
              lastError: null,
              health: null,
              methods: [],
              hasFetch: false,
              respawn: null,
              inspectorUrl: null,
            }
          );
          continue;
        }
        const workerInstance =
          node.kind === "worker" ? workerInstances.get(node.relativePath) : null;
        const workerLastError =
          node.kind === "worker"
            ? (workerdManagerForGateway?.getLastWorkerError(node.relativePath) ?? null)
            : null;
        rows.push({
          name: node.name,
          kind: node.kind,
          source: node.relativePath,
          displayName: node.manifest.displayName ?? node.manifest.title ?? node.name,
          status: workerInstance
            ? workerInstance.status === "starting"
              ? "building"
              : workerInstance.status
            : workerLastError
              ? "error"
              : "available",
          lastError: workerLastError?.message ?? null,
          ev: workerInstance?.buildKey ?? buildSystem?.getEffectiveVersion(node.name) ?? null,
          inspectorUrl: workerInstance
            ? (workerdManagerForGateway?.getWorkerInspectorUrl(workerInstance.source) ?? null)
            : null,
          bindings:
            node.kind === "worker" && workerInstance
              ? ((workerInstance as { bindings?: Record<string, unknown> | null }).bindings ?? null)
              : null,
          lastBuiltAt: null,
          pendingApproval: null,
          availableUpdate: null,
        });
      }
      return rows;
    },
    restartWorkspaceUnit: async (
      ctx: import("@vibestudio/shared/serviceDispatcher").ServiceContext,
      name: string
    ) => {
      // Resolve by kind via the build graph so callers can use either the
      // package name or the workspace-relative source path. Extensions go
      // through the approval-gated reload; workers re-spawn through workerd's
      // config-reload path. Panels have no host-driven restart concept — a
      // panel restarts on the next page navigation.
      const extensionHost = extensionHostForGateway;
      if (extensionHost?.registry.get(name)) {
        await extensionHost.reload(ctx, name);
        return;
      }
      const appHost = appHostForGateway;
      if (
        appHost?.registry.get(name) ||
        appHost?.registry.list().some((entry) => entry.source.repo === name)
      ) {
        await appHost.restartApp(name);
        return;
      }
      const buildSystem = container.get<import("./buildV2/index.js").BuildSystemV2>("buildSystem");
      const node = buildSystem
        ?.getGraph()
        .allNodes()
        .find((candidate) => candidate.name === name || candidate.relativePath === name);
      if (!node) {
        throw new Error(`Workspace unit not found: ${name}`);
      }
      if (node.kind === "worker") {
        const workerdManager = workerdManagerForGateway;
        if (!workerdManager) throw new Error("Worker runtime is not available");
        const instance = workerdManager
          .listInstances()
          .find((entry) => entry.source === node.relativePath);
        if (!instance) {
          throw new Error(`Worker has no running instance to restart: ${node.relativePath}`);
        }
        await workerdManager.updateInstance(instance.name, {});
        return;
      }
      if (node.kind === "panel") {
        throw new Error(
          "Panels restart on next page navigation; no host-driven restart is available"
        );
      }
      throw new Error(`Workspace unit kind not restartable: ${node.kind}`);
    },
    listWorkspaceUnitLogs: (
      name: string,
      opts?: {
        since?: number;
        level?: import("./services/workspaceService.js").WorkspaceUnitLogRecord["level"];
        limit?: number;
      }
    ) => {
      // Resolve the unit kind from the build graph (the same surface
      // listWorkspaceUnits uses) and pull from the corresponding store.
      const buildSystem = container.get<import("./buildV2/index.js").BuildSystemV2>("buildSystem");
      const node = buildSystem
        ?.getGraph()
        .allNodes()
        .find((candidate) => candidate.name === name || candidate.relativePath === name);
      const kind = node?.kind;
      if (kind === "app") {
        return appHostForGateway?.listWorkspaceUnitLogs(name) ?? [];
      }
      if (kind === "worker") {
        const source = node?.relativePath ?? name;
        const persisted = runtimeDiagnostics.history(source, {
          since: opts?.since,
          level: opts?.level,
          limit: opts?.limit,
        });
        return persisted.entries.map((entry) => ({
          workspaceId: entry.workspaceId ?? workspace.config.id,
          unitName: source,
          kind: "worker" as const,
          timestamp: entry.timestamp,
          level: entry.level,
          message: entry.message,
          fields: entry.fields,
          source: entry.source === "system" ? "console" : entry.source,
        }));
      }
      if (kind === "panel") {
        // Panel console errors and lifecycle events are forwarded from the
        // shell via panelLog.append and keyed by package name.
        const persisted = runtimeDiagnostics.history(node?.name ?? name, {
          since: opts?.since,
          level: opts?.level,
          limit: opts?.limit,
        });
        return persisted.entries.map((entry) => ({
          workspaceId: entry.workspaceId ?? workspace.config.id,
          unitName: node?.name ?? name,
          kind: "panel" as const,
          timestamp: entry.timestamp,
          level: entry.level,
          message: entry.message,
          fields: entry.fields,
          source:
            entry.source === "system" || entry.source === "lifecycle" ? "console" : entry.source,
        }));
      }
      // Default and extension: the extension host has its own buffer and
      // also returns [] if the name is unknown.
      return extensionHostForGateway?.listWorkspaceUnitLogs(name, opts) ?? [];
    },
    unitDiagnostics: (
      name: string,
      opts?: {
        since?: number;
        sinceSeq?: number;
        level?: import("./services/workspaceService.js").WorkspaceUnitLogRecord["level"];
        limit?: number;
        errorLimit?: number;
      }
    ) => {
      const units = commonDeps.listWorkspaceUnits();
      const unit = units.find((row) => row.name === name || row.source === name) ?? null;
      const entityId = unit?.kind === "worker" ? unit.source : (unit?.name ?? name);
      const history = runtimeDiagnostics.history(entityId, {
        since: opts?.since,
        sinceSeq: opts?.sinceSeq,
        level: opts?.level,
        limit: opts?.limit,
        errorLimit: opts?.errorLimit,
      });
      const kind = unit?.kind ?? "worker";
      const toLog = (
        entry: import("./runtimeDiagnosticsStore.js").RuntimeDiagnosticRecord
      ): import("./services/workspaceService.js").WorkspaceUnitLogRecord => ({
        workspaceId: entry.workspaceId ?? workspace.config.id,
        unitName: entityId,
        kind,
        timestamp: entry.timestamp,
        level: entry.level,
        message: entry.message,
        fields: entry.fields,
        source: entry.source,
        seq: entry.seq,
      });
      const fallbackLogs = commonDeps.listWorkspaceUnitLogs(name, opts);
      const logs = history.entries.length > 0 ? history.entries.map(toLog) : fallbackLogs;
      const buildSystem = container.get<import("./buildV2/index.js").BuildSystemV2>("buildSystem");
      return {
        unit,
        logs,
        errors: history.errors.map(toLog),
        builds: buildSystem?.listRecentBuildEvents(unit?.name ?? name) ?? [],
        dropped: history.dropped,
        capacity: history.capacity,
      };
    },
    bakeAppDist: (sourceOrName: string, opts?: { outDir?: string }) => {
      const appHost = appHostForGateway;
      if (!appHost) throw new Error("App host is not available");
      return appHost.bakeDist(
        sourceOrName,
        opts?.outDir ?? path.join(appRoot, "dist", "baked-app")
      );
    },
    listAppVersions: (sourceOrName: string) => {
      const appHost = appHostForGateway;
      if (!appHost) return { current: null, previous: [], retentionLimit: 0 };
      return appHost.listAppVersions(sourceOrName);
    },
    rollbackAppVersion: (sourceOrName: string, buildKey?: string) => {
      const appHost = appHostForGateway;
      if (!appHost) throw new Error("App host is not available");
      return appHost.rollbackAppVersion(sourceOrName, buildKey);
    },
    listRecurringJobs: () => recurringRegistryInstance?.listJobs() ?? [],
    listHeartbeats: async () => {
      const doDispatch = container.get<import("./doDispatch.js").DODispatch>("doDispatch");
      const { INTERNAL_DO_SOURCE } = await import("./internalDOs/internalDoLoader.js");
      const rows = (await doDispatch.dispatch(
        { source: INTERNAL_DO_SOURCE, className: "WorkspaceDO", objectKey: workspace.config.id },
        "heartbeatList"
      )) as Array<{
        name: string;
        source: string;
        className: string;
        objectKey: string;
        channelId?: string | null;
        participantHandle?: string | null;
        kind: "declarative" | "code-owned";
        status: "running" | "paused" | "stopped";
        nextRunAt?: number | null;
        lastWakeAt?: number | null;
        lastActionSummary?: string | null;
        lastError?: string | null;
        specHash?: string | null;
        updatedAt: number;
      }>;
      return rows.map((row) => ({
        name: row.name,
        target: { source: row.source, className: row.className, objectKey: row.objectKey },
        channelId: row.channelId ?? null,
        participantHandle: row.participantHandle ?? null,
        kind: row.kind,
        status: row.status,
        nextRunAt: row.nextRunAt ?? null,
        lastWakeAt: row.lastWakeAt ?? null,
        lastActionSummary: row.lastActionSummary ?? null,
        lastError: row.lastError ?? null,
        specHash: row.specHash ?? null,
        updatedAt: row.updatedAt,
      }));
    },
    runHeartbeatNow: async (
      selector:
        | string
        | {
            name?: string;
            target?: { source?: string; className?: string; objectKey?: string };
            channelId?: string;
            participantHandle?: string;
          }
    ) => {
      const doDispatch = container.get<import("./doDispatch.js").DODispatch>("doDispatch");
      const { INTERNAL_DO_SOURCE } = await import("./internalDOs/internalDoLoader.js");
      const rows = (await doDispatch.dispatch(
        { source: INTERNAL_DO_SOURCE, className: "WorkspaceDO", objectKey: workspace.config.id },
        "heartbeatList"
      )) as Array<{
        name: string;
        source: string;
        className: string;
        objectKey: string;
        channelId?: string | null;
        participantHandle?: string | null;
      }>;
      const row = resolveHeartbeatRegistryRow(rows, selector);
      if (!row) throw new Error(`Unknown heartbeat: ${JSON.stringify(selector)}`);
      return doDispatch.dispatch(
        { source: row.source, className: row.className, objectKey: row.objectKey },
        "runHeartbeatNow",
        row.name
      );
    },
    pauseHeartbeat: async (
      selector:
        | string
        | {
            name?: string;
            target?: { source?: string; className?: string; objectKey?: string };
            channelId?: string;
            participantHandle?: string;
          }
    ) => {
      const doDispatch = container.get<import("./doDispatch.js").DODispatch>("doDispatch");
      const { INTERNAL_DO_SOURCE } = await import("./internalDOs/internalDoLoader.js");
      const rows = (await doDispatch.dispatch(
        { source: INTERNAL_DO_SOURCE, className: "WorkspaceDO", objectKey: workspace.config.id },
        "heartbeatList"
      )) as Array<{
        name: string;
        source: string;
        className: string;
        objectKey: string;
        channelId?: string | null;
        participantHandle?: string | null;
      }>;
      const row = resolveHeartbeatRegistryRow(rows, selector);
      if (!row) throw new Error(`Unknown heartbeat: ${JSON.stringify(selector)}`);
      return doDispatch.dispatch(
        { source: row.source, className: row.className, objectKey: row.objectKey },
        "pauseHeartbeat",
        row.name
      ) as Promise<{ ok: true }>;
    },
    resumeHeartbeat: async (
      selector:
        | string
        | {
            name?: string;
            target?: { source?: string; className?: string; objectKey?: string };
            channelId?: string;
            participantHandle?: string;
          }
    ) => {
      const doDispatch = container.get<import("./doDispatch.js").DODispatch>("doDispatch");
      const { INTERNAL_DO_SOURCE } = await import("./internalDOs/internalDoLoader.js");
      const rows = (await doDispatch.dispatch(
        { source: INTERNAL_DO_SOURCE, className: "WorkspaceDO", objectKey: workspace.config.id },
        "heartbeatList"
      )) as Array<{
        name: string;
        source: string;
        className: string;
        objectKey: string;
        channelId?: string | null;
        participantHandle?: string | null;
      }>;
      const row = resolveHeartbeatRegistryRow(rows, selector);
      if (!row) throw new Error(`Unknown heartbeat: ${JSON.stringify(selector)}`);
      return doDispatch.dispatch(
        { source: row.source, className: row.className, objectKey: row.objectKey },
        "resumeHeartbeat",
        row.name
      ) as Promise<{ ok: true }>;
    },
    listHostTargetCandidates: (target: import("@vibestudio/shared/hostTargets").HostTarget) => {
      const appHost = appHostForGateway;
      return appHost?.listHostTargetCandidates(target) ?? [];
    },
    getHostTargetSelection: (target: import("@vibestudio/shared/hostTargets").HostTarget) => {
      const appHost = appHostForGateway;
      return (
        appHost?.getHostTargetSelection(target) ?? {
          selection: null,
          valid: false,
          reason: "App host is not available",
        }
      );
    },
    setHostTargetSelection: (
      target: import("@vibestudio/shared/hostTargets").HostTarget,
      input: import("@vibestudio/shared/hostTargets").HostTargetSelectionInput
    ) => {
      const appHost = appHostForGateway;
      if (!appHost) throw new Error("App host is not available");
      return appHost.setHostTargetSelection(target, input);
    },
    clearHostTargetSelection: (target: import("@vibestudio/shared/hostTargets").HostTarget) => {
      appHostForGateway?.clearHostTargetSelection(target);
    },
    listHostTargetVersions: (
      target: import("@vibestudio/shared/hostTargets").HostTarget,
      sourceOrName: string
    ) => {
      const appHost = appHostForGateway;
      if (!appHost) return { current: null, previous: [], retentionLimit: 0 };
      return appHost.listHostTargetVersions(target, sourceOrName);
    },
    prepareHostTargetPinnedRef: (
      target: import("@vibestudio/shared/hostTargets").HostTarget,
      sourceOrName: string,
      ref: string
    ) => {
      const appHost = appHostForGateway;
      if (!appHost) throw new Error("App host is not available");
      return appHost.prepareHostTargetPinnedRef(target, sourceOrName, ref);
    },
    launchHostTarget: async (target: import("@vibestudio/shared/hostTargets").HostTarget) => {
      return hostTargetLaunchCoordinator.launch(target);
    },
    beginHostTargetLaunch: async (target: import("@vibestudio/shared/hostTargets").HostTarget) => {
      return hostTargetLaunchCoordinator.beginLaunch(target);
    },
    getHostTargetLaunchSession: (sessionId: string) => {
      return hostTargetLaunchCoordinator.getLaunchSession(sessionId);
    },
    resolveHostTargetLaunchSessionApproval: (sessionId: string, decision: "once" | "deny") => {
      return hostTargetLaunchCoordinator.resolveLaunchSessionApproval(sessionId, decision);
    },
    cancelHostTargetLaunchSession: (sessionId: string) => {
      hostTargetLaunchCoordinator.cancelLaunchSession(sessionId);
    },
    approvalQueue,
    registerEntityTitleListener: (
      listener: (
        entityId: string,
        title: string | undefined,
        origin: "set" | "set-explicit" | "mirror" | "clear"
      ) => void | Promise<void>
    ) =>
      entityTitleService.onChanged((entityId, title, origin) => {
        void Promise.resolve(listener(entityId, title, origin)).catch((error: unknown) => {
          console.warn(
            `[entityTitleService] panel title listener failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        });
      }),
    registerSlotStateListener: (listener: () => void) => {
      slotStateListeners.add(listener);
      return () => slotStateListeners.delete(listener);
    },
    getEffectiveVersion: async (source: string) => {
      const buildSystem = container.get<import("./buildV2/index.js").BuildSystemV2>("buildSystem");
      return buildSystem?.getEffectiveVersion(source) ?? undefined;
    },
  };
  await registerPanelServices(commonDeps);

  {
    const { panelRuntimeSurface } = await import("@vibestudio/shared/runtimeSurface.panel");
    const { workerRuntimeSurface } = await import("@vibestudio/shared/runtimeSurface.worker");
    // Agent-facing capability catalog (caller-aware discovery) — the single
    // introspection surface; it absorbed the former `meta` service
    // (listServices/describeService now live on `docs`).
    const { createDocsService } = await import("./services/docsService.js");
    container.registerRpc(
      createDocsService({
        dispatcher,
        runtimeSurfaces: {
          panel: panelRuntimeSurface,
          workerRuntime: workerRuntimeSurface,
        },
      })
    );
  }

  {
    // Settings service for trusted remote hosts and mobile workspace apps.
    const { createSettingsServiceStandalone } =
      await import("./services/settingsServiceStandalone.js");
    container.registerRpc(createSettingsServiceStandalone({ dispatcher }));
  }

  // ── Panel-asset loopback bridge (remote shells) ──
  // A remote shell has no local gateway, so its panel-asset façade calls this to
  // loopback-fetch panel HTML/bundles from the server's own gateway over the
  // pipe. The gateway port is finalized only after gateway.start() below, so we
  // thread it lazily via getResolvedGatewayPort.
  {
    const { createGatewayFetchService } = await import("./services/gatewayFetchService.js");
    container.registerRpc(
      createGatewayFetchService({
        getGatewayPort: () => getResolvedGatewayPort("gateway.fetch"),
      })
    );
  }

  // WebRTC pairing seam (fp/sig/ice/srv — NO room: rooms are minted per invite,
  // plan §2.1) — populated when the ingress pool starts (post-startAll below);
  // captured by auth.getConnectionInfo/createPairingInvite (which mint per-invite
  // rooms + deep links against the pool) and written to the ready file. Stays
  // null when WebRTC is off (loopback co-located mode) ⇒ no deep link.
  let webrtcPairing: import("./services/auth/model.js").ConnectPairingSeam | null = null;
  let webrtcIngress: import("./webrtcIngress.js").WebRtcIngress | null = null;

  // ── Per-workspace content-addressable blobstore ──
  {
    const { createBlobstoreService } = await import("./services/blobstoreService.js");
    const { createAuthService } = await import("./services/authService.js");
    const { serviceWithHttpRoutes } = await import("./serviceWithHttpRoutes.js");
    container.registerManaged(
      serviceWithHttpRoutes(
        createAuthService({
          tokenManager,
          deviceAuthStore,
          getServerBootId: () => serverBootId,
          getWorkspaceId: () => workspace.config.id,
          getConnectionInfo: () => {
            const gatewayPort = getResolvedGatewayPort("auth connection info");
            const protocol = gatewayProtocol();
            const hubUrl = process.env["VIBESTUDIO_HUB_URL"];
            return {
              serverUrl: hubUrl ?? getExternalGatewayUrl("auth connection info"),
              protocol,
              externalHost: hostConfig.externalHost,
              gatewayPort,
              // Lets createPairingInvite mint complete pair artifacts
              // (per-invite room + fp/sig + scheme deep link + HTTPS pair URL).
              pairing: webrtcPairing ?? undefined,
            };
          },
          // The ingress pool arms one signaling room per invite (plan §2.1);
          // resolved lazily because the pool starts after container.startAll().
          getWebRtcIngress: () => webrtcIngress,
          connectionGrants,
          auditLog,
          hasAppCapability: (callerId, capability) =>
            appHostForGateway?.hasAppCapability(callerId, capability) ?? false,
          ensureMobileAppReady: (source) =>
            hostTargetLaunchCoordinator.ensureMobileHostReadyForPairing(source),
          getMobileAppBootstrap: async (source) =>
            appHostForGateway?.getReactNativeBootstrap(source) ?? null,
          registerMobileAppPrincipal: (deviceId, source) =>
            appHostForGateway?.registerReactNativeAppPrincipal(deviceId, source) ?? null,
          retireMobileAppPrincipal: (deviceId) => {
            appHostForGateway?.retireReactNativeAppPrincipal(deviceId);
          },
          resolveRuntimeEntity: (id) => getEntityStore().resolveRecord(id),
        }),
        routeRegistry
      )
    );

    const blobsDir = path.join(getUserDataPath(), "blobs");
    container.registerManaged(
      serviceWithHttpRoutes(createBlobstoreService({ blobsDir }), routeRegistry)
    );
  }

  // ── Gateway ingress ──
  //
  // Start the only caller-facing socket before service startup. Handlers are
  // attached dynamically as container services start.
  const { Gateway } = await import("./gateway.js");
  const startedAt = Date.now();
  const gateway = new Gateway({
    getRpcHandler: () => rpcServerForGateway,
    getPanelHttpHandler: () => {
      if (!container.has("panelHttpServer")) return null;
      return container.get<{ server: import("./panelHttpServer.js").PanelHttpServer }>(
        "panelHttpServer"
      ).server;
    },
    getExtensionHttpHandler: () => extensionHostForGateway,
    getAppArtifactHandler: () => appHostForGateway,
    getWorkerdPort: () => workerdManagerForGateway?.getPort() ?? null,
    getWorkerHost: () => workerdManagerForGateway,
    ensureDORoute: (source, className, objectKey) => {
      const workerdManager = assertPresent(workerdManagerForGateway);
      const targetId = canonicalEntityId({ kind: "do", source, className, key: objectKey });
      const record = entityCache.resolveActive(targetId);
      return workerdManager.ensureDO(source, className, objectKey, {
        contextId: record?.contextId,
      });
    },
    externalHost: hostConfig.externalHost,
    bindHost: hostConfig.bindHost,
    adminToken,
    workerdGatewayToken,
    getWorkerdDispatchSecret: () => workerdManagerForGateway?.getDispatchSecret() ?? null,
    tokenManager,
    connectionGrants,
    entityCache,
    routeRegistry,
    healthProvider: (detailed) => {
      const base: Record<string, unknown> = {
        ok: true,
        product: "vibestudio",
        discoveryVersion: 1,
        protocol: "http",
        serverId: deviceAuthStore.getServerId(),
        serverBootId,
        workspaceId: workspace.config.id,
        // In the base payload so attach-or-spawn can version-check without auth.
        version: serverVersion,
        pid: process.pid,
      };
      if (!detailed) return base;
      return {
        ...base,
        uptimeMs: Date.now() - startedAt,
        workerd: workerdManagerForGateway?.getPort() ? "running" : "stopped",
        tokenSource,
        // Relay-alarm landing spot (plan §2.1/§9.8): per-room pipe state incl.
        // the selected ICE path, plus the pool's connect/relay counters. Null
        // when WebRTC ingress is off (loopback co-located mode).
        webrtc: webrtcIngress
          ? { rooms: webrtcIngress.status(), stats: webrtcIngress.stats() }
          : null,
      };
    },
  });
  const gatewayPort = await gateway.start(requestedGatewayPort ?? 0);
  gatewayPortResolved = gatewayPort;

  // ── Remote ingress: WebRTC pipe ──
  // The public TLS endpoint, public-URL advertisement, and Tailscale/VPN
  // auto-provisioning are decommissioned. Remote clients no longer dial an HTTPS
  // origin; they pair by QR (signaling room + DTLS fingerprint) and the server
  // accepts ONE peer-to-peer WebRTC pipe. The loopback HTTP gateway above is the
  // only socket (co-located mode stays on loopback WS).
  //
  // The answerer is started AFTER `container.startAll()` below — it needs the
  // live `rpcServerForGateway`, which only exists once the RpcServer service has
  // started. (Starting it here would no-op silently: rpcServerForGateway is null.)

  // ── Workerd inspector bridge + service (userland profiling of workers/DOs) ──
  {
    let workerdInspectorDefinition:
      | import("@vibestudio/shared/serviceDefinition").ServiceDefinition
      | null = null;
    container.registerManaged({
      name: "workerdInspector",
      dependencies: ["workerdManager", "panelHttpServer"],
      async start(resolve) {
        const workerdManager = assertPresent(
          resolve<import("./workerdManager.js").WorkerdManager>("workerdManager")
        );
        const { server } = assertPresent(
          resolve<{ server: import("./panelHttpServer.js").PanelHttpServer }>("panelHttpServer")
        );
        const { WorkerdInspectorBridge } = await import("./workerdInspectorBridge.js");
        const bridge = new WorkerdInspectorBridge({
          getInspectorUrl: () => workerdManager.getInspectorUrl(),
          protocol: hostConfig.protocol,
          externalHost: hostConfig.externalHost,
          port: gatewayPort,
        });
        server.setWorkerdInspectorBridge(bridge);
        // Inspector sessions cannot survive a workerd restart — close them
        // eagerly so clients fail fast instead of hanging on a dead socket.
        workerdManager.onRestartBegin(() => bridge.closeAll());
        const { createWorkerdInspectorService } =
          await import("./services/workerdInspectorService.js");
        workerdInspectorDefinition = createWorkerdInspectorService({
          approvalQueue,
          grantStore: capabilityGrantStore,
          hasAppCapability: (callerId, capability) =>
            appHostForGateway?.hasAppCapability(callerId, capability) ?? false,
          listTargets: () => bridge.listTargets(),
          getEndpoint: (targetPath, principalId) => bridge.getEndpoint(targetPath, principalId),
        });
        return bridge;
      },
      async stop(instance: import("./workerdInspectorBridge.js").WorkerdInspectorBridge) {
        instance?.stop();
      },
      getServiceDefinition() {
        if (!workerdInspectorDefinition) throw new Error("workerdInspector not initialized");
        return workerdInspectorDefinition;
      },
    });
  }

  // ── Headless host auto-spawn (renderer of last resort) ──
  {
    // Default ON and lazy: server-created browser panels may need a CDP host
    // even when the Electron desktop is connected, because desktop clients are
    // not lease-assignment defaults. Env/flag override both ways. Keep-alive is
    // opt-in so startup does not launch Chromium before the UI is connected.
    const envAutospawn = process.env["VIBESTUDIO_HEADLESS_HOST_AUTOSPAWN"];
    const autospawnEnabled = resolveHeadlessHostAutospawn({
      cliValue: args.headlessHostAutospawn,
      envValue: envAutospawn,
    });
    const envKeepAlive = process.env["VIBESTUDIO_HEADLESS_HOST_KEEP_ALIVE"];
    const keepAliveEnabled = envKeepAlive === "1" || envKeepAlive === "true";
    const spawnTimeoutEnv = process.env["VIBESTUDIO_HEADLESS_HOST_SPAWN_TIMEOUT_MS"];
    const parsedSpawnTimeout = spawnTimeoutEnv ? Number.parseInt(spawnTimeoutEnv, 10) : Number.NaN;
    // Honor an explicit 0 (don't let `|| undefined` swallow it); only fall back on missing/garbage.
    const spawnTimeoutMs =
      Number.isFinite(parsedSpawnTimeout) && parsedSpawnTimeout >= 0
        ? parsedSpawnTimeout
        : undefined;
    container.registerManaged({
      name: "headlessHostManager",
      dependencies: ["cdpBridge"],
      async start(resolve) {
        const cdpBridge = assertPresent(resolve<import("./cdpBridge.js").CdpBridge>("cdpBridge"));
        const { HeadlessHostManager } = await import("./headlessHostManager.js");
        const manager = new HeadlessHostManager({
          tokenManager,
          coordinator: panelRuntimeCoordinator,
          isHostAvailable: (hostConnectionId) => cdpBridge.isProviderConnected(hostConnectionId),
          getServerUrl: () => `http://127.0.0.1:${gatewayPort}`,
          config: {
            enabled: autospawnEnabled,
            spawnTimeoutMs,
            keepAlive: keepAliveEnabled,
          },
        });
        headlessHostManager = manager;
        if (keepAliveEnabled) manager.startKeepAlive();
        return manager;
      },
      async stop(instance: import("./headlessHostManager.js").HeadlessHostManager) {
        await instance?.stop();
      },
    });
  }

  // ── Start all services in dependency order ──
  await container.startAll();

  // The webhook + credential services are built now, so their refs are set:
  // start the backhaul (no-op when no relay is configured) and re-announce any
  // persisted relay-mode webhook subscriptions so the relay resumes routing.
  relayBackhaul?.start();
  await relayServices.webhook?.internal
    .reannounceRelaySubscriptions()
    .catch((err: unknown) => console.warn("[Server] relay subscription re-announce failed:", err));

  // ── WebRTC ingress pool (now that rpcServerForGateway is live) ──
  // Activated by default. The server presents a persistent DTLS cert
  // (stable QR `fp`) and arms ONE answerer pipe per signaling room: one room per
  // already-paired device (persisted on the device record) plus one per
  // outstanding pairing invite (plan §2.1 — the per-server singleton room and
  // its room file are gone). See docs/webrtc-local-e2e.md.
  const { resolveSignalingUrl } = await import("@vibestudio/shared/connect");
  const webrtcSignalUrl = resolveSignalingUrl({ env: process.env }).url;
  if (rpcServerForGateway) {
    try {
      const { startWebRtcIngress } = await import("./webrtcIngress.js");
      const { ensurePersistentCert } = await import("../main/webrtc/cert.js");
      const { assertNodeDatachannelAvailable } =
        await import("../main/webrtc/nodeDatachannelPeer.js");
      assertNodeDatachannelAvailable();
      const pathMod = await import("node:path");
      const certDir = pathMod.join(appRoot, ".vibestudio", "webrtc");
      const cert = ensurePersistentCert({
        identityPemFile:
          process.env["VIBESTUDIO_WEBRTC_IDENTITY"] ?? pathMod.join(certDir, "identity.pem"),
      });
      const iceTransportPolicy: import("@vibestudio/shared/connect").TurnPolicy =
        process.env["VIBESTUDIO_WEBRTC_ICE"] === "relay" ? "relay" : "all";
      const ingress = startWebRtcIngress({
        rpcServer: rpcServerForGateway,
        signalUrl: webrtcSignalUrl,
        certificatePemFile: cert.certificatePemFile,
        keyPemFile: cert.keyPemFile,
        fingerprint: cert.fingerprint,
        iceTransportPolicy,
      });
      webrtcIngress = ingress;
      // Expose the pairing seam (fp/sig/ice/srv — rooms are per-invite) to
      // auth.getConnectionInfo/createPairingInvite and the ready-file writer.
      webrtcPairing = {
        fp: cert.fingerprint,
        sig: webrtcSignalUrl,
        ice: iceTransportPolicy,
        srv: process.env["VIBESTUDIO_WORKSPACE"] ?? undefined,
      };
      // Invite lifecycle → pool: redemption re-tags the invite's room with the
      // device id (and the room persists on the device record); invite expiry
      // and device revocation tear the room's pipe down.
      deviceAuthStore.onPairingRoomRedeemed((room, deviceId) =>
        ingress.armRoom(room, { deviceId })
      );
      deviceAuthStore.onPairingRoomReleased((room) => void ingress.disarmRoom(room));
      // Re-arm one answerer room per already-paired device so returning
      // devices reconnect into their own room after a server restart.
      for (const device of deviceAuthStore.listDevices()) {
        if (!device.revokedAt && device.room) {
          ingress.armRoom(device.room, { deviceId: device.deviceId });
        }
      }
    } catch (error) {
      throw new Error(
        `[webrtc-ingress] failed to start; refusing loopback-only startup: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  // ── Startup pairing invites (banner + ready file) ──
  // Minted through the SAME per-invite path as auth.createPairingInvite: when
  // the ingress pool is live each invite gets a fresh room armed on the pool
  // and complete pair artifacts. Without WebRTC, minting fails loud.
  const { mintPairingInvite } = await import("./services/auth/model.js");
  const startupInvites =
    process.env["VIBESTUDIO_DISABLE_STARTUP_PAIRING"] !== "1"
      ? [
          mintPairingInvite({ deviceAuthStore, pairing: webrtcPairing, ingress: webrtcIngress }),
          mintPairingInvite({ deviceAuthStore, pairing: webrtcPairing, ingress: webrtcIngress }),
        ]
      : [];
  // A pairing code grants a shell principal — redact codes (and thereby the
  // deep links embedding them) from the userland-visible serverLog surface.
  for (const invite of startupInvites) {
    serverLogStore.addSecret(invite.code);
  }
  const startupInvite = startupInvites[0] ?? null;
  const startupQrInvite = startupInvites[1] ?? null;
  const startupPairingCodes = startupInvites.map((invite) => invite.code);
  const startupPairingCode = startupInvite?.code ?? null;
  const startupQrPairingCode = startupQrInvite?.code ?? null;

  const workerdManager =
    container.get<import("./workerdManager.js").WorkerdManager>("workerdManager");

  // Wire workerdUrl into rpcServer for HTTP relay to workers/DOs
  const rpcServerInstance = container.get<{
    server: import("./rpcServer.js").RpcServer;
    port: number;
  }>("rpcServer").server;
  const workerdPort = workerdManager.getPort();
  if (workerdPort) {
    rpcServerInstance.setWorkerdUrl(`http://127.0.0.1:${workerdPort}`);
  }
  rpcServerInstance.setWorkerdGatewayToken(workerdGatewayToken);
  rpcServerInstance.setWorkerdDispatchSecret(workerdManager.getDispatchSecret());
  rpcServerInstance.setEnsureDO((source, className, objectKey) => {
    const targetId = canonicalEntityId({ kind: "do", source, className, key: objectKey });
    const record = entityCache.resolveActive(targetId);
    return workerdManager.ensureDO(source, className, objectKey, {
      contextId: record?.contextId,
    });
  });

  dispatcher.markInitialized();

  // ===========================================================================
  // WorkspaceDO bootstrap reconciliation
  // (see plan §6 singleton reconciliation, §9 restart revival, §11 GC safety)
  // ===========================================================================
  const doDispatchForBootstrap = container.get<import("./doDispatch.js").DODispatch>("doDispatch");
  const workspaceDORefForBootstrap: import("./doDispatch.js").DORef = {
    source: (await import("./internalDOs/internalDoLoader.js")).INTERNAL_DO_SOURCE,
    className: "WorkspaceDO",
    objectKey: workspace.config.id,
  };
  const dispatchWorkspaceDO = <T>(method: string, ...args: unknown[]) =>
    doDispatchForBootstrap.dispatch(workspaceDORefForBootstrap, method, ...args) as Promise<T>;

  // Steps 1-3 (hydrate, incomplete-cleanup reconcile, GC safety sweep) are
  // factored into `runStartupReconciliation` so both the boot path and tests
  // can call them.
  const { runStartupReconciliation } = await import("./services/startupReconciliation.js");
  const lifecycleDriver =
    container.get<import("./services/lifecycleDriver.js").LifecycleDriver>("lifecycleDriver");
  const reconciliation = await runStartupReconciliation({
    dispatchWorkspaceDO,
    entityCache,
    recoverLifecycle: () => lifecycleDriver.recoverStartup("server_restart"),
    logger: { warn: (msg, ...args) => console.warn(msg, ...args) },
  });
  // Re-arm server-driven DO alarms now that workerd is up and WorkspaceDO is
  // reachable (the managed-service start() ran before workerd was ready).
  try {
    container.get<import("./services/alarmDriver.js").AlarmDriver>("alarmDriver").notifyChanged();
  } catch (err) {
    console.warn("[Bootstrap] alarm re-arm skipped:", err);
  }

  // Re-register bootstrap entries that don't have DO rows.
  entityCache.registerBootstrap({ id: "server", kind: "server" });
  entityCache.registerBootstrap({ id: "electron-main", kind: "shell" });
  if (reconciliation.incompleteCleanupIds.length > 0) {
    console.log(
      `[Bootstrap] Reconciled ${reconciliation.incompleteCleanupIds.length} incomplete cleanup(s): ${reconciliation.incompleteCleanupIds.join(
        ", "
      )}`
    );
  }

  // 4. Singleton reconciliation against vibestudio.yml.singletonObjects.
  try {
    const { createHash } = await import("node:crypto");
    const { canonicalEntityId } = await import("@vibestudio/shared/runtime/entitySpec");
    type EntityRecord = import("@vibestudio/shared/runtime/entitySpec").EntityRecord;
    const declaredKeys = new Set<string>();
    for (const decl of workspaceDecls.singletons.all()) {
      const contextId =
        decl.contextId ??
        createHash("sha256")
          .update(`${workspace.config.id}\x00${decl.source}\x00${decl.className}\x00${decl.key}`)
          .digest("hex");
      const targetId = canonicalEntityId({
        kind: "do",
        source: decl.source,
        className: decl.className,
        key: decl.key,
      });
      declaredKeys.add(targetId);
      try {
        const prepared = await workerdManager.ensureDurableObjectEntity({
          source: decl.source,
          className: decl.className,
          key: decl.key,
          contextId,
          ref: decl.contextId ? undefined : "main",
        });
        const record = await dispatchWorkspaceDO<EntityRecord>("entityActivate", {
          kind: "do",
          source: { repoPath: decl.source, effectiveVersion: prepared.effectiveVersion },
          contextId,
          className: decl.className,
          key: decl.key,
        });
        entityCache._onActivate(record);
      } catch (err) {
        console.warn(
          `[Bootstrap] Singleton activate failed for ${decl.source}:${decl.className}:${decl.key}:`,
          err
        );
      }
    }
    void declaredKeys;
  } catch (err) {
    console.warn("[Bootstrap] Singleton reconciliation failed:", err);
  }

  // 5. Start cleanup reaper to retry partial-failed hooks.
  const { createCleanupReaper } = await import("./services/cleanupReaper.js");
  const cleanupReaper = createCleanupReaper({
    doDispatch: doDispatchForBootstrap,
    workspaceDORef: workspaceDORefForBootstrap,
    onRetire: async (record) => {
      await cleanupRuntimeEntityRecord(record);
    },
    logger: { warn: (msg, ...args) => console.warn(msg, ...args) },
  });
  cleanupReaper.start();

  const runStartupWorkspaceUnitReconcile = async (): Promise<void> => {
    let syncDeclaredRemotesAfterStartupReload = false;
    try {
      do {
        if (pendingStartupMetaConfigReload) {
          syncDeclaredRemotesAfterStartupReload = true;
          pendingStartupMetaConfigReload = false;
        }
        await completeConfiguredWorkspaceDependenciesAtStartup();
        await reconcileDeclaredWorkspaceUnits(workspaceConfig, "startup");
      } while (pendingStartupMetaConfigReload);
      unitApprovalCoordinator.publishPending("startup");
    } finally {
      initialWorkspaceUnitReconcileComplete = true;
      if (syncDeclaredRemotesAfterStartupReload) {
        syncDeclaredRemotesForSource().catch((err: unknown) =>
          console.warn(
            "[GitRemotes] Failed to sync declared remotes after startup config reload:",
            err
          )
        );
      }
    }
  };
  startupWorkspaceUnitReconcile = runStartupWorkspaceUnitReconcile();
  void startupWorkspaceUnitReconcile
    .catch(() => {})
    .then(() => Promise.all(trustedUnitHosts().map((host) => host.whenSettled())))
    .catch(() => {})
    .finally(() => releaseStartupUnitsSettled());
  if (!requireMobileReady && !requireElectronReady) {
    void startupWorkspaceUnitReconcile.catch((err: unknown) =>
      console.warn(
        "[Startup] Background workspace unit reconcile failed:",
        err instanceof Error ? err.message : String(err)
      )
    );
  }

  if (requireMobileReady) {
    await startupWorkspaceUnitReconcile;
    const readiness = await hostTargetLaunchCoordinator.ensureMobileHostReadyForPairing();
    if (!readiness?.ready) {
      printReadinessActionBlock("React Native mobile app is not ready", [
        "This server was started with mobile pairing enabled, but the",
        "workspace-owned React Native app is not ready to serve to the native host.",
        "",
        readiness?.reason ?? "App host is not available",
        ...(readiness?.source ? [`Source: ${readiness.source}`] : []),
        ...(readiness?.appId ? [`App: ${readiness.appId}`] : []),
        ...(readiness?.details?.length ? ["", ...readiness.details] : []),
        "",
        "Fix the blocking app/extension build above, then restart this command.",
      ]);
      process.exit(1);
    }
    console.log(
      `[Mobile] React Native app ready${readiness.appId ? `: ${readiness.appId} (${readiness.source ?? "unknown"}) build ${readiness.buildKey ?? "unknown"}` : ""}`
    );
  }
  if (requireElectronReady) {
    await startupWorkspaceUnitReconcile;
    const appHost = container.get<import("./appHost.js").AppHost>("appHost");
    const readiness = await appHost.ensureElectronReady();
    if (!readiness.ready) {
      printReadinessActionBlock("Electron desktop shell app is not ready", [
        "This server was started with desktop pairing enabled, but the",
        "workspace-owned Electron shell app is not ready to serve to desktop clients.",
        "",
        readiness.reason ?? "App host is not available",
        ...(readiness.source ? [`Source: ${readiness.source}`] : []),
        ...(readiness.appId ? [`App: ${readiness.appId}`] : []),
        ...(readiness.details.length ? ["", ...readiness.details] : []),
        "",
        "Fix the blocking app build above, then restart this command.",
      ]);
      process.exit(1);
    }
    console.log(
      `[Desktop] Electron shell app ready: ${readiness.appId} (${readiness.source}) build ${readiness.buildKey}`
    );
  }

  // ===========================================================================
  // Report ready
  // ===========================================================================

  const workerdMgr = container.get<import("./workerdManager.js").WorkerdManager>("workerdManager");

  {
    // Write admin token to a well-known file for scripting
    const tokenFilePath = path.join(statePath, "admin-token");
    try {
      fs.writeFileSync(tokenFilePath, adminToken, { mode: 0o600 });
    } catch (err) {
      console.warn("[Server] Failed to write admin token file:", err);
    }

    const proto = "http";
    const wsProto = "ws";
    console.log("vibestudio-server ready:");
    console.log(`  Workspace:   ${workspaceName}${workspaceIsEphemeral ? " (ephemeral dev)" : ""}`);
    console.log(`  Gateway:     ${proto}://${hostConfig.externalHost}:${gatewayPort} (loopback)`);
    console.log(`  Workerd:     (via gateway /_w/)`);
    console.log(`  RPC:         ${wsProto}://${hostConfig.externalHost}:${gatewayPort}/rpc`);
    const sourceLabel =
      tokenSource === "env"
        ? " (from VIBESTUDIO_ADMIN_TOKEN)"
        : tokenSource === "persisted"
          ? " (persisted)"
          : " (newly generated)";
    console.log(`  Token file:  ${tokenFilePath}${sourceLabel}`);
    if (tokenSource !== "env") {
      console.log(`  Persisted:   ${getAdminTokenPath()}`);
    }
    // Remote pairing is the WebRTC QR link (per-invite signaling room + DTLS
    // fingerprint) minted through the ingress pool above; there is no public
    // OAuth/QR URL to print. The device pairing code below still authorizes
    // the principal after the DTLS pin verifies.
    if (startupPairingCode) {
      console.log(`  Pairing code: ${startupPairingCode}`);
      if (startupQrPairingCode) {
        console.log(`  QR pairing code: ${startupQrPairingCode}`);
      }
      if (startupInvite?.pairUrl) {
        console.log(`  Pair URL:     ${startupInvite.pairUrl}`);
      }
      if (startupQrInvite?.pairUrl) {
        console.log(`  QR Pair URL:  ${startupQrInvite.pairUrl}`);
      }
      console.log(
        `  Pairing TTL:  ${Math.round(DEFAULT_PAIRING_CODE_TTL_MS / 60_000)} minutes (server exits if unused)`
      );
    }

    if (args.readyFile) {
      const readyPayload = {
        workspaceName,
        workspaceId: workspace.config.id,
        workspaceDir: workspacePath,
        isEphemeral: workspaceIsEphemeral,
        gatewayUrl: `${proto}://${hostConfig.externalHost}:${gatewayPort}`,
        rpcUrl: `${wsProto}://${hostConfig.externalHost}:${gatewayPort}/rpc`,
        workerdUrl: `${proto}://${hostConfig.externalHost}:${gatewayPort}/_w/`,
        adminToken,
        // The WebRTC pairing material and complete startup invite artifacts.
        pairing: webrtcPairing
          ? {
              ...webrtcPairing,
              room: startupInvite?.room,
              deepLink: startupInvite?.deepLink,
              pairUrl: startupInvite?.pairUrl,
              qrDeepLink: startupQrInvite?.deepLink,
              qrPairUrl: startupQrInvite?.pairUrl,
            }
          : null,
        pairingCode: startupPairingCode,
        qrPairingCode: startupQrPairingCode,
        pairingCodes: {
          desktop: startupPairingCode,
          mobile: startupQrPairingCode,
          qr: startupQrPairingCode,
        },
        serverId: deviceAuthStore.getServerId(),
        serverBootId,
        tokenFilePath,
        gatewayPort,
        workerdPort: workerdMgr?.getPort() ?? 0,
        pid: process.pid,
        version: serverVersion,
      };
      try {
        fs.mkdirSync(path.dirname(args.readyFile), { recursive: true });
        fs.writeFileSync(args.readyFile, `${JSON.stringify(readyPayload, null, 2)}\n`, "utf8");
      } catch (error) {
        console.warn("[Server] Failed to write ready file:", error);
      }
    }

    if (args.printCredentials) {
      console.log(`\nVIBESTUDIO_ADMIN_TOKEN=${adminToken}`);
      if (startupPairingCode) console.log(`VIBESTUDIO_PAIRING_CODE=${startupPairingCode}`);
      if (startupQrPairingCode) console.log(`VIBESTUDIO_QR_PAIRING_CODE=${startupQrPairingCode}`);
    }
  }

  // ===========================================================================
  // Graceful shutdown — container.stopAll() handles everything
  // ===========================================================================

  let isShuttingDown = false;
  let startupPairingExpiryTimer: NodeJS.Timeout | null = null;

  async function shutdown() {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log("[Server] Shutting down...");

    const lifecycleDriver =
      container.get<import("./services/lifecycleDriver.js").LifecycleDriver>("lifecycleDriver");
    const shutdownStartedAt = Date.now();
    const forceExit = setTimeout(() => {
      console.warn("[Server] Shutdown timeout — forcing exit");
      process.exit(1);
    }, 8000);

    cleanupReaper.stop();
    if (startupPairingExpiryTimer) {
      clearTimeout(startupPairingExpiryTimer);
      startupPairingExpiryTimer = null;
    }

    await relayBackhaul
      ?.stop()
      .catch((err) => console.warn("[Server] relay backhaul stop failed:", err));

    // Close the WebRTC ingress pool (started outside the service container, so
    // stopAll() never touches it) — remote clients get a clean close instead of
    // an abrupt ICE drop.
    if (webrtcIngress) {
      await webrtcIngress
        .close()
        .catch((err) => console.warn("[Server] WebRTC ingress close failed:", err));
      webrtcIngress = null;
    }

    const prepareBudgetMs = Math.max(0, Math.min(2000, 8000 - (Date.now() - shutdownStartedAt)));
    if (prepareBudgetMs > 0) {
      await lifecycleDriver
        .prepareForShutdown(prepareBudgetMs)
        .catch((err) => console.warn("[Server] lifecycle shutdown prepare failed:", err));
    }

    await container
      .stopAll()
      .then(() => console.log("[Server] All services stopped"))
      .catch((e) => console.error("[Server] Service shutdown error:", e))
      .finally(() => {
        if (workspaceIsEphemeral) {
          try {
            deleteWorkspaceDir(workspaceName);
            centralData.removeWorkspace(workspaceName);
            console.log(`[Server] Deleted ephemeral workspace "${workspaceName}"`);
          } catch (error) {
            console.error("[Server] Failed to delete ephemeral workspace:", error);
          }
        }
        clearTimeout(forceExit);
        console.log("[Server] Shutdown complete");
        process.exit(0);
      });
  }

  requestShutdown = () => void shutdown();

  // Pairing-TTL exit: a fresh spawn that no client ever redeemed cleans itself
  // up (the natural GC for a spawn the desktop never managed to attach).
  if (startupPairingCodes.length > 0) {
    startupPairingExpiryTimer = setTimeout(() => {
      // At the TTL deadline the startup codes have already lazily/proactively
      // expired, so the old `every(hasPendingPairingCode)` check read false and
      // never fired. Ask the durable question instead: has ANY device paired?
      if (deviceAuthStore.hasEverPaired()) return;
      console.warn(
        `[Server] Startup pairing code expired after ${Math.round(
          DEFAULT_PAIRING_CODE_TTL_MS / 60_000
        )} minutes without being used; shutting down. Restart the pair command to print a fresh code.`
      );
      void shutdown();
    }, DEFAULT_PAIRING_CODE_TTL_MS);
    startupPairingExpiryTimer.unref?.();
  }
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  // Idle auto-exit (workspace-server mode only): the garbage collector for
  // detached servers. No connected shell/app clients AND no active background
  // runs, continuously for VIBESTUDIO_IDLE_EXIT_MS (default 30 min; 0 disables)
  // → graceful shutdown.
  if (isWorkspaceServer) {
    const { startIdleExitMonitor, DEFAULT_IDLE_EXIT_MS } =
      await import("./services/hostLifecycleService.js");
    const idleExitEnv = process.env["VIBESTUDIO_IDLE_EXIT_MS"];
    const parsedIdleExit = idleExitEnv === undefined ? Number.NaN : Number(idleExitEnv);
    const idleExitMs = Number.isFinite(parsedIdleExit) ? parsedIdleExit : DEFAULT_IDLE_EXIT_MS;
    startIdleExitMonitor({
      activity: activityRegistry,
      hasConnectedClients: () =>
        (rpcServerForGateway?.countConnectedClients(["shell", "app"]) ?? 0) > 0,
      shutdown: () => void shutdown(),
      idleExitMs,
      log: (message) => console.log(message),
    });
  }
}

function collectWorkspaceUnitPaths(
  nodes: Array<{ path: string; isUnit: boolean; children: unknown[] }>
): string[] {
  const units: string[] = [];
  for (const node of nodes) {
    if (node.isUnit) units.push(node.path);
    units.push(
      ...collectWorkspaceUnitPaths(
        node.children as Array<{ path: string; isUnit: boolean; children: unknown[] }>
      )
    );
  }
  return units;
}

function replaceWorkspaceConfig<T extends object>(target: T, next: T): void {
  const mutableTarget = target as Record<string, unknown>;
  for (const key of Object.keys(mutableTarget)) {
    deleteDynamicProperty(mutableTarget, key);
  }
  Object.assign(target, next);
}

function formatManifestValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "<unset>";
  if (typeof value === "string") return JSON.stringify(value);
  return JSON.stringify(value);
}

function parseGatewayAliases(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (entry): entry is string => typeof entry === "string" && entry.length > 0
      );
    }
  } catch {
    // Fall through to comma-separated env syntax.
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
