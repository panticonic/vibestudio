import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./polyfills.js", () => ({}));
const fixture = vi.hoisted(() => ({
  password: null as string | null,
  terminal: null as null | ((error: Error) => void),
  recovery: null as null | ((kind: "resubscribe" | "cold-recover") => Promise<void>),
  rpcRecoveryRegistration: null as
    | null
    | ((handler: (kind: "resubscribe" | "cold-recover") => void) => () => void),
  close: vi.fn(async () => {}),
  sessionClose: vi.fn(async () => {}),
  ready: vi.fn(async () => {}),
  removeLifecycle: vi.fn(),
  deleteIdentity: vi.fn(async () => {}),
  reset: vi.fn(async () => true),
  connectionIds: [] as string[],
}));
vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: () => ({ remove: fixture.removeLifecycle }),
  },
  NativeModules: {},
}));
vi.mock("react-native-keychain", () => ({
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: "device" },
  setGenericPassword: async (_user: string, password: string) => {
    fixture.password = password;
    return true;
  },
  getGenericPassword: async () => (fixture.password ? { password: fixture.password } : false),
  resetGenericPassword: fixture.reset,
}));
vi.mock("./nativeBridge.js", () => ({
  mobileIrohIdentity: { delete: fixture.deleteIdentity },
  createMobileEndpointBinding: vi.fn(),
}));
vi.mock("@vibestudio/rpc", async (original) => ({
  ...(await original<typeof import("@vibestudio/rpc")>()),
  createRpcClient: (options: {
    onRecovery?: (handler: (kind: "resubscribe" | "cold-recover") => void) => () => void;
  }) => {
    fixture.rpcRecoveryRegistration = options.onRecovery ?? null;
    return {};
  },
}));
vi.mock("@vibestudio/rpc/transports/reconnectingIrohClient", () => ({
  createReconnectingIrohClientPipe: () => {
    let closing: Promise<void> | null = null;
    return {
      // The transport owns its logical sessions and shares concurrent close.
      close: () =>
        (closing ??= (async () => {
          const results = await Promise.allSettled([fixture.close(), fixture.sessionClose()]);
          const failures = results.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : []
          );
          if (failures.length) throw new AggregateError(failures, "Reconnect owner cleanup failed");
        })()),
      openSession: (options: {
        connectionId: string;
        onTerminalClose: (error: Error) => void;
        onRecovery: (kind: "resubscribe" | "cold-recover") => Promise<void>;
      }) => {
        fixture.connectionIds.push(options.connectionId);
        fixture.terminal = options.onTerminalClose;
        fixture.recovery = options.onRecovery;
        return {
          ready: fixture.ready,
          callerId: () => "shell:test",
          close: fixture.sessionClose,
        };
      },
    };
  },
}));
import {
  establishIrohConnection,
  MobileEndpointPool,
  makeReturningShellTokenProvider,
  persistStoredMobileConnection,
} from "./connect.js";
import { createPairedMobileConnection } from "./storedCredential.js";
const credential = { deviceId: `dev_${"d".repeat(24)}`, refreshToken: "r".repeat(43) };
const pairing = {
  endpointId: "aa".repeat(32),
  relays: ["https://relay.example/"],
  v: 5 as const,
  code: "c".repeat(21) + "A",
};
beforeEach(() => {
  vi.clearAllMocks();
  fixture.password = null;
  fixture.terminal = null;
  fixture.recovery = null;
  fixture.rpcRecoveryRegistration = null;
  fixture.reset.mockResolvedValue(true);
  fixture.sessionClose.mockResolvedValue(undefined);
  fixture.ready.mockResolvedValue(undefined);
  fixture.connectionIds.length = 0;
});

