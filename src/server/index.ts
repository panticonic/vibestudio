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
import { createServerLogStore } from "./services/serverLogStore.js";
import type { AppCapability } from "@vibestudio/shared/unitManifest";
import { GIT_INTEROP_PROVIDER_METHOD_NAMES } from "@vibestudio/service-schemas/gitInterop";
import { createHash, randomBytes, randomUUID } from "crypto";
import {
  canonicalEntityId,
  type EntityActivationInput as EntityActivateInput,
  type EntityRecord,
} from "@vibestudio/shared/runtime/entitySpec";
import { isOpenPanelBrowserUrl } from "@vibestudio/shared/panelChrome";
import { parseUnitAuthorityManifest } from "@vibestudio/shared/authorityManifest";
import {
  createHostCaller,
  createVerifiedCaller,
  type VerifiedCodeIdentity,
} from "@vibestudio/shared/serviceDispatcher";
import { parseDoTargetId } from "@vibestudio/shared/workspaceServiceRpc";
import { isCallerKind } from "@vibestudio/shared/principalKinds";
import { registerBuildProvider, unregisterBuildProvider } from "./buildV2/buildProviderRegistry.js";
import { assertPresent, deleteDynamicProperty } from "../lintHelpers";
import { resolveHeadlessHostAutospawn } from "./headlessHostAutospawn.js";
import { resolveDependencyWorkspaceRoot } from "./dependencyWorkspaceRoot.js";
import { writeFileAtomicSync } from "../atomicFile.js";
import { stateLayout } from "./stateLayout.js";
import { consumeWorkspaceChildSecrets } from "./workspaceChildSecrets.js";
import { retireRoutedReach } from "./routedReachRetirement.js";
import { createWorkspaceChildHubPort } from "./workspaceChildHubPort.js";
import { declaredWorkspaceServiceActivationInput } from "./runtimeExecutionIdentity.js";
import type { PreparedCodeIncarnation, RuntimeEntityHooks } from "./services/runtimeService.js";
import {
  releaseDurableObjectRelaySeal,
  sealAndDrainDurableObjectRelays,
} from "./workerdRpcRelay.js";
import { resolveHttpRuntimeCaller } from "./httpRuntimeIdentity.js";
import { mirrorDevTemplatePublication } from "./devTemplateMirror.js";
import { getProductBootManifest } from "./internalDOs/productBootManifest.js";
import {
  AppliedWorkspaceUnitDeclarations,
  workspaceUnitDeclarationFingerprint,
} from "./workspaceUnitDeclarationFingerprint.js";
import { sha256Canonical } from "@vibestudio/shared/authority/invocationSnapshot";
import { codePrincipal } from "@vibestudio/shared/authority/codePrincipal";
import { joinContextIntegrity } from "@vibestudio/shared/authority/contextIntegrity";
import type { UserlandCapabilityDefinition } from "@vibestudio/shared/authorityManifest";
import { hostBuildOrigin } from "@vibestudio/shared/authority/reviewedUnitParts";
import { WorkspaceRpcMethodUndeclaredError } from "./workspaceRpcCatalogMismatch.js";
import type { InstallReviewOrigin } from "@vibestudio/shared/authority/unitInstallReview";
import { HOST_APPROVAL_COPY } from "@vibestudio/shared/hostApprovalCopy";
import type { WorkspaceCreationReviewState } from "@vibestudio/service-schemas/shellApproval";
import { templateGitTransportUrl } from "@vibestudio/workspace/templateCoordinates";
import { productBuiltinDirectAuthority } from "./services/productBuiltinDirectAuthority.js";
import { callerControlsContextTransition } from "./services/lifecycleContextControl.js";
import { startEventLoopResponsivenessMonitor } from "../eventLoopResponsiveness.js";

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
  --log-level <level>      Log verbosity (trace, verbose, info, warn, error, silent)
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
// A boot identity is immutable process state, not a live view of the shared
// checkout's latest build marker. Capture it before asynchronous startup so a
// parallel source build can publish a later identity without invalidating this
// already-starting hub or workspace child.
getProductBootManifest();

// =============================================================================
// Phase B: Async main — load app modules, initialize services
// =============================================================================

