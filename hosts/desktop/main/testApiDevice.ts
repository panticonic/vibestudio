import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { Call } from "@vibestudio/client-host-core";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { clientsMethods, type ClientListingSchema } from "@vibestudio/service-schemas/clients";
import type { z } from "zod";
import { shellApprovalMethods } from "@vibestudio/service-schemas/shellApproval";
import type { HostDescriptor } from "@vibestudio/workspace-contracts/clients";
import { defaultAcceptance } from "@vibestudio/shared/authority/unitInstallReview";
import {
  ApprovalSurfaces,
  serveDeviceDriver,
  type DeviceDriverHandle,
  type DeviceDriverTransport,
  type ClientInstanceIdentity,
  type DeviceOperations,
  type DevicePendingApproval,
  type SurfaceInfo,
} from "@vibestudio/shared/deviceDriver";
import type { LaunchObservation } from "./clientHost.js";
import type { WorkspaceApprovalSnapshot } from "./approvalAttention.js";
import type { ClientWindow, ClientWindows } from "./clientWindow.js";
import type { InstalledLauncher } from "./integration/launcherArtifacts.js";
import type { ScopedServerCaller, ServerClient } from "./serverClient.js";
import { createClientWindowRpc } from "../connection/clientRelay.js";
import type { PanelOrchestrator } from "./panelOrchestrator.js";
import { createPanelFor } from "./services/panelShellService.js";

/**
 * The desktop half of the client system tests' device driver
 * (`packages/shared/src/deviceDriver.ts`): the operations a test runs on the
 * person's desktop, answered from the host's own state and events.
 *
 * Nothing here polls. A wait arms the signal that can change its answer, reads
 * the state, and sleeps until that signal fires again; a window's close, a
 * server announcement, a launch state and a session end all arrive as events
 * the host already handles and forwards through {@link DesktopDriverSignals}.
 */

/** A subscription that cannot miss an emission between arming and waiting. */
class Topic<T = void> {
  private readonly listeners = new Set<(value: T) => void>();

  emit(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }

