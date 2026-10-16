import * as path from "node:path";
import type { Call } from "@vibestudio/client-host-core";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { clientsMethods, type ClientListingSchema } from "@vibestudio/service-schemas/clients";
import type { z } from "zod";
import { shellApprovalMethods } from "@vibestudio/service-schemas/shellApproval";
import type { HostDescriptor } from "@vibestudio/workspace-contracts/clients";
import type { PendingApproval } from "@vibestudio/shared/approvals";
import { defaultAcceptance } from "@vibestudio/shared/authority/unitInstallReview";
import {
  ApprovalFeed,
  serveDeviceDriver,
  type DeviceDriverHandle,
  type DeviceDriverTransport,
  type ClientInstanceIdentity,
  type DeviceOperations,
  type SurfaceInfo,
} from "@vibestudio/shared/deviceDriver";
import type { LaunchObservation } from "./clientHost.js";
import type { ClientWindow, ClientWindows } from "./clientWindow.js";
import type { InstalledLauncher } from "./integration/launcherArtifacts.js";
import type { ScopedServerCaller } from "./serverClient.js";

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
  readonly approvals = new Topic();
  /** A window's build or granted capabilities changed. */
  readonly windowChanged = new Topic<ClientWindow>();
  readonly windowClosed = new Topic<{ window: ClientWindow; reason: string | null }>();
  readonly launches = new Topic<LaunchObservation>();

  clientsChanged(): void {
    this.clients.emit();
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
  /** Bring the host's launch entries up to date with the server's snapshot. */
  refreshIntegration(): Promise<void>;
  /** A hosted client session ended for good (`trust-revoked`, `retired`, ...). */
  onSessionEnded(listener: (caller: ScopedServerCaller, reason: string) => void): () => void;
}

interface ClosedSurface {
  instance: ClientInstanceIdentity;
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
  const approvals = createTypedServiceClient("shellApproval", shellApprovalMethods, deps.call);
  const closedSurfaces = new Map<string, ClosedSurface>();
  const developing = new Set<string>();
  const sessionEnds: Array<{ clientId: string; principalId: string; reason: string }> = [];
  const sessionEnded = new Topic();
  const feed = new ApprovalFeed(() => approvals.listPending());

  // Recorded for the life of the driver, so a close that happens before a test
  // asks about it is still answered.
  const releases = [
    signals.windowClosed.on(({ window, reason }) => {
      closedSurfaces.set(window.windowId, {
        instance: instanceOf(window),
        capabilities: window.spec.capabilities,
        deniedOptional: deps.clientHost.runningClient(window.spec.clientId)?.deniedOptional ?? [],
        reason: reason ?? "closed",
      });
    }),
    signals.approvals.on(() => feed.notify()),
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
    topic: { arm(signal: AbortSignal): Armed },
    signal: AbortSignal,
    check: () => Promise<T | undefined> | T | undefined
  ): Promise<T> {
    for (;;) {
      const armed = topic.arm(signal);
      try {
        const found = await check();
        if (found !== undefined) return found;
        await armed.wait();
      } finally {
        armed.dispose();
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
          } else if (observation.state.state !== "preparing") {
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
        case "approval-required":
          return { state: "approval-required", approvals: state.approvals.length };
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
      return until(signals.windowChanged, signal, () => {
        const info = infoOf(surfaceId);
        if (info.instance.buildKey !== fromBuildKey) return info.instance;
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

    async nextApproval(_args, signal) {
      return abortable(feed.next(), signal);
    },

    async releaseApprovals() {
      feed.release();
      return null;
    },

    async resolveApproval({ approvalId, decision }) {
      const pending = (await approvals.listPending()).find(
        (approval: PendingApproval) => approval.approvalId === approvalId
      );
      if (!pending) throw coded("ENOENT", `No pending approval ${approvalId}`);
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
      feed.release();
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

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(abortReason(signal));
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
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
