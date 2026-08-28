import "./polyfills.js";
import { AppState, type AppStateStatus } from "react-native";
import * as Keychain from "react-native-keychain";
import { EndpointGenerationOwner } from "@vibestudio/iroh-transport";
import { createRpcClient, type RpcClient } from "@vibestudio/rpc";
import {
  createIrohClientPipe,
  type IrohClientSession,
} from "@vibestudio/rpc/transports/irohClient";
import {
  createReconnectingIrohClientPipe,
  type LifecycleIrohClientPipe,
} from "@vibestudio/rpc/transports/reconnectingIrohClient";
import type { OAuthCallbackMode, PairingContext } from "@vibestudio/rpc/protocol/wsProtocol";
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

export type {
  FreshShellPairing,
  ShellCredential,
  StoredMobileConnection,
  StoredPairedMobileConnection,
  StoredRoutedMobileConnection,
  StoredShellPairing,
} from "./storedCredential.js";

const KEYCHAIN_SERVICE = "vibestudio:iroh:shell-credential";

export interface ShellTokenProvider {
  getToken(): string;
  setCredential(next: ShellCredential | null): void;
}

export interface IrohConnectionHandlers {
  onPaired?: (credential: ShellCredential, context?: PairingContext) => void | Promise<void>;
  onPersistError?: (error: Error) => void;
  onRecovery?: (kind: "resubscribe" | "cold-recover") => void | Promise<void>;
}

export interface IrohConnection {
  rpc: RpcClient;
  session: IrohClientSession;
  transport: LifecycleIrohClientPipe;
  callerId: string;
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
      relays.some((relay, index) => relay !== this.relays[index])
    ) {
      throw new Error("Hub and workspace must advertise the same ordered Iroh relay set");
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
  return typeof globalThis.crypto?.randomUUID === "function"
    ? `${prefix}-${globalThis.crypto.randomUUID()}`
    : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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
  const result = await Keychain.setGenericPassword("shell", payload, {
    service: KEYCHAIN_SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  if (result === false) throw new Error("The OS secure store refused the Iroh credential update");
}

export async function loadShellCredential(): Promise<StoredMobileConnection | null> {
  const result = await Keychain.getGenericPassword({ service: KEYCHAIN_SERVICE });
  return result ? parseStoredMobileConnection(result.password) : null;
}

export async function clearShellCredential(): Promise<void> {
  const stored = await loadShellCredential();
  const cleared = await Keychain.resetGenericPassword({ service: KEYCHAIN_SERVICE });
  if (!cleared) throw new Error("The OS secure store refused to clear the Iroh credential");
  if (stored) await mobileIrohIdentity.delete(stored.endpointIdentityId);
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
        timer = setTimeout(
          () => reject(new Error("The Iroh connection did not recover in time")),
          timeoutMs
        );
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
  const transport = createReconnectingIrohClientPipe({
    peerEndpointId: pairing.endpointId,
    dial: async () => {
      const dialed = await endpointPool.dial(pairing);
      return createIrohClientPipe(dialed.connection, dialed);
    },
    suspendEndpoint: () => endpointPool.suspend(),
    closeEndpoint: () => endpointPool.release(),
  });
  const connectionId = randomRequestId();
  const session = transport.openSession({
    sid: connectionId,
    connectionId,
    clientLabel: "Mobile device",
    clientPlatform: "mobile",
    oauthCallbackMode,
    getToken: () => tokenProvider.getToken(),
    onPaired: handlers.onPaired,
    onRecovery: handlers.onRecovery,
  });
  try {
    await session.ready?.();
  } catch (error) {
    await session.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    throw error;
  }
  const callerId = session.callerId() || "shell:pending";
  const rpc = createRpcClient({ selfId: callerId, callerKind: "shell", transport: session });
  const removeLifecycle = registerLifecycle(transport);
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
      await session.close().catch(() => undefined);
      await transport.close();
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
