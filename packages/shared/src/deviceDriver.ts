import { serializeRpcFailure } from "@vibestudio/rpc";
import type { PendingApproval } from "./approvals.js";

/**
 * The device-driver contract: what the client system tests ask of a person's
 * device (the terminal CLI, the desktop app) and how a device host serves it.
 *
 * A host the person started as a test driver registers with the server's
 * `deviceDriver` service and answers the operations below, one request/response
 * each. A wait (`waitForText`, `waitForBuildChange`, ...) is answered by the
 * host from the event that settles it (`clients:changed`, a screen revision,
 * a window's lifecycle, a session's close reason): there is no polling and no
 * clock in this protocol. The server cancels an outstanding request when its
 * caller gives up, which aborts the operation's signal here.
 */

export type DeviceKind = "terminal" | "desktop";

/** One running client instance: a PTY program, an Electron window. */
export interface ClientInstanceIdentity {
  clientId: string;
  /** Process or window identity; a different value means a different instance. */
  instanceId: string;
  buildKey: string;
}

export interface DeviceIdentities {
  /** The server's boot id, as returned in `auth.grantClientPrincipal`. */
  serverBootId: string;
  /** The host process (terminal CLI or Electron main) the device runs. */
  hostPid: number;
  instances: ClientInstanceIdentity[];
}

export interface ClientIntentDeclLite {
  name: string;
  kind: "foreground" | "background";
  handler?: string;
  params?: Record<string, string>;
}

export interface ClientListingLite {
  id: string;
  source: string;
  runtime: string;
  status: string;
  trusted: boolean;
  isDefault: boolean;
  unavailableReason?: string;
  intents: ClientIntentDeclLite[];
  activeBuildKey: string | null;
}

export type LaunchOutcome =
  | { state: "ready"; surfaceId: string; instance: ClientInstanceIdentity }
  | { state: "unavailable"; reason: string; missing?: { capabilities?: string[]; hostAbi?: string } }
  | { state: "approval-required"; approvals: number };

export interface SurfaceInfo {
  instance: ClientInstanceIdentity;
  grantedCapabilities: string[];
  deniedOptional: string[];
  /** A newer ready build the host holds but has not adopted (terminal-host-1 `update.pending()`). */
  pendingBuildKey: string | null;
  developing: boolean;
  /** Set once the host closed the instance, with the stated reason. */
  closed: { reason: string } | null;
}

export type IntentOutcome =
  /** `fields`: the keys of the server's result object (it is `{ text }` and nothing else). */
  | { ok: true; text: string; fields: string[] }
  | { ok: false; code: string; message: string };

export interface IntegrationArtifact {
  clientId: string;
  /** `.desktop` file, shim script, ... */
  kind: string;
  path: string;
}

export interface ShellResult {
  exitCode: number;
  /** What the command printed on stdout: its result, which a pipe consumes. */
  output: string;
  /** What it printed on stderr: diagnostics, which a pipe does not consume. */
  stderr: string;
}

/**
 * The host-side operations. `shell` and `binDirectory` exist only on a
 * terminal device; the rest are common.
 */
export interface ClientDeviceWire {
  identities(args: Record<string, never>): DeviceIdentities;
  list(args: Record<string, never>): ClientListingLite[];
  /** Resolves when the device's client index next satisfies `present` for `id`. */
  waitForListing(args: { id: string; present: boolean }): ClientListingLite | null;
  launch(args: { id: string; develop?: boolean }): LaunchOutcome;
  surfaceInfo(args: { surfaceId: string }): SurfaceInfo;
  /** Rendered text: the PTY screen, or the window's visible text. */
  surfaceText(args: { surfaceId: string }): string;
  /** Resolves with the text once `text` is shown, or rejects when the surface closed without it. */
  waitForText(args: { surfaceId: string; text: string }): string;
  sendKeys(args: { surfaceId: string; keys: string }): null;
  /** Resolves with the reason once the host closed the instance. */
  waitForClosed(args: { surfaceId: string }): { reason: string };
  /** Resolves when the instance's effective capability set includes `capability`. */
  waitForGranted(args: { surfaceId: string; capability: string }): SurfaceInfo;
  /** Resolves when the host adopts a rebuild of this instance's client (develop mode). */
  waitForBuildChange(args: { surfaceId: string; fromBuildKey: string }): ClientInstanceIdentity;
  /** Resolves with the first device session of `clientId` closed with a typed reason. */
  waitForSessionClosed(args: { clientId: string }): { reason: string; principalId: string };
  closeSurface(args: { surfaceId: string }): null;
  invokeIntent(args: { id: string; intent: string; params?: Record<string, string>; stdin?: string }): IntentOutcome;
  /** Host-mediated launcher install (`integration.install`); the device confirms in its own UI. */
  installLauncher(args: { id: string }): IntegrationArtifact;
  integrationArtifacts(args: Record<string, never>): IntegrationArtifact[];
  /** Resolves when no OS artifact remains for `clientId` (reconciled on `clients:changed`). */
  waitForArtifactsRemoved(args: { clientId: string }): null;
  /** The next pending approval this device's approval surface has not yet returned; null once released. */
  nextApproval(args: Record<string, never>): PendingApproval | null;
  /** Settle every outstanding `nextApproval` with null and stop surfacing approvals. */
  releaseApprovals(args: Record<string, never>): null;
  /** Decide a pending approval as the person would; the install review is accepted whole. */
  resolveApproval(args: { approvalId: string; decision: "once" | "deny" | "accept-review" }): null;
  /** terminal: run a command line in a shell with the test-owned PATH, HOME and bin directory. */
  shell(args: { commandLine: string; stdin?: string }): ShellResult;
  /** terminal: the test-owned directory `vibestudio clients link` writes into. */
  binDirectory(args: Record<string, never>): string;
}