async function main() {
  const eventLoopSamples: import("../eventLoopResponsiveness.js").EventLoopResponsivenessSample[] =
    [];
  const stopEventLoopMonitor = startEventLoopResponsivenessMonitor({
    label: "workspace-server",
    onSample: (sample) => {
      eventLoopSamples.push(sample);
      if (eventLoopSamples.length > 240) eventLoopSamples.shift();
    },
  });
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
  } = consumeWorkspaceChildSecrets(process.env);
  const workspaceIdentityPemFile = process.env["VIBESTUDIO_WEBRTC_IDENTITY"];
  if (!workspaceIdentityPemFile) {
    throw new Error("Workspace runtime requires a hub-owned WebRTC identity path");
  }

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
  const { ExecutionPublicationJournal } = await import("./executionPublicationJournal.js");
  const { executionArtifactRefFromBuild, buildKeyRootProvider, DelegatingExecutionRootProvider } =
    await import("./executionRootProviders.js");
  const buildStoreForPublication = await import("./buildV2/buildStore.js");
  const { getInternalDOBundle, internalDOExecutionArtifacts } =
    await import("./internalDOs/internalDoLoader.js");
  const productSeedArtifacts = internalDOExecutionArtifacts(getInternalDOBundle());
  const productSeedArtifactByIdentity = new Map(
    productSeedArtifacts.map((artifact) => [
      `${artifact.buildKey}\0${artifact.executionDigest}`,
      artifact,
    ])
  );
  const executionPublicationJournal = new ExecutionPublicationJournal(
    statePath,
    (buildKey, executionDigest) => {
      const build = buildStoreForPublication.peekLocal(buildKey);
      if (build) return executionArtifactRefFromBuild(workspaceId, build);
      return productSeedArtifactByIdentity.get(`${buildKey}\0${executionDigest}`) ?? null;
    }
  );
  const evalRunRootProvider = new DelegatingExecutionRootProvider("eval-run");
  const developmentRunRootProvider = new DelegatingExecutionRootProvider("development-run");
  const { createCapabilityPresentationResolver, summarizeAuthorityRequests } =
    await import("@vibestudio/shared/authorityPresentation");
  const { PRODUCT_BUILTIN_CATALOG } =
    await import("@vibestudio/shared/productBuiltinCatalog.generated");
  const { discoverPackageGraph: discoverAuthorityPackageGraph } =
    await import("./buildV2/packageGraph.js");
  const capabilityServiceCatalog = [
    ...PRODUCT_BUILTIN_CATALOG.flatMap((entry) =>
      entry.kind === "service"
        ? [
            {
              name: entry.name,
              title: entry.title,
              action: entry.action,
              description: entry.description,
              presentation: entry.presentation,
              source: "vibestudio/internal",
            },
          ]
        : []
    ),
    ...(workspaceConfig.services ?? []),
  ];
  // Authority presentation is used while projecting every build-unit catalog
  // row. Discovering the whole workspace graph for every individual
  // userland capability turns one catalog read into hundreds of synchronous
  // filesystem scans and can starve the RPC loop during startup. The graph
  // only changes when the protected workspace view advances; invalidate this
  // snapshot from the refs listener below.
  let cachedAuthorityCapabilities: Array<{
    provider: string;
    definition: UserlandCapabilityDefinition;
  }> | null = null;
  const authorityCapabilities = () => {
    if (cachedAuthorityCapabilities) return cachedAuthorityCapabilities;
    cachedAuthorityCapabilities = discoverAuthorityPackageGraph(workspacePath)
      .allNodes()
      .flatMap((node) =>
        (node.manifest.authority?.provides ?? []).map((definition) => ({
          provider: node.relativePath,
          definition,
        }))
      );
    return cachedAuthorityCapabilities;
  };
  const describeCapability = createCapabilityPresentationResolver(
    () => capabilityServiceCatalog,
    authorityCapabilities
  );

  // Parse workspace declarations (singletonObjects + services + routes).
  // Validation (every DO-backed service/route has a matching singleton row)
  // runs eagerly here — bad workspaces fail fast at startup with a clear msg.
  const { buildWorkspaceDeclarations } = await import("@vibestudio/workspace/singletonRegistry");
  const { resolveWorkspaceService } = await import("./workspaceServices.js");
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
  const { RuntimeDiagnosticsStore } = await import("./runtimeDiagnosticsStore.js");
  const runtimeDiagnostics = new RuntimeDiagnosticsStore({ statePath });
  const entityCache = new EntityCache();
  let workerdManagerForGateway: import("./workerdManager.js").WorkerdManager | null = null;
  let primePanelRuntimeImage: (source: string, ref?: string) => Promise<void> = async () => {};
  entityCache.registerBootstrap({ id: "server", kind: "server" });
  entityCache.registerBootstrap({ id: "electron-main", kind: "shell" });
  // The single owner of WorkspaceDO entity state: pairs every durable
  // activate/retire with the hot-cache mirror so they can't drift. The
  // write-owners (runtime + eval services) receive this instead of raw entity
  // dispatch. Lazily built once doDispatch is resolvable (registered later).
  const { WorkspaceEntityStore } = await import("./workspaceEntityStore.js");
  let entityStoreInstance: import("./workspaceEntityStore.js").WorkspaceEntityStore | null = null;
  const { DurableObjectExecutionReadiness } = await import("./durableObjectExecutionReadiness.js");
  const durableObjectExecutionReadiness = new DurableObjectExecutionReadiness({
    resolveEntity: (id) =>
      ensureEntityStore(
        container.get<import("./doDispatch.js").DODispatch>("doDispatch")
      ).resolveRecord(id),
    restoreExactExecution: async (record) => {
      const manager = workerdManagerForGateway;
      if (!manager) {
        throw new Error(`Cannot materialize ${record.id} before WorkerdManager starts`);
      }
      await manager.restoreDurableObjectEntity(record);
    },
    getBootGeneration: () => workerdManagerForGateway?.getBootGeneration() ?? 0,
    onPermanentFailure: (incident) => {
      runtimeDiagnostics.record({
        workspaceId,
        entityId: incident.entityId,
        kind: "do",
        level: "error",
        message: "Sealed runtime execution is unavailable",
        source: "lifecycle",
        fields: {
          event: "runtime-execution-blocked",
          alarmState: "blocked",
          buildKey: incident.buildKey,
          executionDigest: incident.executionDigest,
          permanentIncidentCount: incident.incidentCount,
          failure: incident.message,
        },
      });
      eventService.emit("notification:show", {
        id: `runtime-execution-unavailable:${incident.entityId}:${incident.executionDigest}`,
        type: "error",
        title: "Runtime execution unavailable",
        message:
          "Background work is paused because its exact retained execution could not be restored.",
        ttl: 0,
        details: [
          { label: "Entity", value: incident.entityId, mono: true },
          { label: "Build", value: incident.buildKey, mono: true },
          { label: "Execution", value: incident.executionDigest, mono: true },
          { label: "Failure", value: incident.message },
        ],
        actions: [
          {
            id: "restore-exact-execution",
            label: "Restore exact execution",
            command: {
              type: "runtime.execution.recover",
              entityId: incident.entityId,
              expectedExecutionDigest: incident.executionDigest,
              strategy: "restore-exact",
            },
          },
          {
            id: "replace-execution-incarnation",
            label: "Start new incarnation",
            variant: "soft",
            command: {
              type: "runtime.execution.recover",
              entityId: incident.entityId,
              expectedExecutionDigest: incident.executionDigest,
              strategy: "replace-incarnation",
            },
          },
        ],
      });
    },
    onRecovered: (incident) => {
      runtimeDiagnostics.record({
        workspaceId,
        entityId: incident.entityId,
        kind: "do",
        level: "info",
        message: "Sealed runtime execution recovered",
        source: "lifecycle",
        fields: {
          event: "runtime-execution-recovered",
          alarmState: "recoverable",
          buildKey: incident.buildKey,
          executionDigest: incident.executionDigest,
          permanentIncidentCount: incident.incidentCount,
        },
      });
    },
  });
  const ensureEntityStore = (
    doDispatch: import("./doDispatch.js").DODispatch
  ): import("./workspaceEntityStore.js").WorkspaceEntityStore =>
    (entityStoreInstance ??= new WorkspaceEntityStore({
      doDispatch,
      workspaceId,
      entityCache,
      executionPublicationPort: executionPublicationJournal,
      materializeExecution: (record) => durableObjectExecutionReadiness.materialize(record),
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
        source: semanticWorkspaceService.source,
        className: semanticWorkspaceService.className,
        key: semanticWorkspaceService.objectKey,
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
  const { CdpGrantService, CDP_INTERNAL_GRANT_HEADER } =
    await import("@vibestudio/shared/cdpGrants");
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
  const { UserlandResourceHandleStore } = await import("./services/userlandResourceHandleStore.js");
  const userlandResourceHandles = new UserlandResourceHandleStore({ statePath });
  const { AgentExecutionSessionRegistry } =
    await import("./services/agentExecutionSessionRegistry.js");
  const agentExecutionSessions = new AgentExecutionSessionRegistry();
  const { TaskAuthorityRegistry } = await import("./services/taskAuthorityRegistry.js");
  const taskAuthorities = new TaskAuthorityRegistry({
    executionIsActive: (runtimeId, authority) =>
      agentExecutionSessions.resolve(runtimeId)?.taskAuthority === authority,
  });
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
  const {
    authorizeVerifiedCaller,
    callerMatchesReviewedClosureHarness,
    isAttestedSystemTestHarness,
    isBlessedSystemTestConduit,
  } = await import("./services/authorityRuntime.js");
  const { ReviewedClosureRegistry } = await import("./services/reviewedClosureRegistry.js");
  const reviewedClosureRegistry = new ReviewedClosureRegistry({
    statePath,
    grantStore: capabilityGrantStore,
    isHarnessBlessed: (identity) =>
      conduitBlessingStore.isBlessed({
        repoPath: identity.unit,
        effectiveVersion: identity.ev,
      }),
  });
  // Exact root bootstrap may run while services are starting, before the
  // dispatcher can be marked fully initialized. Install the one compositional
  // resolver as soon as all of its
  // durable policy inputs exist; ordinary RPC dispatch remains fenced by
  // markInitialized() after every service has registered.
  dispatcher.setAuthorityResolver(
    ({ ctx, caller, service, method, capability, resourceKey, tier }) => {
      const sessionId = caller.agentBinding?.channelId ?? caller.runtime.id;
      const sessionOrigin = caller.executionSession !== undefined;
      const reviewedClosure = reviewedClosureRegistry.factForSession(sessionId);
      let reviewedClosureChangeRequired = false;
      try {
        reviewedClosureRegistry.assertServiceExposure(sessionId, `${service}.${method}`);
      } catch (error) {
        if (
          reviewedClosure &&
          error instanceof Error &&
          (error as NodeJS.ErrnoException).code === "EMISSIONSCOPE"
        ) {
          reviewedClosureChangeRequired = true;
        } else {
          throw error;
        }
      }
      const conduitBlessed = Boolean(
        caller.code?.executionDigest &&
        conduitBlessingStore.isBlessed(caller.code) &&
        caller.executionSession &&
        caller.executionSession.harness.executionDigest === caller.code.executionDigest &&
        caller.executionSession.harness.principal === codePrincipal(caller.code) &&
        (!reviewedClosure || callerMatchesReviewedClosureHarness(caller, reviewedClosure))
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
          reviewedClosure,
          contextIntegrity: joinContextIntegrity(
            sessionOrigin && caller.agentBinding
              ? contextIntegrityStore.effectiveFact({
                  sessionId,
                  attested: ctx.authorization?.contextIntegrity,
                  conduitBlessed,
                })
              : { class: "not-applicable", latchEpoch: 0, externalKeys: [] },
            ctx.inheritedContextIntegrity ?? null
          ) ?? { class: "not-applicable", latchEpoch: 0, externalKeys: [] },
          grantStore: capabilityGrantStore,
        }),
        ...(reviewedClosureChangeRequired ? { reviewedClosureChangeRequired: true } : {}),
      };
    }
  );
  let resolvedDoDispatchForTitles: import("./doDispatch.js").DODispatch | null = null;
  developmentRunRootProvider.bind({
    id: "development-run",
    mandatory: true,
    async snapshotRoots(epoch) {
      const doDispatch = resolvedDoDispatchForTitles;
      if (!doDispatch) throw new Error("Development builtin is not reachable for retention");
      return (await doDispatch.dispatch(
        {
          source: "vibestudio/internal",
          className: "DevelopmentDO",
          objectKey: workspaceId,
        },
        "snapshotExecutionRoots",
        { epoch }
      )) as import("@vibestudio/shared/execution/retention").ExecutionRoot[];
    },
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
  const getWorkspaceUnitIcon = (repoPath: string): string | undefined => {
    try {
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(workspacePath, repoPath, "package.json"), "utf8")
      ) as { vibestudio?: { icon?: unknown } };
      const icon = packageJson.vibestudio?.icon;
      return typeof icon === "string" && icon.trim().length <= 256 ? icon.trim() : undefined;
    } catch {
      return undefined;
    }
  };
  const approvalRequesterDeps = {
    entityCache,
    getTitle: (id: string) => entityTitleService.getTitle(id),
    getIcon: getWorkspaceUnitIcon,
  };
  const { InstallReviewSelectionStore } = await import("./services/installReviewSelections.js");
  const installReviewSelections = new InstallReviewSelectionStore();
  const approvalQueue = createApprovalQueue({
    eventService,
    installReviewSelections,
    presentationFor: describeCapability,
    recordProvenance: async (record) => {
      await workspaceChildHub.appendApproval(record);
    },
    resolveTitle: (entityId) => resolveApprovalCallerTitle(approvalRequesterDeps, entityId),
    resolveRequester: (input) => resolveApprovalRequester(approvalRequesterDeps, input),
    // One resolver answers this for every surface, so a part's history reads the
    // same on the install card, in its details, and in a grant explanation. It
    // is null while no resolver is up yet — a review that cannot prove where a
    // part came from says nothing rather than naming the wrong source.
    originallyInstalledFrom: (repoPath) =>
      unitOriginResolver?.originallyInstalledFrom(repoPath) ?? null,
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
  const { UnitAdmissionStore } = await import("./services/unitAdmissionStore.js");
  // Where each unit's bytes came from. Constructed further down, once the
  // workspace VCS can be read; the admission store asks through this holder so
  // that every admission records its source without any caller having to
  // remember to pass one (§7.6.3).
  let unitOriginResolver: import("./services/unitOriginResolver.js").UnitOriginResolver | null =
    null;
  const unitAdmissionStore = new UnitAdmissionStore({
    statePath,
    resolveSourceOrigin: (repoPath) => unitOriginResolver?.recordedOriginFor(repoPath) ?? null,
  });
  const { WorkspaceCreationReviewStore } = await import("./services/workspaceCreationReview.js");
  const workspaceCreationReview = new WorkspaceCreationReviewStore({ statePath });
  const { prepareUnitInstallReview } = await import("./services/unitInstallAcceptance.js");
  type ReviewedUnit = import("@vibestudio/shared/approvals").ReviewedUnit;
  /**
   * Record what the launch gate decided (§7.6).
   *
   * Client apps and extensions get exactly one review, and it happens before the
   * workspace UI exists — `apps/shell` cannot render its own approval. That
   * decision has to land in the same admission ledger as everything else, or the
   * unit stays un-admitted forever: the launch gate would keep confirming it
   * while the authority gate keeps demanding a review it can never be given.
   *
   * The gate deliberately offers no per-permission choice — it asks whose code
   * this is, not what it may reach — so a first arrival carries the full slate
   * and an update carries whatever the version it replaces held. The selection
   * is still read rather than assumed: it is keyed by the same identity the
   * review used, so it is consumed here instead of being left behind for
   * something else to pick up.
   */
  const prepareDecidedUnits = (
    units: readonly ReviewedUnit[],
    origin: "launch-gate" | "host-build",
    sourceOrigins?: ReadonlyMap<string, InstallReviewOrigin | null>
  ) => {
    if (units.length === 0) {
      return { committed: () => undefined, failed: () => undefined };
    }
    const identityKeyOf = (unit: ReviewedUnit): string => `${unit.source.repo}@${unit.ev ?? ""}`;
    for (const unit of units) {
      if (!unit.ev) {
        throw new Error(
          `Cannot prepare ${origin} admission for ${unit.source.repo} without an effective version`
        );
      }
    }
    const selectionLease = installReviewSelections.leaseMany(units.map(identityKeyOf));
    const admissible = units.map((unit) => {
      const effectiveVersion = unit.ev;
      if (!effectiveVersion) {
        throw new Error(`Unit ${unit.source.repo} lost its effective version during admission`);
      }
      const clearedRowKeys = selectionLease.selections.get(identityKeyOf(unit));
      // The version this one replaces, read before anything is admitted. Without
      // it an update leaves the outgoing version's grants standing — so reverting
      // a unit silently regains the authority it used to hold — and, because the
      // gate asks nothing about permissions, acceptance has nothing to carry the
      // user's earlier decision forward from (§7.3).
      const outgoing = unitAdmissionStore.latestAdmittedVersion(unit.source.repo);
      const sourceOrigin = sourceOrigins?.get(unit.source.repo);
      return {
        identity: {
          repoPath: unit.source.repo,
          effectiveVersion,
          authority: {
            requests: unit.authority?.requests ?? [],
            provides: unit.authority?.provides ?? [],
          },
        },
        ...(outgoing && outgoing !== effectiveVersion
          ? { previous: { repoPath: unit.source.repo, effectiveVersion: outgoing } }
          : {}),
        ...(clearedRowKeys ? { clearedRowKeys } : {}),
        ...(sourceOrigins?.has(unit.source.repo)
          ? {
              sourceOrigin:
                sourceOrigin && sourceOrigin.originStatus !== "unresolved"
                  ? {
                      originKey: sourceOrigin.originKey,
                      url: sourceOrigin.url,
                      version: sourceOrigin.version,
                      selfName: sourceOrigin.selfName ?? null,
                      isWorkspaceRoot: sourceOrigin.isWorkspaceRoot === true,
                    }
                  : null,
            }
          : {}),
      };
    });
    let transaction: ReturnType<typeof prepareUnitInstallReview>;
    try {
      transaction = prepareUnitInstallReview(
        {
          admissionStore: unitAdmissionStore,
          grantStore: capabilityGrantStore,
          presentationFor: describeCapability,
        },
        { units: admissible, origin }
      );
    } catch (error) {
      selectionLease.failed();
      throw error;
    }
    let settled = false;
    return {
      committed: () => {
        if (settled) return;
        transaction.committed();
        selectionLease.committed();
        settled = true;
      },
      failed: (error: unknown) => {
        if (settled) return;
        try {
          transaction.failed(error);
        } finally {
          selectionLease.failed();
          settled = true;
        }
      },
    };
  };
  const acceptLaunchGateUnits = (
    prepareTrust: () => { committed(): void; failed(error: unknown): void } | undefined,
    units: readonly ReviewedUnit[],
    sourceOrigins?: ReadonlyMap<string, InstallReviewOrigin | null>
  ): void => {
    const trust = prepareTrust();
    let admission: ReturnType<typeof prepareDecidedUnits> | undefined;
    try {
      admission = prepareDecidedUnits(units, "launch-gate", sourceOrigins);
      trust?.committed();
      admission.committed();
    } catch (error) {
      try {
        admission?.failed(error);
      } finally {
        trust?.failed(error);
      }
      throw error;
    }
  };
  /**
   * Admit the units that ship in the host build, before anything runs.
   *
   * These are never offered at the launch gate — the user decided about them by
   * installing Vibestudio — so nothing else would ever record their admission,
   * and `apps/shell` in particular would be unable to render the review it is
   * meant to host. Idempotent by construction: admission is keyed by exact
   * version and manifest digest, so a boot that changes neither is a no-op.
   */
  const admitSeedTrustedUnits = (units: readonly ReviewedUnit[]): void => {
    if (units.length === 0) {
      // Loud, because the shell depends on this: with no seeded unit admitted,
      // `apps/shell` is gated on a review only `apps/shell` can present.
      console.warn(
        "[Units] No host-build units verified a seed record; their admission will not be recorded"
      );
      return;
    }
    const unadmitted = units.filter(
      (unit) => !unit.ev || !unitAdmissionStore.hasVersion(unit.source.repo, unit.ev)
    );
    if (unadmitted.length === 0) return;
    console.info(
      `[Units] Admitting ${unadmitted.length} host-build unit(s): ${unadmitted
        .map((unit) => unit.source.repo)
        .join(", ")}`
    );
    const hostOrigin = hostBuildOrigin(serverVersion);
    const admission = prepareDecidedUnits(
      unadmitted,
      "host-build",
      new Map(unadmitted.map((unit) => [unit.source.repo, hostOrigin]))
    );
    admission.committed();
  };
  const isCodeApproved = (code: VerifiedCodeIdentity): boolean => {
    if (code.repoPath === "vibestudio/internal") return true;
    // Client apps and extensions are admitted by the publication that
    // introduced them and confirmed at the launch gate, exactly like every
    // other unit — there is no kind that is trusted for being its own kind
    // (docs/template-install-unit-approval-ux-plan.md §5.5).
    const evalOwner = code.evalOrigin ? entityCache.resolveActive(code.evalOrigin.ownerId) : null;
    const approvedEntity = evalOwner ?? entityCache.resolveActive(code.callerId);
    if (!approvedEntity?.activeAuthority) return false;
    return unitAdmissionStore.has({
      repoPath: code.repoPath,
      effectiveVersion: code.effectiveVersion,
      authority: approvedEntity.activeAuthority,
    });
  };
  const { UnitInstallReviewCoordinator } = await import("./unitInstallReviewCoordinator.js");
  const unitInstallReviewCoordinator = new UnitInstallReviewCoordinator({
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
  const cdpGrants = new CdpGrantService();

  const egressProxy = createEgressProxy({
    credentialStore,
    auditLog,
    approvalQueue,
    authorizeEffect: (ctx, effect) => dispatcher.authorizeHostEffect(ctx, effect),
    sessionGrantStore: credentialSessionGrantStore,
    credentialUseGrantStore,
    credentialLifecycle,
    authorizeInternalRequest: async (input) => {
      if (await localModelLoopbackAuthority.authorize(input)) return {};
      let gatewayOrigin: string;
      try {
        gatewayOrigin = new URL(getLocalGatewayUrl("CDP transport")).origin;
      } catch {
        return null;
      }
      if (
        input.targetUrl.origin !== gatewayOrigin ||
        !input.targetUrl.pathname.startsWith("/cdp/")
      ) {
        return null;
      }
      const rawHeader =
        input.headers instanceof Headers
          ? input.headers.get(CDP_INTERNAL_GRANT_HEADER)
          : Object.entries(input.headers).find(
              ([name]) => name.toLowerCase() === CDP_INTERNAL_GRANT_HEADER
            )?.[1];
      const token = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
      if (typeof token !== "string" || token.length === 0) return null;
      const targetId = decodeURIComponent(input.targetUrl.pathname.slice("/cdp/".length));
      if (!cdpGrants.validatesTarget(token, targetId)) return null;
      return {
        trustedForwardHeaders: {
          [CDP_INTERNAL_GRANT_HEADER]: token,
        },
      };
    },
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
      return reviewedClosureRegistry.assertNetworkExposure(sessionId, targetUrl.origin);
    },
  });
  let panelRuntimeCoordinatorForCleanup:
    | import("./panelRuntimeCoordinator.js").PanelRuntimeCoordinator
    | null = null;
  const cleanupRuntimeEntityRecord = async (
    record: import("@vibestudio/shared/runtime/entitySpec").EntityRecord
  ) => {
    durableObjectExecutionReadiness.forget(record.id);
    const { cleanupRuntimeEntity } = await import("./runtimeEntityCleanup.js");
    await cleanupRuntimeEntity(record, {
      panelRuntimeCoordinator: panelRuntimeCoordinatorForCleanup,
      egressProxy,
      approvalQueue,
      credentialSessionGrantStore,
      tokenManager,
      connectionGrants,
      entityTitleService,
      resourceHandles: userlandResourceHandles,
      workspaceId,
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
  type TrustedUnitHostInstance =
    | import("@vibestudio/extension-host").ExtensionHost
    | import("./appHost.js").AppHost;
  const trustedUnitHosts = (): TrustedUnitHostInstance[] =>
    [extensionHostForGateway, appHostForGateway].filter(
      (host): host is TrustedUnitHostInstance => host !== null
    );
  let startupWorkspaceUnitReconcile: Promise<void> | null = null;
  // Protected repository content pointers: the single host publication store.
  // Constructed BEFORE WorkspaceVcs (which routes every protected read/advance
  // through it); the approval gate is late-bound below once the main-advance
  // approval machinery exists — advances before that point fail closed.
  const { createProtectedRefStore } = await import("./services/protectedRefStore.js");
  const { collectTreeReachableDigests, getBytes, putBytes } =
    await import("./services/blobstoreService.js");
  let mainRefGate: import("./services/protectedRefStore.js").RefGate | null = null;
  const protectedRefStore = createProtectedRefStore({
    statePath: layout.refsDir,
    gate: async (batch) => {
      if (!mainRefGate) {
        throw new Error("Protected-ref gate not initialized yet (server still starting)");
      }
      return mainRefGate(batch);
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
  const { gitCredentialRequirement } = await import("./gitCredentialRequirements.js");
  const { createHostGitReadClient } = await import("./services/hostGitHttpClient.js");
  const rootTemplateCaller = createHostCaller("server", "server", SYSTEM_SUBJECT);
  const { acquireRootTemplateSnapshot } = await import("./acquireRootTemplateSnapshot.js");
  const { WorkspaceRootTemplateBootstrap } = await import("./workspaceRootTemplateBootstrap.js");
  const createRootTemplateGitClient = (pin: { url: string; credential?: string }) => {
    const remoteUrl = templateGitTransportUrl(pin.url);
    return createHostGitReadClient({
      egress: egressProxy,
      caller: rootTemplateCaller,
      credential: { kind: "anonymous" },
      fallbackCredential: pin.credential
        ? { kind: "named", label: pin.credential }
        : { kind: "automatic" },
      credentialRequirement: gitCredentialRequirement(pin.credential, remoteUrl),
      operation: () => ({
        service: "workspace-initialization",
        method: "acquireRootTemplate",
        workspaceId,
        resourceKey: `workspace-root-template:${pin.url}`,
        preparedStateDigest: sha256Canonical({ workspaceId, pin }),
      }),
    });
  };
  const rootTemplateBootstrap = new WorkspaceRootTemplateBootstrap({
    workspaceId,
    statePath,
    sourcePath: workspacePath,
    acquire: async (pin) => {
      return acquireRootTemplateSnapshot({
        statePath,
        pin,
        git: createRootTemplateGitClient(pin),
        sink: {
          put: (bytes) => putBytes(layout.blobsDir, Buffer.from(bytes)),
        },
      });
    },
  });
  await rootTemplateBootstrap.prepareSource();
  const { parseWorkspaceConfigContentWithId } = await import("@vibestudio/workspace/configParser");
  const materializedWorkspaceConfig = parseWorkspaceConfigContentWithId(
    fs.readFileSync(path.join(workspacePath, "meta", "vibestudio.yml"), "utf8"),
    workspaceId
  );
  replaceWorkspaceConfig(workspaceConfig, materializedWorkspaceConfig);
  const workspaceDecls = buildWorkspaceDeclarations(workspaceConfig);
  const resolvedWorkspaceSource = resolveWorkspaceService(
    workspaceDecls,
    "vibestudio.workspace-source.v1"
  );
  if (resolvedWorkspaceSource.kind !== "durable-object") {
    throw new Error(
      "Workspace protocol vibestudio.workspace-source.v1 must be Durable Object-backed"
    );
  }
  const semanticWorkspaceService = {
    source: resolvedWorkspaceSource.source,
    className: resolvedWorkspaceSource.className,
    objectKey: resolvedWorkspaceSource.objectKey,
  };
  // Workspace VCS is the native effect adapter for the exact manifest-declared
  // semantic authority worker.
  const { WorkspaceVcs } = await import("./vcsHost/workspaceVcs.js");
  const workspaceVcs = new WorkspaceVcs({
    blobsDir: layout.blobsDir,
    workspaceRoot: workspacePath,
    contextProjectionsRoot: layout.contextProjections.current,
    buildSourcesRoot: layout.buildSourcesDir,
    refs: protectedRefStore,
    rootTemplateBootstrap,
    // Public context bindings contain durable identities only. Reachability is
    // resolved from the caller's current hub/session credential.
    workspaceId,
    // Dev extraction gate (Phase-2 revision §3): project a push-to-`main` OUT to
    // the source dir only when there is a persistent dev source to extract to.
    // `devTemplateMirrorDir` is the existing signal (pnpm dev + a real
    // `<appRoot>/workspace` template); the guarded publication mirror below
    // independently persists the same exact changes to that checkout. Off in
    // production ephemeral workspaces, which have no source dir. Computed just
    // above this block.
    extractMainToSource: devTemplateMirrorDir !== null,
  });
  // Set only by the trusted one-time import from the host-shipped workspace
  // template. Protected main is mutable and must never be substituted here.
  let productSeedStateHash: string | null = null;
  let trustedBootstrapStateHash: string | null = null;
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
  let baseTemplateReleasePullCoordinator:
    | import("./baseTemplateRelease.js").BaseTemplateReleasePullCoordinator
    | null = null;
  const initiateShippedBaseTemplatePull = async (): Promise<void> => {
    const { baseTemplatePullForRelease, readBaseTemplateRelease } =
      await import("./baseTemplateRelease.js");
    const release = readBaseTemplateRelease(appRoot);
    if (!release) {
      throw new Error("This host build has no base-template release artifact");
    }
    const { stateHash } = await workspaceVcs.ensureFresh();
    const stateText = await readWorkspaceFileAtState(stateHash, "meta/templates.state.yml");
    if (!stateText) return;
    const [{ default: YAML }, { parseTemplateState }] = await Promise.all([
      import("yaml"),
      import("@vibestudio/workspace/templateState"),
    ]);
    const pull: ReturnType<typeof baseTemplatePullForRelease> = baseTemplatePullForRelease(
      release,
      parseTemplateState(YAML.parse(stateText) as unknown)
    );
    if (!pull) return;
    const host = container.get<import("@vibestudio/extension-host").ExtensionHost>("extensionHost");
    const result = await host.invoke(
      { caller: rootTemplateCaller },
      "@workspace-extensions/template-composer",
      "pull",
      [pull]
    );
    console.info("[Templates] Opened the shipped base-template release operation", {
      commandId: pull.commandId,
      result,
    });
  };
  {
    // Origin is the axis every unit review is organized on, and it is the one
    // relationship context every review should present consistently. It is
    // derived here from current template state, the admission record, and the
    // creation descriptor, then handed to every review request site.
    const { UnitOriginResolver } = await import("./services/unitOriginResolver.js");
    unitOriginResolver = new UnitOriginResolver({
      readWorkspaceFile: async (filePath) => {
        const { stateHash } = await workspaceVcs.ensureFresh();
        return readWorkspaceFileAtState(stateHash, filePath);
      },
      // What was true when a part was admitted, for a repository the live state
      // no longer claims. Removing a template severs a relationship and deletes
      // nothing (§U2): without this the state's disappearance would silently
      // re-attribute every one of that template's parts to whatever answers
      // next — for most workspaces, to the host's own build.
      recordedSourceFor: (repoPath) => unitAdmissionStore.recordedSourceFor(repoPath),
      rootTemplatePin: () => workspaceCreationReview.rootTemplate() ?? null,
      isBootstrapRepository: async (repoPath) => {
        const stateHash = trustedBootstrapStateHash;
        if (!stateHash) return false;
        return (await readWorkspaceFileAtState(stateHash, `${repoPath}/package.json`)) !== null;
      },
      hostBuildVersion: () => serverVersion,
      admittedOriginKeys: () => unitAdmissionStore.admittedOriginKeys(),
    });
  }
  /**
   * Origins for one review, never fatal.
   *
   * A gate that cannot resolve provenance still has to render, and the honest
   * failure is to say nothing about a source rather than to name the wrong one —
   * so a resolver that is not up yet contributes no origins and the review falls
   * back to what it can prove.
   */
  const resolveUnitOrigins = async (
    repoPaths: readonly string[]
  ): Promise<ReadonlyMap<string, InstallReviewOrigin>> => {
    if (!unitOriginResolver) return new Map();
    try {
      return await unitOriginResolver.originsFor(repoPaths);
    } catch (err) {
      console.warn(
        "[Units] Could not resolve where these units came from:",
        err instanceof Error ? err.message : String(err)
      );
      return new Map();
    }
  };
  const launchGateBatchKeyFor = (
    config: typeof workspaceConfig,
    unit: ReviewedUnit
  ): string | undefined => {
    if (unit.unitKind === "app") return unit.target ?? "shared";
    if (unit.unitKind !== "extension") return "shared";
    const targets = (["electron", "react-native", "terminal"] as const).filter((target) =>
      resolveHostTargetDecl(config, target)?.requiresExtensions.includes(unit.source.repo)
    );
    return targets.length === 1 ? targets[0] : "shared";
  };
  const enqueueLaunchGateReview = async (input: {
    review: { units: ReviewedUnit[]; identityKeys: string[] };
    config: typeof workspaceConfig;
    applyApproved(
      units: ReviewedUnit[],
      identityKeys: string[],
      sourceOrigins: ReadonlyMap<string, InstallReviewOrigin>
    ): Promise<void> | void;
    label: string;
  }): Promise<void> => {
    const groups = new Map<string, { units: ReviewedUnit[]; identityKeys: string[] }>();
    input.review.units.forEach((unit, index) => {
      const key = launchGateBatchKeyFor(input.config, unit) ?? "shared";
      const group = groups.get(key) ?? { units: [], identityKeys: [] };
      group.units.push(unit);
      group.identityKeys.push(input.review.identityKeys[index] ?? "");
      groups.set(key, group);
    });

    // Staging must complete before the startup barrier publishes, otherwise a
    // late launch-gate request can be split away from the app/extension review
    // that is meant to approve it. The returned enqueue promises settle only
    // after a human decision and are intentionally not awaited here: startup
    // must remain responsive while the gate is visible.
    await Promise.all(
      [...groups.entries()].map(async ([batchKey, group]) => {
        const origins = await resolveUnitOrigins(group.units.map((unit) => unit.source.repo));
        void unitInstallReviewCoordinator
          .enqueue({
            entries: group.units,
            trigger: "startup",
            batchKey,
            origins,
            applyApproved: async () => {
              await input.applyApproved(group.units, group.identityKeys, origins);
            },
            applyDenied: () => undefined,
          })
          .catch((err: unknown) =>
            console.warn(`[Units] Failed to apply reviewed ${input.label} trust:`, err)
          );
      })
    );
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
  const appliedExtensionDeclarations = new AppliedWorkspaceUnitDeclarations();
  const appliedAppDeclarations = new AppliedWorkspaceUnitDeclarations();
  /**
   * Startup extension reconciliation, which runs in the background and stages
   * approvals of its own. The startup gate cannot be published until it has
   * settled AND the app branch has staged, or whichever staged last is left in
   * a batch nothing will ever publish.
   */
  let startupExtensionStaging: Promise<void> | null = null;
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
        const declarationFingerprint = workspaceUnitDeclarationFingerprint(declared);
        if (
          trigger === "meta-change" &&
          appliedExtensionDeclarations.matches(declarationFingerprint)
        ) {
          console.info("[Extensions] Declarations unchanged after meta change; reconcile skipped");
        } else {
          if (trigger === "startup") {
            // Host-build units first: they are never offered at the gate, so
            // this is the only thing that records their admission — and the
            // shell needs it before it can render any review at all.
            admitSeedTrustedUnits(extensionHost.seedTrustedDeclared(declared));
            const review = extensionHost.reviewDeclared(declared);
            if (review.units.length > 0) {
              tasks.push(
                enqueueLaunchGateReview({
                  review,
                  config: nextConfig,
                  label: "extension",
                  applyApproved: (units, identityKeys, sourceOrigins) => {
                    // Activation trust says this build may run; admission says
                    // its declared authority was reviewed. Both, or the unit
                    // runs with no record of the decision that let it.
                    acceptLaunchGateUnits(
                      () => extensionHost.preparePreapprovedTrust(identityKeys),
                      units,
                      sourceOrigins
                    );
                  },
                })
              );
            }
          }
          const reconcileAll = () =>
            appliedExtensionDeclarations.apply(declarationFingerprint, () =>
              extensionHost.reconcileDeclared(declared, {
                trigger,
                // Startup reconciliation is opportunistic background work.
                // Keep one compiler busy without saturating the machine while
                // the focused panel is building and booting.
                ...(trigger === "startup"
                  ? { maxConcurrentApplies: 1, waitFor: "staged" as const }
                  : {}),
              })
            );
          if (trigger === "startup") {
            // Reconciling stages further approvals of its own, so the gate is
            // released once this settles — but releasing it HERE published a
            // batch the app branch had not joined yet. Publication is owned by
            // the one place that can see both branches finish; this only
            // records what that place has to wait for.
            startupExtensionStaging = Promise.resolve()
              .then(() => {
                const backgroundStartedAt = Date.now();
                return reconcileAll().then(() => {
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
      }
      if (appHostForGateway) {
        const appHost = appHostForGateway;
        try {
          const declared = resolveDeclaredApps(nextConfig);
          const declarationFingerprint = workspaceUnitDeclarationFingerprint(declared);
          if (trigger === "meta-change" && appliedAppDeclarations.matches(declarationFingerprint)) {
            console.info("[Apps] Declarations unchanged after meta change; reconcile skipped");
          } else {
            // Before reconcile, not after: reconcile is where trust is resolved,
            // and admission is one of its inputs. Recording it afterwards would
            // leave every host-build app resolved as un-admitted for the pass
            // that decides whether to run it — it would build and then never
            // activate, with nothing on screen to explain why.
            if (trigger === "startup") {
              admitSeedTrustedUnits(appHost.seedTrustedDeclared(declared));
            }
            await appliedAppDeclarations.apply(declarationFingerprint, () =>
              appHost.setDeclared(declared, { trigger })
            );
            if (trigger === "startup") {
              const review = appHost.reviewDeclared(declared);
              if (review.units.length > 0) {
                tasks.push(
                  enqueueLaunchGateReview({
                    review,
                    config: nextConfig,
                    label: "app",
                    applyApproved: (units, identityKeys, sourceOrigins) => {
                      // Activation trust says this build may run; admission says
                      // its declared authority was reviewed. Both, or the unit
                      // runs with no record of the decision that let it.
                      acceptLaunchGateUnits(
                        () => appHost.preparePreapprovedTrust(identityKeys),
                        units,
                        sourceOrigins
                      );
                    },
                  })
                );
              }
            }
            if (trigger === "startup") {
              console.info("[StartupCriticalPath] App declarations staged for on-demand launch");
            }
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
  const treeScanner = new WorkspaceTreeScanner(async () => {
    const { stateHash } = await workspaceVcs.ensureFresh();
    return workspaceVcs.materializeSourceTree(stateHash);
  });
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
  //  - pnpm dev mode persists protected publications back to the template
  //    checkout through an exact previous-state guard
  let devMirrorQueue = Promise.resolve();
  let initialWorkspaceUnitReconcileComplete = false;
  let pendingStartupMetaConfigReload = false;
  let latestMetaConfigReloadSeq = 0;
  // Bridge one atomic protected publication to the client event bus.
  workspaceVcs.onProtectedPublication((event) => {
    eventService.emit("vcs:publication", event);
    try {
      workerdManagerForGateway?.commitDurableObjectSchemas(event.workspaceStateHash);
    } catch (error) {
      console.error("[SchemaGate] Failed to commit published schema descriptors:", error);
    }
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
      // Preserve publication order: each event expects the checkout state left
      // by its predecessor. A divergent repository is never overwritten.
      devMirrorQueue = devMirrorQueue
        .then(async () => {
          const result = await mirrorDevTemplatePublication({
            destinationRoot: devTemplateMirrorDir,
            publication: event,
            inspectRepository: async (repoPath) => {
              const repositoryRoot = path.join(devTemplateMirrorDir, ...repoPath.split("/"));
              try {
                const stat = await fs.promises.lstat(repositoryRoot);
                if (!stat.isDirectory()) {
                  return { files: [], skippedPaths: [repoPath] };
                }
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                  return { files: [], skippedPaths: [] };
                }
                throw error;
              }
              const inspected = await workspaceVcs.contentProjection.localState(repositoryRoot, {
                exact: true,
              });
              return {
                files: inspected.files.map((file) => ({
                  path: file.path,
                  contentHash: file.contentHash,
                  executable: (file.mode & 0o111) !== 0,
                })),
                skippedPaths: inspected.skipped.map((entry) => entry.path),
              };
            },
            readState: async (stateHash) =>
              (await workspaceVcs.contentProjection.listStateFiles(stateHash)).map((file) => ({
                path: file.path,
                contentHash: file.content_hash,
                executable: (file.mode & 0o111) !== 0,
              })),
            readBlob: (contentHash) => getBytes(layout.blobsDir, contentHash),
          });
          if (result.conflicts.length > 0) {
            console.warn(
              "[DevMirror] checkout changed concurrently; publication was not written back:",
              result.conflicts
            );
          }
        })
        .catch((error: unknown) => {
          console.warn(
            "[DevMirror] publication write-back failed:",
            error instanceof Error ? error.message : String(error)
          );
        });
    }
  });
  // ===========================================================================
  // Unified ServiceContainer — lifecycle + RPC services in one container
  // ===========================================================================

  const { AttachedHostSessionStore } = await import("./services/attachedHostSessionStore.js");
  const { AttachedHostEndpoint } = await import("./services/attachedHostProtocol.js");
  const { AttachedHostApprovalPresenter, createAttachedHostApprovalResolver } =
    await import("./services/attachedHostApprovalPresenter.js");
  const {
    AttachedHostAuthorityBridge,
    AttachedHostDecisionConsumer,
    attachedHostAwareAuthorityAcquirer,
  } = await import("./services/attachedHostAuthorityBridge.js");
  const { createAttachedHostChildEndpoint, readAttachedHostChildEnvironment } =
    await import("./services/attachedHostRuntime.js");
  const {
    HttpAttachedHostApprovalClient,
    attachedHostHttpRoutes,
    attachedHostParentHttpRoutes,
    createAttachedHostPublicationPorts,
  } = await import("./services/attachedHostTransport.js");
  const { createAttachedHostsService } = await import("./services/attachedHostsService.js");
  const { AttachedHostController } = await import("./services/attachedHostController.js");

  // This is an attenuation ceiling, not a grant. An attached child can ask the
  // canonical parent UI about any semantic capability/resource, but it can
  // never bypass normal parent policy or widen the exact child-local decision.
  // Keeping this route complete preserves ordinary agent UX while the signed
  // transcript, canonical presentation, and dispatcher enforce the boundaries.
  const attachedHostAuthorityCeiling = Object.freeze([
    Object.freeze({
      capability: "*",
      resource: Object.freeze({ kind: "prefix" as const, prefix: "" }),
    }),
  ]);
  const attachedHostProtocolStore = new AttachedHostSessionStore(
    layout.development.attachedHostsDb
  );
  const attachedHostApprovalResolver = createAttachedHostApprovalResolver(dispatcher);
  const localHostId = deviceAuthStore.getServerId();
  const attachedHostParentEndpoint = new AttachedHostEndpoint({
    role: "parent",
    store: attachedHostProtocolStore,
    localFacts: (facts) => {
      if (facts.parentHostId !== localHostId) {
        throw Object.assign(new Error("Attached-host parent identity drifted"), {
          code: "EATTACHED_BINDING",
        });
      }
      return { facts, authorityCeiling: attachedHostAuthorityCeiling };
    },
    resolveApprovalPresentation: attachedHostApprovalResolver,
  });
  const attachedHostApprovalPresenter = new AttachedHostApprovalPresenter({
    endpoint: attachedHostParentEndpoint,
    approvalQueue,
  });
  const attachedChildEnvironment = readAttachedHostChildEnvironment(process.env);
  const childInstanceId = attachedChildEnvironment?.instanceId;
  const childGenerationId = attachedChildEnvironment?.generationId;
  const childDevelopmentRunId = attachedChildEnvironment?.developmentRunId;
  const attachedParentGatewayUrl = attachedChildEnvironment?.parentGatewayUrl;
  const attachedHostChildEndpoint =
    childInstanceId && childGenerationId && childDevelopmentRunId && attachedParentGatewayUrl
      ? createAttachedHostChildEndpoint({
          store: attachedHostProtocolStore,
          dispatcher,
          localFacts: (facts) => {
            if (
              facts.childHostId !== localHostId ||
              facts.childGenerationId !== childGenerationId ||
              facts.developmentRunId !== childDevelopmentRunId
            ) {
              throw Object.assign(new Error("Attached-host child readiness facts drifted"), {
                code: "EATTACHED_BINDING",
              });
            }
            return { facts, authorityCeiling: attachedHostAuthorityCeiling };
          },
          resolveCaller: (relationship) => {
            const user = relationship.ownerUserId
              ? userStore.getUser(relationship.ownerUserId)
              : null;
            if (relationship.ownerUserId && (!user || user.revokedAt !== undefined)) {
              throw Object.assign(new Error("Attached-host owner is unavailable"), {
                code: "EATTACHED_OWNER",
              });
            }
            return createVerifiedCaller(
              relationship.ownerRuntimeId,
              relationship.ownerRuntimeKind,
              null,
              null,
              user ? { userId: user.id, handle: user.handle } : null
            );
          },
        })
      : null;
  const attachedHostDecisionConsumer = attachedHostChildEndpoint
    ? new AttachedHostDecisionConsumer({
        endpoint: attachedHostChildEndpoint,
        grantStore: capabilityGrantStore,
        revalidate: (challenge) => attachedHostApprovalResolver(challenge) !== null,
      })
    : null;
  const attachedHostApprovalClient =
    attachedHostChildEndpoint && attachedParentGatewayUrl
      ? new HttpAttachedHostApprovalClient({
          parentGatewayUrl: attachedParentGatewayUrl,
          endpoint: attachedHostChildEndpoint,
        })
      : null;
  const attachedHostController = new AttachedHostController(
    attachedHostParentEndpoint,
    ({ sessionId, developmentRunId, childGenerationId: lostGenerationId }) => {
      const doDispatch = resolvedDoDispatchForTitles;
      if (!doDispatch) return;
      void doDispatch.dispatch(
        {
          source: "vibestudio/internal",
          className: "DevelopmentDO",
          objectKey: workspaceId,
        },
        "nativeRunEvent",
        {
          kind: "attached-route-lost",
          runId: developmentRunId,
          sessionId,
          childGenerationId: lostGenerationId,
        }
      );
    }
  );

  const ordinaryAuthorityAcquirer: import("./services/attachedHostAuthorityBridge.js").OrdinaryAuthorityAcquirer =
    {
      request: (input) => acquisitionCoordinator.request(input),
      acquire: (input, signal) => acquisitionCoordinator.requestAndWait(input, signal),
      consume: (grantId) => acquisitionCoordinator.consume(grantId),
      touch: (grantId) => acquisitionCoordinator.touch(grantId),
      priorInteractiveApprovalCount: (input) =>
        capabilityGrantStore.priorInteractiveApprovalCount(input),
      invalidate: (snapshotDigest, ownerRuntimeId, callerPrincipal) =>
        acquisitionCoordinator.invalidate(snapshotDigest, ownerRuntimeId, callerPrincipal),
      proposeReviewedClosureRevision: ({ snapshot, tier, resource }) => {
        if (snapshot.reviewedClosureSubject === "-") {
          throw new Error("Authority revision proposal requires a reviewed-closure invocation");
        }
        const source = reviewedClosureRegistry.sourceForSession(snapshot.sessionId);
        const ref = source ? parseDoTargetId(source.issuer) : null;
        const dispatcher = resolvedDoDispatchForTitles;
        if (!source || source.sourceDocument.kind !== "mission" || !ref || !dispatcher) {
          throw new Error("Reviewed closure has no reachable source-document owner");
        }
        void dispatcher
          .dispatch(ref, "proposeAuthorityRevision", {
            missionId: source.sourceDocument.id,
            capability: snapshot.capability,
            resource,
            tier,
          })
          .catch((error) => {
            console.error("[ReviewedClosure] Could not record revision proposal:", error);
          });
      },
    };
  dispatcher.setAuthorityAcquirer(
    attachedHostChildEndpoint && attachedHostDecisionConsumer && attachedHostApprovalClient
      ? attachedHostAwareAuthorityAcquirer(
          ordinaryAuthorityAcquirer,
          new AttachedHostAuthorityBridge({
            endpoint: attachedHostChildEndpoint,
            decisionConsumer: attachedHostDecisionConsumer,
            present: (challenge, signal) => attachedHostApprovalClient.present(challenge, signal),
          })
        )
      : ordinaryAuthorityAcquirer
  );
  /**
   * The exact `repoPath@effectiveVersion` set the creation review is asking
   * about, once it is known. Null while startup reconcile is still running.
   */
  let creationReviewUnits: ReadonlySet<string> | null = null;
  /** False once the review has resolved, or been found to owe nothing. */
  let creationReviewOwed = true;
  /**
   * Host-owned semantic startup state. `preparing` means startup can still
   * publish the creation review; every other state proves that preparation has
   * completed without inferring that fact from an empty queue or elapsed time.
   */
  let workspaceCreationReviewState: WorkspaceCreationReviewState = { status: "preparing" };
  const codeIdentityKey = (code: { repoPath: string; effectiveVersion: string }): string =>
    `${code.repoPath}@${code.effectiveVersion}`;
  /**
   * Client apps and the extensions a host target requires are decided at the
   * launch gate, in a host-owned window, before the workspace UI exists (§7.6).
   * The creation review never covers one, whatever its admission state.
   */
  const isLaunchGateRepoPath = (repoPath: string): boolean => {
    for (const decl of resolveDeclaredApps(workspaceConfig)) {
      if (decl.source === repoPath) return true;
    }
    for (const decl of resolveDeclaredExtensions(workspaceConfig)) {
      if (decl.source === repoPath) return true;
    }
    for (const decl of resolveHostTargetRequiredExtensions(workspaceConfig)) {
      if (decl.source === repoPath) return true;
    }
    return false;
  };
  // U6 — while a review covering a unit is unresolved, that unit's calls get one
  // recoverable `review-pending` error instead of one acquisition entry per
  // method. Two things count as an open review: a review sitting in the queue
  // that names this exact version, and the creation review a fresh workspace
  // owes for the parts its ungated publication landed.
  dispatcher.setOpenReviewLookup((code) => {
    // A launch-gate unit is never told to wait, by any review, ever.
    //
    // The gate is answered in a host-owned window before the workspace UI
    // exists (§7.6), and `apps/shell` is the surface every OTHER review renders
    // in. If it is running at all, the gate that admitted it was already
    // answered — so a later review naming it can only be one it cannot reach,
    // and reporting that produced `Waiting for you to finish reviewing Start
    // this workspace?` in the shell's own notification bar, with the workspace
    // wedged behind it. Whatever a second gate is waiting for, the answer is
    // never "make the shell stop working".
    if (isLaunchGateRepoPath(code.repoPath)) return null;
    for (const pending of approvalQueue.listPending()) {
      if (pending.kind !== "unit-install-review") continue;
      const covered = pending.parts.some(
        (part) => part.repoPath === code.repoPath && part.effectiveVersion === code.effectiveVersion
      );
      if (covered) return { approvalId: pending.approvalId, title: pending.title };
    }
    // The creation review covers exactly the units it is going to ask about,
    // and never one more. Deriving the answer from "is anything unadmitted"
    // instead is the other half of the same deadlock.
    if (!creationReviewOwed) return null;
    if (creationReviewUnits) {
      return creationReviewUnits.has(codeIdentityKey(code))
        ? { approvalId: "workspace-creation-review", title: "what's in your workspace" }
        : null;
    }
    // The owed set is not computed until startup reconcile has finished.
    if (!unitAdmissionStore.hasVersion(code.repoPath, code.effectiveVersion)) {
      return { approvalId: "workspace-creation-review", title: "what's in your workspace" };
    }
    return null;
  });
  const container = new ServiceContainer(dispatcher);
  const getEntityStore = (): import("./workspaceEntityStore.js").WorkspaceEntityStore =>
    ensureEntityStore(container.get<import("./doDispatch.js").DODispatch>("doDispatch"));
  const lifecycleContextStore: import("./services/lifecycleContextControl.js").LifecycleContextControlStore =
    {
      listContextEdgesByOwner: (input) => getEntityStore().listContextEdgesByOwner(input),
      listContextEdgesByChild: (contextId) => getEntityStore().listContextEdgesByChild(contextId),
      resolveRecord: (id) => getEntityStore().resolveRecord(id),
    };

  // Route registry — shared across workerdManager (registers manifest-declared
  // worker routes) and the gateway (dispatches `/_r/` requests). Constructed
  // early so both consumers can wire it without awaiting other services.
  const { RouteRegistry } = await import("./routeRegistry.js");
  const routeRegistry = new RouteRegistry();
  routeRegistry.registerHttpServiceRoutes(
    attachedHostParentHttpRoutes(attachedHostApprovalPresenter)
  );
  if (attachedHostChildEndpoint) {
    routeRegistry.registerHttpServiceRoutes(attachedHostHttpRoutes(attachedHostChildEndpoint));
  }

  let attachedHostsDefinition:
    | import("@vibestudio/shared/serviceDefinition").ServiceDefinition
    | null = null;
  container.registerManaged({
    name: "attachedHosts",
    dependencies: [],
    async start() {
      attachedHostsDefinition = createAttachedHostsService({
        parent: attachedHostParentEndpoint,
        controller: attachedHostController,
        approvalPresenter: attachedHostApprovalPresenter,
        ...(attachedHostChildEndpoint ? { child: attachedHostChildEndpoint } : {}),
      });
    },
    getServiceDefinition() {
      if (!attachedHostsDefinition) {
        throw new Error("attachedHosts service not initialized");
      }
      return attachedHostsDefinition;
    },
  });

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

  const { BootstrapWorkspaceSource } = await import("./buildV2/bootstrapWorkspaceSource.js");
  const bootstrapWorkspaceSource = new BootstrapWorkspaceSource(workspaceId, workspacePath);
  // Capture the source identity before any semantic service can publish into
  // the live workspace projection. All later bootstrap references use this
  // immutable value; they must not rediscover the mutable source directory.
  const bootstrapSnapshot = await bootstrapWorkspaceSource.seal();
  trustedBootstrapStateHash = bootstrapSnapshot.stateHash;
  container.registerManaged({
    name: "bootstrapBuildSystem",
    async start() {
      return initBuildSystemV2(
        workspacePath,
        bootstrapWorkspaceSource,
        appNodeModules.length > 0 ? appNodeModules : [path.join(appRoot, "node_modules")],
        {
          appRoot,
          dependencyWorkspaceRoot: buildDependencyWorkspaceRoot,
        }
      );
    },
    async stop(instance: import("./buildV2/index.js").BuildSystemV2 | null) {
      await instance?.shutdown();
    },
  });

  // Steady-state build system, installed only after the workspace source
  // provider has accepted the exact bootstrap snapshot.
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
          workspaceIdStability: workspaceIsEphemeral ? "ephemeral" : "stable",
          workspaceAuthorityEnvironmentAt: async (stateHash) => {
            const { exactWorkspaceServiceBindings } =
              await import("./buildV2/userlandAuthority.js");
            return {
              services: exactWorkspaceServiceBindings(
                await loadWorkspaceConfigFromState(stateHash)
              ),
            };
          },
          executionRootProviders: [
            buildKeyRootProvider({
              id: "app-generation",
              owner: "app-generation",
              buildKeys() {
                const appHost = appHostForGateway;
                if (!appHost) throw new Error("App registry is not available");
                return appHost.registry
                  .list()
                  .filter((entry) => entry.target !== "terminal")
                  .flatMap((entry) => [
                    ...(entry.activeBundleKey
                      ? [
                          {
                            ownerId: entry.name,
                            buildKey: entry.activeBundleKey,
                            reason: "active" as const,
                          },
                        ]
                      : []),
                    ...entry.previousVersions.map((version) => ({
                      ownerId: entry.name,
                      buildKey: version.activeBundleKey,
                      reason: "rollback" as const,
                    })),
                  ]);
              },
              resolve: ({ buildKey }) => {
                const build = buildStoreForPublication.peekLocal(buildKey);
                return build ? executionArtifactRefFromBuild(workspaceId, build) : null;
              },
            }),
            buildKeyRootProvider({
              id: "terminal-app",
              owner: "terminal-app",
              buildKeys() {
                const appHost = appHostForGateway;
                if (!appHost) throw new Error("App registry is not available");
                return appHost.registry
                  .list()
                  .filter((entry) => entry.target === "terminal")
                  .flatMap((entry) => [
                    ...(entry.activeBundleKey
                      ? [
                          {
                            ownerId: entry.name,
                            buildKey: entry.activeBundleKey,
                            reason: "active" as const,
                          },
                        ]
                      : []),
                    ...entry.previousVersions.map((version) => ({
                      ownerId: entry.name,
                      buildKey: version.activeBundleKey,
                      reason: "rollback" as const,
                    })),
                  ]);
              },
              resolve: ({ buildKey }) => {
                const build = buildStoreForPublication.peekLocal(buildKey);
                return build ? executionArtifactRefFromBuild(workspaceId, build) : null;
              },
            }),
            buildKeyRootProvider({
              id: "extension-generation",
              owner: "extension-generation",
              buildKeys() {
                const extensionHost = extensionHostForGateway;
                if (!extensionHost) throw new Error("Extension registry is not available");
                return extensionHost.registry.list().flatMap((entry) =>
                  entry.activeBundleKey
                    ? [
                        {
                          ownerId: entry.name,
                          buildKey: entry.activeBundleKey,
                          reason: "active" as const,
                        },
                      ]
                    : []
                );
              },
              resolve: ({ buildKey }) => {
                const build = buildStoreForPublication.peekLocal(buildKey);
                return build ? executionArtifactRefFromBuild(workspaceId, build) : null;
              },
            }),
            {
              id: "runtime-image",
              mandatory: true,
              async snapshotRoots() {
                const workerdManager = workerdManagerForGateway;
                if (!workerdManager) throw new Error("Runtime image store is not available");
                return workerdManager.listRuntimeImages().map((image) => ({
                  owner: "runtime-image" as const,
                  ownerId: image.id,
                  reason: "active" as const,
                  artifact: image.artifact,
                }));
              },
            },
            buildKeyRootProvider({
              id: "runtime-entity",
              owner: "runtime-entity",
              buildKeys: () =>
                entityCache.listActive().flatMap((entity) =>
                  entity.activeBuildKey
                    ? [
                        {
                          ownerId: entity.id,
                          buildKey: entity.activeBuildKey,
                          reason: "active" as const,
                          executionDigest: entity.activeExecutionDigest,
                        },
                      ]
                    : []
                ),
              resolve: ({ buildKey, executionDigest }) => {
                const build = buildStoreForPublication.peekLocal(buildKey);
                if (build) return executionArtifactRefFromBuild(workspaceId, build);
                return executionDigest
                  ? (productSeedArtifactByIdentity.get(`${buildKey}\0${executionDigest}`) ?? null)
                  : null;
              },
            }),
            {
              id: "panel-history",
              mandatory: true,
              async snapshotRoots() {
                if (!entityStoreInstance)
                  throw new Error("Workspace entity store is not available");
                return (await entityStoreInstance.listExecutionRoots())
                  .filter((entity) => entity.kind === "panel" && entity.activeBuildKey)
                  .map((entity) => {
                    const build = buildStoreForPublication.peekLocal(entity.activeBuildKey!);
                    if (!build) {
                      throw new Error(
                        `Panel history ${entity.id} references missing build ${entity.activeBuildKey}`
                      );
                    }
                    return {
                      owner: "panel-history" as const,
                      ownerId: entity.id,
                      reason:
                        entity.status === "active" ? ("active" as const) : ("rollback" as const),
                      artifact: executionArtifactRefFromBuild(workspaceId, build),
                    };
                  });
              },
            },
            evalRunRootProvider,
            developmentRunRootProvider,
            {
              id: "product-seed",
              mandatory: true,
              async snapshotRoots() {
                // Product code comes from the verified application bundle,
                // outside workspace BuildStore.
                return productSeedArtifacts.map((artifact) => ({
                  owner: "product-seed" as const,
                  ownerId: artifact.executionDigest,
                  reason: "pinned" as const,
                  artifact,
                }));
              },
            },
          ],
          onRetentionDiagnostic(report) {
            const level = report.complete ? "warn" : "error";
            const message =
              report.providerFailures.length > 0
                ? `Build retention diagnostic is incomplete (${report.providerFailures.length} provider failure${report.providerFailures.length === 1 ? "" : "s"})`
                : report.unresolvedAuthoritativeRootBuildKeys.length > 0
                  ? `Build retention diagnostic has ${report.unresolvedAuthoritativeRootBuildKeys.length} unresolved authoritative root${report.unresolvedAuthoritativeRootBuildKeys.length === 1 ? "" : "s"}`
                  : `Build cache contains ${report.unreferenced} unreferenced build${report.unreferenced === 1 ? "" : "s"} (${report.unreferencedBytes} bytes)`;
            const fields = {
              complete: report.complete,
              roots: report.roots,
              rootBuildKeys: report.rootBuildKeys,
              storedRootBuildKeys: report.storedRootBuildKeys,
              unresolvedAuthoritativeRootBuildKeys: report.unresolvedAuthoritativeRootBuildKeys,
              reachableBuilds: report.reachableBuilds,
              unreferenced: report.unreferenced,
              unreferencedBytes: report.unreferencedBytes,
              providerFailures: report.providerFailures,
              quarantined: report.quarantined,
              deleted: report.deleted,
              retainedForGrace: report.retainedForGrace,
              notReconstructible: report.notReconstructible,
              notReconstructibleDetails: report.notReconstructibleDetails,
              cleanupFailures: report.cleanupFailures,
            };
            // The server log is both durable JSONL and a live subscribed event
            // stream, so operators can inspect this finding after the caller
            // that requested the report is gone.
            serverLogStore.append(level, [`[BuildRetention] ${message}`, fields]);
          },
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
  // first interactive `eval.start` doesn't pay the cold esbuild compiles (the bulk
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
  const { listBuildUnitCatalog } = await import("./services/buildUnitCatalog.js");
  const { createPresenceService, createPresenceTracker } =
    await import("./services/presenceService.js");
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
        const buildSystem = assertPresent(buildSystemInstance);
        return createBuildService({
          buildSystem,
          listUnits: () =>
            listBuildUnitCatalog({
              buildSystem,
              hostedSources: () =>
                trustedUnitHosts().flatMap((host) =>
                  host.listWorkspaceUnits().map((row) => ({
                    name: row.name,
                    kind: row.kind,
                    source: row.source,
                    status: row.status,
                    activeBundleKey: row.activeBundleKey,
                    lastError: row.lastError,
                    pendingApproval: "pendingApproval" in row ? row.pendingApproval : null,
                  }))
                ),
              workerSources: () => workerdManagerForGateway?.listInstances() ?? [],
              workerError: (source) => workerdManagerForGateway?.getLastWorkerError(source) ?? null,
              authorityRows: (requests) =>
                summarizeAuthorityRequests(requests, [], describeCapability).rows,
            }),
        });
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

  // Workspace config publication is a domain-neutral digest-bound protected
  // write. Git interpretation lives entirely in the manifest-selected bridge.
  const { createWorkspaceConfigMainWriter } = await import("./workspaceConfigWriter.js");
  const workspaceConfigWriter = createWorkspaceConfigMainWriter({
    workspaceId,
    vcs: workspaceVcs,
  });
  const replaceLiveWorkspaceConfig = (next: typeof workspaceConfig): void =>
    replaceWorkspaceConfig(workspaceConfig, { ...next, id: workspaceId });
  protectedRefStore.onRefsChanged((publication) => {
    cachedAuthorityCapabilities = null;
    const repos = publication.changes
      .filter((change) => change.nextContentRoot !== null)
      .map((change) => change.repoPath);
    if (repos.length === 0) return;
    eventService.emit("workspace:protected-refs-changed", { repoPaths: [...new Set(repos)] });
  });
  const { createBuildUnitChangeApprovalProvider } =
    await import("./services/buildUnitChangeApprovalProvider.js");
  const buildUnitChangeApprovalProvider = createBuildUnitChangeApprovalProvider({
    getBuildSystem: () => assertPresent(buildSystemInstance),
    describeCapability,
    admissionStore: unitAdmissionStore,
    grantStore: capabilityGrantStore,
    selections: installReviewSelections,
  });
  {
    const { createVcsService } = await import("./services/vcsService.js");
    const { createMainAdvanceApprovalGate, createMainRefAdvanceGate } =
      await import("./services/mainAdvanceApproval.js");
    const { heldClearanceRowKeys } = await import("./services/unitClearanceGrants.js");
    const mainAdvanceGate = createMainAdvanceApprovalGate({
      authorizeEffect: (ctx, effect) => dispatcher.authorizeHostEffect(ctx, effect),
      hasAppCapability: (callerId, capability) =>
        appHostForGateway?.hasAppCapability(callerId, capability) ?? false,
      getProviders: () => [
        ...trustedUnitHosts(),
        buildUnitChangeApprovalProvider,
        recurringMetaChangeProvider,
      ],
      resolveUnitOrigins,
      // Descriptive relationship state lets the gate attribute newly arriving
      // units to the template operation that staged them. It is not an
      // integrity boundary; protected-main validation and VCS remain canonical.
      readTemplateState: async (stateHash) => {
        const at = stateHash ?? (await workspaceVcs.ensureFresh()).stateHash;
        return readWorkspaceFileAtState(at, "meta/templates.state.yml");
      },
      admittedOriginKeys: () => unitAdmissionStore.admittedOriginKeys(),
      reportInstallLandingByToken: (landingToken, report) =>
        approvalQueue.reportInstallLandingByToken?.(landingToken, report),
      heldClearanceFor: (repoPath) => {
        const active = entityCache.resolveActiveBySource(repoPath);
        if (!active?.source.effectiveVersion) return null;
        return heldClearanceRowKeys({
          grantStore: capabilityGrantStore,
          repoPath,
          effectiveVersion: active.source.effectiveVersion,
        });
      },
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
      onWorkspaceInitialized: () => {
        // The one ungated publication owes a review. Record the root template
        // it landed so the review can head with where the code came from —
        // URL and human ref only, never a commit id (§7.1, §7.6.3).
        const pin = rootTemplateBootstrap.readDescriptor()?.rootTemplate ?? null;
        workspaceCreationReview.markPending(
          pin ? { url: pin.url, ref: pin.ref, version: pin.ref } : undefined
        );
      },
      beginCandidateReview: (candidate) => {
        const runtimeKind = candidate.caller.runtime.kind;
        const callerKind = ["panel", "app", "worker", "do", "extension"].includes(runtimeKind)
          ? (runtimeKind as "panel" | "app" | "worker" | "do" | "extension")
          : "system";
        approvalQueue.beginPreparation?.({
          kind: "capability",
          capability: "workspace-main-advance",
          dedupKey: `workspace-publication:${candidate.publicationId}`,
          callerId: candidate.caller.runtime.id,
          callerKind,
          repoPath: candidate.caller.code?.repoPath ?? "vibestudio/session",
          effectiveVersion: candidate.caller.code?.effectiveVersion ?? candidate.stateHash,
          ...(candidate.caller.subject
            ? { requestedByUserId: candidate.caller.subject.userId }
            : {}),
          ...(candidate.signal ? { signal: candidate.signal } : {}),
          attention: "interrupt",
          title: "Preparing workspace update…",
          description: "Building and type-checking the candidate workspace before it can be saved.",
          resource: {
            type: "vcs-head",
            label: "Head",
            value:
              candidate.repoPaths.length === 1
                ? `${candidate.repoPaths[0]} main`
                : `${candidate.repoPaths.length} workspace repositories`,
          },
          grantResourceKey: `workspace-source-change:publication:${candidate.publicationId}`,
        });
      },
      updateCandidateReview: (publicationId, progress) =>
        approvalQueue.updatePreparation?.(`workspace-publication:${publicationId}`, progress),
      failCandidateReview: (publicationId, error) =>
        approvalQueue.failPreparation?.(`workspace-publication:${publicationId}`, error),
      discardCandidateReview: (publicationId) =>
        approvalQueue.discardPreparation?.(`workspace-publication:${publicationId}`),
      validateCandidateWorkspaceState: async (stateHash, changedPaths, signal, reportProgress) => {
        reportProgress?.({
          label: "Finding affected workspace projects",
          detail: "Tracing changed projects and the workspace code that depends on them.",
        });
        const candidateConfig = await loadWorkspaceConfigFromState(stateHash);
        const candidateDecls = buildWorkspaceDeclarations(candidateConfig);
        const buildSystem = assertPresent(buildSystemInstance);
        try {
          const classesBySource = new Map<string, Set<string>>();
          const addClass = (source: string, className: string): void => {
            let classes = classesBySource.get(source);
            if (!classes) classesBySource.set(source, (classes = new Set()));
            classes.add(className);
          };
          for (const singleton of candidateDecls.singletons.all()) {
            addClass(singleton.source, singleton.className);
          }
          for (const service of candidateDecls.services) {
            if (service.durableObject) addClass(service.source, service.durableObject.className);
          }
          for (const route of candidateDecls.routes) {
            if (route.durableObject) addClass(route.source, route.durableObject.className);
          }
          const unitNames = await buildSystem.listAffectedBuildUnits(
            stateHash,
            changedPaths,
            signal
          );
          // A manifest-only change can expose a previously undeclared class
          // without changing its worker files. Probe every referenced source
          // against the exact candidate state in that case.
          if (changedPaths.some((changed) => changed.startsWith("meta/"))) {
            for (const source of classesBySource.keys()) {
              if (!unitNames.includes(source)) unitNames.push(source);
            }
          }
          let completedBuilds = 0;
          const activeBuildPhases = new Map<string, "bundling" | "typechecking">();
          let lastBuildDetail: string | undefined;
          const reportBuildActivity = (): void => {
            const bundling = [...activeBuildPhases.values()].filter(
              (phase) => phase === "bundling"
            ).length;
            const typechecking = [...activeBuildPhases.values()].filter(
              (phase) => phase === "typechecking"
            ).length;
            const waiting = Math.max(
              0,
              unitNames.length - completedBuilds - activeBuildPhases.size
            );
            const parts = [
              bundling > 0 ? `${bundling} bundling` : undefined,
              typechecking > 0 ? `${typechecking} type-checking` : undefined,
              waiting > 0 ? `${waiting} waiting to start` : undefined,
              completedBuilds > 0 ? `${completedBuilds} finished` : undefined,
            ].filter((part): part is string => part !== undefined);
            const detail =
              completedBuilds === unitNames.length
                ? "All affected project checks finished."
                : `Projects run in parallel: ${parts.join("; ")}.`;
            if (detail === lastBuildDetail) return;
            lastBuildDetail = detail;
            reportProgress?.({
              label: "Building and type-checking workspace projects",
              detail,
              completed: completedBuilds,
              total: unitNames.length,
            });
          };
          reportProgress?.({
            label: "Building and type-checking workspace projects",
            detail:
              unitNames.length === 0
                ? "No buildable workspace projects were affected."
                : `Verifying ${unitNames.length} affected ${unitNames.length === 1 ? "project" : "projects"} in parallel. A first cold verification can take a few minutes.`,
            completed: completedBuilds,
            total: unitNames.length,
          });
          const reports = await Promise.all(
            unitNames.map(async (unitName) => {
              const report = await buildSystem.getBuildReport(unitName, stateHash, ({ phase }) => {
                activeBuildPhases.set(unitName, phase);
                reportBuildActivity();
              });
              activeBuildPhases.delete(unitName);
              completedBuilds += 1;
              reportBuildActivity();
              return report;
            })
          );
          const failures = reports.flatMap((report) =>
            report.diagnostics
              .filter((diagnostic) => diagnostic.severity === "error")
              .map(
                (diagnostic) =>
                  `${report.repoPath}${diagnostic.line ? `:${diagnostic.line}` : ""}: ${diagnostic.message}`
              )
          );
          if (failures.length > 0) {
            const { BuildGateFailedError } = await import("./buildV2/diagnostics.js");
            throw new BuildGateFailedError(
              reports.flatMap((report) =>
                report.diagnostics.filter((diagnostic) => diagnostic.severity === "error")
              ),
              unitNames,
              stateHash
            );
          }
          const manager = workerdManagerForGateway;
          const schemaReports = reports.filter(
            (report) => report.kind === "worker" && classesBySource.has(report.repoPath)
          );
          if (!manager && schemaReports.length > 0) {
            throw new Error("Durable Object schema publication gate is not ready");
          }
          if (manager) {
            reportProgress?.({
              label: "Checking workspace data compatibility",
              detail: `Verifying ${schemaReports.length} worker ${schemaReports.length === 1 ? "schema" : "schemas"} against existing workspace data.`,
            });
            const probeResults = (
              await Promise.all(
                schemaReports.flatMap((report) => {
                  const buildKey = report.builds.find(
                    (entry) => entry.target === "runtime"
                  )?.buildKey;
                  const build = buildKey ? buildSystem.getBuildByKey(buildKey) : null;
                  const classes = classesBySource.get(report.repoPath);
                  if (!build || !classes) return [];
                  return [...classes].map(async (className) => {
                    try {
                      return {
                        candidate: {
                          source: report.repoPath,
                          effectiveVersion: build.metadata.ev,
                          descriptor: await manager.probeDurableObjectSchema(
                            report.repoPath,
                            className,
                            build
                          ),
                        },
                      };
                    } catch (error) {
                      return {
                        failure: `${report.repoPath}:${className} schema probe failed: ${error instanceof Error ? error.message : String(error)}`,
                      };
                    }
                  });
                })
              )
            ).flat();
            const schemaCandidates = probeResults.flatMap((result) =>
              result.candidate ? [result.candidate] : []
            );
            const schemaFixtureFailures = (
              await Promise.all(
                schemaCandidates.map(async (candidate) => {
                  const report = schemaReports.find((entry) => entry.repoPath === candidate.source);
                  const buildKey = report?.builds.find(
                    (entry) => entry.target === "runtime"
                  )?.buildKey;
                  const build = buildKey ? buildSystem.getBuildByKey(buildKey) : null;
                  if (!build) {
                    return [
                      `${candidate.source}:${candidate.descriptor.className} fixture gate lost its candidate build`,
                    ];
                  }
                  return await manager.validateDurableObjectSchemaFixtures({
                    ...candidate,
                    build,
                  });
                })
              )
            ).flat();
            const schemaFailures = [
              ...probeResults.flatMap((result) => (result.failure ? [result.failure] : [])),
              ...schemaFixtureFailures,
              ...(schemaCandidates.length > 0
                ? manager.validateAndStageDurableObjectSchemas(stateHash, schemaCandidates)
                : []),
            ];
            if (schemaFailures.length > 0) {
              const { BuildGateFailedError } = await import("./buildV2/diagnostics.js");
              throw new BuildGateFailedError(
                schemaFailures.map((message) => ({
                  source: "schema" as const,
                  severity: "error" as const,
                  file: "",
                  line: 0,
                  column: 0,
                  message,
                })),
                unitNames,
                stateHash
              );
            }
          }
          reportProgress?.({ label: "Checking permissions and authority declarations" });
          await buildSystem.stageAuthorityIndex(stateHash, signal);
        } catch (error) {
          buildSystem.discardAuthorityIndex(stateHash);
          throw error;
        }
      },
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
          testPolicyForContext: (contextId) =>
            agentExecutionSessions.testPolicyForContext(contextId),
        });
      },
    });
  }
  const { wireRuntimeObservability } = await import("./bootstrap/runtimeObservability.js");
  wireRuntimeObservability({
    container,
    statePath,
    workspaceId,
    eventService,
    diagnostics: runtimeDiagnostics,
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
      workspaceCreationReviewState: () => workspaceCreationReviewState,
      hasAppCapability: (callerId, capability) =>
        appHostForGateway?.hasAppCapability(callerId, capability) ?? false,
    })
  );
  const { BrowserPermissionGrantProjection, createBrowserPermissionsService } =
    await import("./services/browserPermissionsService.js");
  const browserPermissionGrantStore = new BrowserPermissionGrantProjection(capabilityGrantStore);
  container.registerRpc(
    createBrowserPermissionsService({
      approvalQueue,
      workspaceId,
      grantStore: browserPermissionGrantStore,
      eventService,
    })
  );
  const { createCorsApprovalService } = await import("./services/corsApprovalService.js");
  container.registerRpc(createCorsApprovalService());
  // ── Relay backhaul: OAuth callbacks + third-party webhooks ride one
  // authenticated server→relay pipe (the home server has no public endpoint).
  // Inert until start(); returns null when no relay is configured. Created
  // before the credential/webhook services so its client can be their
  // registrar, with handlers that close over the refs assigned below. ──
  const { startRelayBackhaul, getRelayOrigin } = await import("./services/relayBackhaulClient.js");
  const { ensurePersistentCert: ensureRelayIdentity } = await import("../node/webrtc/cert.js");
  ensureRelayIdentity({ identityPemFile: workspaceIdentityPemFile });
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
    identityPemFile: workspaceIdentityPemFile,
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
  const relayOAuthRegistrar = {
    register: (id: string, platform: "mobile" | "desktop") =>
      relayBackhaul.client.registerOAuth(id, platform),
  };

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
    workspaceId,
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
    const activeAgentBindings = () => {
      const graph = buildSystemInstance?.getGraph().allNodes() ?? [];
      const agentSources = new Set(
        graph.filter((node) => node.manifest.agent).map((node) => node.relativePath)
      );
      return entityCache
        .listActive()
        .filter(
          (record) =>
            record.kind === "do" &&
            record.contextId !== null &&
            agentSources.has(record.source.repoPath)
        )
        .map((record) => `${record.id}@${record.contextId}`);
    };
    const interruptAgentBinding = async (bindingId: string, reason: string): Promise<void> => {
      console.info(`[AuthoritySafety] state=stopping ${bindingId}: ${reason}`);
      const separator = bindingId.lastIndexOf("@");
      const runtimeId = separator > 0 ? bindingId.slice(0, separator) : bindingId;
      const ref = parseDoTargetId(runtimeId);
      if (!ref) return;
      const dispatch = container.get<import("./doDispatch.js").DODispatch>("doDispatch");
      await dispatch.dispatch(ref, "interruptAllChannels", true);
    };
    container.registerRpc(
      createPermissionsService({
        capabilityGrants: capabilityGrantStore,
        credentialUseGrants: credentialUseGrantStore,
        browserPermissions: browserPermissionGrantStore,
        workspaceId,
        // §7.7's origin line reads from the same admission record the review
        // wrote, so "where did this come from" is answered by the decision
        // itself rather than re-derived from the grant's shape.
        admissionProvenance: (repoPath, effectiveVersion) =>
          unitAdmissionStore.provenanceForVersion(repoPath, effectiveVersion),
        pendingAcquisitionCount: () => acquisitionCoordinator.pending().length,
        activeAgentBindingCount: () => new Set(activeAgentBindings()).size,
        activeAgentBindings: () => [...new Set(activeAgentBindings())],
        closeAgentAcquisitions: (bindingId) => acquisitionCoordinator.closeAgent(bindingId),
        closeAllAcquisitions: () => acquisitionCoordinator.closeAll(),
        interruptAgent: interruptAgentBinding,
        resumeAgent: async () => {
          // Removing the durable pause lock re-opens admission. The next
          // queued/user event owns wake-up; resuming must not manufacture work.
        },
        interruptAllAgents: async (reason) => {
          const bindings = new Set(activeAgentBindings());
          await Promise.all(
            [...bindings].map((bindingId) => interruptAgentBinding(bindingId, reason))
          );
        },
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
    const { createReviewedClosureService } = await import("./services/reviewedClosureService.js");
    container.registerRpc(createReviewedClosureService({ registry: reviewedClosureRegistry }));
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

  // ── bounded host/workerd performance diagnostics ──
  {
    const { createHostPerformanceService } = await import("./services/hostPerformanceService.js");
    container.registerRpc(
      createHostPerformanceService({
        startedAt: serverLogStartedAt,
        eventLoopSamples: () => eventLoopSamples,
        workerdSnapshot: () => workerdManagerForGateway?.performanceSnapshot() ?? null,
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
  let closeEvalKernelLeases: (() => Promise<void>) | null = null;
  let closeActiveEvalRuns: ((deadlineMs?: number) => Promise<void>) | null = null;
  {
    const { createEvalService } = await import("./services/evalService.js");
    let evalDefinition: import("@vibestudio/shared/serviceDefinition").ServiceDefinition | null =
      null;
    container.registerManaged({
      name: "eval",
      dependencies: ["workerdWorkspace", "workerdManager", "doDispatch", "runtime"],
      async start(resolve) {
        const doDispatch = assertPresent(
          resolve<import("./doDispatch.js").DODispatch>("doDispatch")
        );
        const workerdManager = assertPresent(
          resolve<import("./workerdManager.js").WorkerdManager>("workerdManager")
        );
        const runtime = assertPresent(
          resolve<import("./services/runtimeService.js").RuntimeServiceResult>("runtime")
        );
        const evalEntityStore = ensureEntityStore(doDispatch);
        const { createEvalEventIngressService, EvalEventSinkRegistry } =
          await import("./services/evalEventIngressService.js");
        const evalEventSinks = new EvalEventSinkRegistry();
        dispatcher.registerService(
          createEvalEventIngressService({
            entityStore: evalEntityStore,
            eventService,
            sinks: evalEventSinks,
          })
        );
        const { createEvalExecutionRootsService } =
          await import("./services/evalExecutionRootsService.js");
        dispatcher.registerService(
          createEvalExecutionRootsService({
            doDispatch,
            entityStore: evalEntityStore,
            publicationPort: executionPublicationJournal,
          })
        );
        evalRunRootProvider.bind({
          id: "eval-run",
          mandatory: true,
          async snapshotRoots() {
            const entities = (await evalEntityStore.listActive("do")).filter(
              (entity) =>
                entity.source.repoPath === "vibestudio/internal" &&
                entity.className === "EvalDO" &&
                typeof entity.key === "string"
            );
            const roots = [];
            for (const entity of entities) {
              const retained = (await doDispatch.dispatch(
                {
                  source: "vibestudio/internal",
                  className: "EvalDO",
                  objectKey: entity.key!,
                },
                "listRetainedExecutionRoots"
              )) as Array<{
                runId: string;
                moduleSpecifier: string;
                artifact: import("@vibestudio/shared/execution/retention").ExecutionArtifactRefV1;
              }>;
              for (const row of retained) {
                roots.push({
                  owner: "eval-run" as const,
                  ownerId: `${entity.id}:${row.runId}:${row.moduleSpecifier}`,
                  reason: "active" as const,
                  artifact: row.artifact,
                });
              }
            }
            return roots;
          },
        });
        dispatcher.setAuthorityObserver(({ executionSession, kind, payload }) => {
          const prefix = "do:vibestudio/internal:EvalDO:";
          if (!executionSession.eval.runtimeId.startsWith(prefix)) return;
          return doDispatch
            .dispatch(
              {
                source: "vibestudio/internal",
                className: "EvalDO",
                objectKey: executionSession.eval.runtimeId.slice(prefix.length),
              },
              "appendAuthorityEvent",
              executionSession.eval.runId,
              kind,
              {
                ...payload,
                callerId: executionSession.eval.runtimeId,
                taskRef: executionSession.taskRef,
                taskAuthority: executionSession.taskAuthority,
              }
            )
            .then(() => undefined);
        });
        evalDefinition = createEvalService({
          doDispatch,
          entityStore: evalEntityStore,
          retireEntity: (id) => runtime.internal.retireEntity(id),
          tokenManager,
          workspaceId,
          executionSessions: agentExecutionSessions,
          taskAuthorities,
          reviewedClosureFactForSession: (sessionId) =>
            reviewedClosureRegistry.factForSession(sessionId),
          isSystemTestHarness: (caller, runId) =>
            runId.startsWith("system-test-runner:") &&
            isBlessedSystemTestConduit(caller, (identity) =>
              conduitBlessingStore.isBlessed(identity)
            ),
          activity: activityRegistry,
          recoverUnresponsiveSandbox: ({ runId, timeoutMs }) =>
            workerdManager.recoverUnresponsiveSandbox(
              `eval ${runId} remained unresponsive after ${timeoutMs}ms`
            ),
          onKernelLeaseCoordinator: (coordinator) => {
            closeEvalKernelLeases = () => coordinator.close();
          },
          onShutdown: (shutdown) => {
            closeActiveEvalRuns = shutdown;
          },
          preauthorize: (ctx, operation) =>
            dispatcher.preauthorizeAuthority(
              ctx,
              operation.service,
              operation.method,
              operation.args
            ),
          eventSinks: evalEventSinks,
          resolveContextSource: async (contextId, sourcePath) => {
            const contentStateHash = await workspaceVcs.resolveContextState(contextId);
            const sourceState = workspaceVcs.executionStateForContent(contentStateHash);
            if (!sourceState) {
              throw new Error(
                `eval context ${contextId} has no semantic identity for ${contentStateHash}`
              );
            }
            const file = await workspaceVcs.readFile(contentStateHash, sourcePath);
            if (!file) throw new Error(`eval source file does not exist: ${sourcePath}`);
            if (file.content.kind !== "text") {
              throw new Error(`eval source file is not UTF-8 text: ${sourcePath}`);
            }
            return {
              code: file.content.text,
              sourceDigest: file.contentHash,
              sourceState,
              contentStateHash,
            };
          },
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
  let durableWorkDispatch: import("./doDispatch.js").DODispatch | null = null;

  // Slot-tree change fan-out: the workspace-state service pokes this after any
  // mutating slot.* method; the panel-tree bridge subscribes (registerSlotStateListener)
  // to self-heal its mirror + re-broadcast. Decoupled via a Set so the bridge
  // (created later in registerPanelServices) can register lazily.
  type SlotStateChange = import("./services/workspaceStateService.js").SlotStateChange;
  const slotStateListeners = new Set<(change?: SlotStateChange) => void>();
  const notifySlotStateListeners = (change?: SlotStateChange) => {
    for (const listener of slotStateListeners) {
      try {
        listener(change);
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
  const { UnitSupervisor } = await import("./services/unitSupervisor.js");
  const unitSupervisor = new UnitSupervisor();
  let runtimeServiceInternal: import("./services/runtimeService.js").RuntimeServiceInternal | null =
    null;

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
          getUnitIcon: getWorkspaceUnitIcon,
          panelAccess: (
            await import("./services/createPanelAccessPermissionDeps.js")
          ).createPanelAccessPermissionDeps({
            contextBoundary: contextBoundaryDeps,
            entityCache,
            lifecycleContextStore,
            getAppHost: () => appHostForGateway,
          }),
          // The DO already writes display_title in the same transaction as
          // searchable_title (see workspaceDO.panelIndex / panelUpdateTitle),
          // so the callback only needs to mirror into the in-memory cache.
          onPanelTitleChanged: (entityId, title, explicit) => {
            entityTitleService.mirrorCachedTitle(entityId, title, { explicit });
          },
          isEntityTitleExplicit: (entityId) => entityTitleService.isExplicit(entityId),
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
          await panelHttpServer.primeBuild(source, ref, async () => {
            const binding = await buildSystem.bindRuntimeImage(source, ref);
            const build = buildSystem.getBuildByKey(binding.artifact.buildKey);
            if (!build) {
              throw new Error(
                `Prebound panel image ${binding.artifact.buildKey} for ${source} is unavailable`
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
            authority,
          };
        };
        runtimeResult = createRuntimeService({
          taskAuthorities,
          unitSupervisor,
          entityStore: ensureEntityStore(doDispatch),
          contextFolders: contextFolderManager,
          onContextCreated: ({ contextId, ownerContextId, inheritedTestPolicy, casePolicy }) => {
            if (inheritedTestPolicy) {
              agentExecutionSessions.markTestContext(contextId, inheritedTestPolicy);
            } else {
              agentExecutionSessions.inheritTestContext(contextId, ownerContextId);
            }
            if (casePolicy) {
              agentExecutionSessions.attachCasePolicy(contextId, ownerContextId, casePolicy);
            }
          },
          onContextRemoved: ({ contextId }) => {
            agentExecutionSessions.removeTestContext(contextId);
          },
          onPanelExecutionActivated: (activation) => {
            eventService.emit("panel:executionActivated", activation);
          },
          // GAD-owned semantic context lifecycle for runtime entities.
          semanticContexts: {
            ensureContext: async (contextId) => {
              await workspaceVcs.ensureSemanticContext(contextId);
            },
            dropContext: (contextId) => workspaceVcs.dropContext(contextId),
            forkContext: async (sourceContextId, targetContextId) => {
              await workspaceVcs.forkContext(sourceContextId, targetContextId);
            },
            resolveWorkingState: (contextId) =>
              workspaceVcs
                .semanticDirectCall("vcsStatus", { contextId })
                .then(
                  (status) =>
                    (status as import("@vibestudio/service-schemas/vcs").VcsStatusResult)
                      .workingHead
                ),
            listContexts: (prefix) => workspaceVcs.listSemanticContexts(prefix),
          },
          hooks: {
            prepare: (async ({ spec, key, contextId, existingBuildKey, parent }) => {
              const targetId = canonicalEntityId({
                kind: spec.kind,
                source:
                  spec.kind === "session"
                    ? spec.source
                    : spec.execution.surface === "external"
                      ? `browser:${spec.execution.url}`
                      : spec.execution.source,
                className: spec.kind === "do" ? spec.className : undefined,
                key,
              });
              if (spec.execution.surface === "external") {
                if (!isOpenPanelBrowserUrl(spec.execution.url)) {
                  throw new Error(`Invalid external browser panel URL: ${spec.execution.url}`);
                }
                return {
                  surface: "external",
                  target: { id: targetId },
                  document: { requestedUrl: spec.execution.url },
                };
              }
              if (spec.execution.surface === "inert") {
                await contextFolderManager.ensureContextFolder(contextId);
                return { surface: "inert", target: { id: targetId } };
              }

              const source = spec.execution.source;
              const ref = spec.execution.ref;
              let prepared: {
                effectiveVersion: string;
                buildKey?: string;
                executionDigest?: string;
                authority?: import("@vibestudio/shared/authorityManifest").UnitAuthorityManifest;
                targetId?: string;
              };
              if (spec.kind === "do") {
                const active = existingBuildKey ? entityCache.resolveActive(targetId) : null;
                if (existingBuildKey) {
                  if (
                    !active?.activeBuildKey ||
                    !active.activeExecutionDigest ||
                    !active.activeAuthority ||
                    active.activeBuildKey !== existingBuildKey
                  ) {
                    throw new Error(
                      `Durable Object ${targetId} cannot reattach build ${existingBuildKey} without its matching active entity record`
                    );
                  }
                  await durableObjectExecutionReadiness.materialize(active);
                  prepared = {
                    targetId,
                    effectiveVersion: active.source.effectiveVersion,
                    buildKey: active.activeBuildKey,
                    executionDigest: active.activeExecutionDigest,
                    authority: active.activeAuthority,
                  };
                } else {
                  prepared = await workerdManager.ensureDurableObjectEntity({
                    source,
                    ref,
                    className: spec.className,
                    key,
                    contextId,
                    stateArgs: spec.stateArgs,
                  });
                }
              } else if (spec.kind === "worker") {
                prepared = await workerdManager.startWorker({
                  source,
                  ref,
                  key,
                  contextId,
                  stateArgs: spec.stateArgs,
                  env: spec.env,
                  parent,
                });
              } else if (spec.kind === "app") {
                prepared = await resolveBuildExecution(source, ref);
              } else if (spec.kind === "panel") {
                if (existingBuildKey) {
                  const build = buildSystem.getBuildByKey(existingBuildKey);
                  if (!build) {
                    throw new Error(
                      `Activated panel build ${existingBuildKey} for ${source} is unavailable from the immutable build store`
                    );
                  }
                  if (build.metadata.kind !== "panel" || build.metadata.sourcePath !== source) {
                    throw new Error(
                      `Activated panel build ${existingBuildKey} does not belong to panel source ${source}`
                    );
                  }
                  prepared = {
                    effectiveVersion: build.metadata.ev,
                    buildKey: existingBuildKey,
                    executionDigest: build.metadata.execution?.executionDigest,
                    authority: build.metadata.authority,
                  };
                } else {
                  const binding = await buildSystem.bindRuntimeImage(source, ref);
                  prepared = {
                    effectiveVersion: binding.artifact.sourceState.effectiveVersion,
                    buildKey: binding.artifact.buildKey,
                    executionDigest: binding.artifact.executionDigest,
                    authority: binding.authority,
                  };
                }
              } else {
                throw new Error(`Inert session ${targetId} cannot request code preparation`);
              }
              if (!prepared.buildKey || !/^[0-9a-f]{64}$/.test(prepared.buildKey)) {
                throw new Error(
                  `${spec.kind} ${targetId} did not select an immutable BuildV2 artifact`
                );
              }
              if (!prepared.executionDigest || !/^[0-9a-f]{64}$/.test(prepared.executionDigest)) {
                throw new Error(`${spec.kind} ${targetId} has no sealed execution digest`);
              }
              const result: PreparedCodeIncarnation = {
                surface: "code",
                target: { id: prepared.targetId ?? targetId },
                effectiveVersion: prepared.effectiveVersion,
                buildKey: prepared.buildKey,
                executionDigest: prepared.executionDigest,
                authority: parseUnitAuthorityManifest(
                  prepared.authority,
                  `${spec.kind} ${targetId} authority`
                ),
              };
              return result;
            }) as RuntimeEntityHooks["prepare"],
            recoverExactExecution: async (record) => {
              await workerdManager.restoreDurableObjectEntity(record);
            },
            restartDurableObjectIncarnation: async (record) => {
              if (!record.className) {
                throw new Error(`Durable Object ${record.id} has no class name`);
              }
              await workerdManager.restartUserlandDOFacet({
                source: record.source.repoPath,
                className: record.className,
                objectKey: record.key,
              });
            },
            onDurableObjectActivated: async (record) => {
              if (!record.className) return;
              const owner = {
                source: record.source.repoPath,
                className: record.className,
                objectKey: record.key,
              };
              const queues = (await doDispatch.dispatch(
                owner,
                "durableWorkCapabilities"
              )) as import("@vibestudio/shared/durableWork").DurableWorkQueue[];
              if (queues.length === 0) return;
              await doDispatch.dispatch(
                {
                  source: (await import("./internalDOs/internalDoLoader.js")).INTERNAL_DO_SOURCE,
                  className: "WorkspaceDO",
                  objectKey: workspaceId,
                },
                "durableWorkOwnerRegister",
                { ...owner, queues }
              );
            },
            // Server-internal DO-storage primitives for cloneContext/destroyContext.
            // cloneDO/destroyDO are NOT exposed to userland — only the runtime
            // service (here) drives them, behind the context-boundary gate.
            cloneDurableStorage: async ({
              source,
              className,
              fromKey,
              toKey,
              cooperativelyPaused,
            }) => {
              await workerdManager.cloneDO({ source, className, objectKey: fromKey }, toKey, {
                cooperativelyPaused,
              });
            },
            destroyDurableStorage: async ({ source, className, key }) => {
              await workerdManager.destroyRetiredDOStorage({
                source,
                className,
                objectKey: key,
              });
            },
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
              return released;
            },
            sealAndDrainEntityRelays: (entityId) =>
              sealAndDrainDurableObjectRelays(entityId, `runtime-retire:${entityId}`),
            releaseEntityRelaySeal: (entityId) =>
              releaseDurableObjectRelaySeal(entityId, `runtime-retire:${entityId}`),
            onRetire: async (record) => {
              await cleanupRuntimeEntityRecord(record);
            },
          },
          contextBoundary: contextBoundaryDeps,
          hasAppCapability: (callerId, capability) =>
            appHostForGateway?.hasAppCapability(callerId, capability) ?? false,
          setEntityTitle: (entityId, title, options) =>
            entityTitleService.setTitle(entityId, title, options),
          onExecutionRecovery: (event) => {
            const active = entityCache.resolveActive(event.entityId);
            runtimeDiagnostics.record({
              workspaceId,
              entityId: event.entityId,
              kind: "do",
              level: event.state === "failed" ? "error" : "info",
              message: `Runtime execution recovery ${event.state}`,
              source: "lifecycle",
              fields: {
                event: "runtime-execution-recovery",
                recoveryState: event.state,
                recoveryStrategy: event.strategy,
                recoveryAttemptCount: event.attemptCount,
                expectedExecutionDigest: event.expectedExecutionDigest,
                ...(event.result
                  ? {
                      buildKey: event.result.buildKey,
                      executionDigest: event.result.executionDigest,
                      previousExecutionDigest: event.result.previousExecutionDigest,
                    }
                  : {
                      ...(active?.activeBuildKey ? { buildKey: active.activeBuildKey } : {}),
                      ...(active?.activeExecutionDigest
                        ? { executionDigest: active.activeExecutionDigest }
                        : {}),
                    }),
                ...(event.error ? { error: event.error } : {}),
              },
            });
          },
          // Agent credentials follow the entity (§3.2): on retire, revoke all
          // outstanding agent credentials and the live `agent:<entityId>` token.
          revokeAgentCredentials: async (entityId) => {
            await workspaceChildHub.revokeAgentCredentialsForEntity(entityId);
            // Matches auth/model.ts agentCallerId(entityId).
            tokenManager.revokeToken(`agent:${entityId}`);
          },
          faultAbortAgentVessel: async (caller, record) => {
            if (
              !isAttestedSystemTestHarness(caller, (identity) =>
                conduitBlessingStore.isBlessed(identity)
              )
            ) {
              throw new Error(
                "runtime.faultAbortAgentVessel requires an attested system-test harness"
              );
            }
            if (
              record.source.repoPath !== "workers/agent-worker" ||
              record.className !== "AiChatWorker" ||
              !record.agentBinding
            ) {
              throw new Error(
                "runtime.faultAbortAgentVessel accepts only an exact headless agent vessel"
              );
            }
            await workerdManager.faultAbortUserlandDOFacet({
              source: record.source.repoPath,
              className: record.className,
              objectKey: record.key,
            });
          },
        });
        runtimeServiceInternal = runtimeResult.internal;
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

  // Browser data is reached through its declared extension provider; direct
  // package invocation is not a provider route. The extension proxies to the
  // BrowserDataDO via unified RPC, so storage stays in workerd unchanged.

  // ── Generic public webhook ingress ──
  {
    const { createWebhookIngressService, resolveWebhookDirectMaxBodyBytes } =
      await import("./services/webhookIngressService.js");
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
          relayOrigin: getRelayOrigin(),
          relayRegistrar: relayBackhaul.client,
          // No public ingress: direct-mode webhooks only resolve co-located (loopback).
          // Remote webhooks ride the multi-tenant callback relay over the backhaul.
          directPublicBaseUrl: getLocalGatewayUrl("webhook direct base URL"),
          directMaxBodyBytes: resolveWebhookDirectMaxBodyBytes(
            process.env["VIBESTUDIO_WEBHOOK_DIRECT_MAX_BODY_BYTES"]
          ),
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
          dispatchToTarget: async (target, event, verifiedExternalContext) => {
            const { bindVerifiedExternalContext } = await import("@vibestudio/rpc/internal");
            await rpcServer.server.callTarget(
              `do:${target.source}:${target.className}:${target.objectKey}`,
              target.method,
              [event],
              bindVerifiedExternalContext({}, verifiedExternalContext)
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
  const panelRuntimeCoordinator = new PanelRuntimeCoordinator({
    eventService,
    onError: (error, operation) => {
      console.warn(
        `[PanelRuntimeCoordinator] Failed to ${operation}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    },
  });
  const { reconcilePanelPresentationChange } = await import("./panelPresentationReconciler.js");
  const { PanelExecutionReconciler } = await import("./panelExecutionReconciler.js");
  const panelExecutionReconciler = new PanelExecutionReconciler({
    getDetail: (slotId) =>
      dispatcher.dispatch(
        { caller: createHostCaller("server") },
        "workspace-state",
        "panelTree.detail",
        [slotId]
      ) as Promise<
        import("@vibestudio/shared/panel/workspaceStateSnapshot").WorkspacePanelDetail | null
      >,
    resolveSlotByEntity: (entityId) =>
      dispatcher.dispatch(
        { caller: createHostCaller("server") },
        "workspace-state",
        "slot.resolveByEntity",
        [entityId]
      ) as Promise<string | null>,
    listPreparingPanels: () => {
      if (!runtimeServiceInternal) throw new Error("Runtime service is not available");
      return runtimeServiceInternal.listPreparingPanels();
    },
    activate: (spec) => {
      if (!runtimeServiceInternal) throw new Error("Runtime service is not available");
      return runtimeServiceInternal.activateReservedEntity(spec);
    },
    onError: (error, slotId, entityId) => {
      const message = error instanceof Error ? error.message : String(error);
      eventService.emit("panel:executionFailed", {
        panelId: slotId,
        runtimeEntityId: entityId,
        message,
      });
      console.warn(
        `[PanelExecutionReconciler] Failed to activate ${entityId} for ${slotId}: ${message}`
      );
    },
  });
  const convergePanelPresentation = (change?: SlotStateChange) => {
    try {
      reconcilePanelPresentationChange(panelRuntimeCoordinator, change);
    } catch (error) {
      console.warn(
        `[PanelPresentationReconciler] Failed to converge presentation: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  };
  slotStateListeners.add((change) => {
    panelExecutionReconciler.observe(change);
    convergePanelPresentation(change);
  });
  panelRuntimeCoordinatorForCleanup = panelRuntimeCoordinator;
  const { wireDevelopmentNative } = await import("./bootstrap/developmentNative.js");
  await wireDevelopmentNative({
    container,
    workspaceId,
    workspaceVcs,
    layout,
    eventService,
    serverLogStore,
    getLocalGatewayUrl,
    createAttachedHostPublicationPorts,
    attachedHostParentEndpoint,
    attachedHostPublisher: attachedHostController,
    attachedHostParentId: localHostId,
    attachedHostAuthorityCeiling,
    workspaceChildHub,
    panelRuntimeCoordinator,
  });

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
        onClientDisconnect: (callerId) => {
          // A shell/debug client is not a runtime entity, so the entity reaper
          // cannot perform its normal caller-scoped cleanup.  The reconnect
          // grace in RpcServer is the lifecycle boundary for these callers;
          // once it expires, pending approvals and open fs handles must not
          // survive an abandoned client.
          approvalQueue.cancelForCaller(callerId);
          fsService.closeHandlesForCaller(callerId);
        },
        capabilityGrantStore,
        userlandResourceHandles,
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
        ensureUserlandDoReady: async (ref) => {
          await durableObjectExecutionReadiness.ensureReady(ref);
        },
        executionSessionForRuntime: (runtimeId, nonce) =>
          agentExecutionSessions.resolveInvocation(runtimeId, nonce),
        testPolicyForContext: (contextId) => agentExecutionSessions.testPolicyForContext(contextId),
        taskAuthorityForRuntime: (runtimeId) =>
          taskAuthorities.resolveRuntime(runtimeId, entityCache),
        connectionGrants,
        // Resolves each authenticated caller's account subject (WP0 §5.2/§5.5).
        userSubjectSource,
        // Membership entry gate (WP2 §4): refuse a non-member of this child's
        // workspace at auth time. Undefined (no-op) in local/dev/hub mode.
        membershipGate: membershipEntryGate,
        workspaceRoleResolver,
        describeCapability,
        reviewedClosureFactForSession: (sessionId) =>
          reviewedClosureRegistry.factForSession(sessionId),
        contextIntegrityFactForSession: (sessionId, caller) =>
          caller.executionSession !== undefined
            ? contextIntegrityStore.effectiveFact({
                sessionId,
                attested: contextIntegrityStore.fact(sessionId),
                conduitBlessed: conduitBlessingStore.isBlessed(caller.code),
              })
            : { class: "not-applicable", latchEpoch: 0, externalKeys: [] },
        isAttestedSystemTestHarness: (caller) =>
          isAttestedSystemTestHarness(caller, (identity) =>
            conduitBlessingStore.isBlessed(identity)
          ),
        resolveProductBuiltinPreparedAuthority: async ({
          caller,
          source,
          className,
          objectKey,
          args,
          resolver,
          contextBoundary,
        }) => {
          if (!contextBoundary) {
            throw new Error(
              `Product builtin authority resolver '${resolver}' has no supported preparation descriptor`
            );
          }
          const { INTERNAL_DO_SOURCE } = await import("./internalDOs/internalDoLoader.js");
          if (source !== INTERNAL_DO_SOURCE || className !== "WorkspaceDO") {
            throw new Error(`Context-boundary preparation is not valid for ${source}:${className}`);
          }
          const selectPath = (root: unknown, path: readonly (string | number)[]): unknown => {
            let selected = root;
            for (const segment of path) {
              if (selected === null || typeof selected !== "object" || !(segment in selected)) {
                return null;
              }
              selected = (selected as Record<string | number, unknown>)[segment];
            }
            return selected;
          };
          const argument = args[contextBoundary.targetArgument];
          const selectedTarget = selectPath(argument, contextBoundary.targetPath ?? []);
          if (selectedTarget == null) return [];
          const slotId = selectedTarget;
          if (typeof slotId !== "string" || slotId.length === 0) {
            throw new Error(
              `Context-boundary resolver '${resolver}' requires a slot id at argument ${contextBoundary.targetArgument}`
            );
          }
          const doDispatch = container.get<import("./doDispatch.js").DODispatch>("doDispatch");
          if (!doDispatch) throw new Error("Workspace state dispatcher is unavailable");
          const detail = (await doDispatch.dispatch(
            { source, className, objectKey },
            "panelTreeDetail",
            slotId
          )) as {
            slot: { current_entity_title?: string | null };
            currentHistory: { source: string; context_id: string };
            entity: { id: string };
          } | null;
          if (!detail) throw new Error(`Unknown panel slot: ${slotId}`);
          let requestedContext = contextBoundary.requestedContextPath
            ? selectPath(argument, contextBoundary.requestedContextPath)
            : null;
          if (requestedContext == null && contextBoundary.requestedContextLookup) {
            const lookupArgs = contextBoundary.requestedContextLookup.arguments.map((input) =>
              selectPath(args[input.argument], input.path ?? [])
            );
            if (lookupArgs.every((value) => value != null)) {
              const lookupResult = await doDispatch.dispatch(
                { source, className, objectKey },
                contextBoundary.requestedContextLookup.method,
                lookupArgs
              );
              requestedContext = selectPath(
                lookupResult,
                contextBoundary.requestedContextLookup.resultPath
              );
            }
          }
          const { preparePanelAccessAuthority } =
            await import("./services/panelAccessPermission.js");
          const { createVerifiedCaller } = await import("@vibestudio/shared/serviceDispatcher");
          const isEntityControlledBy = (entityId: string, callerId: string): boolean => {
            const visited = new Set<string>();
            let current = entityCache.resolve(entityId);
            while (current && !visited.has(current.id)) {
              if (current.parentId === callerId) return true;
              visited.add(current.id);
              current = current.parentId ? entityCache.resolve(current.parentId) : null;
            }
            return false;
          };
          return preparePanelAccessAuthority(
            {
              contextExists: contextBoundaryDeps.contextExists,
              resolveContextOwnerLabel: contextBoundaryDeps.resolveContextOwnerLabel,
              resolveCallerContext: async (callerId) => entityCache.resolveContext(callerId),
              resolveEntityContext: (entityId) => entityCache.resolveContext(entityId),
              isEntityControlledBy,
              controlsLifecycleContext: (callerId, originContextId, targetContextId) =>
                callerControlsContextTransition(
                  lifecycleContextStore,
                  callerId,
                  originContextId,
                  targetContextId
                ),
              resolveSubjectCaller: (entityId) => {
                const entity = entityCache.resolveActive(entityId);
                if (
                  !entity ||
                  !["panel", "app", "worker", "do"].includes(entity.kind) ||
                  !entity.activeExecutionDigest ||
                  !entity.activeAuthority
                ) {
                  return null;
                }
                return createVerifiedCaller(
                  entity.id,
                  entity.kind as "panel" | "app" | "worker" | "do",
                  {
                    callerId: entity.id,
                    callerKind: entity.kind as "panel" | "app" | "worker" | "do",
                    repoPath: entity.source.repoPath,
                    effectiveVersion: entity.source.effectiveVersion,
                    executionDigest: entity.activeExecutionDigest,
                    requested: entity.activeAuthority.requests,
                  }
                );
              },
              hasAppCapability: (callerId, capability) =>
                appHostForGateway?.hasAppCapability(callerId, capability) ?? false,
            },
            { caller },
            contextBoundary.operation,
            {
              id: slotId,
              title: detail.slot.current_entity_title ?? slotId,
              source: detail.currentHistory.source,
              kind: isOpenPanelBrowserUrl(detail.currentHistory.source) ? "browser" : "workspace",
              runtimeEntityId: detail.entity.id,
              contextId: detail.currentHistory.context_id,
              ...(typeof requestedContext === "string" && requestedContext.length > 0
                ? { requestedContextId: requestedContext }
                : {}),
            }
          );
        },
        resolveWorkspaceDirectAuthority: async ({ source, className, objectKey, method }) => {
          const { isHostIntrinsicDirectMethod } =
            await import("@vibestudio/shared/authority/hostIntrinsicDirectMethods");
          const authoritiesFrom = async (
            declarations: import("@vibestudio/workspace/singletonRegistry").WorkspaceDeclarations
          ) => {
            const matches = declarations.services.filter(
              (service) =>
                service.source === source && service.durableObject?.className === className
            );
            if (matches.length === 0) {
              const productAuthority = productBuiltinDirectAuthority({
                source,
                className,
                method,
              });
              return productAuthority ? [productAuthority] : [];
            }
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
            const hostIntrinsic = isHostIntrinsicDirectMethod(method);
            if (!catalogMethod && !hostIntrinsic) {
              throw new WorkspaceRpcMethodUndeclaredError({
                source,
                className,
                objectKey,
                method,
                serviceName: matches[0]?.name,
                activeBuildKey: active?.activeBuildKey ?? null,
                declaredMethods:
                  build && "metadata" in build && build.metadata.kind === "worker"
                    ? (build.metadata.workspaceRpcCatalog ?? [])
                        .filter((entry) => entry.className === className)
                        .map((entry) => entry.name)
                    : [],
              });
            }
            if (
              catalogMethod?.effect.kind === "userland-capability" &&
              (!catalogMethod.userlandCapability || !build?.metadata.execution?.executionDigest)
            ) {
              throw new Error(
                `Live workspace service ${source}:${className}.${method} has unsealed userland authority`
              );
            }
            const methodCapability =
              catalogMethod?.effect.kind === "userland-capability"
                ? catalogMethod.userlandCapability!.canonicalCapability
                : catalogMethod?.effect.kind === "host-capability"
                  ? catalogMethod.effect.capability
                  : undefined;
            const methodEffect =
              (hostIntrinsic ? ({ kind: "open" } as const) : catalogMethod?.effect) ??
              ({ kind: "open" } as const);
            const methodTier = catalogMethod?.access?.tier ?? "open";
            return matches.map((service) => ({
              capability: `workspace-service:${service.name}`,
              serviceBinding: service.authority.binding ?? "consent",
              methodEffect,
              principals: service.authority.principals,
              ...(methodCapability ? { methodCapability } : {}),
              ...(catalogMethod?.userlandCapability && build?.metadata.execution?.executionDigest
                ? {
                    methodReceiverAuthority: {
                      capabilityDefinitionDigest: catalogMethod.userlandCapability.definitionDigest,
                      resourceType: catalogMethod.userlandCapability.resourceType,
                      provider: source,
                      providerExecutionDigest: build.metadata.execution.executionDigest,
                      grantScopes: catalogMethod.userlandCapability.grantScopes,
                      title: catalogMethod.userlandCapability.title,
                      action: catalogMethod.userlandCapability.action,
                      ...(catalogMethod.userlandCapability.description
                        ? { description: catalogMethod.userlandCapability.description }
                        : {}),
                    },
                  }
                : {}),
              ...(catalogMethod?.producesHandle
                ? {
                    methodHandleProduction: {
                      capability: catalogMethod.producesHandle.canonicalCapability,
                      capabilityDefinitionDigest: catalogMethod.producesHandle.definitionDigest,
                      resourceType: catalogMethod.producesHandle.resourceType,
                      provider: source,
                    },
                  }
                : {}),
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
            // Main workspace singletons may use host-owned context ids rather
            // than VCS operation contexts.
            return [];
          }
        },
        liveCallerGate,
        // RpcServer starts before workerd by design. Resolve the declared
        // workspace source provider lazily at the first provenance-bearing ingress, then
        // prove the exact invocation node exists before any service or relay
        // can persist the asserted causal edge.
        verifyExactCausalInvocation: async (parent) => {
          const doDispatch = container.get<import("./doDispatch.js").DODispatch>("doDispatch");
          const { createWorkspaceSemanticPort, hasExactCausalInvocation } =
            await import("./workspaceSourceProvider.js");
          return hasExactCausalInvocation(
            createWorkspaceSemanticPort(doDispatch, {
              source: semanticWorkspaceService.source,
              className: semanticWorkspaceService.className,
              objectKey: semanticWorkspaceService.objectKey,
            }),
            parent
          );
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
        isCodeApproved,
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
    const { createConnectedClientTransportService } =
      await import("./services/connectedClientTransportService.js");
    container.registerRpc(
      createConnectedClientTransportService({
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
          "workspace-state",
          "slot.closeOwnedRoots",
          [userId]
        )) as { rootIds: string[]; closedIds: string[] };
        for (;;) {
          const page = (await dispatcher.dispatch(
            { caller: createHostCaller("server") },
            "workspace-state",
            "slot.closeCleanupPage",
            [{ ownerUserId: userId, limit: 200 }]
          )) as {
            items: Array<{ slotId: string; entityId: string | null }>;
          };
          if (page.items.length === 0) break;
          for (const item of page.items) {
            if (!item.entityId) continue;
            await dispatcher.dispatch(
              { caller: createHostCaller("server") },
              "runtime",
              "retireEntity",
              [{ id: item.entityId, removeContext: true }]
            );
          }
          await dispatcher.dispatch(
            { caller: createHostCaller("server") },
            "workspace-state",
            "slot.closeCleanupAck",
            [page.items.map((item) => item.slotId)]
          );
        }

        const gadRef = {
          source: semanticWorkspaceService.source,
          className: semanticWorkspaceService.className,
          objectKey: semanticWorkspaceService.objectKey,
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
            archivedRootIds: archived.rootIds,
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
      dependencies: ["cdpBridge"],
      async start(resolve) {
        const cdpBridge = assertPresent(resolve<import("./cdpBridge.js").CdpBridge>("cdpBridge"));
        panelRuntimeDefinition = createPanelRuntimeService({
          coordinator: panelRuntimeCoordinator,
          ensureExecutable: (slotId, entityId) =>
            panelExecutionReconciler.ensureExecutable(slotId, entityId),
          observeHostSlot: async (slotId) => {
            if (!cdpBridge.isTargetRegistered(slotId)) return null;
            const { PanelHostObservationSchema } =
              await import("@vibestudio/shared/panelContracts");
            const hostObservation = PanelHostObservationSchema.parse(
              await cdpBridge.sendHostCommand(slotId, "panelObservation")
            );
            if (
              !hostObservation.view.exists ||
              typeof hostObservation.view.url !== "string" ||
              typeof hostObservation.view.loading !== "boolean"
            ) {
              return null;
            }
            return {
              url: hostObservation.view.url,
              loading: hostObservation.view.loading,
              boot: hostObservation.boot,
              ...(hostObservation.failure
                ? {
                    failure:
                      hostObservation.failure.stage === "build" ||
                      hostObservation.failure.stage === "resolve"
                        ? {
                            reporter: "build" as const,
                            failure: {
                              stage: "build" as const,
                              code: hostObservation.failure.code,
                              message: hostObservation.failure.message,
                              diagnostics: hostObservation.failure.details,
                            },
                          }
                        : {
                            reporter: "host" as const,
                            failure: {
                              stage: "navigation" as const,
                              code: hostObservation.failure.code,
                              message: hostObservation.failure.message,
                              diagnostics: hostObservation.failure.details,
                            },
                          },
                  }
                : {}),
            };
          },
          currentEntityForSlot: async (slotId) => {
            const doDispatch = container.get<import("./doDispatch.js").DODispatch>("doDispatch");
            const { INTERNAL_DO_SOURCE } = await import("./internalDOs/internalDoLoader.js");
            const detail = (await doDispatch.dispatch(
              {
                source: INTERNAL_DO_SOURCE,
                className: "WorkspaceDO",
                objectKey: entryWorkspaceId,
              },
              "panelTreeDetail",
              slotId
            )) as { entity?: { id?: string } } | null;
            return detail?.entity?.id ?? null;
          },
          browserSourceForSlot: async (slotId) => {
            const doDispatch = container.get<import("./doDispatch.js").DODispatch>("doDispatch");
            const { INTERNAL_DO_SOURCE } = await import("./internalDOs/internalDoLoader.js");
            const detail = (await doDispatch.dispatch(
              {
                source: INTERNAL_DO_SOURCE,
                className: "WorkspaceDO",
                objectKey: entryWorkspaceId,
              },
              "panelTreeDetail",
              slotId
            )) as { currentHistory?: { source?: string } } | null;
            return detail?.currentHistory?.source ?? null;
          },
          isRuntimeRouteReachable: (runtimeEntityId, connectionId) =>
            rpcServerForGateway?.isRuntimeRouteReachable(runtimeEntityId, connectionId) ?? false,
          ensureDefaultHeadlessHost: async () => {
            const manager = getHeadlessHostManager();
            if (!manager) return false;
            return Boolean(await manager.ensureDefaultHost());
          },
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
        executionPublicationPort: executionPublicationJournal,
        tokenManager: tokenManagerInst,
        eventService,
        approvalQueue,
        approvalCoordinator: unitInstallReviewCoordinator,
        approvalBatchKeyFor: (entry) => launchGateBatchKeyFor(workspaceConfig, entry),
        // The gate asks whose code this is, so it is answered from workspace
        // state the server reads rather than from anything under review.
        resolveUnitOrigins,
        // Trust from before admission was recorded is not a review: an
        // un-admitted version is offered at the launch gate once more.
        isAdmitted: (repoPath, effectiveVersion) =>
          unitAdmissionStore.hasVersion(repoPath, effectiveVersion),
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
        providerContracts: {
          gitInterop: GIT_INTEROP_PROVIDER_METHOD_NAMES,
        },
        privateProviderMethods: {
          gitInterop: ["cloneRepo", "remoteDefaultBranch", "reconcileUpstreams"],
        },
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
        executionPublicationPort: executionPublicationJournal,
        eventService,
        approvalQueue,
        approvalCoordinator: unitInstallReviewCoordinator,
        // The gate asks whose code this is, so it is answered from workspace
        // state the server reads rather than from anything under review.
        resolveUnitOrigins,
        // Trust from before admission was recorded is not a review: an
        // un-admitted version is offered at the launch gate once more.
        isAdmitted: (repoPath, effectiveVersion) =>
          unitAdmissionStore.hasVersion(repoPath, effectiveVersion),
        notificationService: notificationResult.internal,
        entityCache,
        connectionGrants,
        readWorkspaceFileAtState,
        describeCapability,
        getGatewayUrl: () => getLocalGatewayUrl("app startup"),
        getReactNativeAppArtifactBaseUrl: () => getConnectUrl("React Native app artifact"),
        getTerminalAppArtifactBaseUrl: () => getLocalGatewayUrl("Terminal app artifact"),
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
  const durableWorkRegistrationCache = new Set<string>();
  const activateDurableObjectEntity = async (
    doDispatch: import("./doDispatch.js").DODispatch,
    workerdManagerInst: import("./workerdManager.js").WorkerdManager,
    ref: {
      source: string;
      className: string;
      objectKey: string;
      contextId?: string;
      contextPolicy?: "exact" | "initial";
      buildRef?: string;
    }
  ): Promise<void> => {
    const { source, className, objectKey, buildRef } = ref;
    const targetId = canonicalEntityId({ kind: "do", source, className, key: objectKey });
    const { INTERNAL_DO_SOURCE } = await import("./internalDOs/internalDoLoader.js");
    const workspaceDORef: import("@vibestudio/shared/doDispatcher").DORef = {
      source: INTERNAL_DO_SOURCE,
      className: "WorkspaceDO",
      objectKey: workspaceId,
    };
    const registerDurableWorkOwner = async (): Promise<void> => {
      if (durableWorkRegistrationCache.has(targetId)) return;
      const owner = { source, className, objectKey };
      const queues = (await doDispatch.dispatch(
        owner,
        "durableWorkCapabilities"
      )) as import("@vibestudio/shared/durableWork").DurableWorkQueue[];
      if (queues.length > 0) {
        await doDispatch.dispatch(workspaceDORef, "durableWorkOwnerRegister", {
          ...owner,
          queues,
        });
      }
      durableWorkRegistrationCache.add(targetId);
    };
    const active = entityCache.resolveActive(targetId);
    if (active?.activeBuildKey && active.activeExecutionDigest && active.activeAuthority) {
      if (ref.contextId && ref.contextPolicy !== "initial" && active.contextId !== ref.contextId) {
        throw new Error(
          `Durable Object ${targetId} is already active in context ${active.contextId}; cannot resolve it from context ${ref.contextId}`
        );
      }
      await durableObjectExecutionReadiness.materialize(active);
      await registerDurableWorkOwner();
      return;
    }
    const existing = (await doDispatch.dispatch(
      workspaceDORef,
      "entityResolve",
      targetId
    )) as EntityRecord | null;
    if (existing?.status === "active") {
      if (
        ref.contextId &&
        ref.contextPolicy !== "initial" &&
        existing.contextId !== ref.contextId
      ) {
        throw new Error(
          `Durable Object ${targetId} is already registered in context ${existing.contextId}; cannot resolve it from context ${ref.contextId}`
        );
      }
      if (existing.activeBuildKey && existing.activeExecutionDigest && existing.activeAuthority) {
        entityCache._onActivate(existing);
        await durableObjectExecutionReadiness.materialize(existing);
        await registerDurableWorkOwner();
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
    const activation = declaredWorkspaceServiceActivationInput(
      { source, className, key: objectKey, contextId },
      prepared,
      existing,
      SYSTEM_SUBJECT.userId
    );
    const store = ensureEntityStore(doDispatch);
    if (existing) await store.advanceExecution(activation);
    else await store.activate(activation);
    await registerDurableWorkOwner();
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
            reviewedClosureRegistry.assertUserlandServiceExposure({ sessionId, ...service });
          },
          activateDurableObject: ({
            source,
            className,
            objectKey,
            contextId,
            contextPolicy,
            buildRef,
          }) => {
            return activateDurableObjectEntity(doDispatch, workerdManagerInst, {
              source,
              className,
              objectKey,
              ...(contextId ? { contextId } : {}),
              ...(contextPolicy ? { contextPolicy } : {}),
              ...(buildRef ? { buildRef } : {}),
            });
          },
          resetDurableObjectStorage: (target, intent) =>
            workerdManagerInst.resetDOStorage(target, intent),
          listDurableObjectStorageBackups: (target) =>
            workerdManagerInst.listDOStorageBackups(target),
          restoreDurableObjectStorageBackup: (target, operationId, intent) =>
            workerdManagerInst.restoreDOStorageBackup(target, operationId, intent),
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
      resolveRepository: (input) => callSemantic("vcsResolveRepository", input),
      readFile: (input) => callSemantic("vcsReadFile", input),
      listDirectory: (input) => callSemantic("vcsListDirectory", input),
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
  const { resolveLiveExecutionCaller } = await import("./services/liveExecutionCaller.js");
  wireWorkerdCore({
    container,
    tokenManager,
    workspacePath,
    statePath,
    workspaceId,
    workspaceDeclarations: workspaceDecls,
    userlandResourceHandles,
    assertBootstrapSnapshotUnchanged: () => bootstrapSnapshot.assertUnchanged(),
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
    executionPublicationPort: executionPublicationJournal,
    resolveEgressCaller: (registered) => {
      const activeEntity = entityCache.resolveActive(registered.runtime.id);
      return resolveLiveExecutionCaller({
        registered,
        activeEntity,
        executionSession: agentExecutionSessions.resolve(registered.runtime.id),
        contextTestPolicy: activeEntity
          ? agentExecutionSessions.testPolicyForContext(activeEntity.contextId)
          : null,
        taskAuthority: taskAuthorities.resolveRuntime(registered.runtime.id, entityCache),
        isCodeApproved,
      });
    },
    ensureUserlandDoReady: async (ref) => {
      await durableObjectExecutionReadiness.ensureReady(ref);
    },
    onManagerStarted: (manager) => {
      workerdManagerForGateway = manager;
    },
    publishSourceBuild: async (manager, source, doClasses, trigger, buildKey) => {
      const build = buildKey ? assertPresent(buildSystemInstance).getBuildByKey(buildKey) : null;
      if (!build || build.metadata.kind !== "worker" || build.metadata.sourcePath !== source) {
        await manager.reconcileMutableSourceBuild(source, doClasses, trigger, buildKey);
        return;
      }
      const artifact = executionArtifactRefFromBuild(workspaceId, build);
      const mainSingletons = workspaceDecls.singletons
        .all()
        .filter((decl) => decl.source === source && !decl.contextId);
      const unchanged: EntityRecord[] = [];
      const advances: EntityActivateInput[] = [];
      for (const decl of mainSingletons) {
        const targetId = canonicalEntityId({
          kind: "do",
          source,
          className: decl.className,
          key: decl.key,
        });
        const current = entityCache.resolveActive(targetId);
        if (!current || !current.className) continue;
        if (
          current.activeBuildKey === artifact.buildKey &&
          current.activeExecutionDigest === artifact.executionDigest
        ) {
          unchanged.push(current);
          continue;
        }
        advances.push({
          kind: "do",
          source: {
            repoPath: source,
            effectiveVersion: artifact.sourceState.effectiveVersion,
          },
          activeBuildKey: artifact.buildKey,
          activeExecutionDigest: artifact.executionDigest,
          activeAuthority: assertPresent(build.metadata.authority),
          contextId: current.contextId,
          className: current.className,
          key: current.key,
          stateArgs: current.stateArgs,
          agentBinding: current.agentBinding,
          parentId: current.parentId,
          ownerUserId: current.ownerUserId,
        });
      }
      await getEntityStore().advanceExecutions(advances);
      for (const record of unchanged) {
        await durableObjectExecutionReadiness.materialize(record);
      }
      await manager.reconcileMutableSourceBuild(source, doClasses, trigger, buildKey);
    },
  });

  const { wireVcsDurability } = await import("./bootstrap/vcsDurability.js");
  wireVcsDurability({
    container,
    workspaceVcs,
    executionPublicationJournal,
    workspaceId,
    workspaceSourceProvider: {
      source: semanticWorkspaceService.source,
      className: semanticWorkspaceService.className,
      objectKey: semanticWorkspaceService.objectKey,
    },
    bootstrapStateHash: bootstrapSnapshot.stateHash,
    publishBootstrapEntity: async (
      _manager,
      {
        targetId,
        source,
        className,
        objectKey,
        effectiveVersion,
        buildKey,
        executionDigest,
        authority,
        contextId,
      }
    ) => {
      const store = ensureEntityStore(
        container.get<import("./doDispatch.js").DODispatch>("doDispatch")
      );
      const activation: EntityActivateInput = {
        kind: "do",
        source: { repoPath: source, effectiveVersion },
        activeBuildKey: buildKey,
        activeExecutionDigest: executionDigest,
        activeAuthority: authority,
        contextId,
        className,
        key: objectKey,
        ownerUserId: SYSTEM_SUBJECT.userId,
      };
      const existing = await store.resolveRecord(targetId);
      if (existing) await store.advanceExecution(activation);
      else await store.activate(activation);
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

  const { createDurableWorkService } = await import("./services/durableWorkService.js");
  {
    container.registerManaged({
      name: "durableWorkDriver",
      dependencies: ["workerdWorkspace", "doDispatch"],
      async start(resolve) {
        const doDispatch = assertPresent(
          resolve<import("./doDispatch.js").DODispatch>("doDispatch")
        );
        const { DurableWorkDriver, createDurableWorkHandlers, createDurableWorkOwnerScanner } =
          await import("./services/durableWorkDriver.js");
        const workspaceOwner: import("@vibestudio/shared/doDispatcher").DORef = {
          source: (await import("./internalDOs/internalDoLoader.js")).INTERNAL_DO_SOURCE,
          className: "WorkspaceDO",
          objectKey: workspaceId,
        };
        const workerId = `durable-work-driver:${serverBootId}:${randomUUID()}`;
        const driver = new DurableWorkDriver({
          handlers: createDurableWorkHandlers(doDispatch),
          scanReadyOwners: createDurableWorkOwnerScanner(doDispatch, workspaceOwner, workerId),
          workerId,
        });
        doDispatch.setWorkReadyObserver((hint) => driver.notify(hint));
        durableWorkDispatch = doDispatch;
        return driver;
      },
      async stop(instance: import("./services/durableWorkDriver.js").DurableWorkDriver | null) {
        durableWorkDispatch?.setWorkReadyObserver(null);
        await instance?.quiesce();
        durableWorkDispatch = null;
      },
      getServiceDefinition() {
        return createDurableWorkService(
          container.get<import("./services/durableWorkDriver.js").DurableWorkDriver>(
            "durableWorkDriver"
          )
        );
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
          onStateChange: (event) => {
            const entityId = canonicalEntityId({
              kind: "do",
              source: event.ref.source,
              className: event.ref.className,
              key: event.ref.objectKey,
            });
            const entity = entityCache.resolveActive(entityId);
            runtimeDiagnostics.record({
              workspaceId,
              entityId,
              kind: "do",
              level: event.state === "blocked" ? "error" : "info",
              message: `Alarm ${event.state}`,
              source: "lifecycle",
              fields: {
                event: "alarm-state",
                alarmState: event.state,
                ...(event.wakeAt === undefined ? {} : { wakeAt: event.wakeAt }),
                ...(event.reason ? { reason: event.reason } : {}),
                ...(entity?.activeBuildKey ? { buildKey: entity.activeBuildKey } : {}),
                ...(entity?.activeExecutionDigest
                  ? { executionDigest: entity.activeExecutionDigest }
                  : {}),
              },
            });
          },
          isAuthorityPaused: (ref) => {
            const unit = buildSystemInstance
              ?.getGraph()
              .allNodes()
              .find((node) => node.relativePath === ref.source);
            if (!unit?.manifest.agent) return false;
            return capabilityGrantStore.isRuntimeAuthorityPaused(
              `do:${ref.source}:${ref.className}:${ref.objectKey}`
            );
          },
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

  const { cdpDefaultHostAssignmentError, registerPanelServices } =
    await import("./panelRuntimeRegistration.js");
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
    workspaceId,
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
    applyPreparedWorkspaceConfig: async (
      ctx: import("@vibestudio/shared/serviceDispatcher").ServiceContext,
      input: {
        expectedBaseDigest: string;
        nextState: typeof workspaceConfig;
        resultDigest: string;
        allowedPathScope: string[];
        summary: string;
      }
    ) => {
      const result = await workspaceConfigWriter.applyPrepared({ ctx, ...input });
      replaceLiveWorkspaceConfig(result.nextConfig);
      return {
        changed: result.changed,
        resultDigest: result.resultDigest,
        config: result.nextConfig,
      };
    },
    treeScanner,
    adminToken,
    args,
    hostConfig,
    tokenManager,
    cdpGrants,
    grantStore: capabilityGrantStore,
    recordContextIngestion,
    hasAppCapability: (callerId: string, capability: AppCapability) =>
      appHostForGateway?.hasAppCapability(callerId, capability) ?? false,
    contextExists: contextBoundaryDeps.contextExists,
    resolveContextOwnerLabel: contextBoundaryDeps.resolveContextOwnerLabel,
    lifecycleContextStore,
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
    approvalQueue,
    registerEntityTitlePersistedListener: (
      listener: (
        entityId: string,
        title: string | undefined,
        origin: "set" | "set-explicit" | "mirror" | "clear"
      ) => void | Promise<void>
    ) =>
      entityTitleService.onPersisted((entityId, title, origin) => {
        void Promise.resolve(listener(entityId, title, origin)).catch((error: unknown) => {
          console.warn(
            `[entityTitleService] persisted panel title listener failed: ${
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
  (await import("./services/registerEntityUnitDrivers.js")).registerEntityUnitDrivers({
    supervisor: unitSupervisor,
    entityCache,
    diagnostics: runtimeDiagnostics,
    titleFor: (entityId) => entityTitleService.getTitle(entityId),
    restartPanel: async (_ctx, entity) => {
      const slotId = (await dispatcher.dispatch(
        { caller: createHostCaller("server") },
        "workspace-state",
        "slot.resolveByEntity",
        [entity.id]
      )) as string | null;
      if (!slotId) throw new Error(`Panel entity is not current in an open slot: ${entity.id}`);
      const cdpBridge = container.get<import("./cdpBridge.js").CdpBridge>("cdpBridge");
      if (cdpBridge) {
        const { reloadRegisteredPanelPresentation } = await import("./reloadPanelPresentation.js");
        if (await reloadRegisteredPanelPresentation(cdpBridge, slotId)) return;
      }
      panelRuntimeCoordinator.unloadSlot(slotId);
      const assigned = panelRuntimeCoordinator.ensureDefaultCdpHostForSlot(slotId, entity.id);
      if (!assigned.assigned && assigned.reason !== "already_held") {
        throw (
          cdpDefaultHostAssignmentError(slotId, assigned.reason) ??
          new Error(`Unable to restart panel runtime: ${slotId}`)
        );
      }
    },
    restartWorker: async (_ctx, entity) => {
      const manager = workerdManagerForGateway;
      if (!manager) throw new Error("Worker runtime is not available");
      const instance = manager
        .listInstances()
        .find((candidate) => candidate.source === entity.source.repoPath);
      if (!instance) throw new Error(`Worker runtime is not active: ${entity.id}`);
      await manager.updateInstance(instance.name, {});
    },
    restartDurableObject: async (_ctx, entity) => {
      if (!entity.className) throw new Error(`Durable Object entity has no class: ${entity.id}`);
      const manager = workerdManagerForGateway;
      if (!manager) throw new Error("Durable Object runtime is not available");
      await manager.restartUserlandDOFacet({
        source: entity.source.repoPath,
        className: entity.className,
        objectKey: entity.key,
      });
    },
    retire: async (_ctx, entity) => {
      const runtime = runtimeServiceInternal;
      if (!runtime) throw new Error("Runtime service is not available");
      await runtime.retireEntity(entity.id);
    },
  });
  unitSupervisor.register(
    (await import("./services/extensionUnitDriver.js")).createExtensionUnitDriver(
      () => extensionHostForGateway
    )
  );
  unitSupervisor.register(
    (await import("./services/appUnitDriver.js")).createAppUnitDriver({
      getHost: () => appHostForGateway,
      entityCache,
    })
  );
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
    const workspaceDocsByState = new Map<
      string,
      Promise<readonly import("./services/docsService.js").LiveWorkspaceServiceDoc[]>
    >();
    const rememberWorkspaceDocs = (
      stateHash: string,
      pending: Promise<readonly import("./services/docsService.js").LiveWorkspaceServiceDoc[]>
    ): void => {
      workspaceDocsByState.delete(stateHash);
      workspaceDocsByState.set(stateHash, pending);
      while (workspaceDocsByState.size > 16) {
        const oldest = workspaceDocsByState.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        workspaceDocsByState.delete(oldest);
      }
    };
    container.registerRpc(
      createDocsService({
        dispatcher,
        runtimeSurfaces: {
          panel: panelRuntimeSurface,
          workerRuntime: workerRuntimeSurface,
        },
        workspaceServicesForCaller: async (ctx) => {
          const contextId = entityCache.resolveContext(ctx.caller.runtime.id);
          const stateHash = contextId
            ? await workspaceVcs.resolveContextState(contextId)
            : (await workspaceVcs.ensureFresh()).stateHash;
          const cached = workspaceDocsByState.get(stateHash);
          if (cached) {
            rememberWorkspaceDocs(stateHash, cached);
            return cached;
          }
          const pending = (async () => {
            const declarations = buildWorkspaceDeclarations(
              await readWorkspaceConfigFromState(workspaceVcs, workspaceId, stateHash)
            );
            const services = declarations.services;
            const buildSystem =
              container.get<import("./buildV2/index.js").BuildSystemV2>("buildSystem");
            if (!buildSystem)
              throw new Error("Build system is unavailable for workspace service docs");
            const providerCatalogs = new Map<
              string,
              Promise<import("./buildV2/index.js").ResolvedWorkspaceRpcCatalog>
            >();
            const providerCatalogFor = (source: string, className: string) => {
              const key = `${source}\0${className}`;
              let provider = providerCatalogs.get(key);
              if (!provider) {
                provider = buildSystem.resolveWorkspaceRpcCatalog(source, className, stateHash);
                providerCatalogs.set(key, provider);
              }
              return provider;
            };
            return Promise.all(
              services.map(async (declaration) => {
                try {
                  const provider = declaration.durableObject
                    ? await providerCatalogFor(
                        declaration.source,
                        declaration.durableObject.className
                      )
                    : await buildSystem.resolveBuildUnit(declaration.source, stateHash);
                  if (!provider) {
                    throw new Error(
                      `Workspace service provider ${declaration.source} is not an exact build unit`
                    );
                  }
                  return {
                    declaration,
                    ...(declaration.durableObject
                      ? {
                          defaultObjectKey:
                            declarations.singletons.find(
                              declaration.source,
                              declaration.durableObject.className
                            )?.key ?? null,
                        }
                      : {}),
                    providerEffectiveVersion: provider.effectiveVersion,
                    methods: "methods" in provider ? provider.methods : [],
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
                    ...(declaration.durableObject
                      ? {
                          defaultObjectKey:
                            declarations.singletons.find(
                              declaration.source,
                              declaration.durableObject.className
                            )?.key ?? null,
                        }
                      : {}),
                    providerBuildError: error instanceof Error ? error.message : String(error),
                    methods: [],
                  };
                }
              })
            );
          })();
          rememberWorkspaceDocs(stateHash, pending);
          void pending.catch(() => {
            if (workspaceDocsByState.get(stateHash) === pending) {
              workspaceDocsByState.delete(stateHash);
            }
          });
          return pending;
        },
      })
    );
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
          ensureMobileAppReady: async (source) =>
            appHostForGateway?.reactNative.ensureReady(source, { waitForApproval: false }) ?? {
              ready: false,
              source: source ?? null,
              reason: "App host is not available",
              details: [],
            },
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
    ensureDORoute: async (source, className, objectKey) => {
      await durableObjectExecutionReadiness.ensureReady({
        source,
        className,
        objectKey,
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
        // Generation-closing (not restart-begin): purely in-process, and it
        // must run for crash transitions too, which skip graceful prepare.
        workerdManager.onGenerationClosing(() => bridge.closeAll());
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
  await panelExecutionReconciler.recoverPreparingPanels();

  // The webhook + credential services are built now, so their refs are set:
  // start the backhaul (no-op when no relay is configured) and re-announce any
  // persisted relay-mode webhook subscriptions so the relay resumes routing.
  relayBackhaul.start();
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
      const cert = ensurePersistentCert({
        identityPemFile: workspaceIdentityPemFile,
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
  // Relay routing follows the workerd process generation. Never leave the
  // prior loopback port looking authoritative during replacement, and publish
  // the new port only after WorkerdManager declares that generation ready.
  // Generation-closing (not restart-begin): crash transitions skip graceful
  // prepare entirely, and the relay URL must still stop pointing at the dead
  // generation all through recovery. Purely in-process by contract.
  workerdManager.onGenerationClosing(() => {
    rpcServerInstance.setWorkerdUrl(null);
    // Lifecycle signal for shell-side consumers (e.g. the browser cookie
    // projection pauses its reconcile loop while the runtime is offline).
    eventService.emit("server-health", { workerd: "restarting", sampledAt: Date.now() });
  });
  workerdManager.onRestartReady(() => {
    const restartedPort = workerdManager.getPort();
    if (!restartedPort) {
      throw new Error("workerd restart reported ready without a relay port");
    }
    rpcServerInstance.setWorkerdUrl(`http://127.0.0.1:${restartedPort}`);
    eventService.emit("server-health", { workerd: "running", sampledAt: Date.now() });
  });
  rpcServerInstance.setWorkerdGatewayToken(workerdGatewayToken);
  rpcServerInstance.setWorkerdDispatchSecret(workerdManager.getDispatchSecret());
  rpcServerInstance.setWorkerInstanceResolver((targetId) =>
    workerdManager.resolveWorkerInstanceName(targetId)
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
  const bootstrapReconciliationStartedAt = Date.now();
  const { runStartupReconciliation } = await import("./services/startupReconciliation.js");
  const lifecycleDriver =
    container.get<import("./services/lifecycleDriver.js").LifecycleDriver>("lifecycleDriver");
  const reconciliation = await runStartupReconciliation({
    dispatchWorkspaceDO,
    entityCache,
    restoreRuntimes: async (records) => {
      type RuntimeTarget = { source: string; className: string; objectKey: string };
      const [lifecycle, alarms, recurring, heartbeats, durableWorkOwners] = await Promise.all([
        dispatchWorkspaceDO<RuntimeTarget[]>("lifecycleListResumeTargets"),
        dispatchWorkspaceDO<RuntimeTarget[]>("alarmListScheduled"),
        dispatchWorkspaceDO<RuntimeTarget[]>("recurringList"),
        dispatchWorkspaceDO<RuntimeTarget[]>("heartbeatList"),
        dispatchWorkspaceDO<import("@vibestudio/shared/durableWork").DurableWorkReadyHint[]>(
          "durableWorkOwnerList"
        ),
      ]);
      const required = new Set(
        [
          ...lifecycle,
          ...alarms,
          ...recurring,
          ...heartbeats,
          ...durableWorkOwners.map((entry) => entry.owner),
        ].map((target) => `${target.source}\0${target.className}\0${target.objectKey}`)
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
      await Promise.all(
        durable.map((record) => durableObjectExecutionReadiness.materialize(record))
      );
    },
    recoverLifecycle: () => lifecycleDriver.recoverStartup("server_restart"),
    logger: { warn: (msg, ...args) => console.warn(msg, ...args) },
  });
  const durableReconciliationCompletedAt = Date.now();
  // Runtime creation primes new panel entities. Replaying active panels after
  // durable hydration gives restored trees the same lazy dependency behavior
  // without treating manifest initPanels as a build-time special case.
  for (const record of entityCache.listActive()) {
    if (record.kind === "panel" && record.activeBuildKey) {
      void primePanelRuntimeImage(record.source.repoPath);
    }
  }
  // Admit server-driven alarms only after every persisted runtime incarnation
  // has reproduced its exact sealed class image and lifecycle recovery has run.
  try {
    container.get<import("./services/alarmDriver.js").AlarmDriver>("alarmDriver").start();
  } catch (err) {
    console.warn("[Bootstrap] alarm re-arm skipped:", err);
  }
  try {
    const durableWorkDriver =
      container.get<import("./services/durableWorkDriver.js").DurableWorkDriver>(
        "durableWorkDriver"
      );
    durableWorkDriver.start();
    void durableWorkDriver.recoverNow();
  } catch (err) {
    console.warn("[Bootstrap] durable work recovery skipped:", err);
  }
  const runtimeRecoveryStartedAt = Date.now();

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
  const { canonicalSingletonContextId, reconcileSingletons, singletonEntityActivationInput } =
    await import("./bootstrap/singletonReconciliation.js");
  const singletonPlans = workspaceDecls.singletons.all().map((decl) => ({
    decl,
    contextId: decl.contextId ?? canonicalSingletonContextId(workspaceId, decl),
  }));
  const singletonPreparationMs = new Map<string, number>();
  const singletonActivationMs = new Map<string, number>();
  const singletonLabel = ({ decl }: (typeof singletonPlans)[number]) =>
    `${decl.source}:${decl.className}:${decl.key}`;
  await reconcileSingletons({
    items: singletonPlans,
    prepare: async (plan) => {
      const { decl, contextId } = plan;
      const startedAt = Date.now();
      try {
        return await workerdManager.ensureDurableObjectEntity({
          source: decl.source,
          className: decl.className,
          key: decl.key,
          contextId,
          ref: decl.contextId ? undefined : "main",
        });
      } finally {
        singletonPreparationMs.set(singletonLabel(plan), Date.now() - startedAt);
      }
    },
    activate: async ({ decl, contextId }, prepared) => {
      const label = `${decl.source}:${decl.className}:${decl.key}`;
      const startedAt = Date.now();
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
      const store = getEntityStore();
      try {
        const existing = await store.resolveRecord(prepared.targetId);
        return await (existing ? store.advanceExecution(activation) : store.activate(activation));
      } finally {
        singletonActivationMs.set(label, Date.now() - startedAt);
      }
    },
    onActivated: () => undefined,
  });
  const singletonReconciliationCompletedAt = Date.now();

  // The bootstrap build system compiled from the filesystem snapshot only to
  // start the semantic source provider. After singleton reconciliation, every
  // active entity has a semantic-main execution identity; discard leftover
  // snapshot builds so their non-CAS roots cannot poison the first GC epoch.
  const protectedBuildKeys = new Set(
    entityCache
      .listActive()
      .map((record) => record.activeBuildKey)
      .filter((key): key is string => typeof key === "string")
  );
  const discardedBootstrapBuilds = buildStoreForPublication.discardBootstrapBuilds(
    bootstrapSnapshot.stateHash,
    protectedBuildKeys
  );
  if (discardedBootstrapBuilds > 0) {
    console.log(
      `[BuildV2] Discarded ${discardedBootstrapBuilds} transitional bootstrap build${discardedBootstrapBuilds === 1 ? "" : "s"}`
    );
  }
  const bootstrapBuildDiscardCompletedAt = Date.now();

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
  const bootstrapReconciliationCompletedAt = Date.now();
  console.info("[StartupBootstrap] Reconciliation barrier", {
    durableReconciliationMs: durableReconciliationCompletedAt - bootstrapReconciliationStartedAt,
    runtimeRecoveryMs: runtimeRecoveryStartedAt - durableReconciliationCompletedAt,
    singletonReconciliationMs: singletonReconciliationCompletedAt - runtimeRecoveryStartedAt,
    bootstrapBuildDiscardMs: bootstrapBuildDiscardCompletedAt - singletonReconciliationCompletedAt,
    cleanupReaperMs: bootstrapReconciliationCompletedAt - bootstrapBuildDiscardCompletedAt,
    singletons: singletonPlans.map((plan) => ({
      singleton: singletonLabel(plan),
      prepareMs: singletonPreparationMs.get(singletonLabel(plan)) ?? null,
      activateMs: singletonActivationMs.get(singletonLabel(plan)) ?? null,
    })),
    totalMs: bootstrapReconciliationCompletedAt - bootstrapReconciliationStartedAt,
  });

  /**
   * The creation review (§7.1), held in the new workspace immediately after it
   * opens.
   *
   * Preparation is awaited by the startup readiness barrier, but the human
   * decision is not. The old startup card blocked the workspace behind a
   * decision nobody could evaluate; this opens the workspace and holds the
   * review inside it. Until it resolves, U6 answers every one of
   * these parts with one recoverable `review-pending` rather than a prompt per
   * method, so the question is asked exactly once, on one surface.
   *
   * The obligation is read from the parts themselves, never from a marker. A
   * marker only describes the workspace it was written in: the first boot after
   * a cutover that discarded the admission file has none, and the emptiness of
   * the admission store cannot stand in for it, because host-build units are
   * admitted from their seed records before this runs. Both together still
   * answered "no" for every workspace created before this change set, which left
   * every panel and worker unadmitted, holding no clearance, and prompting at
   * each use with no review anywhere to answer. On a workspace that owes
   * nothing the set is empty and this does nothing at all, which is what
   * deletes the startup card for good.
   */
  const prepareWorkspaceCreationReview = async (): Promise<void> => {
    try {
      const creationReview = await buildUnitChangeApprovalProvider.creationReview();
      if (creationReview.units.length === 0) {
        creationReviewUnits = new Set();
        creationReviewOwed = false;
        workspaceCreationReview.resolve();
        workspaceCreationReviewState = { status: "not-required" };
      } else {
        // From here on U6 answers from the exact set under review, so no unit
        // outside it can be told to wait on a question nobody asked about it.
        creationReviewUnits = new Set(
          creationReview.units.map((unit) =>
            codeIdentityKey({ repoPath: unit.source.repo, effectiveVersion: unit.ev ?? "" })
          )
        );
        // The workspace opens on the collection surface, headed by the
        // template being adopted (§7.1). Placement is deliberate: before
        // creation there is no workspace and, on first run, no shell to
        // render in; after creation every primitive the install surface
        // uses is available.
        //
        // Until this resolves, U6 makes every one of these parts answer
        // `review-pending` rather than raising a prompt of its own, so the
        // question is asked exactly once, on one surface.
        // One resolver answers for every surface, so the creation review and
        // the launch gate can never disagree about where the same unit came
        // from. It reads template relationship state and the creation descriptor rather
        // than assuming this workspace's root owns everything in it.
        const origins = await resolveUnitOrigins(
          creationReview.units.map((unit) => unit.source.repo)
        );
        const rootOrigin =
          [...origins.values()].find((origin) => origin.isWorkspaceRoot === true) ?? null;
        const decisionPromise = approvalQueue.request({
          kind: "unit-install-review",
          callerId: "system:workspace-creation",
          callerKind: "system",
          repoPath: "meta",
          effectiveVersion: "",
          dedupKey: "workspace-creation-review",
          mode: "adopt-root",
          title: HOST_APPROVAL_COPY.installReview.heading["adopt-root"],
          description:
            !rootOrigin || rootOrigin.isHostBuild
              ? "These are the parts your workspace starts with."
              : `This workspace is built from code at ${rootOrigin.url}.`,
          units: creationReview.units,
          origins,
          reportsLanding: true,
          ...(creationReview.identityKeysByRepo
            ? { identityKeys: creationReview.identityKeysByRepo }
            : {}),
        });
        // Capture the approval id while the review is still pending. An
        // install review that reports landing deliberately keeps its resolver
        // open until this startup reconciliation publishes the outcome; the
        // entry is removed before `request()` resolves, so looking it up after
        // the await would deadlock the resolver and leave every dependent
        // panel stuck behind the creation review.
        const creationApproval = approvalQueue
          .listPending()
          .find(
            (approval) =>
              approval.kind === "unit-install-review" &&
              approval.callerId === "system:workspace-creation"
          );
        if (creationApproval?.kind !== "unit-install-review") {
          throw new Error("Workspace creation review was not published to the approval queue");
        }
        workspaceCreationReviewState = {
          status: "pending",
          approvalId: creationApproval.approvalId,
          partCount: creationApproval.parts.length,
        };

        // Publication is the startup barrier. Settlement remains interactive
        // and continues independently after the host has exposed the exact
        // pending approval id.
        void decisionPromise
          .then((decision) => {
            if (decision === "deny" || decision === "dismiss") {
              // Nothing was accepted, so nothing is admitted and the marker
              // stays: the question is re-offered rather than silently dropped.
              workspaceCreationReviewState = { status: "unresolved" };
              console.info("[Units] Creation review left unresolved; it will be offered again.");
              return;
            }

            // Accepting admits every part the creation publication landed —
            // selected or not — and mints clearance only for what the user
            // allowed now. The selection rides the store keyed by exact
            // identity, so it can only apply to the versions it was made about.
            try {
              buildUnitChangeApprovalProvider.acceptPreapprovedTrust(
                creationReview.identityKeys,
                "workspace-creation",
                undefined,
                origins
              );
              creationReviewUnits = new Set();
              creationReviewOwed = false;
              workspaceCreationReview.resolve();
              workspaceCreationReviewState = { status: "resolved" };
              approvalQueue.reportInstallLanding?.(creationApproval.approvalId, {
                landed: creationApproval.parts.map((part) => part.identityKey),
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              workspaceCreationReviewState = { status: "failed", error: message };
              approvalQueue.reportInstallLanding?.(creationApproval.approvalId, {
                landed: [],
                failed: creationApproval.parts.map((part) => ({
                  identityKey: part.identityKey,
                  reason: message,
                })),
                workspaceUnchanged: false,
              });
              console.warn("[Units] Failed to resolve the workspace creation review:", error);
            }
          })
          .catch((err: unknown) => {
            const error = err instanceof Error ? err.message : String(err);
            workspaceCreationReviewState = { status: "failed", error };
            console.warn("[Units] Failed to resolve the workspace creation review:", err);
          });
      }
    } catch (err: unknown) {
      // Leave the obligation standing: an unanswered creation review is
      // re-offered on the next boot rather than silently forgotten.
      workspaceCreationReviewState = {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
      console.warn("[Units] Failed to resolve the workspace creation review:", err);
    }
  };

  const runStartupWorkspaceUnitReconcile = async (): Promise<void> => {
    let syncDeclaredRemotesAfterStartupReload = false;
    try {
      do {
        if (pendingStartupMetaConfigReload) {
          syncDeclaredRemotesAfterStartupReload = true;
          pendingStartupMetaConfigReload = false;
        }
        await reconcileDeclaredWorkspaceUnits(workspaceConfig, "startup");
      } while (pendingStartupMetaConfigReload);
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
  // Calling an async function still executes its synchronous prefix inline.
  // Unit discovery and seed verification can be substantial on a cold
  // workspace, so cross a scheduling boundary before starting opportunistic
  // reconciliation. Explicit mobile/Electron readiness modes await this same
  // promise below and therefore retain their stronger startup contract.
  startupWorkspaceUnitReconcile = Promise.resolve()
    .then(runStartupWorkspaceUnitReconcile)
    .then(async () => {
      // Wait only until both declaration branches have staged their requests.
      // publishPending starts the queue entries synchronously; its promise is the
      // later human decision/application and therefore remains detached.
      await Promise.resolve(startupExtensionStaging);
      // The host release unit moves independently of userland. Retry only until
      // Composer records the canonical durable operation; from there Composer
      // owns every review, repair, and publication transition.
      const { startBaseTemplateReleasePullCoordinator } = await import("./baseTemplateRelease.js");
      baseTemplateReleasePullCoordinator = startBaseTemplateReleasePullCoordinator({
        attempt: initiateShippedBaseTemplatePull,
        reportFailure: (error, retryInMs) => {
          const message = error instanceof Error ? error.message : String(error);
          console.warn("[Templates] Failed to open the shipped base-template release operation", {
            error: message,
            retryInMs,
          });
          eventService.emit("notification:show", {
            id: "host-base-template-release-initiation-failed",
            type: "error",
            title: "Workspace update could not start",
            message: "Vibestudio will keep retrying the required base workspace update.",
            ttl: 0,
            details: [
              { label: "Failure", value: message },
              { label: "Retry", value: `in ${Math.ceil(retryInMs / 1_000)} seconds` },
            ],
          });
        },
        reportReady: () => {
          eventService.emit("notification:dismiss", {
            id: "host-base-template-release-initiation-failed",
          });
        },
      });
      void unitInstallReviewCoordinator
        .publishPending("startup")
        .catch((err: unknown) => console.warn("[Units] Failed to publish startup approvals:", err));
      await prepareWorkspaceCreationReview();
    });
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
    const appHost = container.get<import("./appHost.js").AppHost>("appHost");
    const readiness = await appHost.reactNative.ensureReady(null, {
      waitForApproval: false,
    });
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

  // Eval libraries are additionally warmed for persistent workspaces. Apps and
  // extensions continue to activate their own dependency graphs on demand.
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
    stopEventLoopMonitor();
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
    baseTemplateReleasePullCoordinator?.stop();
    baseTemplateReleasePullCoordinator = null;

    // Stop scheduling admission before asking activations to release. A
    // scheduler-owned __alarm may be awaiting a long model/tool effect; cancel
    // only that transport and preserve its durable wake row so lifecycle
    // prepare can enter the activation and release its live resources.
    await alarmDriver
      .quiesce()
      .catch((err) => console.warn("[Server] alarm scheduler quiesce failed:", err));

    await relayBackhaul
      .stop()
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

    // Close the shared eval admission before tearing down its host-held
    // transports. Every EvalDO run is a durable trust unit with its own
    // cancellation cleanup; cancelling it here lets model/tool work, child
    // runtimes, and system-test drivers unwind while the relay is still alive.
    // Reserve the final two seconds for lifecycle release instead of allowing
    // an unbounded cleanup to consume the entire process shutdown budget.
    const evalDrainBudgetMs = Math.max(
      0,
      Math.min(4_000, 8_000 - (Date.now() - shutdownStartedAt) - 2_000)
    );
    await closeActiveEvalRuns?.(evalDrainBudgetMs).catch((err) =>
      console.warn("[Server] active eval shutdown drain failed:", err)
    );

    await closeEvalKernelLeases?.().catch((err) =>
      console.warn("[Server] eval kernel lease shutdown failed:", err)
    );
    const prepareBudgetMs = Math.max(0, Math.min(2000, 8000 - (Date.now() - shutdownStartedAt)));
    if (prepareBudgetMs > 0) {
      await lifecycleDriver
        .prepareForShutdown(prepareBudgetMs)
        .catch((err) => console.warn("[Server] lifecycle shutdown prepare failed:", err));
    }

    // At this point the owned eval/lifecycle work has had its chance to
    // release normally. Abort any remaining inbound RPC/stream work before
    // stopping workerd so a DO callback cannot keep a workerd handler alive
    // while its host-side owner is already being dismantled. RpcServer remains
    // available as an object for the ordered service stop below; it simply no
    // longer admits or retains transport-owned work.
    rpcServerForGateway?.quiesce("Server shutting down");

    await container
      .stopAll()
      .then(() => console.log("[Server] All services stopped"))
      .catch((e) => console.error("[Server] Service shutdown error:", e));

    // Gateway is deliberately outside the service container because it is the
    // socket owner for several services. It still needs an explicit terminal
    // close after those services are down; otherwise keep-alive and upgraded
    // sockets survive the service graph and can hold a shutdown hostage.
    await gateway.stop().catch((err) => console.warn("[Server] gateway shutdown failed:", err));
    try {
      userlandResourceHandles.close();
    } catch (error) {
      console.error("[Server] Resource handle store shutdown error:", error);
    }
    try {
      reviewedClosureRegistry.close();
    } catch (error) {
      console.error("[Server] Reviewed closure registry shutdown error:", error);
    }
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
