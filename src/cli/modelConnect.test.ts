import * as http from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { DeviceCredential } from "./rpcClient.js";
import { connectModelProvider, type ModelConnectDependencies } from "./modelConnect.js";

const CREDENTIALS = {
  schemaVersion: 4,
  kind: "device",
  url: "webrtc://workspace-room/_workspace/dev",
  workspaceId: "ws_dev",
  workspaceName: "dev",
  serverId: `srv_${"S".repeat(24)}`,
  deviceId: `dev_${"D".repeat(24)}`,
  refreshToken: "R".repeat(43),
  controlPairing: pairing("control-room"),
  workspacePairing: pairing("workspace-room"),
  pairedAt: 1,
} satisfies DeviceCredential;

describe("connectModelProvider", () => {
  it("subscribes before connect and uses one RPC for callback forwarding", async () => {
    const port = await getFreePort();
    const calls: string[] = [];
    let listener: ((payload: unknown, fromId: string) => void) | null = null;
    let resolveConnect!: (value: unknown) => void;
    const connected = new Promise((resolve) => {
      resolveConnect = resolve;
    });
    const close = vi.fn(async () => undefined);
    const unsubscribe = vi.fn();
    let browserResponse: Promise<void> | null = null;
    const rpc = {
      async onEvent(event: string, next: (payload: unknown, fromId: string) => void) {
        calls.push(`listen:${event}`);
        listener = next;
        return unsubscribe;
      },
      async callTargetPush(targetId: string, method: string, args: unknown[]) {
        calls.push(`${targetId}:${method}`);
        if (method === "credentials.connect") {
          queueMicrotask(() => listener?.(oauthPayload(port), "main"));
          return await connected;
        }
        if (method === "credentials.forwardOAuthCallback") {
          resolveConnect(storedCredential());
          return undefined;
        }
        throw new Error(`unexpected method ${method} ${JSON.stringify(args)}`);
      },
      close,
    };
    const openExternal = vi.fn(async () => {
      browserResponse = httpGet(`http://127.0.0.1:${port}/auth/callback?code=code-1&state=state-1`);
    });

    const result = await connectModelProvider(CREDENTIALS, "openai-codex", {
      createRpc: () => rpc,
      openExternal,
    });

    expect(calls).toEqual([
      "listen:external-open:open",
      "main:credentials.connect",
      "main:credentials.forwardOAuthCallback",
    ]);
    expect(result).toEqual({
      providerId: "openai-codex",
      credential: {
        id: "cred-renewed",
        label: "ChatGPT Codex model credential",
        lifecycle: { state: "active", canRefresh: true },
      },
    });
    expect(openExternal).toHaveBeenCalledWith("https://auth.example.test/oauth/authorize");
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    await browserResponse;
  });

  it("does not open unrelated external-open events while waiting for OAuth", async () => {
    const port = await getFreePort();
    let listener: ((payload: unknown, fromId: string) => void) | null = null;
    let resolveConnect!: (value: unknown) => void;
    const connected = new Promise((resolve) => {
      resolveConnect = resolve;
    });
    const opened: string[] = [];
    let browserResponse: Promise<void> | null = null;
    const rpc = {
      async onEvent(_event: string, next: (payload: unknown, fromId: string) => void) {
        listener = next;
        return () => undefined;
      },
      async callTargetPush(_targetId: string, method: string) {
        if (method === "credentials.connect") {
          queueMicrotask(() => {
            listener?.(
              {
                url: "https://unrelated.example.test",
                callerId: "shell:test",
                callerKind: "shell",
              },
              "main"
            );
            listener?.(oauthPayload(port), "main");
          });
          return await connected;
        }
        if (method === "credentials.forwardOAuthCallback") {
          resolveConnect(storedCredential());
          return undefined;
        }
        throw new Error(`unexpected method ${method}`);
      },
      async close() {},
    };

    await connectModelProvider(CREDENTIALS, "openai-codex", {
      createRpc: () => rpc,
      openExternal: async (url) => {
        opened.push(url);
        browserResponse = httpGet(
          `http://127.0.0.1:${port}/auth/callback?code=code-1&state=state-1`
        );
      },
    });

    expect(opened).toEqual(["https://auth.example.test/oauth/authorize"]);
    await browserResponse;
  });

  it("cancels through the same RPC when the browser launcher fails", async () => {
    const port = await getFreePort();
    const calls: string[] = [];
    let listener: ((payload: unknown, fromId: string) => void) | null = null;
    let rejectConnect!: (reason: unknown) => void;
    const connected = new Promise((_resolve, reject) => {
      rejectConnect = reject;
    });
    const rpc = {
      async onEvent(_event: string, next: (payload: unknown, fromId: string) => void) {
        listener = next;
        return () => undefined;
      },
      async callTargetPush(_targetId: string, method: string) {
        calls.push(method);
        if (method === "credentials.connect") {
          queueMicrotask(() => listener?.(oauthPayload(port), "main"));
          return await connected;
        }
        if (method === "credentials.cancelOAuth") {
          rejectConnect(new Error("cancelled"));
          return undefined;
        }
        throw new Error(`unexpected method ${method}`);
      },
      async close() {},
    };

    await expect(
      connectModelProvider(CREDENTIALS, "openai-codex", {
        createRpc: () => rpc,
        openExternal: async () => {
          throw new Error("browser unavailable");
        },
      })
    ).rejects.toThrow("browser unavailable");
    expect(calls).toEqual(["credentials.connect", "credentials.cancelOAuth"]);
  });

  it("does not invent a second API-key input flow", async () => {
    const createRpc = vi.fn<ModelConnectDependencies["createRpc"]>();
    await expect(
      connectModelProvider(CREDENTIALS, "anthropic", {
        createRpc,
        openExternal: async () => undefined,
      })
    ).rejects.toThrow("must currently be entered in Vibestudio model settings");
    expect(createRpc).not.toHaveBeenCalled();
  });
});

function pairing(room: string) {
  return {
    room,
    fp: "AA".repeat(32),
    sig: "wss://signal.example.test",
    v: 2 as const,
    ice: "all" as const,
  };
}

function oauthPayload(port: number) {
  return {
    url: "https://auth.example.test/oauth/authorize",
    callerId: `shell:${CREDENTIALS.deviceId}`,
    callerKind: "shell" as const,
    oauthLoopback: {
      transactionId: "tx-1",
      redirectUri: `http://127.0.0.1:${port}/auth/callback`,
      host: "127.0.0.1" as const,
      port,
      callbackPath: "/auth/callback",
      state: "state-1",
      timeoutMs: 5_000,
    },
  };
}

function storedCredential() {
  return {
    id: "cred-renewed",
    label: "ChatGPT Codex model credential",
    lifecycle: { state: "active" as const, canRefresh: true },
    audience: [],
    injection: { type: "header" as const, name: "Authorization", valueTemplate: "Bearer {token}" },
    scopes: [],
    accountIdentity: { providerUserId: "must-not-leak" },
    metadata: { internal: "must-not-leak" },
  };
}

function httpGet(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        response.resume();
        response.on("end", resolve);
      })
      .on("error", reject);
  });
}

async function getFreePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
