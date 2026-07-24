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
import { GIT_INTEROP_PROVIDER_METHOD_NAMES } from "@vibestudio/service-schemas/gitInterop";
import { createHash, randomBytes, randomUUID } from "crypto";
import { canonicalEntityId, type EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import { createHostCaller } from "@vibestudio/shared/serviceDispatcher";
import { parseDoTargetId } from "@vibestudio/shared/workspaceServiceRpc";
import { isCallerKind } from "@vibestudio/shared/principalKinds";
import { registerBuildProvider, unregisterBuildProvider } from "./buildV2/buildProviderRegistry.js";
import { assertPresent, deleteDynamicProperty } from "../lintHelpers";
import { resolveHeadlessHostAutospawn } from "./headlessHostAutospawn.js";
import { resolveDependencyWorkspaceRoot } from "./dependencyWorkspaceRoot.js";
import { writeFileAtomicSync } from "../atomicFile.js";
import { stateLayout } from "./stateLayout.js";
import { consumeWorkspaceChildSecrets } from "./workspaceChildSecrets.js";
import { createGitInteropProviderInvoker } from "./gitInteropProviderInvoker.js";
import { retireRoutedReach } from "./routedReachRetirement.js";
import { createWorkspaceChildHubPort } from "./workspaceChildHubPort.js";
import { declaredWorkspaceServiceActivationInput } from "./runtimeExecutionIdentity.js";
import {
  releaseDurableObjectRelaySeal,
  sealAndDrainDurableObjectRelays,
} from "./workerdRpcRelay.js";
import { resolveHttpRuntimeCaller } from "./httpRuntimeIdentity.js";

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
  bootstrapWorkspace?: string;
  workspaceName?: string;
  workspaceDir?: string;
  appRoot?: string;
  logLevel?: string;
  readyFile?: string;
  ephemeral?: boolean;
  servePanels?: boolean;
  gatewayPort?: number;
  init?: boolean;
  host?: string;
  bindHost?: string;
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
  --bootstrap-workspace <name>
                           Register and use an existing workspace for first-run pairing
  --ready-file <path>      Write structured readiness JSON to this file
  --ephemeral              Use a disposable dev workspace (deleted on shutdown)
  --host <hostname>        External hostname (also sets bind to 0.0.0.0)
  --bind-host <addr>       Explicit bind address (default: 127.0.0.1, or 0.0.0.0 with --host)
  --serve-panels           Enable panel HTTP serving
  --gateway-port <port>    Port for the gateway HTTP/WS ingress (default: auto-assigned)
  --log-level <level>      Log verbosity
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
    "bootstrap-workspace",
    "workspace",
    "workspace-dir",
    "app-root",
    "ready-file",
    "ephemeral",
    "log-level",
    "serve-panels",
    "gateway-port",
    "init",
    "host",
    "bind-host",
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
      case "bootstrap-workspace":
        args.bootstrapWorkspace = value;
        break;
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
      case "host":
        args.host = value;
        break;
      case "bind-host":
        args.bindHost = value;
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
  const { setUserDataPath } = await import("@vibestudio/env-paths");
  const { loadCentralEnv } = await import("@vibestudio/workspace/loader");
  const { loadPersistedAdminToken, savePersistedAdminToken, getAdminTokenPath } =
    await import("@vibestudio/shared/centralAuth");
  const { resolveLocalWorkspaceStartup } = await import("@vibestudio/workspace/startup");
  const { TokenManager } = await import("@vibestudio/shared/tokenManager");
  const { ServiceDispatcher } = await import("@vibestudio/shared/serviceDispatcher");
  const dispatcher = new ServiceDispatcher();
  const { EventService } = await import("@vibestudio/shared/eventsService");
  const { createWorkspaceEventsService } = await import("./services/eventsService.js");
  const { getExistingAppNodeModulesRoots } = await import("@vibestudio/shared/runtimePaths");
  const eventService = new EventService();
  const { RpcServer, SYSTEM_SUBJECT } = await import("./rpcServer.js");
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
  const processRole = process.env["VIBESTUDIO_PROCESS_ROLE"] ?? "hub";
  if (processRole !== "hub" && processRole !== "workspace-child") {
    throw new Error(
      `VIBESTUDIO_PROCESS_ROLE must be "hub" or "workspace-child" (got ${processRole})`
    );
  }
  const isWorkspaceServer = processRole === "workspace-child";

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

  // Consume hub-only capabilities before resolving or loading any
  // workspace-controlled code. Descendants must never inherit these values.
  const {
    identityDbPath,
    hubUrl,
    workspaceChildToken,
    adminToken: childAdminToken,
    relaySigningSecret,
  } = consumeWorkspaceChildSecrets(process.env);

  const wsDir = args.workspaceDir ?? process.env["VIBESTUDIO_WORKSPACE_DIR"];
  const wsName = args.workspaceName ?? process.env["VIBESTUDIO_WORKSPACE"];
  const advertisedWorkspaceName = process.env["VIBESTUDIO_ADVERTISED_WORKSPACE"] ?? wsName;
  const childWorkspaceId = process.env["VIBESTUDIO_WORKSPACE_ID"];
  if (!childWorkspaceId) {
    throw new Error("Workspace runtime requires its authoritative workspace id from the hub");
  }
  // Process authority is hub-owned and immutable. The live manifest object is
  // intentionally mutable, so it must never be consulted as an identity
  // source after startup.
  const workspaceId = childWorkspaceId;

  let workspace: import("@vibestudio/workspace-contracts/types").Workspace;
  let workspaceName: string;
  let workspaceIsEphemeral = false;
  try {
    const startup = resolveLocalWorkspaceStartup({
      appRoot,
      wsDir,
      name: wsName,
      init: args.init,
      requireExplicitSelection: isWorkspaceServer,
    });
    // Managed directory names are storage coordinates, not workspace
    // identities. In particular, ephemeral children use a randomized disk
    // name while retaining the hub catalog's opaque id.
    workspace = {
      ...startup.resolved.workspace,
      config: { ...startup.resolved.workspace.config, id: workspaceId },
    };
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
  const layout = stateLayout(workspace.statePath);
  if (
    path.resolve(workspace.contextProjectionsPath) !==
    path.resolve(layout.contextProjections.current)
  ) {
    throw new Error(
      `Workspace context-projection topology mismatch: ${workspace.contextProjectionsPath} is not the current epoch root`
    );
  }
  // Structured host-log persistence next to the spawn-time stdout log.
  serverLogStore.attachJsonlSink(layout.logsDir);

  // Aliases — used throughout service init below
  const workspacePath = workspace.path;
  const workspaceConfig = workspace.config;
  const statePath = workspace.statePath;
  const { createCapabilityPresentationResolver, summarizeAuthorityRequests } =
    await import("@vibestudio/shared/authorityPresentation");
  const { PRODUCT_WORKSPACE_SERVICES } =
    await import("@vibestudio/shared/productWorkspaceServices.mjs");
  const describeCapability = createCapabilityPresentationResolver(() => [
    ...(workspaceConfig.services ?? []),
    ...PRODUCT_WORKSPACE_SERVICES,
  ]);
  const { DisposableGitRemoteManager } = await import("./services/disposableGitRemoteManager.js");
  const disposableGitRemotes = new DisposableGitRemoteManager(statePath);

  // Parse workspace declarations (singletonObjects + services + routes).
  // Validation (every DO-backed service/route has a matching singleton row)
  // runs eagerly here — bad workspaces fail fast at startup with a clear msg.
  const { buildWorkspaceDeclarations } = await import("@vibestudio/workspace/singletonRegistry");
  const workspaceDecls = buildWorkspaceDeclarations(workspaceConfig);
  const { resolveWorkspaceService } = await import("./workspaceServices.js");
  const { SEMANTIC_CONTROL_PLANE } = await import("./internalDOs/controlPlane.js");
  const {
    resolveWorkspaceTrustGrants,
    resolveHostTargetDecl,
    resolveHostTargetRequiredExtensions,
    WORKSPACE_EXTENSION_PROVIDER_NAMES,
    workspaceProviderExtensionPackageName,
    workspaceExtensionRepoPath,
  } = await import("@vibestudio/workspace/configParser");
  const { setWorkspaceAppTrust } = await import("@vibestudio/shared/chromeTrust");
  const restartBoundManifestChanges = (
    previousConfig: typeof workspaceConfig,
    nextConfig: typeof workspaceConfig,
    _previousDecls: typeof workspaceDecls,
    _nextDecls: typeof workspaceDecls
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

    return changes;
  };
  const applyWorkspaceConfigReload = (
    nextConfig: typeof workspaceConfig,
    opts: { warnRestartBoundChanges?: boolean } = {}
  ): { routeSources: string[] } => {
    // Parsed manifests derive an id from their managed directory. A child
    // runtime's identity is hub-owned, so reloads must preserve the opaque
    // catalog id just like initial load does.
    const authoritativeNextConfig = { ...nextConfig, id: workspaceId };
    const routeSources = new Set(workspaceDecls.routes.map((route) => route.source));
    const nextDecls = buildWorkspaceDeclarations(authoritativeNextConfig);
    const restartBoundChanges = restartBoundManifestChanges(
      workspaceConfig,
      authoritativeNextConfig,
      workspaceDecls,
      nextDecls
    );
    for (const route of nextDecls.routes) routeSources.add(route.source);
    replaceWorkspaceConfig(workspaceConfig, authoritativeNextConfig);
    workspaceDecls.singletons.replaceAll(nextDecls.singletons.all());
    workspaceDecls.services = nextDecls.services;
    workspaceDecls.routes = nextDecls.routes;
    setWorkspaceAppTrust(resolveWorkspaceTrustGrants(authoritativeNextConfig));
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
      const declared = workspaceConfig.providers?.browserData?.extension;
      return declared ? { BROWSER_DATA_BROKER_SOURCE: workspaceExtensionRepoPath(declared) } : {};
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
  let primePanelRuntimeImage: (source: string, ref?: string) => Promise<void> = async () => {};
  entityCache.registerBootstrap({ id: "server", kind: "server" });
  entityCache.registerBootstrap({ id: "electron-main", kind: "shell" });
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
      workspaceId,
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
  const { DeviceAuthStore } = await import("./hostCore/deviceAuthStore.js");
  const { IdentityDb } = await import("@vibestudio/identity/identityDb");
  const { UserStore } = await import("@vibestudio/identity/userStore");
  const { MembershipStore } = await import("@vibestudio/identity/membership");
  // A workspace runtime is always hub-managed. Identity and membership live in
  // the hub's single database; the child has a query-only handle and no private
  // fallback store or standalone pairing mode.
  const entryWorkspaceId = childWorkspaceId;
  const identityDb = new IdentityDb({ path: identityDbPath, readOnly: true });
  const userStore = new UserStore(identityDb);
  const membershipStore = new MembershipStore(identityDb, userStore);
  const deviceAuthStore = new DeviceAuthStore({
    db: identityDb,
    serverIdPath: path.join(path.dirname(identityDbPath), "server-id.json"),
  });
  const listWorkspaceMemberUserIds = (): string[] => {
    const explicit = membershipStore
      .listMembers(entryWorkspaceId)
      .map((membership) => membership.userId);
    const root = userStore
      .listUsers()
      .find((user) => user.role === "root" && user.revokedAt === undefined)?.id;
    return [...new Set(root ? [root, ...explicit] : explicit)];
  };
  const workspaceChildHub = createWorkspaceChildHubPort({
    hubUrl,
    runtimeToken: workspaceChildToken,
  });
  // Resolves each authenticated caller to its account subject at auth time
  // (WP0 §5.2/§5.5): device shells → owning user, agents → spawner, panel/DO/
  // worker lineage → owner, and the local console → root. Passed to RpcServer.
  const { createUserSubjectSource, isSystemOwnedRuntime } =
    await import("./services/userSubjectSource.js");
  const isSystemRuntime = (
    callerId: string,
    callerKind: import("@vibestudio/shared/serviceDispatcher").CallerKind
  ): boolean => {
    if (isSystemOwnedRuntime(entityCache, callerId, callerKind)) return true;
    if (callerKind !== "do") return false;
    return (
      callerId ===
      canonicalEntityId({
        kind: "do",
        source: SEMANTIC_CONTROL_PLANE.source,
        className: SEMANTIC_CONTROL_PLANE.className,
        key: SEMANTIC_CONTROL_PLANE.objectKey,
      })
    );
  };
  const userSubjectSource = createUserSubjectSource({
    deviceAuthStore,
    userStore,
    entityCache,
    isSystemRuntime,
  });
  let extensionHostForGateway: import("@vibestudio/extension-host").ExtensionHost | null = null;
  // One authoritative workspace-membership fact for both transport admission
  // and method authority. The synthetic system subject represents workspace-
  // local infrastructure (singletons/internal control plane), not an IdentityDb
  // account, so it is a member by construction. Every human-backed runtime is
  // re-evaluated against the shared membership store.
  const membershipEntryGate = (
    subject: import("@vibestudio/identity/types").UserSubject | undefined
  ): boolean => {
    if (subject?.userId === SYSTEM_SUBJECT.userId) return true;
    return subject !== undefined && membershipStore.has(subject.userId, entryWorkspaceId);
  };
  const workspaceRoleResolver = (
    subject: import("@vibestudio/identity/types").UserSubject | undefined
  ): import("@vibestudio/identity/types").UserRole | null => {
    if (!subject || subject.userId === SYSTEM_SUBJECT.userId) return null;
    return userStore.getUser(subject.userId)?.role ?? null;
  };
  const { createLiveCallerGate } = await import("./services/liveCallerGate.js");
  const liveCallerGate = createLiveCallerGate({
    workspaceId: entryWorkspaceId,
    userStore,
    membershipStore,
    deviceAuthStore,
    entityCache,
    isLiveExtension: (callerId) =>
      (extensionHostForGateway?.resolveCodeIdentity(callerId) ?? null) !== null,
    isLiveSystemRuntime: isSystemRuntime,
  });
  const workerdGatewayToken = randomBytes(32).toString("hex");
  serverLogStore.addSecret(workerdGatewayToken);
  const { CredentialStore } = await import("@vibestudio/credential-client/store");
  const { ClientConfigStore } = await import("@vibestudio/credential-client/clientConfigStore");
  const { AuditLog } = await import("@vibestudio/credential-client/audit");
  const { createEgressProxy } = await import("./services/egressProxy.js");
  const { CredentialLifecycle } = await import("./services/credentialLifecycle.js");
  const { CredentialSessionGrantStore } = await import("./services/credentialSessionGrants.js");
  const { CredentialUseGrantStore } = await import("./services/credentialUseGrantStore.js");

  const credentialStore = new CredentialStore();
  const clientConfigStore = new ClientConfigStore();
  const auditLog = new AuditLog({ logDir: layout.credentialsAuditDir });
  const credentialSessionGrantStore = new CredentialSessionGrantStore();
  const credentialUseGrantStore = new CredentialUseGrantStore({ statePath });
  const { CapabilityGrantStore } = await import("./services/capabilityGrantStore.js");
  const capabilityGrantStore = new CapabilityGrantStore({ statePath });
  const { AgentExecutionSessionRegistry } =
    await import("./services/agentExecutionSessionRegistry.js");
  const agentExecutionSessions = new AgentExecutionSessionRegistry();
  const {
    ContextIntegrityStore,
    createContextIngestionBatchRecorder,
    createContextIngestionRecorder,
    recordContextIngestionForCaller,
  } = await import("./services/contextIntegrityStore.js");
  const contextIntegrityStore = new ContextIntegrityStore({ statePath });
  const recordContextIngestion = createContextIngestionRecorder(contextIntegrityStore);
  const recordContextIngestionBatch = createContextIngestionBatchRecorder(contextIntegrityStore);
  const { ConduitBlessingStore } = await import("./services/conduitBlessingStore.js");
  const conduitBlessingStore = new ConduitBlessingStore({ statePath });
  const { MissionRegistry } = await import("./services/missionRegistry.js");
  const missionRegistry = new MissionRegistry({
    statePath,
    grantStore: capabilityGrantStore,
    isConduitBlessed: (identity) =>
      conduitBlessingStore.isBlessed({
        repoPath: identity.unit,
        effectiveVersion: identity.ev,
      }),
  });
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
      objectKey: workspaceId,
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
    recordProvenance: async (record) => {
      await workspaceChildHub.appendApproval(record);
    },
    resolveTitle: (entityId) => resolveApprovalCallerTitle(approvalRequesterDeps, entityId),
    resolveRequester: (input) => resolveApprovalRequester(approvalRequesterDeps, input),
  });
  const { AcquisitionCoordinator } = await import("./services/acquisitionCoordinator.js");
  const acquisitionCoordinator = new AcquisitionCoordinator({
    approvalQueue,
    grantStore: capabilityGrantStore,
    notifyOwner: async (ownerRuntimeId, acquisitionId) => {
      const ref = parseDoTargetId(ownerRuntimeId);
      const doDispatch = resolvedDoDispatchForTitles;
      if (!ref || !doDispatch) return;
      await doDispatch.dispatch(ref, "onAuthorityChanged", acquisitionId);
    },
  });
  const { UnitVersionApprovalStore } = await import("./services/unitVersionApprovalStore.js");
  const unitVersionApprovalStore = new UnitVersionApprovalStore({ statePath });
  const { ServerUnitApprovalCoordinator } = await import("./unitApprovalCoordinator.js");
  const unitApprovalCoordinator = new ServerUnitApprovalCoordinator({
    approvalQueue,
    delayMs: 250,
    autoPublishStartup: false,
  });
  const requireMobileReady =
    args.requireMobileReady || process.env["VIBESTUDIO_REQUIRE_MOBILE_READY"] === "1";
  const requireElectronReady =
    args.requireElectronReady || process.env["VIBESTUDIO_REQUIRE_ELECTRON_READY"] === "1";
  const credentialLifecycle = new CredentialLifecycle({
    credentialStore,
    clientConfigStore,
  });
  const { LocalModelLoopbackAuthority } = await import("./services/localModelLoopbackAuthority.js");
  const localModelLoopbackAuthority = new LocalModelLoopbackAuthority();

  const egressProxy = createEgressProxy({
    credentialStore,
    auditLog,
    approvalQueue,
    authorizeEffect: (ctx, effect) => dispatcher.authorizeHostEffect(ctx, effect),
    sessionGrantStore: credentialSessionGrantStore,
    credentialUseGrantStore,
    credentialLifecycle,
    authorizeInternalRequest: (input) => localModelLoopbackAuthority.authorize(input),
    authorizePlatformRpcCallback: ({ targetUrl, authorization, runtimeId }) => {
      let gatewayOrigin: string;
      try {
        gatewayOrigin = new URL(getLocalGatewayUrl("platform RPC callback")).origin;
      } catch {
        return false;
      }
      if (targetUrl.origin !== gatewayOrigin) return false;
      const token = authorization.slice("Bearer ".length);
      const entry = tokenManager.validateToken(token);
      if (!entry) return false;
      try {
        return resolveHttpRuntimeCaller(entry.callerId, entry.callerKind, runtimeId) === runtimeId;
      } catch {
        return false;
      }
    },
    recordExternalIngestion: (caller, url, via) => {
      recordContextIngestionForCaller(contextIntegrityStore, caller, {
        key: `web:${url.hostname.toLowerCase()}`,
        via,
        classification: "external",
      });
    },
    assertMissionNetworkExposure: (caller, targetUrl) => {
      const sessionId = caller.agentBinding?.channelId ?? caller.runtime.id;
      return missionRegistry.assertNetworkExposure(sessionId, targetUrl.origin);
    },
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
  // The supervisor designates exactly one source-coupled developer instance.
  // Its committed workspace changes are mirrored back to `<appRoot>/workspace`
  // so interactive source development persists. Named and ephemeral peers are
  // isolated test/runtime instances: their publications must never mutate the
  // checkout template or leak into another hub's next bootstrap.
  const templateDir = path.join(appRoot, "workspace");
  const isPnpmDevMode = process.env["NODE_ENV"] === "development";
  const hasDevTemplate = fs.existsSync(path.join(templateDir, "meta", "vibestudio.yml"));
  const templateDiffersFromActive =
    templateDir !== workspacePath && !workspacePath.startsWith(templateDir + path.sep);
  // pnpm dev mode: mirror protected workspace publications back to the
  // template source checkout. Hooked onto publication effects below.
  const devTemplateMirrorDir =
    isPnpmDevMode &&
    process.env["VIBESTUDIO_SOURCE_INSTANCE"] === "1" &&
    process.env["VIBESTUDIO_DISABLE_DEV_TEMPLATE_MIRROR"] !== "1" &&
    workspaceIsEphemeral &&
    hasDevTemplate &&
    templateDiffersFromActive
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
  // Resolve the advertised gateway before registering workerd: workerd's
  // back-channel aliases are a real startup input, not a later lexical side effect.
  const { resolveHostConfig } = await import("@vibestudio/shared/hostConfig");
  const hostConfig = resolveHostConfig({
    workerdPort: 0,
    gatewayPort: requestedGatewayPort ?? 0,
    host: args.host,
    bindHost: args.bindHost,
  });
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
  let startupNonCriticalUnitReconcile: Promise<void> = Promise.resolve();
  let releaseRuntimeUnitApprovalStaged!: () => void;
  let runtimeUnitApprovalStagedReleased = false;
  const runtimeUnitApprovalStaged = new Promise<void>((resolve) => {
    releaseRuntimeUnitApprovalStaged = resolve;
  });
  const finishRuntimeUnitApprovalStaging = (): void => {
    if (runtimeUnitApprovalStagedReleased) return;
    runtimeUnitApprovalStagedReleased = true;
    releaseRuntimeUnitApprovalStaged();
  };
  let releaseStartupLaunchWindow!: () => void;
  let startupLaunchWindowReleased = false;
  let startupLaunchRequested = false;
  let startupLaunchFallbackTimer: NodeJS.Timeout | null = null;
  const startupLaunchWindowComplete = new Promise<void>((resolve) => {
    releaseStartupLaunchWindow = resolve;
  });
  const finishStartupLaunchWindow = (reason: string): void => {
    if (startupLaunchWindowReleased) return;
    startupLaunchWindowReleased = true;
    if (startupLaunchFallbackTimer) clearTimeout(startupLaunchFallbackTimer);
    console.info(`[StartupCriticalPath] Interactive launch window complete: ${reason}`);
    releaseStartupLaunchWindow();
  };
  const armStartupLaunchFallback = (): void => {
    if (startupLaunchRequested || startupLaunchWindowReleased || startupLaunchFallbackTimer) return;
    startupLaunchFallbackTimer = setTimeout(
      () => finishStartupLaunchWindow("no host target requested within 10000ms"),
      10000
    );
    startupLaunchFallbackTimer.unref();
  };
  let releaseStartupBackgroundWork!: () => void;
  const startupBackgroundWorkComplete = new Promise<void>((resolve) => {
    releaseStartupBackgroundWork = resolve;
  });
  const { HostTargetLaunchCoordinator } = await import("./hostTargetLaunchCoordinator.js");
  // Launch/session state only needs declared units to be CLASSIFIED (pending
  // entries upserted, approval batches staged with the coordinator) — waiting
  // for the whole startup reconcile made the launch gate sit behind every unit
  // build. Race against the reconcile promise so a pass that fails before
  // staging still releases the gate (with its error surfaced by resolveLaunch).
  const startupUnitDeclarationsStaged = (): Promise<void> => {
    if (!startupWorkspaceUnitReconcile) return Promise.resolve();
    const staged = Promise.all([
      ...trustedUnitHosts().map((host) => host.whenDeclarationsStaged()),
      runtimeUnitApprovalStaged,
    ]).then(() => {});
    return Promise.race([staged, startupWorkspaceUnitReconcile]);
  };
  const startupHostTargetPreparations = new Map<string, Promise<void>>();
  const prepareStartupHostTarget = async (
    target: import("@vibestudio/shared/hostTargets").HostTarget
  ): Promise<void> => {
    await startupUnitDeclarationsStaged();
    const required = resolveHostTargetRequiredExtensions(workspaceConfig, target);
    if (!extensionHostForGateway || required.length === 0) return;
    const key = `${target}:${required.map((decl) => `${decl.source}@${decl.ref}`).join(",")}`;
    let preparation = startupHostTargetPreparations.get(key);
    if (!preparation) {
      const startedAt = Date.now();
      preparation = extensionHostForGateway
        .reconcileDeclared(required, {
          trigger: "startup",
          removeUndeclared: false,
          // Trusted provider dependencies have no approval publication to
          // await, so their targeted reconcile is the settlement boundary.
          // Approval-gated dependencies stage here and settle through the
          // unit-selective publication below.
          waitFor: "applied",
        })
        .then(() => {
          console.info(
            `[StartupCriticalPath] ${target} provider dependencies classified in ${Date.now() - startedAt}ms (${required.map((decl) => decl.source).join(", ")})`
          );
        });
      startupHostTargetPreparations.set(key, preparation);
      void preparation.catch(() => startupHostTargetPreparations.delete(key));
    }
    await preparation;
  };
  const hostTargetLaunchCoordinator = new HostTargetLaunchCoordinator({
    approvalQueue,
    eventService,
    startupApprovals: unitApprovalCoordinator,
    awaitStartupUnitReconcile: startupUnitDeclarationsStaged,
    prepareHostTarget: prepareStartupHostTarget,
    getRequiredExtensionSources: (target) =>
      resolveHostTargetRequiredExtensions(workspaceConfig, target).map((decl) => decl.source),
    getAppHost: () => appHostForGateway,
    getTrustedUnitHosts: trustedUnitHosts,
    onLaunchActivity: (target, phase) => {
      if (phase === "requested") {
        startupLaunchRequested = true;
        if (startupLaunchFallbackTimer) clearTimeout(startupLaunchFallbackTimer);
        return;
      }
      finishStartupLaunchWindow(`${target} launch settled`);
    },
  });
  // Protected repository content pointers: the single host publication store.
  // Constructed BEFORE WorkspaceVcs (which routes every protected read/advance
  // through it); the approval gate is late-bound below once the main-advance
  // approval machinery exists — advances before that point fail closed.
  const { createProtectedRefStore } = await import("./services/protectedRefStore.js");
  const { collectTreeReachableDigests } = await import("./services/blobstoreService.js");
  let mainRefGate: import("./services/protectedRefStore.js").RefGate | null = null;
  const protectedRefStore = createProtectedRefStore({
    statePath: layout.refsDir,
    gate: async (batch) => {
      if (!mainRefGate) {
        throw new Error("Protected-ref gate not initialized yet (server still starting)");
      }
      await mainRefGate(batch);
    },
    // Validity check BEFORE approval (§2.1): every candidate `main` state must
    // be a well-formed tree fully present in the content store — userland can
    // never publish a hash the store cannot expand. Fails closed before any prompt.
    assertTreeComplete: async (stateHash) => {
      const reachable = await collectTreeReachableDigests(layout.blobsDir, stateHash);
      if (!reachable) {
        throw new Error(
          `updateMains: candidate main ${stateHash} is not fully present in the content store`
        );
      }
    },
  });
  // Workspace VCS is a host adapter for the product-sealed semantic control
  // plane. It has no pre-attachment history or mutable workspace binding.
  const { WorkspaceVcs } = await import("./vcsHost/workspaceVcs.js");
  const workspaceVcs = new WorkspaceVcs({
    blobsDir: layout.blobsDir,
    workspaceRoot: workspacePath,
    contextProjectionsRoot: layout.contextProjections.current,
    buildSourcesRoot: layout.buildSourcesDir,
    refs: protectedRefStore,
    // Public context bindings contain durable identities only. Reachability is
    // resolved from the caller's current hub/session credential.
    workspaceId,
    // Dev extraction gate (Phase-2 revision §3): project a push-to-`main` OUT to
    // the source dir only when there is a persistent dev source to extract to.
    // `devTemplateMirrorDir` is the existing signal (pnpm dev + a real
    // `<appRoot>/workspace` template); the rsync mirror below then bridges the
    // exported source dir to that checkout. Off in production ephemeral
    // workspaces, which have no source dir. Computed just above this block.
    extractMainToSource: devTemplateMirrorDir !== null,
  });
  // Set only by the trusted one-time import from the host-shipped workspace
  // template. Protected main is mutable and must never be substituted here.
  let productSeedStateHash: string | null = null;
  const readWorkspaceFileAtState = async (
    stateHash: string,
    filePath: string
  ): Promise<string | null> => {
    if (!/^state:[0-9a-f]{64}$/.test(stateHash)) {
      throw new Error(`workspace content read requires a canonical state hash: ${stateHash}`);
    }
    const file = await workspaceVcs.readFile(stateHash, filePath);
    if (!file || file.content.kind !== "text") return null;
    return file.content.text;
  };
  const { createRecurringMetaChangeProvider } = await import("./services/recurringRegistry.js");
  const recurringMetaChangeProvider = createRecurringMetaChangeProvider({
    workspaceId,
    getCurrentRecurring: () => workspaceConfig.recurring ?? [],
    getCurrentHeartbeats: () => workspaceConfig.heartbeats ?? [],
    readWorkspaceFileAtState,
  });
  // Create ContextFolderManager before core services. Context folders are
  // disposable projections of GAD-owned semantic contexts.
  const { ContextFolderManager } = await import("@vibestudio/shared/contextFolderManager");
  const contextFolderManager = new ContextFolderManager({
    contextProjectionsRoot: layout.contextProjections.current,
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
    await import("@vibestudio/workspace/remotes");
  const { resolveDeclaredApps, resolveDeclaredExtensions } =
    await import("@vibestudio/workspace/loader");
  const { readWorkspaceConfigFromState } = await import("./workspaceConfigSource.js");
  const loadWorkspaceConfigFromState = async (
    stateHash: string
  ): Promise<typeof workspaceConfig> => {
    return readWorkspaceConfigFromState(workspaceVcs, workspaceId, stateHash);
  };
  const reconcileDeclaredWorkspaceUnits = async (
    nextConfig: typeof workspaceConfig,
    trigger: "startup" | "meta-change"
  ): Promise<void> => {
    const reconcile = async (): Promise<void> => {
      const tasks: Array<Promise<void>> = [];
      if (extensionHostForGateway) {
        const extensionHost = extensionHostForGateway;
        const critical = resolveHostTargetRequiredExtensions(nextConfig);
        const criticalSources = new Set(critical.map((decl) => decl.source));
        const declared = [
          ...critical,
          ...resolveDeclaredExtensions(nextConfig).filter(
            (declaration) => !criticalSources.has(declaration.source)
          ),
        ];
        if (trigger === "startup") {
          const review = extensionHost.reviewDeclared(declared);
          if (review.units.length > 0) {
            void unitApprovalCoordinator
              .enqueue({
                entries: review.units,
                trigger,
                applyApproved: async () => {
                  extensionHost.acceptPreapprovedTrust(review.identityKeys);
                },
                applyDenied: () => undefined,
              })
              .catch((err: unknown) =>
                console.warn("[Units] Failed to apply reviewed extension trust:", err)
              );
          }
        }
        const reconcileAll = () =>
          extensionHost
            .reconcileDeclared(declared, { trigger })
            .then(() => extensionHost.whenReconciled())
            .then(() => import("@vibestudio/workspace/extensionRegistry"))
            .then(({ writeExtensionRegistry }) => {
              writeExtensionRegistry(workspacePath);
            });
        if (trigger === "startup") {
          console.info(
            "[StartupCriticalPath] Extension builds deferred until a host target or background reconcile needs them"
          );
          armStartupLaunchFallback();
          startupNonCriticalUnitReconcile = Promise.resolve()
            .then(() => startupLaunchWindowComplete)
            .then(() => {
              const backgroundStartedAt = Date.now();
              return reconcileAll().then(() => {
                void unitApprovalCoordinator
                  .publishPending("startup")
                  .catch((err: unknown) =>
                    console.warn("[Units] Failed to publish startup approvals:", err)
                  );
                console.info(
                  `[StartupBackground] Remaining extensions reconciled in ${Date.now() - backgroundStartedAt}ms`
                );
              });
            })
            .catch((err: unknown) =>
              console.warn("[Extensions] Failed to reconcile background workspace units:", err)
            );
        } else {
          tasks.push(
            reconcileAll().catch((err: unknown) =>
              console.warn("[Extensions] Failed to reconcile declared workspace units:", err)
            )
          );
        }
      }
      if (appHostForGateway) {
        try {
          const declared = resolveDeclaredApps(nextConfig);
          appHostForGateway.setDeclared(declared, { trigger });
          if (trigger === "startup") {
            const review = appHostForGateway.reviewDeclared(declared);
            if (review.units.length > 0) {
              const appHost = appHostForGateway;
              void unitApprovalCoordinator
                .enqueue({
                  entries: review.units,
                  trigger,
                  applyApproved: async () => {
                    appHost.acceptPreapprovedTrust(review.identityKeys);
                  },
                  applyDenied: () => undefined,
                })
                .catch((err: unknown) =>
                  console.warn("[Units] Failed to apply reviewed app trust:", err)
                );
            }
          }
          if (trigger === "startup") {
            console.info("[StartupCriticalPath] App declarations staged for on-demand launch");
          }
        } catch (err) {
          console.warn("[Apps] Failed to update declared workspace app units:", err);
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
  // Protected workspace publications drive source-side reactions:
  //  - meta/ changes reload workspace config from the exact published state
  //    and reconcile declared units
  //  - any change invalidates the tree scanner cache
  //  - pnpm dev mode mirrors the committed tree back to the template checkout
  let devMirrorTimer: NodeJS.Timeout | null = null;
  let initialWorkspaceUnitReconcileComplete = false;
  let pendingStartupMetaConfigReload = false;
  let latestMetaConfigReloadSeq = 0;
  // Bridge one atomic protected publication to the client event bus.
  workspaceVcs.onProtectedPublication((event) => {
    eventService.emit("vcs:publication", event);
  });
  workspaceVcs.onProtectedPublication((event) => {
    treeScanner.invalidate();
    if (event.changedPaths.some((changed) => changed.startsWith("meta/"))) {
      const reloadSeq = ++latestMetaConfigReloadSeq;
      queueMicrotask(() => {
        void (async () => {
          try {
            const nextConfig = await loadWorkspaceConfigFromState(event.workspaceStateHash);
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
            "--exclude=.context-projections",
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
  // ===========================================================================
  // Unified ServiceContainer — lifecycle + RPC services in one container
  // ===========================================================================

  dispatcher.setAuthorityAcquirer({
    request: (input) => acquisitionCoordinator.request(input),
    acquire: (input, signal) => acquisitionCoordinator.requestAndWait(input, signal),
    consume: (grantId) => acquisitionCoordinator.consume(grantId),
    touch: (grantId) => acquisitionCoordinator.touch(grantId),
    priorInteractiveApprovalCount: (input) =>
      capabilityGrantStore.priorInteractiveApprovalCount(input),
    invalidate: (snapshotDigest, ownerRuntimeId, callerPrincipal) =>
      acquisitionCoordinator.invalidate(snapshotDigest, ownerRuntimeId, callerPrincipal),
    proposeMissionRevision: ({ snapshot, tier, resource }) => {
      if (snapshot.mission === "-") {
        throw new Error("Mission revision proposal requires a mission-bound invocation");
      }
      const mission = missionRegistry.proposePermissionRevision({
        sessionId: snapshot.sessionId,
        service: snapshot.service,
        method: snapshot.method,
        capability: snapshot.capability,
        resource,
        tier,
      });
      void import("./services/missionService.js")
        .then(({ reviewMission }) =>
          reviewMission(
            {
              registry: missionRegistry,
              approvalQueue,
              capabilityGrants: capabilityGrantStore,
              describeCapability,
              contextIntegrityReady: () => contextIntegrityStore.isCutoverComplete(),
            },
            mission,
            mission.owner.userId,
            {
              reviewKind: "out-of-charter",
              blockedAt: Date.now(),
              declinedRestriction: {
                capability: snapshot.capability,
                resourceKey: snapshot.resourceKey,
              },
            }
          )
        )
        .catch((error) => {
          console.error("[Mission] Could not publish revision review:", error);
        });
    },
  });
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
    dependencies: ["semanticWorkspace"],
    async start() {
      const buildSystem = await initBuildSystemV2(
        workspacePath,
        workspaceVcs,
        appNodeModules.length > 0 ? appNodeModules : [path.join(appRoot, "node_modules")],
        {
          appRoot,
          dependencyWorkspaceRoot: buildDependencyWorkspaceRoot,
        }
      );
      const snapshotState = productSeedStateHash;
      if (snapshotState) {
        const { PRODUCT_CONDUIT_UNITS } = await import("./productConduitPolicy.js");
        const resolutions = await buildSystem.resolveBuildUnits(
          PRODUCT_CONDUIT_UNITS,
          snapshotState
        );
        const identities = PRODUCT_CONDUIT_UNITS.map((repoPath, index) => {
          const resolved = resolutions[index];
          if (!resolved || resolved.kind !== "worker") {
            throw new Error(
              `Product conduit policy entry ${repoPath} is absent or is not a worker in the shipped snapshot`
            );
          }
          return {
            repoPath: resolved.unitPath,
            effectiveVersion: resolved.effectiveVersion,
          };
        });
        if (!conduitBlessingStore.isSeededFor(snapshotState)) {
          conduitBlessingStore.seedProductSnapshot(snapshotState, identities);
        }
        const { loadMissionSeedDefinitions, reconcileSeededMissions } =
          await import("./services/seededMissions.js");
        const definitions = loadMissionSeedDefinitions(path.join(appRoot, "seed", "missions"));
        reconcileSeededMissions({
          productSnapshotState: snapshotState,
          definitions,
          harnessVersions: new Map(
            identities.map((identity) => [identity.repoPath, identity.effectiveVersion])
          ),
          registry: missionRegistry,
        });
      }
      return buildSystem;
    },
    async stop(instance: import("./buildV2/index.js").BuildSystemV2) {
      await instance?.shutdown();
    },
  });

  // Prepare the manifest-declared eval engine + runtime prewarm. The returned
  // starter runs only after host readiness so optional compiles cannot starve
  // the VCS store DO that is on the critical startup path.
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
        return () => undefined;
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
      let started = false;
      return () => {
        if (started) return;
        started = true;
        prewarm(engineSource);
        // The EvalDO loads these three runtime subpaths (see ensureRuntimeSupport).
        prewarm(`${runtimeSource}/hosted`);
        prewarm(`${runtimeSource}/panel-runtime`);
        prewarm(`${runtimeSource}/portable`);
      };
    },
  });

  // ── RPC-only services (replacing serverServiceRegistry.ts) ──

  const { createBuildService } = await import("./services/buildService.js");
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
    // Account profile reads resolve live through the child's shared query-only
    // DB. Writes go directly to hubControl over the client's stable hub session.
    const { createAccountService } = await import("./services/accountService.js");
    container.registerRpc(
      createAccountService({
        identityDb,
        isWorkspaceMember: (userId) => membershipStore.has(userId, entryWorkspaceId),
        listWorkspaceMemberUserIds,
      })
    );
    const { createGovernanceService } = await import("./services/governanceService.js");
    container.registerRpc(
      createGovernanceService({
        query: async (query) => {
          return workspaceChildHub.queryGovernance(query);
        },
      })
    );
  }

  // Git interchange semantics live behind the manifest-declared
  // providers.gitInterop extension. The host keeps only this policy/dispatch
  // service (approvals, config writes, and provider invocation).
  const { createWorkspaceConfigMainWriter } = await import("./workspaceConfigWriter.js");
  const workspaceConfigWriter = createWorkspaceConfigMainWriter({
    workspaceId,
    vcs: workspaceVcs,
  });
  const replaceLiveWorkspaceConfig = (next: typeof workspaceConfig): void =>
    replaceWorkspaceConfig(workspaceConfig, { ...next, id: workspaceId });
  const invokeGitInteropProvider = createGitInteropProviderInvoker(() => extensionHostForGateway);
  const gitInteropDefinition = createGitInteropService({
    workspacePath,
    workspaceConfig,
    invokeGitProvider: invokeGitInteropProvider,
    disposableRemotes: disposableGitRemotes,
    persistWorkspaceConfigMutation: async (input) => {
      const result = await workspaceConfigWriter.applyMutation(input);
      replaceLiveWorkspaceConfig(result.nextConfig);
      return result;
    },
  });
  container.registerRpc(gitInteropDefinition);
  const pendingGitUpstreamRepos = new Set<string>();
  let gitUpstreamFlushRunning = false;
  const flushGitUpstreamRepos = async (): Promise<void> => {
    if (gitUpstreamFlushRunning) return;
    gitUpstreamFlushRunning = true;
    let readinessAttempts = 0;
    try {
      // Ref advances begin during VCS/bootstrap attachment, before declared
      // extensions are reconciled. Keep those notifications queued until the
      // background extension pass has installed git-bridge instead of polling
      // and emitting a transient ENOEXT on the interactive launch path.
      await startupBackgroundWorkComplete;
      while (pendingGitUpstreamRepos.size > 0) {
        if (!extensionHostForGateway) {
          if (readinessAttempts >= 120) {
            console.warn("[GitUpstream] extension host did not become ready within 60s");
            return;
          }
          readinessAttempts += 1;
          await new Promise<void>((resolve) => setTimeout(resolve, 500));
          continue;
        }
        const repos = [...pendingGitUpstreamRepos];
        pendingGitUpstreamRepos.clear();
        try {
          await invokeGitInteropProvider({ caller: createHostCaller("server") }, "onMainAdvanced", [
            repos,
          ]);
          readinessAttempts = 0;
        } catch (err) {
          const code =
            typeof err === "object" && err !== null && "code" in err
              ? (err as { code?: unknown }).code
              : undefined;
          if ((code === "ENOEXT" || code === "ENOTREADY") && readinessAttempts < 120) {
            for (const repo of repos) pendingGitUpstreamRepos.add(repo);
            readinessAttempts += 1;
            await new Promise<void>((resolve) => setTimeout(resolve, 500));
            continue;
          }
          console.warn("[GitUpstream] forward failed:", err);
        }
      }
    } finally {
      gitUpstreamFlushRunning = false;
    }
  };
  protectedRefStore.onRefsChanged((publication) => {
    const repos = publication.changes
      .filter((change) => change.nextContentRoot !== null)
      .map((change) => change.repoPath);
    if (repos.length === 0) return;
    for (const repo of repos) pendingGitUpstreamRepos.add(repo);
    void flushGitUpstreamRepos();
  });
  const completeConfiguredWorkspaceDependenciesAtStartup = async (): Promise<void> => {
    try {
      const result = (await gitInteropDefinition.handler(
        { caller: createHostCaller("server") },
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
  const { createBuildUnitChangeApprovalProvider } =
    await import("./services/buildUnitChangeApprovalProvider.js");
  const buildUnitChangeApprovalProvider = createBuildUnitChangeApprovalProvider({
    getBuildSystem: () => assertPresent(buildSystemInstance),
    readWorkspaceFileAtState,
    describeCapability,
    approvalStore: unitVersionApprovalStore,
  });
  {
    const { createVcsService } = await import("./services/vcsService.js");
    const { createMainAdvanceApprovalGate, createMainRefAdvanceGate } =
      await import("./services/mainAdvanceApproval.js");
    const mainAdvanceGate = createMainAdvanceApprovalGate({
      authorizeEffect: (ctx, effect) => dispatcher.authorizeHostEffect(ctx, effect),
      hasAppCapability: (callerId, capability) =>
        appHostForGateway?.hasAppCapability(callerId, capability) ?? false,
      getProviders: () => [
        ...trustedUnitHosts(),
        buildUnitChangeApprovalProvider,
        recurringMetaChangeProvider,
      ],
    });
    // The ONE approval path for protected main-ref advances: the server
    // computes the authoritative diff (content-store diffTrees over the CAS'd
    // trees) inside the gate; the meta repo additionally derives its semantic
    // unit-change prompt from the candidate workspace view.
    mainRefGate = createMainRefAdvanceGate({
      blobsDir: layout.blobsDir,
      approvalGate: mainAdvanceGate,
      ensureStateMirrored: (stateHash) =>
        workspaceVcs.contentProjection.ensureStateMirrored(stateHash),
      workspaceViewWithReposAt: (overrides) =>
        workspaceVcs.repositories.workspaceViewWithReposAt(overrides),
      computeDeleteDependents: (repoPath) => workspaceVcs.repositories.deletionDependents(repoPath),
    });
    // Remote context mirrors (plan §6.5): read-side of exact context content
    // over the wire. `targets` exposes its repository content states; `objects` streams the
    // CAS tree content in size-bounded pages. Backed by the same WorkspaceVcs +
    // ContentProjectionStore + blobstore the projector uses — no new write semantics.
    {
      const { createMirrorService } = await import("./services/mirrorService.js");
      const { getBytes: readMirrorBlob } = await import("./services/blobstoreService.js");
      const mirrorBlobsDir = layout.blobsDir;
      container.registerRpc(
        createMirrorService({
          contextRepoTargets: (contextId) => workspaceVcs.contextRepoTargets(contextId),
          listStateFiles: async (stateHash) =>
            (await workspaceVcs.contentProjection.listStateFiles(stateHash)).map((file) => ({
              path: file.path,
              contentHash: file.content_hash,
              mode: file.mode,
            })),
          readBlob: (contentHash) => readMirrorBlob(mirrorBlobsDir, contentHash),
        })
      );
    }
    container.registerManaged({
      name: "vcsService",
      getServiceDefinition() {
        return createVcsService({
          workspaceVcs,
          entityCache,
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
  const { wireRuntimeObservability } = await import("./bootstrap/runtimeObservability.js");
  const runtimeDiagnostics = wireRuntimeObservability({
    container,
    statePath,
    workspaceId,
    eventService,
  });
  container.registerRpc(
    createWorkspaceEventsService({
      eventService,
      onWatchOpened: (events, ctx) => {
        if (events.includes("server-log:append") || events.includes("workspace:unit-log")) {
          recordContextIngestion(ctx, {
            key: "log:server",
            via: "events:log-watch",
            classification: "external",
          });
        }
        return undefined;
      },
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
      })
    );
  }

  // ── Notification service ──
  const { createNotificationService } = await import("./services/notificationService.js");
  const notificationResult = createNotificationService({ eventService });
  container.registerRpc(notificationResult.definition);

  // ── Push + shell presence services ──
  let pushForRevocation: import("./services/pushService.js").PushServiceInternal | null = null;
  {
    const { createPushService } = await import("./services/pushService.js");
    const pushResult = createPushService();
    pushForRevocation = pushResult.internal;
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
          // Include root's implicit membership, which intentionally has no row.
          workspaceMemberUserIds: listWorkspaceMemberUserIds,
        });
      },
      stop: async (bridge: import("./services/approvalPushBridge.js").ApprovalPushBridge) => {
        bridge.stop();
      },
    });
  }

  // ── Shell approval service (consent bar queue) ──
  const { createShellApprovalService } = await import("./services/shellApprovalService.js");
  container.registerRpc(
    createShellApprovalService({
      approvalQueue,
      deviceLabelFor: (deviceId) => identityDb.getDevice(deviceId)?.label,
    })
  );
  const { BrowserPermissionGrantStore, createBrowserPermissionsService } =
    await import("./services/browserPermissionsService.js");
  const browserPermissionGrantStore = new BrowserPermissionGrantStore(statePath);
  container.registerRpc(
    createBrowserPermissionsService({
      approvalQueue,
      workspaceId,
      grantStore: browserPermissionGrantStore,
    })
  );
  const { createCorsApprovalService } = await import("./services/corsApprovalService.js");
  container.registerRpc(createCorsApprovalService());
  const { createUserlandApprovalService } = await import("./services/userlandApprovalService.js");
  container.registerRpc(
    createUserlandApprovalService({
      approvalQueue,
      grantStore: capabilityGrantStore,
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
  const { wireCredentialService } = await import("./bootstrap/credentials.js");
  relayServices.credential = wireCredentialService({
    container,
    routeRegistry,
    eventService,
    entityCache,
    dispatcher,
    credentialStore,
    clientConfigStore,
    auditLog,
    relayOAuthRegistrar,
    egressProxy,
    disposableGitHttp: disposableGitRemotes,
    approvalQueue,
    sessionGrantStore: credentialSessionGrantStore,
    credentialUseGrantStore,
    credentialLifecycle,
    hasConnectedShell: () => (rpcServerForGateway?.countConnectedClients(["shell"]) ?? 0) > 0,
    getAuthorizingShell: (principalId) =>
      rpcServerForGateway?.getAuthorizingShell(principalId) ?? null,
    hasAppCapability: (callerId, capability) =>
      appHostForGateway?.hasAppCapability(callerId, capability) ?? false,
  });

  // Durable and session permission grants are owned by the workspace server.
  // Register their trusted management surface beside the stores that back it;
  // panels reach this service over their authenticated server session rather
  // than through an Electron-only facade.
  {
    const { createPermissionsService } = await import("./services/permissionsService.js");
    container.registerRpc(
      createPermissionsService({
        capabilityGrants: capabilityGrantStore,
        credentialUseGrants: credentialUseGrantStore,
        browserPermissions: browserPermissionGrantStore,
        workspaceId,
      })
    );
  }

  {
    const { createAuthorityService } = await import("./services/authorityService.js");
    container.registerRpc(
      createAuthorityService({ dispatcher, acquisitions: acquisitionCoordinator })
    );
  }

  {
    const { createMissionService } = await import("./services/missionService.js");
    container.registerRpc(
      createMissionService({
        registry: missionRegistry,
        approvalQueue,
        capabilityGrants: capabilityGrantStore,
        describeCapability,
        contextIntegrityReady: () => contextIntegrityStore.isCutoverComplete(),
      })
    );
  }

  {
    const { createContentTrustService } = await import("./services/contentTrustService.js");
    container.registerRpc(createContentTrustService({ store: contextIntegrityStore }));
  }

  {
    const { createContextIntegrityService } = await import("./services/contextIntegrityService.js");
    container.registerRpc(
      createContextIntegrityService({
        store: contextIntegrityStore,
        resolveMessageClass: async ({ channelId, messageId }) => {
          const envelope = await workspaceVcs.getChannelEnvelopeIntegrity({
            channelId,
            envelopeId: messageId,
          });
          return envelope?.contentClass ?? "unknown";
        },
      })
    );
  }

  // ── serverLog service (host log inspection + live tail) ──
  {
    const { createServerLogService } = await import("./services/serverLogService.js");
    container.registerRpc(
      createServerLogService({
        store: serverLogStore,
        eventService,
        workspaceId: entryWorkspaceId,
        serverBootId,
        startedAt: serverLogStartedAt,
        recordContextIngestion,
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
      dependencies: ["workerdWorkspace", "workerdManager", "doDispatch"],
      async start(resolve) {
        const doDispatch = assertPresent(
          resolve<import("./doDispatch.js").DODispatch>("doDispatch")
        );
        const workerdManager = assertPresent(
          resolve<import("./workerdManager.js").WorkerdManager>("workerdManager")
        );
        evalDefinition = createEvalService({
          doDispatch,
          entityStore: ensureEntityStore(doDispatch),
          tokenManager,
          workspaceId,
          executionSessions: agentExecutionSessions,
          missionFactForSession: (sessionId) => missionRegistry.factForSession(sessionId),
          isSystemTestHarness: (caller, runId) =>
            runId.startsWith("system-test-runner:") &&
            caller.code?.repoPath === "workers/system-test-runner" &&
            Boolean(caller.code.executionDigest) &&
            conduitBlessingStore.isBlessed(caller.code),
          activity: activityRegistry,
          recoverUnresponsiveSandbox: ({ runId, timeoutMs }) =>
            workerdManager.recoverUnresponsiveSandbox(
              `eval ${runId} remained unresponsive after ${timeoutMs}ms`
            ),
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
      dependencies: ["workerdWorkspace", "doDispatch"],
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
          workspaceId,
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
    let runtimeResult: import("./services/runtimeService.js").RuntimeServiceResult | null = null;
    container.registerManaged({
      name: "runtime",
      dependencies: [
        "workerdWorkspace",
        "doDispatch",
        "workerdManager",
        "buildSystem",
        "panelHttpServer",
      ],
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
        const { server: panelHttpServer } = assertPresent(
          resolve<{ server: import("./panelHttpServer.js").PanelHttpServer }>("panelHttpServer")
        );
        primePanelRuntimeImage = async (source, ref) => {
          if (source.startsWith("browser:")) return;
          await panelHttpServer.primeBuild(source, ref, async () => {
            const binding = await buildSystem.bindRuntimeImage(source, ref);
            const build = buildSystem.getBuildByKey(binding.buildKey);
            if (!build) {
              throw new Error(
                `Prebound panel image ${binding.buildKey} for ${source} is unavailable`
              );
            }
            return build;
          });
        };
        const resolveBuildExecution = async (source: string, ref: string | undefined) => {
          const build = await buildSystem.getBuild(source, ref);
          const authority = build.metadata.authority;
          const executionDigest = build.metadata.execution?.executionDigest;
          if (!authority) {
            throw new Error(
              `Build ${build.buildKey} for ${source} has no sealed authority envelope`
            );
          }
          if (!executionDigest) {
            throw new Error(
              `Build ${build.buildKey} for ${source} has no sealed execution identity`
            );
          }
          return {
            effectiveVersion: build.metadata.ev,
            buildKey: build.buildKey,
            executionDigest,
            authorityRequests: authority.requests,
          };
        };
        runtimeResult = createRuntimeService({
          entityStore: ensureEntityStore(doDispatch),
          contextFolders: contextFolderManager,
          onContextCreated: ({ contextId, ownerContextId, testPolicy }) => {
            agentExecutionSessions.inheritTestContext(contextId, ownerContextId);
            if (testPolicy) {
              agentExecutionSessions.attachCasePolicy(contextId, ownerContextId, testPolicy);
            }
          },
          // GAD-owned semantic context lifecycle for runtime entities.
          semanticContexts: {
            ensureContext: async (contextId) => {
              await workspaceVcs.ensureContext(contextId);
            },
            dropContext: (contextId) => workspaceVcs.dropContext(contextId),
            forkContext: async (sourceContextId, targetContextId) => {
              await workspaceVcs.forkContext(sourceContextId, targetContextId);
            },
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
            preparePanel: async ({ source, ref, buildKey }) => {
              if (source.startsWith("browser:")) return { effectiveVersion: "" };
              if (buildKey) {
                const build = buildSystem.getBuildByKey(buildKey);
                if (!build) {
                  throw new Error(
                    `Activated panel build ${buildKey} for ${source} is unavailable from the immutable build store`
                  );
                }
                if (build.metadata.kind !== "panel" || build.metadata.sourcePath !== source) {
                  throw new Error(
                    `Activated panel build ${buildKey} does not belong to panel source ${source}`
                  );
                }
                const authority = build.metadata.authority;
                const executionDigest = build.metadata.execution?.executionDigest;
                if (!authority || !executionDigest) {
                  throw new Error(
                    `Activated panel build ${buildKey} has incomplete sealed identity`
                  );
                }
                return {
                  effectiveVersion: build.metadata.ev,
                  buildKey,
                  executionDigest,
                  authorityRequests: authority.requests,
                };
              }
              const binding = await buildSystem.bindRuntimeImage(source, ref);
              return {
                effectiveVersion: binding.effectiveVersion,
                buildKey: binding.buildKey,
                executionDigest: binding.executionDigest,
                authorityRequests: binding.authorityRequests,
              };
            },
            resolveAppExecution: ({ source, ref }) => resolveBuildExecution(source, ref),
            releaseEntity: async (record, input) => {
              if (record.kind !== "do") return { status: "ready" };
              if (!record.className) {
                return {
                  status: "failed",
                  detail: { error: `Durable Object ${record.id} has no class name` },
                };
              }
              const released = await doDispatch.dispatchLifecycle(
                {
                  source: record.source.repoPath,
                  className: record.className,
                  objectKey: record.key,
                },
                "prepare",
                input
              );
              if (released.status === "ready" && input.mode === "retire") {
                await sealAndDrainDurableObjectRelays(record.id);
              }
              return released;
            },
            releaseEntityRelaySeal: releaseDurableObjectRelaySeal,
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
          revokeAgentCredentials: async (entityId) => {
            await workspaceChildHub.revokeAgentCredentialsForEntity(entityId);
            // Matches auth/model.ts agentCallerId(entityId).
            tokenManager.revokeToken(`agent:${entityId}`);
          },
        });
        return runtimeResult;
      },
      getServiceDefinition() {
        if (!runtimeResult) {
          throw new Error("runtime service not initialized");
        }
        return runtimeResult.definition;
      },
    });
  }

  // ── Product-owned System Agent conversation lifecycle ──
  // The service depends on runtime + the live relay, but selects code only from
  // the immutable shipped snapshot used to seed conduit blessings.
  {
    const { createSystemAgentService } = await import("./services/systemAgentService.js");
    let systemAgentDefinition:
      | import("@vibestudio/shared/serviceDefinition").ServiceDefinition
      | null = null;
    container.registerManaged({
      name: "systemAgent",
      dependencies: ["runtime", "rpcServer", "buildSystem"],
      async start(resolve) {
        const runtime = assertPresent(
          resolve<import("./services/runtimeService.js").RuntimeServiceResult>("runtime")
        );
        const rpcServer = assertPresent(
          resolve<{ server: import("./rpcServer.js").RpcServer }>("rpcServer")
        );
        systemAgentDefinition = createSystemAgentService({
          workspaceId,
          productSnapshotState: productSeedStateHash,
          runtime: runtime.internal,
          conduitBlessings: conduitBlessingStore,
          startMissionSession: (input) => missionRegistry.startSession(input),
          callTarget: (targetId, method, args) =>
            rpcServer.server.callTarget(targetId, method, args),
          hasAppCapability: (callerId, capability) =>
            appHostForGateway?.hasAppCapability(callerId, capability) ?? false,
        });
        return systemAgentDefinition;
      },
      getServiceDefinition() {
        if (!systemAgentDefinition) {
          throw new Error("systemAgent service not initialized");
        }
        return systemAgentDefinition;
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
    const { INTERNAL_DO_SOURCE } = await import("./internalDOs/internalDoLoader.js");
    let webhookIngress: ReturnType<typeof createWebhookIngressService> | null = null;
    container.registerManaged({
      name: "webhookIngress",
      dependencies: ["workerdWorkspace", "rpcServer", "doDispatch"],
      async start(resolve) {
        const rpcServer = assertPresent(
          resolve<{ server: import("./rpcServer.js").RpcServer }>("rpcServer")
        );
        const doDispatch = assertPresent(
          resolve<import("./doDispatch.js").DODispatch>("doDispatch")
        );
        webhookIngress = createWebhookIngressService({
          relaySigningSecret,
          relayOrigin: getRelayOrigin(),
          relayRegistrar: relayBackhaul?.client,
          // No public ingress: direct-mode webhooks only resolve co-located (loopback).
          // Remote webhooks ride the multi-tenant callback relay over the backhaul.
          directPublicBaseUrl: getLocalGatewayUrl("webhook direct base URL"),
          doDispatch,
          resolveDelegatedCaller: async (callerId) => {
            const store = getEntityStore();
            const record = store.cache.resolve(callerId) ?? (await store.resolveRecord(callerId));
            const stateArgs =
              record?.stateArgs && typeof record.stateArgs === "object"
                ? (record.stateArgs as Record<string, unknown>)
                : null;
            const ownerPrincipalId = stateArgs?.["ownerPrincipalId"];
            // Only the host-created, owner-scoped internal EvalDO delegates its
            // ergonomic runtime calls. Both the class/source and owner lineage
            // are server-authored entity state; no request value participates.
            if (
              record?.source.repoPath !== INTERNAL_DO_SOURCE ||
              record.className !== "EvalDO" ||
              typeof ownerPrincipalId !== "string" ||
              record.parentId !== ownerPrincipalId
            ) {
              return null;
            }
            const owner =
              store.cache.resolve(ownerPrincipalId) ??
              (await store.resolveRecord(ownerPrincipalId));
            if (!owner || owner.status !== "active" || !isCallerKind(owner.kind)) return null;
            return {
              callerId: owner.id,
              callerKind: owner.kind,
              repoPath: owner.source.repoPath,
            };
          },
          rpc: {
            call: (targetId, method, ...args) =>
              rpcServer.server.callTarget(targetId, method, args),
          },
          hasAppCapability: (callerId, capability) =>
            appHostForGateway?.hasAppCapability(callerId, capability) ?? false,
          dispatchToTarget: async (target, event) => {
            await rpcServer.server.callTarget(
              `do:${target.source}:${target.className}:${target.objectKey}`,
              target.method,
              [event]
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
  //   3. Generate a random one and persist it
  // The token is a LOCAL operator/machine break-glass for the diagnostic
  // `admin-token` routes and hub→child loopback plumbing — never a human
  // identity (WP9 §4 retired admin-token-as-root; root is a User). RPC auth
  // rejects it outright (rpcServer handleAuth, close 4006).
  let adminToken: string;
  let tokenSource: "env" | "persisted" | "generated" = "generated";
  if (childAdminToken) {
    adminToken = childAdminToken;
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
  // Keep the management secret out of the userland-visible serverLog surface.
  serverLogStore.addSecret(adminToken);
  let gatewayPortResolved: number | null = null;
  // Child ingress is armed exclusively by authenticated hub control requests.
  // Exact transport ownership is injected from the advertised workspace's
  // hub-owned reach tree, outside resettable semantic/runtime state.
  let webrtcPairing: Omit<
    import("@vibestudio/shared/connect").ConnectPairing,
    "code" | "room"
  > | null = null;
  let webrtcIngress: import("./webrtcIngress.js").WebRtcIngress | null = null;
  const { RoutedRoomStore, replaceRoutedRoom, routedRoomKey } =
    await import("./hostCore/routedRoomStore.js");
  const routedRoomStatePath = process.env["VIBESTUDIO_ROUTED_ROOM_STATE_PATH"];
  if (!routedRoomStatePath) {
    throw new Error("Workspace runtime requires a hub-owned routed-room state path");
  }
  const routedRoomStore = new RoutedRoomStore(routedRoomStatePath);
  for (const route of routedRoomStore.list()) {
    const key = routedRoomKey(route);
    const userId = deviceAuthStore.userFor(route.deviceId);
    const keep = !!userId && membershipStore.has(userId, entryWorkspaceId);
    if (!keep) routedRoomStore.remove(key);
  }
  const disarmRoutedRoom = async (key: string): Promise<void> => {
    const persisted = routedRoomStore.remove(key);
    if (persisted && webrtcIngress) await webrtcIngress.disarmRoom(persisted.room);
  };
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
      const { createWorkspaceCredentialRedeemer } = await import("./services/authService.js");
      const server = new RpcServer({
        tokenManager,
        dispatcher,
        workspaceId: entryWorkspaceId,
        capabilityGrantStore,
        directAuthorityAcquirer: {
          request: (input) => acquisitionCoordinator.request(input),
          acquire: (input, signal) => acquisitionCoordinator.requestAndWait(input, signal),
          consume: (grantId) => acquisitionCoordinator.consume(grantId),
          touch: (grantId) => acquisitionCoordinator.touch(grantId),
          invalidate: (snapshotDigest, ownerRuntimeId, callerPrincipal) =>
            acquisitionCoordinator.invalidate(snapshotDigest, ownerRuntimeId, callerPrincipal),
        },
        eventService,
        egressProxy,
        fsService,
        entityCache,
        executionSessionForRuntime: (runtimeId) => agentExecutionSessions.resolve(runtimeId),
        testPolicyForContext: (contextId) => agentExecutionSessions.testPolicyForContext(contextId),
        connectionGrants,
        // Resolves each authenticated caller's account subject (WP0 §5.2/§5.5).
        userSubjectSource,
        // Membership entry gate (WP2 §4): refuse a non-member of this child's
        // workspace at auth time. Undefined (no-op) in local/dev/hub mode.
        membershipGate: membershipEntryGate,
        workspaceRoleResolver,
        describeCapability,
        missionFactForSession: (sessionId) => missionRegistry.factForSession(sessionId),
        contextIntegrityFactForSession: (sessionId, caller) =>
          caller.executionSession !== undefined
            ? contextIntegrityStore.effectiveFact({
                sessionId,
                attested: contextIntegrityStore.fact(sessionId),
                conduitBlessed: conduitBlessingStore.isBlessed(caller.code),
              })
            : { class: "not-applicable", latchEpoch: 0, externalKeys: [] },
        resolveWorkspaceDirectAuthority: async ({ source, className, objectKey, method }) => {
          const { PRODUCT_WORKSPACE_SERVICES } =
            await import("@vibestudio/shared/productWorkspaceServices.mjs");
          const { productDirectMethodCapability } =
            await import("@vibestudio/shared/authority/directMethodEffects");
          const authoritiesFrom = async (
            declarations: import("@vibestudio/workspace/singletonRegistry").WorkspaceDeclarations
          ) => {
            const matches = [...declarations.services, ...PRODUCT_WORKSPACE_SERVICES].filter(
              (service) =>
                service.source === source && service.durableObject?.className === className
            );
            if (matches.length === 0) return [];
            const targetId = `do:${source}:${className}:${objectKey}`;
            const active = entityCache.resolveActive(targetId);
            const buildSystem =
              container.get<import("./buildV2/index.js").BuildSystemV2>("buildSystem");
            const build = active?.activeBuildKey
              ? buildSystem?.getBuildByKey(active.activeBuildKey)
              : null;
            const catalogMethod =
              build && "metadata" in build && build.metadata.kind === "worker"
                ? build.metadata.workspaceRpcCatalog?.find(
                    (entry) => entry.className === className && entry.name === method
                  )
                : undefined;
            const productCapability = productDirectMethodCapability(className, method);
            if (
              !catalogMethod &&
              !PRODUCT_WORKSPACE_SERVICES.some((service) => matches.includes(service))
            ) {
              throw new Error(
                `Live workspace service ${source}:${className}.${method} has no exact build-catalog declaration`
              );
            }
            const methodCapability =
              catalogMethod?.effect.kind === "semantic"
                ? catalogMethod.effect.capability
                : (productCapability ?? undefined);
            const methodEffect =
              catalogMethod?.effect ??
              (productCapability
                ? ({ kind: "semantic", capability: productCapability } as const)
                : ({ kind: "workspace-service" } as const));
            const methodTier =
              catalogMethod?.access?.tier ?? (productCapability ? "critical" : "open");
            return matches.map((service) => ({
              capability: `workspace-service:${service.name}`,
              methodEffect,
              principals: service.authority.principals,
              ...(methodCapability ? { methodCapability } : {}),
              methodTier,
              presentation: service.presentation,
              title: service.title ?? service.name,
              action: service.action,
              description: service.description,
              declaredBy: service.source,
            }));
          };

          const live = await authoritiesFrom(workspaceDecls);
          if (live.length > 0) return live;

          const targetId = `do:${source}:${className}:${objectKey}`;
          const contextId = entityCache.resolveActive(targetId)?.contextId;
          if (!contextId) return [];
          try {
            const stateHash = await workspaceVcs.resolveContextState(contextId);
            const config = await readWorkspaceConfigFromState(workspaceVcs, workspaceId, stateHash);
            return await authoritiesFrom(buildWorkspaceDeclarations(config));
          } catch {
            // Main/product DOs use host-owned context ids that are not VCS
            // contexts. They deliberately stay on the reviewed static path.
            return [];
          }
        },
        liveCallerGate,
        // RpcServer starts before workerd by design. Resolve the sealed semantic
        // control plane lazily at the first provenance-bearing ingress, then
        // prove the exact invocation node exists before any service or relay
        // can persist the asserted causal edge.
        verifyExactCausalInvocation: async (parent) => {
          const doDispatch = container.get<import("./doDispatch.js").DODispatch>("doDispatch");
          const { createSemanticControlPlaneCaller, hasExactCausalInvocation } =
            await import("./internalDOs/controlPlane.js");
          return hasExactCausalInvocation(createSemanticControlPlaneCaller(doDispatch), parent);
        },
        runtimeCoordinator: panelRuntimeCoordinator,
        // The child accepts only identities already issued by the hub: returning
        // devices and workspace-scoped agents. Fresh pairing never enters a child.
        redeemPairingCredential: createWorkspaceCredentialRedeemer({
          deviceAuthStore,
          tokenManager,
          resolveUser: (userId) => userStore.getUser(userId),
          resolveRuntimeEntity: (entityId) => getEntityStore().resolveRecord(entityId),
          touchDevice: async (deviceId) => {
            await workspaceChildHub.touchDevice(deviceId);
          },
        }),
        resolveExtensionInvocation: (extensionName, requestId) =>
          extensionHostForGateway?.resolveActiveInvocation(extensionName, requestId) ?? null,
        resolveExtensionCodeIdentity: (extensionName) =>
          extensionHostForGateway?.resolveCodeIdentity(extensionName) ?? null,
        isCodeApproved: (code) => {
          if (code.repoPath === "vibestudio/internal") return true;
          if (code.callerKind === "app" || code.callerKind === "extension") return true;
          const evalOwner = code.evalOrigin
            ? entityCache.resolveActive(code.evalOrigin.ownerId)
            : null;
          if (evalOwner?.kind === "app") return true;
          const approvedEntity = evalOwner ?? entityCache.resolveActive(code.callerId);
          if (!approvedEntity?.activeAuthority) return false;
          return unitVersionApprovalStore.has({
            repoPath: code.repoPath,
            effectiveVersion: code.effectiveVersion,
            authority: approvedEntity.activeAuthority,
          });
        },
      });
      server.initHandlers();
      rpcServerForGateway = server;
      return { server };
    },
    async stop(instance: { server: import("./rpcServer.js").RpcServer }) {
      await instance?.server?.stop();
    },
  });
  {
    const { createPhoneProvisioningProxyService } =
      await import("./services/phoneProvisioningService.js");
    container.registerRpc(
      createPhoneProvisioningProxyService({
        getUserConnections: (userId) =>
          assertPresent(rpcServerForGateway).getUserConnections(userId),
        getClientBridge: (callerId) => assertPresent(rpcServerForGateway).getClientBridge(callerId),
      })
    );
  }

  // Revocation invalidates identity immediately, while RpcServer keeps only an
  // already-running request alive long enough to queue its response. Routed
  // reach can then be removed at that exact transport retirement boundary.
  const retireWorkspaceReach = (
    callerIds: readonly string[],
    routeKeys: readonly string[]
  ): Promise<void> =>
    retireRoutedReach(
      {
        tokenManager,
        rpcServer: assertPresent(rpcServerForGateway),
        disarmRoute: disarmRoutedRoom,
      },
      callerIds,
      routeKeys
    );
  const observeReachRetirement = (retirement: Promise<void>): void => {
    void retirement.catch((error) => {
      console.error("[Sessions] Routed reach retirement failed:", error);
    });
  };
  routeRegistry.registerHttpServiceRoutes([
    {
      serviceName: "revocation",
      path: "/cleanup-user",
      methods: ["POST"],
      auth: "admin-token",
      handler: async (req, res) => {
        const respond = (status: number, payload: unknown): void => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        let input: import("@vibestudio/identity/revocationCleanup").RevokedUserCleanupRequest;
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = chunks.length
            ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>)
            : {};
          const { RevokedUserCleanupRequestSchema } =
            await import("@vibestudio/identity/revocationCleanup");
          input = RevokedUserCleanupRequestSchema.parse(body);
        } catch (error) {
          respond(400, {
            error: error instanceof Error ? error.message : String(error),
            code: "BAD_REQUEST",
          });
          return;
        }
        if (!rpcServerForGateway) {
          respond(503, { error: "RPC server not started", code: "NOT_READY" });
          return;
        }
        const { userId } = input;
        const connections = rpcServerForGateway.getUserConnections(userId);

        const { retireRevokedUserDeputies } = await import("./services/authService.js");
        const { retired } = await retireRevokedUserDeputies(
          {
            listActiveEntities: () => entityCache.listActive(),
            retireEntity: async (id) => {
              await dispatcher.dispatch(
                { caller: createHostCaller("server") },
                "runtime",
                "retireEntity",
                [{ id, removeContext: true }]
              );
            },
          },
          userId
        );
        const archived = (await dispatcher.dispatch(
          { caller: createHostCaller("server") },
          "panelTree",
          "archiveOwnedRoots",
          [userId]
        )) as { archivedRootIds: string[]; closedIds: string[] };

        const gad = resolveWorkspaceService(workspaceDecls, "vibestudio.gad.workspace.v1");
        if (gad.kind !== "durable-object") {
          throw new Error("Workspace GAD service is not a durable object");
        }
        const gadRef = {
          source: gad.source,
          className: gad.className,
          objectKey: gad.objectKey,
        };
        const doDispatch = container.get<import("./doDispatch.js").DODispatch>("doDispatch");
        const channelPlan = (await doDispatch.dispatch(gadRef, "listChannelMembershipsForUser", {
          userId,
        })) as import("@vibestudio/shared/channelInvites").ChannelMembershipCleanupPlan;
        for (const channelId of channelPlan.channelIds) {
          const channel = resolveWorkspaceService(
            workspaceDecls,
            "vibestudio.channel.v1",
            channelId
          );
          if (channel.kind !== "durable-object") {
            throw new Error(`Channel ${channelId} is not a durable object`);
          }
          await doDispatch.dispatch(
            {
              source: channel.source,
              className: channel.className,
              objectKey: channel.objectKey,
            },
            "removeMember",
            { userId }
          );
        }
        await doDispatch.dispatch(gadRef, "purgeRevokedUserChannelIndexes", { userId });
        if (!pushForRevocation) throw new Error("Push service is not started");
        const removedPushRegistrations = pushForRevocation.unregisterUser(userId);

        const routeKeys = routedRoomStore
          .list()
          .filter((route) => identityDb.getDevice(route.deviceId)?.userId === userId)
          .map(routedRoomKey);
        const { RevokedUserCleanupResultSchema } =
          await import("@vibestudio/identity/revocationCleanup");
        respond(
          200,
          RevokedUserCleanupResultSchema.parse({
            userId,
            closedSessions: connections.length,
            retiredDeputyIds: retired,
            archivedRootIds: archived.archivedRootIds,
            archivedPanelIds: archived.closedIds,
            removedChannelIds: channelPlan.channelIds,
            removedPushRegistrations,
          })
        );
        observeReachRetirement(
          retireWorkspaceReach(
            connections.map((connection) => connection.caller.runtime.id),
            routeKeys
          )
        );
      },
    },
  ]);

  routeRegistry.registerHttpServiceRoutes([
    {
      serviceName: "internal",
      path: "/route",
      methods: ["POST"],
      auth: "admin-token",
      handler: async (req, res) => {
        const respond = (status: number, payload: unknown): void => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const decoded = chunks.length
            ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown)
            : {};
          if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
            respond(400, { error: "Route request must be a JSON object" });
            return;
          }
          const body = decoded as Record<string, unknown>;
          const deviceId = typeof body["deviceId"] === "string" ? body["deviceId"] : undefined;
          if (!deviceId) {
            respond(400, { error: "deviceId is required" });
            return;
          }
          const actualKeys = Object.keys(body).sort().join(",");
          if (actualKeys !== "deviceId") {
            respond(400, { error: "Route request fields must be exactly: deviceId" });
            return;
          }
          const owner = deviceAuthStore.userFor(deviceId);
          if (!owner || !membershipStore.has(owner, entryWorkspaceId)) {
            respond(403, { error: "Device owner is not a workspace member", code: "EACCES" });
            return;
          }
          if (!webrtcIngress || !webrtcPairing) {
            respond(503, { error: "Workspace WebRTC ingress is not ready", code: "NOT_READY" });
            return;
          }
          const key = `device:${deviceId}`;
          const existing = routedRoomStore.get(key);
          if (existing) {
            await webrtcIngress.armRoom(existing.room, { deviceId: existing.deviceId });
            respond(200, { room: existing.room, ...webrtcPairing });
            return;
          }
          const room = randomUUID();
          const route: import("./hostCore/routedRoomStore.js").RoutedRoomRecord = {
            kind: "device",
            deviceId,
            room,
          };
          await replaceRoutedRoom(routedRoomStore, route, webrtcIngress);
          respond(200, { room, ...webrtcPairing });
        } catch (error) {
          respond(400, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      serviceName: "sessions",
      path: "/close-device",
      methods: ["POST"],
      auth: "admin-token",
      handler: async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = chunks.length
          ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>)
          : {};
        const deviceId = typeof body["deviceId"] === "string" ? body["deviceId"] : "";
        if (!deviceId || !rpcServerForGateway) {
          res.writeHead(deviceId ? 503 : 400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ error: deviceId ? "RPC server not started" : "deviceId is required" })
          );
          return;
        }
        const callerId = `shell:${deviceId}`;
        const connections = rpcServerForGateway.getPrincipalConnections(callerId);
        const retirement = retireWorkspaceReach([callerId], [`device:${deviceId}`]);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ closed: connections.length }));
        observeReachRetirement(retirement);
      },
    },
    {
      serviceName: "sessions",
      path: "/close-user",
      methods: ["POST"],
      auth: "admin-token",
      handler: async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = chunks.length
          ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>)
          : {};
        const userId = typeof body["userId"] === "string" ? body["userId"] : "";
        const validUserId = /^usr_[A-Za-z0-9_-]{24}$/.test(userId);
        if (!validUserId || !rpcServerForGateway) {
          res.writeHead(validUserId ? 503 : 400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: validUserId ? "RPC server not started" : "A canonical userId is required",
            })
          );
          return;
        }
        const connections = rpcServerForGateway.getUserConnections(userId);
        const routeKeys = routedRoomStore
          .list()
          .filter((route) => identityDb.getDevice(route.deviceId)?.userId === userId)
          .map(routedRoomKey);
        const retirement = retireWorkspaceReach(
          connections.map((connection) => connection.caller.runtime.id),
          routeKeys
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ closed: connections.length }));
        observeReachRetirement(retirement);
      },
    },
  ]);

  {
    // Workspace USER presence (WP8 §4): a host surface built purely from the
    // connection registry + each caller's verified subject.userId — zero channel
    // coupling (INV-1). Keyed on the logical user (phone+laptop = one present
    // user), human runtime kinds only, identity resolved live off the shared
    // identity DB. Emits `workspace-presence-changed` on connect/drop.
    const { createWorkspacePresenceService } =
      await import("./services/workspacePresenceService.js");
    let workspacePresence:
      | import("./services/workspacePresenceService.js").WorkspacePresenceService
      | null = null;
    let presenceReportRevision = 0;
    let presenceReportQueue: Promise<void> = Promise.resolve();
    const reportOnlinePresence = (users: Array<{ userId: string; endpoints: number }>): void => {
      const revision = ++presenceReportRevision;
      // Serialize snapshots so a slow request cannot overwrite a newer one at
      // the hub. The hub also rejects stale revisions defensively.
      presenceReportQueue = presenceReportQueue
        .then(async () => {
          await workspaceChildHub.reportPresence({ serverBootId, revision, users });
        })
        .catch((error) => {
          console.warn(`[WorkspacePresence] Failed to report revision ${revision} to hub:`, error);
        });
    };
    container.registerManaged({
      name: "workspacePresence",
      dependencies: ["rpcServer"],
      async start(resolve) {
        const rpc = assertPresent(
          resolve<{ server: import("./rpcServer.js").RpcServer }>("rpcServer")
        );
        workspacePresence = createWorkspacePresenceService({
          connectionRegistry: rpc.server,
          identityDb,
          eventService,
          onOnlineChanged: reportOnlinePresence,
        });
      },
      async stop() {
        workspacePresence?.dispose();
      },
      getServiceDefinition() {
        if (!workspacePresence) throw new Error("workspacePresence service not initialized");
        return workspacePresence.definition;
      },
    });
  }
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
        workspaceId,
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
        readWorkspaceFileAtState,
        describeCapability,
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
          call(name, method, args, options) {
            const rpcServer = rpcServerForGateway;
            if (!rpcServer) throw new Error("RPC server is not initialized");
            return rpcServer.callTarget(name, method, args, options);
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
        workspaceId,
        buildSystem: buildSystemInst,
        eventService,
        approvalQueue,
        approvalCoordinator: unitApprovalCoordinator,
        notificationService: notificationResult.internal,
        entityCache,
        connectionGrants,
        readWorkspaceFileAtState,
        describeCapability,
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
  // Server-dispatched semantic control-plane objects activate explicitly.
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
    if (active?.activeBuildKey && active.activeExecutionDigest && active.activeAuthority) {
      if (ref.contextId && active.contextId !== ref.contextId) {
        throw new Error(
          `Durable Object ${targetId} is already active in context ${active.contextId}; cannot resolve it from context ${ref.contextId}`
        );
      }
      await workerdManagerInst.restoreDurableObjectEntity(active);
      return;
    }
    const { INTERNAL_DO_SOURCE } = await import("./internalDOs/internalDoLoader.js");
    const workspaceDORef: import("@vibestudio/shared/doDispatcher").DORef = {
      source: INTERNAL_DO_SOURCE,
      className: "WorkspaceDO",
      objectKey: workspaceId,
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
      if (existing.activeBuildKey && existing.activeExecutionDigest && existing.activeAuthority) {
        entityCache._onActivate(existing);
        return;
      }
    }
    const contextId =
      ref.contextId ??
      existing?.contextId ??
      createHash("sha256")
        .update(`${workspaceId}\x00${source}\x00${className}\x00${objectKey}`)
        .digest("hex");
    const prepared = await workerdManagerInst.ensureDurableObjectEntity({
      source,
      className,
      key: objectKey,
      contextId,
      ref: buildRef,
    });
    const record = (await doDispatch.dispatch(
      workspaceDORef,
      "entityActivate",
      declaredWorkspaceServiceActivationInput(
        { source, className, key: objectKey, contextId },
        prepared,
        existing,
        SYSTEM_SUBJECT.userId
      )
    )) as EntityRecord;
    entityCache._onActivate(record);
  };

  {
    let workerServiceDef: import("@vibestudio/shared/serviceDefinition").ServiceDefinition;
    container.registerManaged({
      name: "workersRpc",
      dependencies: ["workerdWorkspace", "buildSystem", "workerdManager", "doDispatch"],
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
          workspaceId,
          getCallerContextId: (callerId) => entityCache.resolveContext(callerId),
          loadContextDeclarations: async (contextId) => {
            const stateHash = await workspaceVcs.resolveContextState(contextId);
            const config = await readWorkspaceConfigFromState(workspaceVcs, workspaceId, stateHash);
            return buildWorkspaceDeclarations(config);
          },
          assertUserlandServiceExposure: (ctx, service) => {
            const sessionId = ctx.caller.agentBinding?.channelId ?? ctx.caller.runtime.id;
            missionRegistry.assertUserlandServiceExposure({ sessionId, ...service });
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
    const { isWritableVcsPath } = await import("./vcsHost/paths.js");
    type FsCausalParent = import("@vibestudio/rpc").RpcCausalParent | null;
    type FsMutationIntegrity = import("@vibestudio/shared/fsService").FsVcsMutationIntegrity;
    const callSemantic = <T>(
      method: string,
      input: unknown,
      causalParent?: FsCausalParent,
      contextIntegrity?: FsMutationIntegrity
    ) =>
      causalParent === undefined
        ? workspaceVcs.semanticDirectCall<T>(method, input)
        : workspaceVcs.semanticCausalCall<T>(
            method,
            input,
            causalParent,
            assertPresent(contextIntegrity)
          );
    const vcsBridge: import("@vibestudio/shared/fsService").FsVcsBridge = {
      isTracked: async (relPath) => isWritableVcsPath(relPath),
      edit: (input, causalParent, integrity) =>
        callSemantic("vcsEdit", input, causalParent, integrity),
      move: (input, causalParent, integrity) =>
        callSemantic("vcsMove", input, causalParent, integrity),
      copy: (input, causalParent, integrity) =>
        callSemantic("vcsCopy", input, causalParent, integrity),
      status: (input) => callSemantic("vcsStatus", input),
      inspect: (input) => callSemantic("vcsInspect", input),
      neighbors: (input) => callSemantic("vcsNeighbors", input),
      readFile: (input) => callSemantic("vcsReadFile", input),
      listFiles: (input) => callSemantic("vcsListFiles", input),
      ensureMaterialized: (contextId, repos) =>
        workspaceVcs.materializeContextRepos(contextId, repos),
      isMaterialized: (contextId, repoPath) =>
        workspaceVcs.isContextRepoMaterialized(contextId, repoPath),
    };
    container.registerManaged({
      name: "fsService",
      async start() {
        return new FsService(contextFolderManager, entityCache, {
          contextAuthority: { kind: "semantic", bridge: vcsBridge },
          recordContextIngestion,
          recordContextIngestionBatch,
        });
      },
    });
  }

  const { wireWorkerdCore } = await import("./bootstrap/workerd.js");
  const { resolveLiveExecutionCaller } = await import(
    "./services/liveExecutionCaller.js"
  );
  wireWorkerdCore({
    container,
    tokenManager,
    workspacePath,
    statePath,
    workspaceId,
    workspaceDeclarations: workspaceDecls,
    routeRegistry,
    egressProxy,
    gatewayToken: workerdGatewayToken,
    gateway: {
      getPort: () => gatewayPortResolved,
      protocol: configuredProtocol,
      externalHost: hostConfig.externalHost,
      configuredAliases: process.env["VIBESTUDIO_GATEWAY_ALIASES"],
    },
    getInternalDoEnv: internalDoProviderEnv,
    runtimeDiagnostics,
    eventService,
    resolveEgressCaller: (registered) => {
      const activeEntity = entityCache.resolveActive(registered.runtime.id);
      return resolveLiveExecutionCaller({
        registered,
        activeEntity,
        executionSession: agentExecutionSessions.resolve(registered.runtime.id),
        contextTestPolicy: activeEntity
          ? agentExecutionSessions.testPolicyForContext(activeEntity.contextId)
          : null,
      });
    },
    onManagerStarted: (manager) => {
      workerdManagerForGateway = manager;
    },
  });

  const { wireVcsDurability } = await import("./bootstrap/vcsDurability.js");
  wireVcsDurability({
    container,
    workspaceVcs,
    registerControlPlanePrincipal: ({
      targetId,
      source,
      className,
      objectKey,
      effectiveVersion,
      buildKey,
      executionDigest,
      authorityRequests,
    }) => {
      entityCache.registerControlPlane({
        id: targetId,
        source: { repoPath: source, effectiveVersion },
        activeBuildKey: buildKey,
        activeExecutionDigest: executionDigest,
        activeAuthority: {
          requests: authorityRequests,
        },
        contextId: `control-plane:${workspaceId}`,
        className,
        key: objectKey,
      });
    },
    activateSemanticWorkspace: async (vcs) => {
      const activationStartedAt = performance.now();
      let spanStartedAt = performance.now();
      const recovered = await vcs.recoverPendingSemanticEffects();
      if (recovered > 0) console.log(`[Vcs] Recovered ${recovered} pending semantic host effects`);
      const recoverPendingSemanticEffectsMs = performance.now() - spanStartedAt;
      const activated = await vcs.activateWorkspaceFromSource();
      if (activated.initialized) productSeedStateHash = activated.stateHash;
      contextIntegrityStore.ensureCutover(activated.stateHash);
      spanStartedAt = performance.now();
      const config = await readWorkspaceConfigFromState(vcs, workspaceId, activated.stateHash);
      const configReadMs = performance.now() - spanStartedAt;
      spanStartedAt = performance.now();
      applyWorkspaceConfigReload(config, { warnRestartBoundChanges: false });
      const configReloadMs = performance.now() - spanStartedAt;
      warnMissingWorkspaceTrust();
      console.log("[Vcs] semantic activation report", {
        recoverPendingSemanticEffectsMs,
        ...activated.timings,
        configReadMs,
        configReloadMs,
        lifecycleTotalMs: performance.now() - activationStartedAt,
      });
      console.log(
        `[WorkspaceConfig] ${activated.initialized ? "Initialized" : "Loaded"} semantic main ${activated.stateHash}`
      );
    },
  });

  {
    container.registerManaged({
      name: "lifecycleDriver",
      dependencies: ["workerdWorkspace", "workerdManager", "doDispatch"],
      async start(resolve) {
        const { LifecycleDriver } = await import("./services/lifecycleDriver.js");
        const driver = new LifecycleDriver({
          workerdManager: assertPresent(
            resolve<import("./workerdManager.js").WorkerdManager>("workerdManager")
          ),
          doDispatch: assertPresent(resolve<import("./doDispatch.js").DODispatch>("doDispatch")),
          workspaceId,
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
      name: "alarmDriver",
      dependencies: ["workerdWorkspace", "doDispatch"],
      async start(resolve) {
        const { AlarmDriver } = await import("./services/alarmDriver.js");
        const driver = new AlarmDriver({
          doDispatch: assertPresent(resolve<import("./doDispatch.js").DODispatch>("doDispatch")),
          workspaceId,
        });
        alarmDriverInstance = driver;
        return driver;
      },
      async stop(instance: import("./services/alarmDriver.js").AlarmDriver | null) {
        await instance?.quiesce();
        alarmDriverInstance = null;
      },
    });
  }

  {
    container.registerManaged({
      name: "recurringRegistry",
      dependencies: ["workerdWorkspace", "doDispatch"],
      async start(resolve) {
        const { RecurringRegistry } = await import("./services/recurringRegistry.js");
        const registry = new RecurringRegistry({
          doDispatch: assertPresent(resolve<import("./doDispatch.js").DODispatch>("doDispatch")),
          workspaceId,
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
      dependencies: ["workerdWorkspace", "doDispatch"],
      async start(resolve) {
        const { HeartbeatDeclarationRegistry } = await import("./services/recurringRegistry.js");
        const registry = new HeartbeatDeclarationRegistry({
          doDispatch: assertPresent(resolve<import("./doDispatch.js").DODispatch>("doDispatch")),
          workspaceId,
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
    activeWorkspaceName: advertisedWorkspaceName ?? workspaceName,
    workspacePath,
    workspaceConfig,
    getWorkspaceConfig: () => workspaceConfig,
    persistWorkspaceConfigField: async (
      ctx: import("@vibestudio/shared/serviceDispatcher").ServiceContext,
      key: string,
      value: unknown
    ) => {
      const result = await workspaceConfigWriter.applyMutation({
        ctx,
        mutate: (current) => ({ ...current, [key]: value }),
        summary: `update workspace config field ${key}`,
      });
      replaceLiveWorkspaceConfig(result.nextConfig);
    },
    treeScanner,
    adminToken,
    args,
    hostConfig,
    tokenManager,
    grantStore: capabilityGrantStore,
    recordContextIngestion,
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
      const graphNodes = buildSystem?.getGraph().allNodes() ?? [];
      const authorityRowsFor = (node: (typeof graphNodes)[number] | undefined) =>
        summarizeAuthorityRequests(node?.manifest.authority?.requests ?? [], [], describeCapability)
          .rows;
      type WorkspaceUnitStatus = import("./services/workspaceService.js").WorkspaceUnitStatus;
      const trustedRows: WorkspaceUnitStatus[] = trustedUnitHosts()
        .flatMap((host) => host.listWorkspaceUnits() as WorkspaceUnitStatus[])
        .map((row) => {
          const node = graphNodes.find((candidate) => candidate.relativePath === row.source);
          return {
            ...row,
            isAgent: Boolean(node?.manifest.agent),
            authorityRows: authorityRowsFor(node),
          };
        });
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
      for (const node of graphNodes) {
        if (node.kind !== "panel" && node.kind !== "worker" && node.kind !== "extension") continue;
        if (node.kind === "extension") {
          rows.push(
            trustedRowsBySource.get(node.relativePath) ?? {
              name: node.name,
              kind: "extension",
              isAgent: false,
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
              authorityRows: authorityRowsFor(node),
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
          isAgent: Boolean(node.manifest.agent),
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
          authorityRows: authorityRowsFor(node),
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
        await appHost.terminal.restart(name);
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
          workspaceId: entry.workspaceId ?? workspaceId,
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
          workspaceId: entry.workspaceId ?? workspaceId,
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
        workspaceId: entry.workspaceId ?? workspaceId,
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
        { source: INTERNAL_DO_SOURCE, className: "WorkspaceDO", objectKey: workspaceId },
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
        { source: INTERNAL_DO_SOURCE, className: "WorkspaceDO", objectKey: workspaceId },
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
        { source: INTERNAL_DO_SOURCE, className: "WorkspaceDO", objectKey: workspaceId },
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
        { source: INTERNAL_DO_SOURCE, className: "WorkspaceDO", objectKey: workspaceId },
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
    const { panelRuntimeSurface } =
      await import("@vibestudio/service-schemas/runtime/runtimeSurface.panel");
    const { workerRuntimeSurface } =
      await import("@vibestudio/service-schemas/runtime/runtimeSurface.worker");
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
        workspaceServicesForCaller: async (ctx) => {
          const contextId = entityCache.resolveContext(ctx.caller.runtime.id);
          const services = contextId
            ? buildWorkspaceDeclarations(
                await readWorkspaceConfigFromState(
                  workspaceVcs,
                  workspaceId,
                  await workspaceVcs.resolveContextState(contextId)
                )
              ).services
            : workspaceDecls.services;
          const buildSystem =
            container.get<import("./buildV2/index.js").BuildSystemV2>("buildSystem");
          if (!buildSystem)
            throw new Error("Build system is unavailable for workspace service docs");
          const builds = new Map<string, Promise<import("./buildV2/buildStore.js").BuildResult>>();
          const buildFor = (source: string) => {
            let pending = builds.get(source);
            if (!pending) {
              pending = buildSystem
                .getBuild(source, contextId ? `ctx:${contextId}` : undefined)
                .then((result) => {
                  if (!("metadata" in result) || result.metadata.kind !== "worker") {
                    throw new Error(`Workspace service provider ${source} is not a worker build`);
                  }
                  return result;
                });
              builds.set(source, pending);
            }
            return pending;
          };
          return Promise.all(
            services.map(async (declaration) => {
              try {
                const build = await buildFor(declaration.source);
                const methods = declaration.durableObject
                  ? (build.metadata.workspaceRpcCatalog ?? []).filter(
                      (method) => method.className === declaration.durableObject?.className
                    )
                  : [];
                return {
                  declaration,
                  providerEffectiveVersion: build.metadata.ev,
                  methods,
                };
              } catch (error) {
                // Live API discovery is also the repair surface. One provider
                // that is invalid in the caller's in-progress context must not
                // make host/runtime docs or other workspace services
                // undiscoverable. Keep its declaration visible, mark it
                // unavailable, and leave the authoritative build diagnostic in
                // the build system rather than inventing a stale method roster.
                return {
                  declaration,
                  providerBuildError: error instanceof Error ? error.message : String(error),
                  methods: [],
                };
              }
            })
          );
        },
      })
    );
  }

  {
    // Settings service for trusted remote hosts and mobile workspace apps.
    const { createSettingsService } = await import("./services/settingsService.js");
    container.registerRpc(createSettingsService());
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

  // Static WebRTC reach material (fp/sig/ice — no room) is populated after
  // the ingress starts. The hub combines it with each ephemeral routed room;
  // identity rows and the child auth service never own transport coordinates.

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
          roleOf: (userId) => userStore.getUser(userId)?.role ?? null,
          agentCredentialWriter: {
            mint: async (input) => {
              return workspaceChildHub.mintAgentCredential(input);
            },
            revoke: async (agentId) => {
              return workspaceChildHub.revokeAgentCredential(agentId);
            },
          },
          getServerBootId: () => serverBootId,
          getWorkspaceId: () => workspaceId,
          getConnectionInfo: () => {
            const gatewayPort = getResolvedGatewayPort("auth connection info");
            const protocol = gatewayProtocol();
            const hubUrl = process.env["VIBESTUDIO_HUB_URL"];
            return {
              serverUrl: hubUrl ?? getExternalGatewayUrl("auth connection info"),
              protocol,
              externalHost: hostConfig.externalHost,
              gatewayPort,
            };
          },
          connectionGrants,
          auditLog,
          hasAppCapability: (callerId, capability) =>
            appHostForGateway?.hasAppCapability(callerId, capability) ?? false,
          ensureMobileAppReady: (source) =>
            hostTargetLaunchCoordinator.ensureMobileHostReadyForPairing(source),
          getMobileAppBootstrap: async (source) =>
            appHostForGateway?.reactNative.getBootstrap(source) ?? null,
          registerMobileAppPrincipal: (deviceId, source) =>
            appHostForGateway?.reactNative.registerPrincipal(deviceId, source) ?? null,
          retireMobileAppPrincipal: (deviceId) => {
            appHostForGateway?.reactNative.retirePrincipal(deviceId);
          },
          resolveRuntimeEntity: (id) => getEntityStore().resolveRecord(id),
        }),
        routeRegistry
      )
    );

    const blobsDir = layout.blobsDir;
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
        workspaceId,
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
      dependencies: ["workerdWorkspace", "workerdManager", "panelHttpServer"],
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
  // The child presents a persistent DTLS certificate (stable `fp`) and starts
  // with no rooms. Authenticated hub routing arms ephemeral answerer pipes.
  const { resolveSignalingUrl } = await import("@vibestudio/shared/connect");
  const webrtcSignalUrl = resolveSignalingUrl({ env: process.env }).url;
  if (rpcServerForGateway) {
    try {
      const { startWebRtcIngress } = await import("./webrtcIngress.js");
      const { ensurePersistentCert } = await import("../node/webrtc/cert.js");
      const { assertNodeDatachannelAvailable } =
        await import("../node/webrtc/nodeDatachannelPeer.js");
      assertNodeDatachannelAvailable();
      const identityPemFile = process.env["VIBESTUDIO_WEBRTC_IDENTITY"];
      if (!identityPemFile) {
        throw new Error("Workspace runtime requires a hub-owned WebRTC identity path");
      }
      const cert = ensurePersistentCert({
        identityPemFile,
      });
      const iceTransportPolicy: import("@vibestudio/shared/connect").TurnPolicy =
        process.env["VIBESTUDIO_WEBRTC_ICE"] === "relay" ? "relay" : "all";
      const serverIceTransportPolicy: import("@vibestudio/shared/connect").TurnPolicy =
        process.env["VIBESTUDIO_WEBRTC_SERVER_ICE"] === "relay"
          ? "relay"
          : process.env["VIBESTUDIO_WEBRTC_SERVER_ICE"] === "all"
            ? "all"
            : iceTransportPolicy;
      const ingress = startWebRtcIngress({
        rpcServer: rpcServerForGateway,
        signalUrl: webrtcSignalUrl,
        certificatePemFile: cert.certificatePemFile,
        keyPemFile: cert.keyPemFile,
        iceTransportPolicy: serverIceTransportPolicy,
      });
      webrtcIngress = ingress;
      for (const route of routedRoomStore.list()) {
        await ingress.armRoom(route.room, { deviceId: route.deviceId });
      }
      // Expose static reach material to the hub through the ready file and the
      // authenticated internal routing endpoint. Device ownership is durable;
      // the ingress pipe is reconstructed from that route after restart.
      webrtcPairing = {
        fp: cert.fingerprint,
        sig: webrtcSignalUrl,
        v: (await import("@vibestudio/shared/connect")).PAIRING_PROTOCOL_VERSION,
        ice: iceTransportPolicy,
      };
    } catch (error) {
      throw new Error(
        `[webrtc-ingress] failed to start; refusing loopback-only startup: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

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
  rpcServerInstance.setWorkerInstanceResolver((targetId) =>
    workerdManager.resolveWorkerInstanceName(targetId)
  );
  const { authorizeVerifiedCaller, callerMatchesMissionHarness } =
    await import("./services/authorityRuntime.js");
  dispatcher.setAuthorityResolver(
    ({ ctx, caller, service, method, capability, resourceKey, tier }) => {
      const sessionId = caller.agentBinding?.channelId ?? caller.runtime.id;
      const sessionOrigin = caller.executionSession !== undefined;
      const mission = missionRegistry.factForSession(sessionId);
      let missionChangeRequired = false;
      try {
        missionRegistry.assertServiceExposure(sessionId, `${service}.${method}`);
      } catch (error) {
        if (
          mission &&
          error instanceof Error &&
          (error as NodeJS.ErrnoException).code === "EMISSIONSCOPE"
        ) {
          missionChangeRequired = true;
        } else {
          throw error;
        }
      }
      const conduitBlessed = Boolean(
        caller.code?.executionDigest &&
        conduitBlessingStore.isBlessed(caller.code) &&
        caller.executionSession &&
        caller.executionSession.harness.principal ===
          `code:${caller.code.repoPath}@${caller.code.executionDigest}` &&
        (!mission || callerMatchesMissionHarness(caller, mission))
      );
      return {
        ...authorizeVerifiedCaller(caller, {
          workspaceId,
          workspaceMember: caller.hostOriginated === true || membershipEntryGate(caller.subject),
          workspaceRole: workspaceRoleResolver(caller.subject),
          sessionId,
          audience: `service:${service}`,
          capability,
          resourceKey,
          tier,
          mission,
          contextIntegrity:
            sessionOrigin && caller.agentBinding
              ? contextIntegrityStore.effectiveFact({
                  sessionId,
                  attested: ctx.authorization?.contextIntegrity,
                  conduitBlessed,
                })
              : { class: "not-applicable", latchEpoch: 0, externalKeys: [] },
          grantCode: caller.codeApproved === true,
          grantStore: capabilityGrantStore,
        }),
        ...(missionChangeRequired ? { missionChangeRequired: true } : {}),
      };
    }
  );
  dispatcher.markInitialized();

  // ===========================================================================
  // WorkspaceDO bootstrap reconciliation
  // (see plan §6 singleton reconciliation, §9 restart revival, §11 GC safety)
  // ===========================================================================
  const doDispatchForBootstrap = container.get<import("./doDispatch.js").DODispatch>("doDispatch");
  const workspaceDORefForBootstrap: import("@vibestudio/shared/doDispatcher").DORef = {
    source: (await import("./internalDOs/internalDoLoader.js")).INTERNAL_DO_SOURCE,
    className: "WorkspaceDO",
    objectKey: workspaceId,
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
    restoreRuntimes: async (records) => {
      const manager = container.get<import("./workerdManager.js").WorkerdManager>("workerdManager");
      type RuntimeTarget = { source: string; className: string; objectKey: string };
      const [lifecycle, alarms, recurring, heartbeats] = await Promise.all([
        dispatchWorkspaceDO<RuntimeTarget[]>("lifecycleListResumeTargets"),
        dispatchWorkspaceDO<Array<RuntimeTarget & { wakeAt: number }>>(
          "alarmListDue",
          Number.MAX_SAFE_INTEGER
        ),
        dispatchWorkspaceDO<RuntimeTarget[]>("recurringList"),
        dispatchWorkspaceDO<RuntimeTarget[]>("heartbeatList"),
      ]);
      const required = new Set(
        [...lifecycle, ...alarms, ...recurring, ...heartbeats].map(
          (target) => `${target.source}\0${target.className}\0${target.objectKey}`
        )
      );
      const activeKeys = new Set(
        records
          .filter((record) => record.kind === "do" && record.className)
          .map((record) => `${record.source.repoPath}\0${record.className}\0${record.key}`)
      );
      const missing = [...required].filter((key) => !activeKeys.has(key));
      if (missing.length > 0) {
        throw new Error(
          `Persisted runtime work targets ${missing.length} unknown Durable Object incarnation(s)`
        );
      }
      const durable = records.filter(
        (record) =>
          record.kind === "do" &&
          record.className &&
          required.has(`${record.source.repoPath}\0${record.className}\0${record.key}`)
      );
      await Promise.all(durable.map((record) => manager.restoreDurableObjectEntity(record)));
    },
    recoverLifecycle: () => lifecycleDriver.recoverStartup("server_restart"),
    logger: { warn: (msg, ...args) => console.warn(msg, ...args) },
  });
  // Runtime creation primes new panel entities. Replaying active panels after
  // durable hydration gives restored trees the same lazy dependency behavior
  // without treating manifest initPanels as a build-time special case.
  for (const record of entityCache.listActive()) {
    if (record.kind === "panel") void primePanelRuntimeImage(record.source.repoPath);
  }
  // Admit server-driven alarms only after every persisted runtime incarnation
  // has reproduced its exact sealed class image and lifecycle recovery has run.
  try {
    container.get<import("./services/alarmDriver.js").AlarmDriver>("alarmDriver").start();
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
  // Preparing an image may restart workerd, so all preparations complete
  // before any activation request is admitted.
  const { reconcileSingletons, singletonEntityActivationInput } =
    await import("./bootstrap/singletonReconciliation.js");
  const singletonPlans = workspaceDecls.singletons.all().map((decl) => ({
    decl,
    contextId:
      decl.contextId ??
      createHash("sha256")
        .update(`${workspaceId}\x00${decl.source}\x00${decl.className}\x00${decl.key}`)
        .digest("hex"),
  }));
  await reconcileSingletons({
    items: singletonPlans,
    prepare: ({ decl, contextId }) =>
      workerdManager.ensureDurableObjectEntity({
        source: decl.source,
        className: decl.className,
        key: decl.key,
        contextId,
        ref: decl.contextId ? undefined : "main",
      }),
    activate: async ({ decl, contextId }, prepared) => {
      const activation = singletonEntityActivationInput(
        {
          source: decl.source,
          className: decl.className,
          key: decl.key,
          contextId,
        },
        prepared,
        SYSTEM_SUBJECT.userId
      );
      const existing = await dispatchWorkspaceDO<EntityRecord | null>(
        "entityResolve",
        prepared.targetId
      );
      return dispatchWorkspaceDO<EntityRecord>(
        existing ? "entityAdvanceExecution" : "entityActivate",
        activation
      );
    },
    onActivated: (record) => entityCache._onActivate(record),
  });

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
      const runtimeApproval = await buildUnitChangeApprovalProvider.startupApproval();
      if (runtimeApproval.units.length > 0) {
        void unitApprovalCoordinator
          .enqueue({
            entries: runtimeApproval.units,
            trigger: "startup",
            applyApproved: async () => {
              buildUnitChangeApprovalProvider.acceptPreapprovedTrust(runtimeApproval.identityKeys);
            },
            applyDenied: () => undefined,
          })
          .catch((err: unknown) =>
            console.warn("[Units] Failed to apply runtime unit approval:", err)
          );
      }
      finishRuntimeUnitApprovalStaging();
      void unitApprovalCoordinator
        .publishPending("startup")
        .catch((err: unknown) => console.warn("[Units] Failed to publish startup approvals:", err));
    } finally {
      finishRuntimeUnitApprovalStaging();
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
    .then(
      () => startupNonCriticalUnitReconcile,
      () => startupNonCriticalUnitReconcile
    )
    .finally(() => releaseStartupBackgroundWork());
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
    await startupUnitDeclarationsStaged();
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
    const tokenFilePath = layout.adminTokenFile;
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
    if (args.readyFile) {
      const readyPayload = {
        workspaceName,
        workspaceId,
        workspaceDir: workspacePath,
        isEphemeral: workspaceIsEphemeral,
        gatewayUrl: `${proto}://${hostConfig.externalHost}:${gatewayPort}`,
        rpcUrl: `${wsProto}://${hostConfig.externalHost}:${gatewayPort}/rpc`,
        workerdUrl: `${proto}://${hostConfig.externalHost}:${gatewayPort}/_w/`,
        adminToken,
        // Static child ingress seam. Rooms are armed on demand by the hub.
        pairing: webrtcPairing,
        serverId: deviceAuthStore.getServerId(),
        serverBootId,
        tokenFilePath,
        gatewayPort,
        workerdPort: workerdMgr?.getPort() ?? 0,
        pid: process.pid,
        version: serverVersion,
      };
      writeFileAtomicSync(args.readyFile, `${JSON.stringify(readyPayload, null, 2)}\n`, {
        mode: 0o600,
      });
    }
  }

  // Eval libraries are the only intentional warmup. Panels, apps, extensions,
  // and workers activate their own dependency graph on demand.
  if (!workspaceIsEphemeral) {
    container.get<() => void>("evalEnginePrewarm")();
  }

  // ===========================================================================
  // Graceful shutdown — container.stopAll() handles everything
  // ===========================================================================

  let isShuttingDown = false;

  async function shutdown() {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log("[Server] Shutting down...");

    const lifecycleDriver =
      container.get<import("./services/lifecycleDriver.js").LifecycleDriver>("lifecycleDriver");
    const alarmDriver =
      container.get<import("./services/alarmDriver.js").AlarmDriver>("alarmDriver");
    const shutdownStartedAt = Date.now();
    const forceExit = setTimeout(() => {
      console.warn("[Server] Shutdown timeout — forcing exit");
      process.exit(1);
    }, 8000);

    cleanupReaper.stop();

    // Stop scheduling admission before asking activations to release. A
    // scheduler-owned __alarm may be awaiting a long model/tool effect; cancel
    // only that transport and preserve its durable wake row so lifecycle
    // prepare can enter the activation and release its live resources.
    await alarmDriver
      .quiesce()
      .catch((err) => console.warn("[Server] alarm scheduler quiesce failed:", err));

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
      .catch((e) => console.error("[Server] Service shutdown error:", e));
    try {
      identityDb.close();
    } catch (error) {
      console.error("[Server] Identity DB shutdown error:", error);
    }
    clearTimeout(forceExit);
    console.log("[Server] Shutdown complete");
    process.exit(0);
  }

  requestShutdown = () => void shutdown();

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

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
