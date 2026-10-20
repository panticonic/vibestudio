import type {
  TerminalClientExit,
  TerminalClientServerInfo,
  TerminalClientWorkspace,
} from "@vibestudio/shell-core/terminal/terminalClientHost";
import type { EventName } from "@vibestudio/shared/events";
import { clientsMethods } from "@vibestudio/service-schemas/clients";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import type { ClientSelection } from "@vibestudio/workspace-contracts/clients";
import { openExternalBrowser } from "../../src/node/openExternalBrowser.js";
import { workspaceLabel } from "../../src/node/workspaceLabel.js";
import { CliError } from "../../src/cli/output.js";
import {
  listWorkspacesVia,
  selectRemoteWorkspace,
  type RemoteWorkspaceEntry,
  type RemoteWorkspaceSelector,
} from "../../src/cli/remoteClient.js";
import { RpcClient, type DeviceCredential } from "../../src/cli/rpcClient.js";
import { ChangeSignal, runClientLaunchGate } from "./clientLaunchGate.js";
import { createTerminalDelivery, deviceCall } from "./clientDelivery.js";
import { openServerEvents, type ServerEvents } from "./serverEvents.js";
import { createClientState } from "./hostModules.js";
import { syncClientIndex, type ShimContext } from "./clientShims.js";
import type { TerminalHostState } from "./hostState.js";
import type { LaunchProgress } from "./launchProgress.js";
import { runOwnedCleanupSteps, runWithOwnedCleanup } from "../../scripts/lib/owned-cleanup.mjs";
import { importClientModule, runTerminalClient } from "./terminalHost.js";

export interface TerminalSessionsOptions {
  /** The paired device credential (any selected workspace). */
  credentials: DeviceCredential;
  /**
   * The workspace the client shows. Defaults to the account's Personal
   * workspace, as the desktop does. The client itself always runs from the
   * account's System workspace, where clients are installed.
   */
  workspace?: RemoteWorkspaceSelector;
  /** Which client to launch (the default client, or one by id). */
  select: ClientSelection;
  server: TerminalClientServerInfo;
  /** Owned server lifetime; its exit ends the client with that cause. */
  serverExited?: Promise<string>;
  /** Approve startup approvals once without prompting. */
  yes: boolean;
  /** The owner's termination request; it ends a startup prompt that is still open. */
  signal?: AbortSignal;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  /** What is happening while the client is made ready, before it takes the terminal. */
  progress: LaunchProgress;
  hostVersion: string;
  hostState: TerminalHostState;
  /** Shims and the command table follow `clients:changed` while the client runs. */
  shims: ShimContext;
  /** Test seams. */
  dependencies?: Partial<TerminalSessionDependencies>;
}

export interface TerminalSessionDependencies {
  route(
    credentials: DeviceCredential,
    selector: RemoteWorkspaceSelector,
    options?: { signal?: AbortSignal }
  ): Promise<DeviceCredential>;
  createDevice(credentials: DeviceCredential, options?: { signal?: AbortSignal }): RpcClient;
  listWorkspaces(control: RpcClient): Promise<RemoteWorkspaceEntry[]>;
  createDelivery: typeof createTerminalDelivery;
  runGate: typeof runClientLaunchGate;
  importModule: typeof importClientModule;
  runClient: typeof runTerminalClient;
  openEvents(device: RpcClient): Promise<ServerEvents>;
  openExternal(url: string): Promise<void>;
}

const DEFAULT_DEPENDENCIES: TerminalSessionDependencies = {
  route: selectRemoteWorkspace,
  createDevice: (credentials, owner) => new RpcClient(credentials, owner),
  listWorkspaces: listWorkspacesVia,
  createDelivery: createTerminalDelivery,
  runGate: runClientLaunchGate,
  importModule: importClientModule,
  runClient: runTerminalClient,
  openEvents: openServerEvents,
  openExternal: (url) => openExternalBrowser(url),
};

/** The server pushes a launch or a running client acts on. */
const WATCHED_EVENTS: readonly EventName[] = [
  "clients:changed",
  "supervision:changed",
  "shell-approval:pending-changed",
];

/**
 * Run a client until the user quits or the connection is lost.
 *
 * Each pass routes to the account's System workspace, asks the server to
 * launch the selected client there (`clients.launch`: build, approvals and
 * activation, while the terminal is still in line mode), fetches and verifies
 * its artifacts, obtains the principal of exactly that build, imports the
 * verified module and runs it showing the selected workspace. A
 * `switch-workspace` exit shows the chosen workspace in another pass; so does
 * a restart (an update the client adopted at a safe point, or development
 * mode) and a withdrawal of trust, which launches again so a client that held
 * only an optional power carries on without it.
 */