export type WireMethod = keyof ClientDeviceWire & string;

/** The operations a host implements; a method the device kind lacks is simply absent. */
export type DeviceOperations = {
  [K in WireMethod]?: (
    args: Parameters<ClientDeviceWire[K]>[0],
    signal: AbortSignal
  ) => Promise<ReturnType<ClientDeviceWire[K]>>;
};

/** What a host needs of its server connection to serve as a driver. */
export interface DeviceDriverTransport {
  call(service: string, method: string, args: unknown[]): Promise<unknown>;
  /** Subscribe to a direct-address event; resolves to the unsubscribe. */
  onDirectEvent(
    event: string,
    listener: (payload: unknown) => void
  ): (() => void) | Promise<() => void>;
}

export interface DeviceDriverHandle {
  /** Abort every running operation, join them, and stop listening. */
  close(): Promise<void>;
}

/**
 * Register `deviceKind` as the account's driver and serve its operations.
 * Listening starts before registration so no request can be missed.
 */
export async function serveDeviceDriver(options: {
  transport: DeviceDriverTransport;
  deviceKind: DeviceKind;
  ops: DeviceOperations;
  /** An answer that could not be delivered (the caller already cancelled, the link dropped). */
  onUndelivered?: (error: unknown) => void;
}): Promise<DeviceDriverHandle> {
  const { transport, deviceKind, ops } = options;
  const running = new Map<string, { abort: AbortController; done: Promise<void> }>();
  let closed = false;

  const answer = async (callId: string, outcome: unknown) => {
    try {
      await transport.call("deviceDriver", "answer", [{ callId, outcome }]);
    } catch (error) {
      options.onUndelivered?.(error);
    }
  };

  const onRequest = (payload: unknown) => {
    if (closed) return;
    const { callId, op, args } = payload as { callId: string; op: string; args: unknown };
    const abort = new AbortController();
    const handler = (ops as Record<string, ((a: unknown, s: AbortSignal) => Promise<unknown>) | undefined>)[op];
    const done = (async () => {
      let outcome: unknown;
      try {
        if (!handler) {
          throw Object.assign(new Error(`The ${deviceKind} device does not implement ${op}`), {
            code: "ENOSYS",
          });
        }
        const arg = Array.isArray(args) ? args[0] : args;
        outcome = { ok: true, value: await handler(arg ?? {}, abort.signal) };
      } catch (error) {
        outcome = { ok: false, failure: serializeRpcFailure(error) };
      }
      running.delete(callId);
      if (!abort.signal.aborted) await answer(callId, outcome);
    })();
    running.set(callId, { abort, done });
  };

  const onCancel = (payload: unknown) => {
    const { callId } = payload as { callId: string };
    running.get(callId)?.abort.abort(new Error("The test cancelled this operation"));
  };

  const unsubscribes = [
    await transport.onDirectEvent("development:device-drive-request", onRequest),
    await transport.onDirectEvent("development:device-drive-cancel", onCancel),
  ];
  await transport.call("deviceDriver", "register", [{ deviceKind }]);

  return {
    async close() {
      closed = true;
      for (const unsubscribe of unsubscribes) unsubscribe();
      for (const entry of running.values()) entry.abort.abort(new Error("The device driver is closing"));
      await Promise.allSettled([...running.values()].map((entry) => entry.done));
    },
  };
}

/**
 * The device's approval surface for one run, fed by the server's approval
 * queue. `notify` is called when the queue changes (the
 * `shell-approval:pending-changed` event); `next` hands out each pending
 * approval once, waiting on that notification, and returns null after
 * `release`.
 */
export class ApprovalFeed {
  private readonly handedOut = new Set<string>();
  private readonly waiters: Array<() => void> = [];
  private released = false;

  constructor(private readonly listPending: () => Promise<readonly PendingApproval[]>) {}

  notify(): void {
    for (const wake of this.waiters.splice(0)) wake();
  }

  async next(): Promise<PendingApproval | null> {
    for (;;) {
      if (this.released) return null;
      const wake = new Promise<void>((resolve) => this.waiters.push(resolve));
      const pending = await this.listPending();
      const fresh = pending.find((approval) => !this.handedOut.has(approval.approvalId));
      if (fresh) {
        this.handedOut.add(fresh.approvalId);
        return fresh;
      }
      // Nothing new in the queue as of the read above; any change after it has
      // already woken `wake`, so this wait cannot miss one.
      await wake;
    }
  }

  release(): void {
    this.released = true;
    this.notify();
  }
}
