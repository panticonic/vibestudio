import "./polyfills.js";
import { AppState, type AppStateStatus } from "react-native";
import * as Keychain from "react-native-keychain";
import { EndpointGenerationOwner } from "@vibestudio/iroh-transport";
import {
  CLOSE_TOKEN_REVOKED,
  createRpcClient,
  secureRandomUuid,
  type RpcClient,
} from "@vibestudio/rpc";
import { serializeByKey } from "@vibestudio/shared/keyedSerializer";
import {
  createIrohClientPipe,
  type IrohClientSession,
} from "@vibestudio/rpc/transports/irohClient";
import {
  createReconnectingIrohClientPipe,
  type LifecycleIrohClientPipe,
} from "@vibestudio/rpc/transports/reconnectingIrohClient";
import type { OAuthCallbackMode } from "@vibestudio/rpc/protocol/wsProtocol";
import {
  createMobileEndpointBinding,
  mobileIrohIdentity,
  type MobileConnection,
  type MobileEndpoint,
} from "./nativeBridge.js";
import {
  parseStoredMobileConnection,
  replaceMobileConnectionCredential,
  type FreshShellPairing,
  type ShellCredential,
  type StoredMobileConnection,
  type StoredShellPairing,
} from "./storedCredential.js";
import { resumeMobileConnection } from "./resumeConnection.js";
import { MobileWorkspaceAccount } from "./workspaceAccount.js";
import { mobileConnectionRecoveryTimeoutError } from "./connectionRecovery.js";

export type {
  FreshShellPairing,
  ShellCredential,
  StoredMobileConnection,
  StoredPairedMobileConnection,
  StoredRoutedMobileConnection,
  StoredShellPairing,
} from "./storedCredential.js";

const KEYCHAIN_SERVICE = "vibestudio:iroh:shell-credential";
const credentialWrites = new Map<string, Promise<unknown>>();

export interface ShellTokenProvider {
  getToken(): string;
  setCredential(next: ShellCredential | null): void;
}

export interface IrohConnectionHandlers {
  onPaired?: (credential: ShellCredential) => void | Promise<void>;
  onPersistError?: (error: Error) => void;
  onRecovery?: (kind: "resubscribe" | "cold-recover") => void | Promise<void>;
}

export interface IrohConnection {
  rpc: RpcClient;
  session: IrohClientSession;
  transport: LifecycleIrohClientPipe;
  callerId: string;
  serverId?: string;
  endpointIdentityId: string;
  /** Shared physical endpoint owner for the retained hub/workspace pair. */
  endpointPool: MobileEndpointPool;
  deviceId?: string | null;
  hubControlRpc?: RpcClient;
  waitUntilConnected(timeoutMs: number): Promise<void>;
  close(): Promise<void>;
}

export class MobileEndpointPool {
  private owner: EndpointGenerationOwner<MobileConnection, MobileEndpoint> | null = null;
  private references = 0;
  private closed = false;

  constructor(
    readonly identityId: string,
    private readonly relays: readonly string[]
  ) {}

  acquire(relays: readonly string[]): void {
    if (this.closed) throw new Error("Mobile Iroh endpoint pool is closed");
    if (
      relays.length !== this.relays.length ||
      relays.some((relay) => !this.relays.includes(relay))
    ) {
      throw new Error("Hub and workspace must advertise the same Iroh relay set");
    }
    this.references += 1;
  }

  dial(reach: StoredShellPairing) {
    if (this.closed) return Promise.reject(new Error("Mobile Iroh endpoint pool is closed"));
    this.owner ??= new EndpointGenerationOwner(
      createMobileEndpointBinding(this.identityId, this.relays)
    );
    return this.owner.dial({
      reach,
      overallDeadlineMs: 30_000,
      perAttemptDeadlineMs: 12_000,
    });
  }

  async suspend(): Promise<void> {
    const current = this.owner;
    this.owner = null;
    await current?.close();
  }

  async release(): Promise<void> {
    this.references = Math.max(0, this.references - 1);
    if (this.references > 0 || this.closed) return;
    this.closed = true;
    await this.suspend();
  }
}