export async function runTerminalSessions(
  options: TerminalSessionsOptions
): Promise<TerminalClientExit> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
  let selector: RemoteWorkspaceSelector = options.workspace ?? { privateRole: "personal" };
  let select = options.select;
  let revokedClient: string | null = null;
  for (;;) {
    options.signal?.throwIfAborted();
    const routing = options.signal ? { signal: options.signal } : undefined;
    const system = routing
      ? await deps.route(options.credentials, { privateRole: "system" }, routing)
      : await deps.route(options.credentials, { privateRole: "system" });
    const shown = routing
      ? await deps.route(options.credentials, selector, routing)
      : await deps.route(options.credentials, selector);
    const showsPersonal =
      typeof selector === "object" &&
      "privateRole" in selector &&
      selector.privateRole === "personal";
    const personal = showsPersonal
      ? shown
      : routing
        ? await deps.route(options.credentials, { privateRole: "personal" }, routing)
        : await deps.route(options.credentials, { privateRole: "personal" });
    const result = await runOnce(system, shown, personal, select, revokedClient, options, deps);
    revokedClient = null;
    if (result.kind === "restart") {
      options.progress.note("The client was updated; loading the new version…");
      // The intent was for the first entry; a re-entry is a plain open.
      select = "id" in select ? { id: select.id } : select;
      continue;
    }
    if (result.kind === "trust-revoked") {
      options.progress.note(`Vibestudio no longer trusts ${result.title} with everything it held.`);
      revokedClient = result.title;
      select = "id" in select ? { id: select.id } : select;
      continue;
    }
    if (result.exit.kind === "switch-workspace") {
      selector = { workspaceId: result.exit.workspaceId };
      select = "id" in select ? { id: select.id } : select;
      continue;
    }
    return result.exit;
  }
}

type PassResult =
  | { kind: "exit"; exit: TerminalClientExit }
  | { kind: "restart" }
  | { kind: "trust-revoked"; title: string };