describe("MobileEndpointPool relay configuration", () => {
  it("delivers physical recovery to the RPC client before the account observer", async () => {
    const calls: string[] = [];
    const connection = await establishIrohConnection(
      pairing,
      makeReturningShellTokenProvider(credential),
      "installed-endpoint",
      "app-scheme",
      {
        onRecovery: () => {
          calls.push("account");
        },
      }
    );
    const remove = fixture.rpcRecoveryRegistration!(() => calls.push("rpc"));

    await fixture.recovery!("resubscribe");
    expect(calls).toEqual(["rpc", "account"]);

    remove();
    await fixture.recovery!("cold-recover");
    expect(calls).toEqual(["rpc", "account", "account"]);
    await connection.close();
  });

  it("propagates workspace reconciliation failure through awaited session recovery", async () => {
    const failure = new Error("workspace reconciliation failed");
    const calls: string[] = [];
    const connection = await establishIrohConnection(
      pairing,
      makeReturningShellTokenProvider(credential),
      "installed-endpoint",
      "app-scheme",
      {
        onRecovery: async () => {
          calls.push("account");
          throw failure;
        },
      }
    );
    fixture.rpcRecoveryRegistration!(() => calls.push("rpc"));

    await expect(fixture.recovery!("resubscribe")).rejects.toBe(failure);
    expect(calls).toEqual(["rpc", "account"]);
    await connection.close();
  });

  it("shares one endpoint when peers prefer different homes in the same relay set", async () => {
    const relays = ["https://us.example/", "https://eu.example/"];
    const pool = new MobileEndpointPool("identity", relays);
    expect(() => pool.acquire(relays)).not.toThrow();
    expect(() => pool.acquire([...relays].reverse())).not.toThrow();
    expect(() => pool.acquire(["https://other.example/", relays[1]!])).toThrow(
      "same Iroh relay set"
    );
    await pool.release();
    await pool.release();
  });
});

describe("mobile reach connection identity", () => {
  it("replaces a cold process incarnation for the same endpoint and reach", async () => {
    const first = await establishIrohConnection(
      pairing,
      makeReturningShellTokenProvider(credential),
      "installed-endpoint",
      "app-scheme"
    );
    await first.close();
    const replacement = await establishIrohConnection(
      pairing,
      makeReturningShellTokenProvider(credential),
      "installed-endpoint",
      "app-scheme"
    );
    await replacement.close();

    expect(fixture.connectionIds).toEqual([
      `mobile-shell:18:installed-endpoint:${pairing.endpointId}`,
      `mobile-shell:18:installed-endpoint:${pairing.endpointId}`,
    ]);
  });

  it("keeps different native endpoints and server reaches distinct", async () => {
    const otherReach = { ...pairing, endpointId: "bb".repeat(32) };
    const connections = await Promise.all([
      establishIrohConnection(
        pairing,
        makeReturningShellTokenProvider(credential),
        "installed-endpoint",
        "app-scheme"
      ),
      establishIrohConnection(
        otherReach,
        makeReturningShellTokenProvider(credential),
        "installed-endpoint",
        "app-scheme"
      ),
      establishIrohConnection(
        pairing,
        makeReturningShellTokenProvider(credential),
        "other-endpoint",
        "app-scheme"
      ),
    ]);
    await Promise.all(connections.map((connection) => connection.close()));

    expect(new Set(fixture.connectionIds).size).toBe(3);
  });
});