export function randomRequestId(prefix = "mobile-shell"): string {
  return `${prefix}-${secureRandomUuid()}`;
}

export function makeFreshShellTokenProvider(pairing: FreshShellPairing): ShellTokenProvider {
  let credential: ShellCredential | null = null;
  return {
    getToken: () =>
      credential ? `refresh:${credential.deviceId}:${credential.refreshToken}` : pairing.code,
    setCredential: (next) => {
      credential = next;
    },
  };
}

export function makeReturningShellTokenProvider(initial: ShellCredential): ShellTokenProvider {
  let credential: ShellCredential | null = initial;
  return {
    getToken: () => (credential ? `refresh:${credential.deviceId}:${credential.refreshToken}` : ""),
    setCredential: (next) => {
      credential = next;
    },
  };
}

export async function persistStoredMobileConnection(stored: StoredMobileConnection): Promise<void> {
  const payload = JSON.stringify(stored);
  if (!parseStoredMobileConnection(payload)) throw new Error("Cannot persist invalid Iroh state");
  await serializeByKey(credentialWrites, KEYCHAIN_SERVICE, async () => {
    const result = await Keychain.setGenericPassword("shell", payload, {
      service: KEYCHAIN_SERVICE,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    if (result === false) throw new Error("The OS secure store refused the Iroh credential update");
  });
}

export async function loadShellCredential(): Promise<StoredMobileConnection | null> {
  const result = await Keychain.getGenericPassword({ service: KEYCHAIN_SERVICE });
  return result ? parseStoredMobileConnection(result.password) : null;
}

export async function clearShellCredential(expected?: {
  endpointIdentityId: string;
  deviceId: string;
}): Promise<void> {
  await serializeByKey(credentialWrites, KEYCHAIN_SERVICE, async () => {
    const stored = await loadShellCredential();
    if (
      expected &&
      (!stored ||
        stored.endpointIdentityId !== expected.endpointIdentityId ||
        stored.credential.deviceId !== expected.deviceId)
    )
      return;
    const cleared = await Keychain.resetGenericPassword({ service: KEYCHAIN_SERVICE });
    if (!cleared) throw new Error("The OS secure store refused to clear the Iroh credential");
    if (stored) await mobileIrohIdentity.delete(stored.endpointIdentityId);
  });
}

export const createMobileIrohIdentity = mobileIrohIdentity.create;
export const deleteMobileIrohIdentity = mobileIrohIdentity.delete;

function registerLifecycle(transport: LifecycleIrohClientPipe): () => void {
  let state: AppStateStatus = AppState.currentState;
  const subscription = AppState.addEventListener("change", (next) => {
    const previous = state;
    state = next;
    if (next === "active" && previous !== "active") {
      void transport
        .resume()
        .catch((error) => console.warn("[mobile-iroh] foreground rebind failed", error));
    } else if (next !== "active" && previous === "active") {
      void transport
        .suspend()
        .catch((error) => console.warn("[mobile-iroh] background shutdown failed", error));
    }
  });
  return () => subscription.remove();
}

function collectRetirementFailures(results: readonly PromiseSettledResult<unknown>[]): unknown[] {
  const failures: unknown[] = [];
  const seen = new Set<unknown>();
  const add = (failure: unknown): void => {
    if (failure instanceof AggregateError && failure.errors.length > 0) {
      for (const nested of failure.errors) add(nested);
      return;
    }
    if (!seen.has(failure)) {
      seen.add(failure);
      failures.push(failure);
    }
  };
  for (const result of results) if (result.status === "rejected") add(result.reason);
  return failures;
}

async function retireOwnedConnection(
  session: IrohClientSession,
  transport: LifecycleIrohClientPipe,
  getTerminalRetirement: () => Promise<void> | null
): Promise<unknown[]> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => session.close()),
    Promise.resolve().then(() => transport.close()),
  ]);
  const terminalRetirement = getTerminalRetirement();
  if (terminalRetirement) {
    results.push(...(await Promise.allSettled([terminalRetirement])));
  }
  return collectRetirementFailures(results);
}