  on(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Start listening now; `wait` settles on the first emission since this call. */
  arm(signal: AbortSignal): Armed {
    let fired = false;
    let wake: (() => void) | null = null;
    const off = this.on(() => {
      fired = true;
      wake?.();
    });
    return {
      wait: () =>
        new Promise<void>((resolve, reject) => {
          if (signal.aborted) return reject(abortReason(signal));
          if (fired) return resolve();
          const onAbort = () => reject(abortReason(signal));
          wake = () => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      dispose: off,
    };
  }
}

export interface Armed {
  wait(): Promise<void>;
  dispose(): void;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("The operation was cancelled");
}

/**
 * What the host tells the driver, from the places the host already learns it.
 * The host's wiring calls these where it handles the same event for itself.
 */
export class DesktopDriverSignals {
  readonly clients = new Topic();
  /** A supervised unit's build was adopted, rejected or failed (`supervision:changed`). */
  readonly supervision = new Topic();
  readonly approvals = new Topic();
  /** A window's build or granted capabilities changed. */
  readonly windowChanged = new Topic<ClientWindow>();
  readonly windowClosed = new Topic<{ window: ClientWindow; reason: string | null }>();
  readonly launches = new Topic<LaunchObservation>();

  clientsChanged(): void {
    this.clients.emit();
  }
  supervisionChanged(): void {
    this.supervision.emit();
  }
  approvalsChanged(): void {
    this.approvals.emit();
  }
  changed(window: ClientWindow): void {
    this.windowChanged.emit(window);
  }
  closed(window: ClientWindow, reason: string | null): void {
    this.windowClosed.emit({ window, reason });
  }
  launchObserved(observation: LaunchObservation): void {
    this.launches.emit(observation);
  }
}

/** What a client window exposes to a test: its rendered text and its keyboard. */
export interface WindowTextPort {
  read(window: ClientWindow): Promise<string>;
  /** Arm now; `wait` settles when the window's text may have changed since. */
  changed(window: ClientWindow, signal: AbortSignal): Armed;
  type(window: ClientWindow, keys: string): Promise<void>;
}

export interface DesktopDriverDeps {
  call: Call;
  /** The approval queues of every open workspace; a card is answered by its own workspace. */
  approvals: {
    listPending(): Promise<readonly WorkspaceApprovalSnapshot[]>;
    call(workspaceId: string): Call;
  };
  descriptor: HostDescriptor;
  hostPid: number;
  signals: DesktopDriverSignals;
  clientHost: {
    launch(select: { id: string }): Promise<unknown>;
    setDevelopmentMode(clientId: string, enabled: boolean): void;
    pendingFor(clientId: string): { buildKey: string } | null;
    runningClient(clientId: string): { deniedOptional: readonly string[] } | null;
  };
  windows: Pick<ClientWindows, "all" | "windowsOf" | "close">;
  text: WindowTextPort;
  launchers: {
    install(clientId: string): Promise<boolean>;
    records(): InstalledLauncher[];
    onChanged(listener: () => void): () => void;
  };
  /** The account's private workspace `role`, opened as the desktop opens it for its own windows. */
  panelWorkspace(role: "personal" | "system"): Promise<{
    workspaceId: string;
    orchestrator: Pick<PanelOrchestrator, "createPanel">;
    /** The workspace's connection, on which a client window holds its principal session. */
    serverClient: Pick<ServerClient, "callAs">;
    hasPanel(panelId: string): boolean;
  }>;
  /** Bring the host's launch entries up to date with the server's snapshot. */
  refreshIntegration(): Promise<void>;
  /** A hosted client session ended for good (`trust-revoked`, `retired`, ...). */
  onSessionEnded(listener: (caller: ScopedServerCaller, reason: string) => void): () => void;
}

interface ClosedSurface {
  instance: ClientInstanceIdentity;
  principalId: string;
  capabilities: readonly string[];
  deniedOptional: readonly string[];
  reason: string;
}

const CLOSED_BY_DRIVER = "closed-by-test";

function instanceOf(window: ClientWindow): ClientInstanceIdentity {
  return {
    clientId: window.spec.clientId,
    instanceId: window.windowId,
    buildKey: window.spec.buildKey,
  };
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "EUNKNOWN";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** The desktop operations, plus the release that retires everything they own. */
export function createDesktopDeviceOps(deps: DesktopDriverDeps): {
  ops: DeviceOperations;
  close(): void;
} {
  const { signals, windows } = deps;
  const clients = createTypedServiceClient("clients", clientsMethods, deps.call);
  const approvalsOf = (workspaceId: string) =>
    createTypedServiceClient(
      "shellApproval",
      shellApprovalMethods,
      deps.approvals.call(workspaceId)
    );
  const closedSurfaces = new Map<string, ClosedSurface>();
  const developing = new Set<string>();
  const sessionEnds: Array<{ clientId: string; principalId: string; reason: string }> = [];
  const sessionEnded = new Topic();
  const approvalSurfaces = new ApprovalSurfaces<DevicePendingApproval>(async () =>
    (await deps.approvals.listPending()).flatMap(({ workspaceId, pending }) =>
      pending.map((approval) => ({ ...approval, workspaceId }))
    )
  );

  // Recorded for the life of the driver, so a close that happens before a test
  // asks about it is still answered.
  const releases = [
    signals.windowClosed.on(({ window, reason }) => {
      closedSurfaces.set(window.windowId, {
        instance: instanceOf(window),
        principalId: window.spec.principalId,
        capabilities: window.spec.capabilities,
        deniedOptional: deps.clientHost.runningClient(window.spec.clientId)?.deniedOptional ?? [],
        reason: reason ?? "closed",
      });
    }),
    signals.approvals.on(() => approvalSurfaces.notify()),
    deps.onSessionEnded((caller, reason) => {
      const match = /^client:(.+):web:[^:]+$/u.exec(caller.callerId);
      if (!match) return;
      sessionEnds.push({ clientId: match[1]!, principalId: caller.callerId, reason });
      sessionEnded.emit();
    }),
  ];

  const openWindow = (surfaceId: string): ClientWindow | null =>
    windows.all().find((window) => window.windowId === surfaceId) ?? null;

  const requireSurface = (
    surfaceId: string
  ): { window: ClientWindow; closed: null } | { window: null; closed: ClosedSurface } => {
    const window = openWindow(surfaceId);
    if (window) return { window, closed: null };
    const closed = closedSurfaces.get(surfaceId);
    if (closed) return { window: null, closed };
    throw coded("ENOENT", `No window ${surfaceId}`);
  };

  const infoOf = (surfaceId: string): SurfaceInfo => {
    const surface = requireSurface(surfaceId);
    if (surface.window) {
      const { spec } = surface.window;
      return {
        instance: instanceOf(surface.window),
        grantedCapabilities: [...spec.capabilities],
        deniedOptional: [...(deps.clientHost.runningClient(spec.clientId)?.deniedOptional ?? [])],
        pendingBuildKey: deps.clientHost.pendingFor(spec.clientId)?.buildKey ?? null,
        developing: developing.has(spec.clientId),
        closed: null,
      };
    }
    const { closed } = surface;
    return {
      instance: closed.instance,
      grantedCapabilities: [...closed.capabilities],
      deniedOptional: [...closed.deniedOptional],
      pendingBuildKey: null,
      developing: developing.has(closed.instance.clientId),
      closed: { reason: closed.reason },
    };
  };

  const closedReason = (surfaceId: string): string | null =>
    closedSurfaces.get(surfaceId)?.reason ?? null;

  /** Run `check` now and after every `topic` emission until it returns a value. */
  async function until<T>(
    topic: { arm(signal: AbortSignal): Armed } | readonly { arm(signal: AbortSignal): Armed }[],
    signal: AbortSignal,
    check: () => Promise<T | undefined> | T | undefined
  ): Promise<T> {
    const topics = Array.isArray(topic) ? topic : [topic as { arm(signal: AbortSignal): Armed }];
    for (;;) {
      const armed = topics.map((t) => t.arm(signal));
      try {
        const found = await check();
        if (found !== undefined) return found;
        await Promise.race(armed.map((a) => a.wait()));
      } finally {
        for (const a of armed) a.dispose();
      }
    }
  }

  /** The wire listing of a client, or null when the host's index lacks it. */
  const listingOf = async (id: string) => {
    const found = (await clients.list(deps.descriptor)).find((listing) => listing.id === id);
    return found ? toLite(found) : null;
  };

  const ops: DeviceOperations = {
    async identities() {
      const info = (await deps.call("auth", "getConnectionInfo", [])) as { serverBootId: string };
      return {
        serverBootId: info.serverBootId,
        hostPid: deps.hostPid,
        instances: windows.all().map(instanceOf),
      };
    },

    async list() {
      return (await clients.list(deps.descriptor)).map(toLite);
    },

    async waitForListing({ id, present }, signal) {
      const found = await until(signals.clients, signal, async () => {
        const listing = await listingOf(id);
        return (listing !== null) === present ? { listing } : undefined;
      });
      return found.listing;
    },

    async launch({ id, develop }, signal) {
      const select = { id };
      if (develop === true) developing.add(id);
      else developing.delete(id);
      deps.clientHost.setDevelopmentMode(id, develop === true);
      const finished = new Promise<LaunchObservation>((resolve, reject) => {
        const stop = signals.launches.on((observation) => {
          if (observation.select !== select) return;
          if ("failure" in observation) {
            stop();
            reject(observation.failure);
          } else if (
            observation.state.state !== "preparing" &&
            observation.state.state !== "approval-required"
          ) {
            // A build still preparing and an install review still waiting for
            // the person are not answers: this driver is the person's device,
            // its approval surface answers the review, and the host continues
            // the launch when the review is resolved.
            stop();
            resolve(observation);
          }
        });
        signal.addEventListener(
          "abort",
          () => {
            stop();
            reject(abortReason(signal));
          },
          { once: true }
        );
        deps.clientHost.launch(select).catch((error: unknown) => {
          stop();
          reject(error);
        });
      });
      const outcome = await finished;
      if ("failure" in outcome) throw outcome.failure;
      const state = outcome.state;
      switch (state.state) {
        case "ready": {
          const window = windows.windowsOf(id).at(-1);
          if (!window) throw coded("ENOENT", `${id} launched but has no window`);
          return { state: "ready", surfaceId: window.windowId, instance: instanceOf(window) };
        }
        case "unavailable":
          return {
            state: "unavailable",
            reason: state.reason,
            ...(state.missing ? { missing: state.missing } : {}),
          };
        default:
          throw coded("EINVAL", `Unexpected launch state ${state.state}`);
      }
    },

    async surfaceInfo({ surfaceId }) {
      return infoOf(surfaceId);
    },

    async surfaceText({ surfaceId }) {
      const surface = requireSurface(surfaceId);
      if (!surface.window)
        throw coded("ECLOSED", `Window ${surfaceId} is closed (${surface.closed.reason})`);
      return deps.text.read(surface.window);
    },

    async waitForText({ surfaceId, text }, signal) {
      const surface = requireSurface(surfaceId);
      if (!surface.window)
        throw coded(
          "ECLOSED",
          `Window ${surfaceId} closed (${surface.closed.reason}) before showing "${text}"`
        );
      const window = surface.window;
      // A window that ends while the wait is armed settles it as a failure.
      const ended = new Promise<never>((_, reject) => {
        const stop = signals.windowClosed.on((event) => {
          if (event.window.windowId !== surfaceId) return;
          stop();
          reject(
            coded(
              "ECLOSED",
              `Window ${surfaceId} closed (${event.reason ?? "closed"}) before showing "${text}"`
            )
          );
        });
        signal.addEventListener("abort", stop, { once: true });
      });
      ended.catch(() => undefined);
      for (;;) {
        const armed = deps.text.changed(window, signal);
        try {
          const shown = await Promise.race([deps.text.read(window), ended]);
          if (shown.includes(text)) return shown;
          await Promise.race([armed.wait(), ended]);
        } finally {
          armed.dispose();
        }
      }
    },

    async sendKeys({ surfaceId, keys }) {
      const surface = requireSurface(surfaceId);
      if (!surface.window) throw coded("ECLOSED", `Window ${surfaceId} is closed`);
      await deps.text.type(surface.window, keys);
      return null;
    },

    async waitForClosed({ surfaceId }, signal) {
      requireSurface(surfaceId);
      const reason = await until(
        signals.windowClosed,
        signal,
        () => closedReason(surfaceId) ?? undefined
      );
      return { reason };
    },

    async waitForGranted({ surfaceId, capability }, signal) {
      return until(signals.windowChanged, signal, () => {
        const info = infoOf(surfaceId);
        if (info.grantedCapabilities.includes(capability)) return info;
        if (info.closed) {
          throw coded(
            "ECLOSED",
            `Window ${surfaceId} closed (${info.closed.reason}) before it was granted ${capability}`
          );
        }
        return undefined;
      });
    },

    async waitForBuildChange({ surfaceId, fromBuildKey }, signal) {
      return until([signals.windowChanged, signals.supervision], signal, async () => {
        const info = infoOf(surfaceId);
        if (info.instance.buildKey !== fromBuildKey) return info.instance;
        // A rebuild that failed is the outcome: no build will be adopted for it.
        const rejected = (await listingOf(info.instance.clientId))?.lastError;
        if (rejected) {
          throw coded(
            "EBUILDREJECTED",
            `The rebuild of ${info.instance.clientId} was not adopted: ${rejected}`
          );
        }
        if (info.closed) {
          throw coded(
            "ECLOSED",
            `Window ${surfaceId} closed (${info.closed.reason}) before it moved off build ${fromBuildKey}`
          );
        }
        return undefined;
      });
    },

    async waitForSessionClosed({ clientId }, signal) {
      const ended = await until(sessionEnded, signal, () => {
        const index = sessionEnds.findIndex((entry) => entry.clientId === clientId);
        return index < 0 ? undefined : sessionEnds.splice(index, 1)[0];
      });
      return { reason: ended.reason, principalId: ended.principalId };
    },

    async closeSurface({ surfaceId }) {
      const surface = requireSurface(surfaceId);
      if (surface.window) windows.close(surface.window, CLOSED_BY_DRIVER);
      return null;
    },

    async invokeIntent({ id, intent, params }) {
      try {
        // The raw result, so a test can see exactly which fields the server returned.
        const result = (await deps.call("clients", "invokeIntent", [
          deps.descriptor,
          { id, intent, ...(params ? { params } : {}) },
        ])) as Record<string, unknown>;
        return { ok: true, text: String(result["text"] ?? ""), fields: Object.keys(result) };
      } catch (error) {
        return { ok: false, code: codeOf(error), message: messageOf(error) };
      }
    },

    async installLauncher({ id: clientId }) {
      await deps.refreshIntegration();
      if (!(await deps.launchers.install(clientId))) {
        throw coded("ECANCELLED", `The launcher for ${clientId} was not confirmed`);
      }
      const artifact = artifactsOf(deps.launchers.records()).find(
        (entry) => entry.clientId === clientId
      );
      if (!artifact) throw coded("ENOENT", `Installing the launcher for ${clientId} wrote nothing`);
      return artifact;
    },

    async integrationArtifacts() {
      return artifactsOf(deps.launchers.records());
    },

    async waitForArtifactsRemoved({ clientId }, signal) {
      const changed = new Topic();
      const off = deps.launchers.onChanged(() => changed.emit());
      try {
        await until(changed, signal, () =>
          deps.launchers.records().some((launcher) => launcher.clientId === clientId)
            ? undefined
            : true
        );
      } finally {
        off();
      }
      return null;
    },

    async createPanelAsClient({ surfaceId, workspace, source, title }) {
      const surface = requireSurface(surfaceId);
      if (!surface.window) {
        throw coded("ECLOSED", `Window ${surfaceId} is closed (${surface.closed.reason})`);
      }
      const { window } = surface;
      const target = await deps.panelWorkspace(workspace);
      // The host path `view.createPanel` runs for a client window, after the
      // same panel-hosting capability gate.
      if (!window.spec.capabilities.includes("panel-hosting")) {
        throw coded("EACCES", `Window ${surfaceId} lacks client capability 'panel-hosting'`);
      }
      const created = await createPanelFor(
        target.orchestrator,
        window.callerId,
        null,
        source,
        title === undefined ? undefined : { title }
      );
      return {
        workspaceId: target.workspaceId,
        panelId: created.id,
        title: created.title,
        registered: target.hasPanel(created.id),
      };
    },

    async callAsClient({ surfaceId, workspace, service, method, args }, signal) {
      const surface = requireSurface(surfaceId);
      if (!surface.window) {
        throw coded("ECLOSED", `Window ${surfaceId} is closed (${surface.closed.reason})`);
      }
      const { window } = surface;
      const target = await deps.panelWorkspace(workspace);
      const principalId = window.spec.principalId;
      // The window's renderer relay and RPC client, not a call made for it: a failure is
      // the server's original error, and an authority acquisition is awaited as the principal.
      const relay = createClientWindowRpc(
        target.serverClient,
        {
          callerId: window.callerId,
          runtimeId: principalId,
          capabilities: window.spec.capabilities,
        },
        target.workspaceId
      );
      try {
        const value = await relay.rpc.call("main", `${service}.${method}`, args ?? [], { signal });
        return { workspaceId: target.workspaceId, principalId, value };
      } finally {
        relay.close();
      }
    },

    async retireClient({ id }) {
      // Supervision names a client by its registry entity (the unit name), not by
      // the listing id; the listing's source is what links the two.
      const listing = await listingOf(id);
      if (!listing) throw coded("ENOENT", `No client ${id} is listed`);
      const running = (await deps.call("runtime", "supervision.list", [
        { kind: "client" },
      ])) as Array<{
        identity: { entityId: string };
        source: string;
      }>;
      const entity = running.find((entry) => entry.source === listing.source);
      if (!entity) throw coded("ENOENT", `Client ${id} (${listing.source}) is not supervised`);
      await deps.call("runtime", "supervision.retire", [
        { kind: "client", entityId: entity.identity.entityId },
      ]);
      return null;
    },

    async openClientSession({ surfaceId, workspace }) {
      const surface = requireSurface(surfaceId);
      const target = await deps.panelWorkspace(workspace);
      // An open window's own held session; a closed window's principal gets a new one,
      // which the server must admit with the credential the host still holds for it.
      const session = surface.window
        ? { principalId: surface.window.spec.principalId, instanceId: surface.window.callerId }
        : { principalId: surface.closed.principalId, instanceId: `session-probe-${randomUUID()}` };
      try {
        await target.serverClient.callAs(
          { callerId: session.principalId, callerKind: "client", instanceId: session.instanceId },
          "workspace-state",
          "panel.sourceUsage",
          [1]
        );
        return { ok: true };
      } catch (error) {
        return { ok: false, code: codeOf(error), message: messageOf(error) };
      }
    },

    async openApprovals() {
      return approvalSurfaces.open();
    },

    async nextApproval({ surfaceToken }, signal) {
      return approvalSurfaces.next(surfaceToken, signal);
    },

    async releaseApprovals({ surfaceToken }) {
      approvalSurfaces.release(surfaceToken);
      return null;
    },

    async resolveApproval({ approvalId, decision }) {
      const owner = (await deps.approvals.listPending()).find(({ pending }) =>
        pending.some((approval) => approval.approvalId === approvalId)
      );
      const pending = owner?.pending.find((approval) => approval.approvalId === approvalId);
      if (!owner || !pending) throw coded("ENOENT", `No pending approval ${approvalId}`);
      const approvals = approvalsOf(owner.workspaceId);
      if (decision === "accept-review") {
        if (pending.kind !== "unit-install-review") {
          throw coded("EINVAL", `${pending.kind} is not an install review`);
        }
        await approvals.resolveInstallReview(
          approvalId,
          defaultAcceptance(pending.mode, pending.parts)
        );
      } else {
        await approvals.resolve(approvalId, decision);
      }
      return null;
    },
  };

  return {
    ops,
    close() {
      approvalSurfaces.releaseAll();
      for (const release of releases) release();
    },
  };
}

function artifactsOf(records: readonly InstalledLauncher[]) {
  return records.flatMap((launcher) =>
    launcher.paths.map((artifactPath) => ({
      clientId: launcher.clientId,
      kind: path.extname(artifactPath) || "launcher",
      path: artifactPath,
    }))
  );
}

function toLite(listing: z.infer<typeof ClientListingSchema>) {
  return {
    id: listing.id,
    source: listing.source,
    runtime: listing.runtime,
    status: listing.status,
    trusted: listing.trusted,
    isDefault: listing.isDefault,
    ...(listing.unavailableReason ? { unavailableReason: listing.unavailableReason } : {}),
    ...(listing.lastError ? { lastError: listing.lastError } : {}),
    intents: listing.intents.map((intent) => ({
      name: intent.name,
      kind: intent.kind,
      ...(intent.handler ? { handler: intent.handler } : {}),
      ...(intent.params ? { params: intent.params } : {}),
    })),
    activeBuildKey: listing.activeBuildKey,
  };
}

/** Register this desktop as the account's desktop driver and serve the operations until closed. */
export async function startDesktopDeviceDriver(
  deps: DesktopDriverDeps & {
    transport: DeviceDriverTransport;
    onUndelivered?: (error: unknown) => void;
  }
): Promise<DeviceDriverHandle> {
  const desktop = createDesktopDeviceOps(deps);
  try {
    const served = await serveDeviceDriver({
      transport: deps.transport,
      deviceKind: "desktop",
      ops: desktop.ops,
      ...(deps.onUndelivered ? { onUndelivered: deps.onUndelivered } : {}),
    });
    return {
      async close() {
        try {
          await served.close();
        } finally {
          desktop.close();
        }
      },
    };
  } catch (error) {
    desktop.close();
    throw error;
  }
}