describe("mobile device revocation", () => {
  it("closes each logical session through its reconnect owner exactly once", async () => {
    const provider = makeReturningShellTokenProvider(credential);
    const connection = await establishIrohConnection(pairing, provider, "identity", "app-scheme");
    await connection.close();
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.sessionClose).toHaveBeenCalledOnce();
  });

  it("clears the revoked credential, retires foreground reconnect, and joins secure-store deletion", async () => {
    const provider = makeReturningShellTokenProvider(credential);
    await persistStoredMobileConnection(
      createPairedMobileConnection(credential, pairing, "system", "identity")
    );
    let finish!: (result: boolean) => void;
    fixture.reset.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const connection = await establishIrohConnection(pairing, provider, "identity", "app-scheme");
    fixture.terminal!(Object.assign(new Error("Token revoked"), { code: 4001 }));
    expect(provider.getToken()).toBe("");
    expect(fixture.removeLifecycle).toHaveBeenCalledOnce();
    const closed = vi.fn();
    const closing = connection.close().then(closed);
    await vi.waitFor(() => {
      expect(fixture.reset).toHaveBeenCalledOnce();
      expect(fixture.sessionClose).toHaveBeenCalledOnce();
      expect(fixture.close).toHaveBeenCalled();
    });
    expect(closed).not.toHaveBeenCalled();
    finish(true);
    await closing;
    expect(fixture.deleteIdentity).toHaveBeenCalledWith("identity");
    expect(fixture.close).toHaveBeenCalled();
  });
  it("preserves a newer pairing when an old session's revocation arrives", async () => {
    const provider = makeReturningShellTokenProvider(credential);
    const connection = await establishIrohConnection(
      pairing,
      provider,
      "old-identity",
      "app-scheme"
    );
    await persistStoredMobileConnection(
      createPairedMobileConnection(credential, pairing, "system", "new-identity")
    );
    fixture.terminal!(Object.assign(new Error("Token revoked"), { code: 4001 }));
    await connection.close();
    expect(fixture.reset).not.toHaveBeenCalled();
    expect(fixture.deleteIdentity).not.toHaveBeenCalled();
  });
  it("preserves credentials on other terminal closes", async () => {
    const provider = makeReturningShellTokenProvider(credential);
    const connection = await establishIrohConnection(pairing, provider, "identity", "app-scheme");
    fixture.terminal!(Object.assign(new Error("Server closed"), { code: 4000 }));
    await connection.close();
    expect(provider.getToken()).toContain(credential.deviceId);
    expect(fixture.reset).not.toHaveBeenCalled();
  });

  it("joins session and transport closure when revoked-keychain cleanup fails", async () => {
    const provider = makeReturningShellTokenProvider(credential);
    const keychainFailure = new Error("Keychain refused credential deletion");
    const observerFailure = new Error("Persistence observer failed");
    const reportFailure = vi.fn(() => {
      throw observerFailure;
    });
    let finishSession!: () => void;
    let finishTransport!: () => void;
    await persistStoredMobileConnection(
      createPairedMobileConnection(credential, pairing, "system", "identity")
    );
    fixture.reset.mockRejectedValueOnce(keychainFailure);
    fixture.sessionClose.mockImplementationOnce(
      () => new Promise((resolve) => (finishSession = resolve))
    );
    const transportClosing = new Promise<void>((resolve) => {
      finishTransport = resolve;
    });
    fixture.close.mockImplementation(() => transportClosing);
    const connection = await establishIrohConnection(pairing, provider, "identity", "app-scheme", {
      onPersistError: reportFailure,
    });
    fixture.terminal!(Object.assign(new Error("Token revoked"), { code: 4001 }));

    const closing = connection.close();
    let closeSettled = false;
    const observeClose = closing.then(
      () => {
        closeSettled = true;
      },
      () => {
        closeSettled = true;
      }
    );
    await vi.waitFor(() => {
      expect(fixture.reset).toHaveBeenCalledOnce();
      expect(fixture.sessionClose).toHaveBeenCalledOnce();
      expect(fixture.close).toHaveBeenCalled();
    });
    expect(closeSettled).toBe(false);
    finishSession();
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    finishTransport();
    await expect(closing).rejects.toBe(keychainFailure);
    await observeClose;
    expect(reportFailure).toHaveBeenCalledOnce();
    expect(fixture.sessionClose).toHaveBeenCalledOnce();
    expect(fixture.close).toHaveBeenCalled();
  });

  it("preserves authentication failure while joining terminal and owned cleanup failures", async () => {
    const provider = makeReturningShellTokenProvider(credential);
    const authenticationFailure = new Error("Authentication failed");
    const keychainFailure = new Error("Keychain refused credential deletion");
    const sessionFailure = new Error("Logical session close failed");
    const transportFailure = new Error("Reconnect owner close failed");
    await persistStoredMobileConnection(
      createPairedMobileConnection(credential, pairing, "system", "identity")
    );
    fixture.reset.mockRejectedValueOnce(keychainFailure);
    fixture.sessionClose.mockRejectedValueOnce(sessionFailure);
    fixture.close.mockRejectedValueOnce(transportFailure);
    fixture.ready.mockImplementationOnce(async () => {
      fixture.terminal!(Object.assign(new Error("Token revoked"), { code: 4001 }));
      throw authenticationFailure;
    });

    const failure = await establishIrohConnection(
      pairing,
      provider,
      "identity",
      "app-scheme"
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).cause).toBe(authenticationFailure);
    expect((failure as AggregateError).errors).toEqual(
      expect.arrayContaining([
        authenticationFailure,
        keychainFailure,
        sessionFailure,
        transportFailure,
      ])
    );
    expect(fixture.sessionClose).toHaveBeenCalledOnce();
    expect(fixture.close).toHaveBeenCalled();
  });
});