function throwRetirementFailures(failures: readonly unknown[], message: string): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}

async function waitUntilConnected(
  transport: LifecycleIrohClientPipe,
  session: IrohClientSession,
  timeoutMs: number
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([transport.resume(), session.ready?.()]).then(() => undefined),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(mobileConnectionRecoveryTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function establishIrohConnection(
  pairing: StoredShellPairing,
  tokenProvider: ShellTokenProvider,
  endpointIdentityId: string,
  oauthCallbackMode: OAuthCallbackMode,
  handlers: IrohConnectionHandlers = {},
  sharedEndpointPool?: MobileEndpointPool
): Promise<IrohConnection> {
  const endpointPool =
    sharedEndpointPool ?? new MobileEndpointPool(endpointIdentityId, pairing.relays);
  if (endpointPool.identityId !== endpointIdentityId) {
    throw new Error("Hub and workspace attempted to use different mobile endpoint identities");
  }
  endpointPool.acquire(pairing.relays);
  console.log("[mobile-iroh] endpoint lease acquired");
  const transport = createReconnectingIrohClientPipe({
    peerEndpointId: pairing.endpointId,
    dial: async () => {
      console.log("[mobile-iroh] physical dial requested");
      const dialed = await endpointPool.dial(pairing);
      console.log("[mobile-iroh] physical dial connected");
      return createIrohClientPipe(dialed.connection, dialed);
    },
    suspendEndpoint: () => endpointPool.suspend(),
    closeEndpoint: () => endpointPool.release(),
    onReconnectAttempt: (attempt, delayMs) =>
      console.warn(`[mobile-iroh] reconnect attempt ${attempt} in ${delayMs}ms`),
    onReconnectResult: (result) => {
      if (result.success) console.log("[mobile-iroh] reconnect owner connected");
      else {
        console.warn(`[mobile-iroh] reconnect attempt ${result.attempt} failed`, result.error);
      }
    },
  });
  let terminalRetirement: Promise<void> | null = null;
  let removeLifecycle = () => {};
  console.log("[mobile-iroh] reconnect owner created");
  const connectionId = randomRequestId();
  console.log("[mobile-iroh] logical session identity created");
  const session = transport.openSession({
    connectionId,
    clientLabel: "Mobile device",
    clientPlatform: "mobile",
    oauthCallbackMode,
    getToken: () => tokenProvider.getToken(),
    onPaired: handlers.onPaired,
    onRecovery: handlers.onRecovery,
    onTerminalClose: (error) => {
      if ((error as { code?: unknown }).code !== CLOSE_TOKEN_REVOKED) return;
      const deviceId = /^refresh:([^:]+):/.exec(tokenProvider.getToken())?.[1];
      tokenProvider.setCredential(null);
      removeLifecycle();
      terminalRetirement ??= (async () => {
        const results = await Promise.allSettled([
          deviceId ? clearShellCredential({ endpointIdentityId, deviceId }) : Promise.resolve(),
          transport.close(),
        ]);
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : []
        );
        throwRetirementFailures(failures, "Revoked mobile credential retirement failed");
      })();
      void terminalRetirement.catch((failure: unknown) => {
        const error =
          failure instanceof Error
            ? failure
            : new Error("Revoked mobile credential retirement failed", { cause: failure });
        try {
          handlers.onPersistError?.(error);
        } catch (observerError) {
          console.error(
            "[mobile-iroh] revoked credential retirement observer failed",
            observerError
          );
        }
        console.error("[mobile-iroh] revoked credential retirement failed", failure);
      });
    },
  });
  console.log("[mobile-iroh] logical session opened");
  try {
    console.log("[mobile-iroh] waiting for authenticated session");
    await session.ready?.();
    console.log("[mobile-iroh] authenticated session ready");
  } catch (error) {
    const failures = await retireOwnedConnection(session, transport, () => terminalRetirement);
    if (failures.length > 0) {
      throw new AggregateError([error, ...failures], "Iroh session opening and cleanup failed", {
        cause: error,
      });
    }
    throw error;
  }
  const callerId = session.callerId() || "shell:pending";
  // The server distinguishes native bootstrap from the loaded workspace host
  // using its live method declarations, including mobileWorkspace.readiness.
  const rpc = createRpcClient({
    selfId: callerId,
    callerKind: "shell",
    transport: session,
    publishExposures: true,
  });
  removeLifecycle = registerLifecycle(transport);
  return {
    rpc,
    session,
    transport,
    callerId,
    endpointIdentityId,
    endpointPool,
    waitUntilConnected: (timeoutMs) => waitUntilConnected(transport, session, timeoutMs),
    async close() {
      removeLifecycle();
      const failures = await retireOwnedConnection(session, transport, () => terminalRetirement);
      throwRetirementFailures(failures, "Mobile Iroh connection cleanup failed");
    },
  };
}

export async function reconnectViaIroh(
  stored: StoredMobileConnection,
  oauthCallbackMode: OAuthCallbackMode,
  onRecovery?: (kind: "resubscribe" | "cold-recover") => void | Promise<void>,
  reach: "workspace" | "control" = "workspace",
  onCredentialStored?: (stored: StoredMobileConnection) => void,
  sharedEndpointPool?: MobileEndpointPool
): Promise<IrohConnection> {
  const pairing =
    reach === "control"
      ? stored.controlPairing
      : stored.phase === "routed"
        ? stored.workspacePairing
        : null;
  if (!pairing) throw new Error("Cannot connect a workspace before routing it durably");
  let current = stored;
  const tokenProvider = makeReturningShellTokenProvider(stored.credential);
  const connection = await establishIrohConnection(
    pairing,
    tokenProvider,
    stored.endpointIdentityId,
    oauthCallbackMode,
    {
      onPaired: async (next) => {
        tokenProvider.setCredential(next);
        current = replaceMobileConnectionCredential(current, next);
        await persistStoredMobileConnection(current);
        onCredentialStored?.(current);
      },
      onRecovery,
    },
    sharedEndpointPool
  );
  connection.deviceId = stored.credential.deviceId;
  return connection;
}

/**
 * Open the stable account pipe once. Workspace routing stays in memory: opening
 * another workspace never changes the native bundle source or the saved pairing.
 * All children use the same returning credential provider and endpoint owner.
 */
export async function connectMobileAccount(
  stored: StoredMobileConnection,
  oauthCallbackMode: OAuthCallbackMode
): Promise<MobileWorkspaceAccount> {
  let current = stored;
  let persistence = Promise.resolve();
  const provider = makeReturningShellTokenProvider(stored.credential);
  const onPaired = (credential: ShellCredential): Promise<void> => {
    provider.setCredential(credential);
    current = replaceMobileConnectionCredential(current, credential);
    const snapshot = current;
    persistence = persistence.then(() => persistStoredMobileConnection(snapshot));
    return persistence;
  };
  const control = await establishIrohConnection(
    stored.controlPairing,
    provider,
    stored.endpointIdentityId,
    oauthCallbackMode,
    { onPaired }
  );
  control.deviceId = stored.credential.deviceId;
  return new MobileWorkspaceAccount(control, async (reach, onRecovery) => {
    const child = await establishIrohConnection(
      reach,
      provider,
      stored.endpointIdentityId,
      oauthCallbackMode,
      { onPaired, onRecovery },
      control.endpointPool
    );
    child.deviceId = stored.credential.deviceId;
    return child;
  });
}

export function reconnectMobileSession(
  stored: StoredMobileConnection,
  oauthCallbackMode: OAuthCallbackMode,
  onRecovery?: (kind: "resubscribe" | "cold-recover") => void | Promise<void>
): Promise<IrohConnection> {
  return resumeMobileConnection(stored, {
    connect: (current, reach, onCredentialStored, controlConnection) =>
      reconnectViaIroh(
        current,
        oauthCallbackMode,
        reach === "workspace" ? onRecovery : undefined,
        reach,
        onCredentialStored,
        controlConnection?.endpointPool
      ),
    persist: persistStoredMobileConnection,
  });
}