async function runOnce(
  systemRoute: DeviceCredential,
  shownRoute: DeviceCredential,
  personalRoute: DeviceCredential,
  select: ClientSelection,
  revokedClient: string | null,
  options: TerminalSessionsOptions,
  deps: TerminalSessionDependencies
): Promise<PassResult> {
  const device = options.signal
    ? deps.createDevice(systemRoute, { signal: options.signal })
    : deps.createDevice(systemRoute);
  // One System connection carries the launch, the artifact download, the grant
  // and the client principal's session (a second session on the same Iroh connection).
  const releaseDevice = device.retainConnection();
  let control: RpcClient | null = null;
  let workspaceDevice: RpcClient | null = null;
  let personalDevice: RpcClient | null = null;
  const watches: ServerEvents[] = [];
  const reconciles = new Set<Promise<unknown>>();
  const reconcileFailures: unknown[] = [];
  const unwatch: Array<() => void> = [];
  // Workspaces as the person sees them: by label, never by internal name.
  const listWorkspaces = async (): Promise<TerminalClientWorkspace[]> => {
    control ??= await device.openControlConnection();
    return (await deps.listWorkspaces(control)).map((entry) => ({
      id: entry.workspaceId,
      name: workspaceLabel(entry),
    }));
  };
  return runWithOwnedCleanup(
    async () => {
      const visible = await listWorkspaces();
      const routed = (route: DeviceCredential): TerminalClientWorkspace => {
        const entry = visible.find((candidate) => candidate.id === route.workspaceId);
        if (!entry) throw new CliError("The selected workspace is not visible to this account.");
        return entry;
      };
      const system = routed(systemRoute);
      const workspace = routed(shownRoute);
      // The account's Personal workspace starts with System: whether its code
      // may run is asked in the same gate, not again once the client is up.
      if (personalRoute.workspaceId !== systemRoute.workspaceId)
        personalDevice = await device.openWorkspaceConnection(personalRoute);
      const delivery = deps.createDelivery({
        device,
        ...(personalDevice ? { companions: [personalDevice] } : {}),
        hostVersion: options.hostVersion,
      });

      // What a waiting launch and a running client act on is pushed by the server.
      const changes = new ChangeSignal();
      const systemWatch = await deps.openEvents(device);
      watches.push(systemWatch);
      if (personalDevice) watches.push(await deps.openEvents(personalDevice));
      for (const watch of watches) {
        for (const name of WATCHED_EVENTS)
          unwatch.push(watch.events.on(name, () => changes.bump()));
        await watch.events.subscribeAll(WATCHED_EVENTS);
      }
      const clients = createTypedServiceClient("clients", clientsMethods, deviceCall(device));
      const reconcile = async () => {
        syncClientIndex(options.shims, await clients.list(delivery.descriptor));
      };
      unwatch.push(
        systemWatch.events.on("clients:changed", () => {
          const run = reconcile().catch((error: unknown) => {
            reconcileFailures.push(error);
          });
          reconciles.add(run);
          void run.finally(() => reconciles.delete(run));
        })
      );

      const prepare = options.progress.step(`Preparing the client in ${system.name}`);
      let outcome: Awaited<ReturnType<typeof deps.runGate>>;
      try {
        outcome = await deps.runGate(delivery.launcher, {
          select,
          yes: options.yes,
          input: options.stdin,
          output: options.stdout,
          onProgress: (line) => prepare.note(line),
          changes,
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (error) {
        prepare.fail();
        throw error;
      }
      if (outcome.status === "denied") {
        prepare.fail();
        throw new CliError("Startup was declined; nothing was started.");
      }
      if (outcome.status === "unavailable") {
        prepare.fail();
        if (revokedClient) {
          throw new CliError(
            `Vibestudio no longer trusts ${revokedClient} to act as this device: ${outcome.reason}`
          );
        }
        const missing = [
          ...(outcome.missing?.capabilities ?? []).map((capability) => `capability ${capability}`),
          ...(outcome.missing?.hostAbi ? [`host ABI ${outcome.missing.hostAbi}`] : []),
        ];
        throw new CliError(
          `That client cannot run in this terminal: ${outcome.reason}` +
            (missing.length ? ` (needs ${missing.join(", ")}).` : "")
        );
      }
      prepare.done();
      const { launched } = outcome;
      const load = options.progress.step(`Loading ${launched.client.title}`);
      let module: Awaited<ReturnType<typeof deps.importModule>>;
      try {
        module = await deps.importModule(launched);
        // Only the running build's artifacts stay cached.
        await delivery.cache.retain(
          new Map([[launched.client.buildKey, launched.artifacts.map((a) => a.integrity)]])
        );
        // The workspace the client shows is reached as this device, exactly as
        // the desktop shell reaches the workspace it shows.
        workspaceDevice =
          workspace.id === system.id
            ? device
            : workspace.id === personalRoute.workspaceId && personalDevice
              ? personalDevice
              : await device.openWorkspaceConnection(shownRoute);
        await reconcile();
      } catch (error) {
        load.fail();
        throw error;
      }
      load.done();
      const run = await deps.runClient({
        device,
        workspaceDevice,
        launched,
        module,
        system,
        workspace,
        server: options.server,
        ...(options.serverExited ? { serverExited: options.serverExited } : {}),
        events: systemWatch.events,
        hostState: options.hostState,
        state: createClientState(launched.client.id),
        listWorkspaces,
        openExternal: deps.openExternal,
        stdin: options.stdin,
        stdout: options.stdout,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return run.kind === "trust-revoked"
        ? { kind: "trust-revoked", title: launched.client.title }
        : run;
    },
    async () => {
      const openControl = control as RpcClient | null;
      const openWorkspace = workspaceDevice as RpcClient | null;
      const openPersonal = personalDevice as RpcClient | null;
      await runOwnedCleanupSteps(
        [
          () => {
            for (const stop of unwatch.splice(0)) stop();
          },
          async () => {
            await Promise.allSettled([...reconciles]);
            if (reconcileFailures.length === 1) throw reconcileFailures[0];
            if (reconcileFailures.length > 1)
              throw new AggregateError(reconcileFailures, "Client index reconciliation failed");
          },
          async () => {
            const results = await Promise.allSettled([
              ...watches.map((watch) => watch.close()),
              openControl?.close(),
              openWorkspace && openWorkspace !== device ? openWorkspace.close() : undefined,
              openPersonal && openPersonal !== openWorkspace ? openPersonal.close() : undefined,
              releaseDevice(),
            ]);
            const failures = [
              ...new Set(
                results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
              ),
            ];
            if (failures.length === 1) throw failures[0];
            if (failures.length)
              throw new AggregateError(failures, "Terminal connections could not all be closed");
          },
          () => device.close(),
        ],
        "Terminal connection retirement failed"
      );
    },
    "Terminal client operation and retirement failed"
  );
}
