import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError, ConnectionError } from "./output.js";
import { RpcClient, clearShellTokenCache, refreshAgent, refreshShell } from "./rpcClient.js";
import type { LocalHubControlTransport } from "./localHubTransport.js";

// Intercept the lazily-imported WS client so push/stream selection can be
// asserted without opening a real socket.
const wsMocks = vi.hoisted(() => ({
  ctor: vi.fn(),
  onEvent: vi.fn(async () => () => {}),
  stream: vi.fn(async () => new Response("streamed")),
}));

const localTransportMocks = vi.hoisted(() => ({
  resolve: vi.fn<() => Promise<LocalHubControlTransport | null>>(async () => null),
}));

const webRtcMocks = vi.hoisted(() => ({
  ctor: vi.fn(),
  call: vi.fn(),
  close: vi.fn(async () => undefined),
}));

const credentialStoreMocks = vi.hoisted(() => ({ save: vi.fn() }));

vi.mock("./credentialStore.js", async (loadOriginal) => {
  const original = await loadOriginal<typeof import("./credentialStore.js")>();
  return { ...original, saveCliCredentials: credentialStoreMocks.save };
});

vi.mock("./localHubTransport.js", () => ({
  resolveLocalHubControlTransport: localTransportMocks.resolve,
}));

vi.mock("./webrtcClient.js", () => ({
  WebRtcRpcClient: class {
    constructor(config: unknown) {
      webRtcMocks.ctor(config);
    }
    call = webRtcMocks.call;
    close = webRtcMocks.close;
  },
}));

vi.mock("./wsClient.js", () => ({
  WsRpcClient: class {
    constructor(config: unknown) {
      wsMocks.ctor(config);
    }
    onEvent = wsMocks.onEvent;
    stream = wsMocks.stream;
    async onRecovery() {
      return () => {};
    }
    async close() {}
  },
}));

const CREDS = {
  url: "https://host.tailnet.ts.net",
  deviceId: "dev_cli",
  refreshToken: "refresh_cli",
};

const PAIRED_CREDS = {
  schemaVersion: 4 as const,
  kind: "device" as const,
  url: "webrtc://11111111-1111-4111-8111-111111111111/_workspace/dev",
  workspaceId: "ws_dev",
  workspaceName: "dev",
  serverId: `srv_${"S".repeat(24)}`,
  deviceId: `dev_${"D".repeat(24)}`,
  refreshToken: "R".repeat(43),
  controlPairing: {
    room: "22222222-2222-4222-8222-222222222222",
    fp: "AA".repeat(32),
    sig: "wss://signal.example/",
    v: 2 as const,
    ice: "all" as const,
  },
  workspacePairing: {
    room: "11111111-1111-4111-8111-111111111111",
    fp: "BB".repeat(32),
    sig: "wss://signal.example/",
    v: 2 as const,
    ice: "all" as const,
  },
  pairedAt: 1,
};

function refreshShellResult(shellToken: string, callerId = "c"): string {
  return JSON.stringify({
    shellToken,
    callerId,
    deviceId: CREDS.deviceId,
    label: "CLI test device",
    serverId: "srv_1",
    serverBootId: "boot_1",
    workspaceId: "ws_1",
  });
}

function rpcResult(result: unknown): string {
  return JSON.stringify({
    from: "main",
    target: CREDS.deviceId,
    delivery: { caller: { callerId: "server", callerKind: "server" } },
    provenance: [{ callerId: "server", callerKind: "server" }],
    message: { type: "response", requestId: "test-request", result },
  });
}

function rpcError(error: string, errorCode?: string, errorData?: unknown): string {
  return JSON.stringify({
    from: "main",
    target: CREDS.deviceId,
    delivery: { caller: { callerId: "server", callerKind: "server" } },
    provenance: [{ callerId: "server", callerKind: "server" }],
    message: {
      type: "response",
      requestId: "test-request",
      error,
      errorKind: "application",
      errorCode,
      errorData,
    },
  });
}

describe("rpcClient", () => {
  beforeEach(() => {
    clearShellTokenCache();
    localTransportMocks.resolve.mockReset().mockResolvedValue(null);
    webRtcMocks.ctor.mockClear();
    webRtcMocks.call.mockReset();
    webRtcMocks.close.mockClear();
    credentialStoreMocks.save.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("types the refresh-shell response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              shellToken: "tok",
              callerId: "shell:dev_cli",
              deviceId: "dev_cli",
              label: "CLI test device",
              serverId: "srv_1",
              serverBootId: "boot_1",
              workspaceId: "ws_1",
            })
          )
      )
    );
    const refresh = await refreshShell(CREDS);
    expect(refresh).toEqual({
      shellToken: "tok",
      callerId: "shell:dev_cli",
      deviceId: "dev_cli",
      label: "CLI test device",
      serverId: "srv_1",
      serverBootId: "boot_1",
      workspaceId: "ws_1",
    });
  });

  it("rejects a refresh without a shell token as an auth error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "unknown device" }), { status: 401 }))
    );
    await expect(refreshShell(CREDS)).rejects.toThrow(AuthError);
  });

  it("types an unreachable auth endpoint as a retryable connection error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("read ECONNRESET")))
    );
    const request = refreshShell(CREDS);
    await expect(request).rejects.toThrow(ConnectionError);
    await expect(request).rejects.toThrow(AuthError);
  });

  it("rejects a truncated successful shell refresh response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ shellToken: "tok" })))
    );
    await expect(refreshShell(CREDS)).rejects.toThrow(
      "shell refresh returned a malformed response"
    );
  });

  it("calls /rpc with a bearer token and caches it across calls", async () => {
    const requests: Array<{ url: string; auth?: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        requests.push({
          url: String(url),
          auth: headers["Authorization"],
          body: JSON.parse(String(init?.body ?? "{}")),
        });
        if (String(url).endsWith("/refresh-shell")) {
          return new Response(refreshShellResult("tok"));
        }
        return new Response(rpcResult({ ok: true }));
      })
    );

    const client = new RpcClient(CREDS);
    await expect(client.call("meta.listServices", [])).resolves.toEqual({ ok: true });
    await expect(client.call("workspace.getActive", [])).resolves.toEqual({ ok: true });

    // One refresh, then two RPC posts with the same token.
    expect(requests.map((req) => req.url)).toEqual([
      "https://host.tailnet.ts.net/_r/s/auth/refresh-shell",
      "https://host.tailnet.ts.net/rpc",
      "https://host.tailnet.ts.net/rpc",
    ]);
    expect(requests[1]?.auth).toBe("Bearer tok");
    expect(requests[2]?.auth).toBe("Bearer tok");
    expect(requests[1]?.body).toMatchObject({
      from: "c",
      target: "main",
      delivery: { caller: { callerId: "c", callerKind: "shell" } },
      provenance: [{ callerId: "c", callerKind: "shell" }],
      message: {
        type: "request",
        fromId: "c",
        method: "meta.listServices",
        args: [],
      },
    });
  });

  it("refreshes exactly once on a 401 and retries the call", async () => {
    let rpcCalls = 0;
    let refreshes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (String(url).endsWith("/refresh-shell")) {
          refreshes += 1;
          return new Response(refreshShellResult(`tok_${refreshes}`));
        }
        rpcCalls += 1;
        if (rpcCalls === 1) {
          return new Response(JSON.stringify({ error: "Invalid token" }), { status: 401 });
        }
        return new Response(rpcResult(42));
      })
    );

    const client = new RpcClient(CREDS);
    await expect(client.call("meta.listServices", [])).resolves.toBe(42);
    expect(refreshes).toBe(2); // initial token + the one 401-triggered refresh
    expect(rpcCalls).toBe(2);
  });

  it("fails with an auth error when 401 persists after the refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (String(url).endsWith("/refresh-shell")) {
          return new Response(refreshShellResult("tok"));
        }
        return new Response(JSON.stringify({ error: "Invalid token" }), { status: 401 });
      })
    );
    const client = new RpcClient(CREDS);
    await expect(client.call("meta.listServices", [])).rejects.toThrow(AuthError);
  });

  it("surfaces server-reported RPC errors with their code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (String(url).endsWith("/refresh-shell")) {
          return new Response(refreshShellResult("tok"));
        }
        return new Response(rpcError("boom", "ENOENT", { path: "/missing", retryable: false }));
      })
    );
    const client = new RpcClient(CREDS);
    await expect(client.call("fs.readFile", ["/missing"])).rejects.toMatchObject({
      name: "RpcError",
      message: "boom",
      errorKind: "application",
      errorCode: "ENOENT",
      errorData: { path: "/missing", retryable: false },
    });
  });

  it("classifies an HTTP gateway failure as retryable transport", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (String(url).endsWith("/refresh-shell")) {
          return new Response(refreshShellResult("tok"));
        }
        return new Response("", { status: 502, statusText: "Bad Gateway" });
      })
    );
    const client = new RpcClient(CREDS);
    await expect(client.call("meta.listServices", [])).rejects.toMatchObject({
      name: "RpcError",
      message: "rpc failed (502 Bad Gateway)",
      errorKind: "transport",
    });
  });

  it("sends the relay body shape for callTarget", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        if (String(url).endsWith("/refresh-shell")) {
          return new Response(refreshShellResult("tok"));
        }
        bodies.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(rpcResult("pong"));
      })
    );
    const client = new RpcClient(CREDS);
    await expect(client.callTarget("worker:repo:abc", "ping", ["x"])).resolves.toBe("pong");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      from: "c",
      target: "worker:repo:abc",
      delivery: { caller: { callerId: "c", callerKind: "shell" } },
      message: {
        type: "request",
        fromId: "c",
        method: "ping",
        args: ["x"],
      },
    });
  });

  it("routes a paired local workspace through the hub-authenticated loopback endpoint", async () => {
    localTransportMocks.resolve.mockResolvedValue({
      serverUrl: "http://127.0.0.1:46247",
    });
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        requests.push(String(url));
        if (String(url).endsWith("/refresh-shell")) {
          return new Response(
            JSON.stringify({
              shellToken: "loopback-token",
              callerId: `shell:${PAIRED_CREDS.deviceId}`,
              deviceId: PAIRED_CREDS.deviceId,
              label: "CLI test device",
              serverId: PAIRED_CREDS.serverId,
              serverBootId: `boot_${"C".repeat(24)}`,
              workspaceId: PAIRED_CREDS.workspaceId,
            })
          );
        }
        if (String(url) === "http://127.0.0.1:46247/rpc") {
          return new Response(
            rpcResult({
              workspace: "dev",
              workspaceId: PAIRED_CREDS.workspaceId,
              running: true,
              serverUrl: "http://127.0.0.1:46247/_workspace/dev",
              workspaceReach: PAIRED_CREDS.workspacePairing,
              serverId: PAIRED_CREDS.serverId,
              serverBootId: `boot_${"C".repeat(24)}`,
            })
          );
        }
        return new Response(rpcResult({ workspace: "dev" }));
      })
    );

    const client = new RpcClient(PAIRED_CREDS);
    await expect(client.call("auth.getConnectionInfo", [])).resolves.toEqual({ workspace: "dev" });

    expect(localTransportMocks.resolve).toHaveBeenCalledOnce();
    expect(requests).toEqual([
      "http://127.0.0.1:46247/_r/s/auth/refresh-shell",
      "http://127.0.0.1:46247/rpc",
      "http://127.0.0.1:46247/_workspace/dev/_r/s/auth/refresh-shell",
      "http://127.0.0.1:46247/_workspace/dev/rpc",
    ]);
    expect(webRtcMocks.ctor).not.toHaveBeenCalled();
  });

  it("does not hide a rejected local workspace route behind a WebRTC fallback", async () => {
    localTransportMocks.resolve.mockRejectedValue(
      new Error("The local hub routed the paired device to a different server or workspace")
    );

    const client = new RpcClient(PAIRED_CREDS);
    await expect(client.call("auth.getConnectionInfo", [])).rejects.toThrow(
      "different server or workspace"
    );
    await expect(client.close()).resolves.toBeUndefined();
    expect(webRtcMocks.ctor).not.toHaveBeenCalled();
  });

  it("connects an explicit WebRTC endpoint without resolving a workspace", async () => {
    const client = new RpcClient({
      url: PAIRED_CREDS.url,
      deviceId: PAIRED_CREDS.deviceId,
      refreshToken: PAIRED_CREDS.refreshToken,
      pairing: PAIRED_CREDS.controlPairing,
    });

    await client.call("hubControl.listWorkspaces", []);

    expect(localTransportMocks.resolve).not.toHaveBeenCalled();
    expect(webRtcMocks.ctor).toHaveBeenCalledWith(
      expect.objectContaining({ pairing: PAIRED_CREDS.controlPairing })
    );
  });

  it("rejects a 200 /rpc response without result or error keys as malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (String(url).endsWith("/refresh-shell")) {
          return new Response(refreshShellResult("tok"));
        }
        return new Response(JSON.stringify({ ok: true }));
      })
    );
    const client = new RpcClient(CREDS);
    await expect(client.call("meta.listServices", [])).rejects.toMatchObject({
      name: "RpcError",
      message: "malformed rpc response (non-envelope or proxy response?)",
    });
  });

  it("rejects a non-JSON 200 /rpc response as malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (String(url).endsWith("/refresh-shell")) {
          return new Response(refreshShellResult("tok"));
        }
        return new Response("<html>proxy says hi</html>");
      })
    );
    const client = new RpcClient(CREDS);
    await expect(client.call("meta.listServices", [])).rejects.toMatchObject({
      name: "RpcError",
      message: "malformed rpc response (non-envelope or proxy response?)",
    });
  });

  it("rejects the retired wrapped RPC response shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (String(url).endsWith("/refresh-shell")) {
          return new Response(refreshShellResult("tok"));
        }
        return new Response(JSON.stringify({ envelope: JSON.parse(rpcResult({ ok: true })) }));
      })
    );
    const client = new RpcClient(CREDS);
    await expect(client.call("meta.listServices", [])).rejects.toThrow(
      "malformed rpc response (non-envelope or proxy response?)"
    );
  });

  it("still returns null results without treating them as malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (String(url).endsWith("/refresh-shell")) {
          return new Response(refreshShellResult("tok"));
        }
        return new Response(rpcResult(null));
      })
    );
    const client = new RpcClient(CREDS);
    await expect(client.call("meta.listServices", [])).resolves.toBeNull();
  });

  it("maps unreachable servers to auth/connection errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );
    const client = new RpcClient(CREDS);
    await expect(client.call("meta.listServices", [])).rejects.toThrow(AuthError);
  });

  describe("WS push transport selection (§6.1)", () => {
    beforeEach(() => {
      wsMocks.ctor.mockClear();
      wsMocks.onEvent.mockClear();
      wsMocks.stream.mockClear();
    });

    it("opens the WS client for onEvent on a loopback device credential (was WebRTC-only)", async () => {
      const client = new RpcClient(CREDS);
      const off = await client.onEvent("some:event", () => {});
      expect(wsMocks.ctor).toHaveBeenCalledWith(
        expect.objectContaining({
          url: CREDS.url,
          callerId: `shell:${CREDS.deviceId}`,
          callerKind: "shell",
        })
      );
      expect(wsMocks.onEvent).toHaveBeenCalledTimes(1);
      expect(typeof off).toBe("function");
    });

    it("opens the WS client for stream with an agent-kind caller on a raw agent token", async () => {
      const client = new RpcClient({ url: CREDS.url, token: "agent:agt_1:sec" });
      await client.stream("main", "eval.run", []);
      expect(wsMocks.ctor).toHaveBeenCalledWith(
        expect.objectContaining({ callerId: "agent:agt_1", callerKind: "agent" })
      );
      expect(wsMocks.stream).toHaveBeenCalledTimes(1);
    });
  });

  describe("agent raw-token credential (§6.1)", () => {
    const AGENT_CREDS = {
      url: "https://host.tailnet.ts.net",
      token: "agent:agt_cli:secret_cli",
    };

    it("exchanges the agent token for a bearer at /refresh-agent and posts an agent envelope", async () => {
      const requests: Array<{ url: string; auth?: string; body: unknown }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: URL, init?: RequestInit) => {
          const headers = (init?.headers ?? {}) as Record<string, string>;
          requests.push({
            url: String(url),
            auth: headers["Authorization"],
            body: JSON.parse(String(init?.body ?? "{}")),
          });
          if (String(url).endsWith("/refresh-agent")) {
            return new Response(
              JSON.stringify({
                token: "bearer_agent",
                callerId: "agent:session:s1",
                callerKind: "agent",
                entityId: "session:s1",
                contextId: "ctx-abc",
                channelId: "chan-1",
                agentId: "agt_cli",
                serverId: "srv_1",
                serverBootId: "boot_1",
                workspaceId: "ws_1",
              })
            );
          }
          return new Response(rpcResult({ ok: true }));
        })
      );

      const client = new RpcClient(AGENT_CREDS);
      await expect(client.call("fs.readFile", ["/x"])).resolves.toEqual({ ok: true });

      expect(requests.map((r) => r.url)).toEqual([
        "https://host.tailnet.ts.net/_r/s/auth/refresh-agent",
        "https://host.tailnet.ts.net/rpc",
      ]);
      // The agent credential is sent verbatim to /refresh-agent.
      expect(requests[0]?.body).toEqual({ agentToken: "agent:agt_cli:secret_cli" });
      // /rpc rides the exchanged bearer with an agent-kind envelope.
      expect(requests[1]?.auth).toBe("Bearer bearer_agent");
      expect(requests[1]?.body).toMatchObject({
        from: "agent:session:s1",
        target: "main",
        delivery: { caller: { callerId: "agent:session:s1", callerKind: "agent" } },
        message: { type: "request", method: "fs.readFile", args: ["/x"] },
      });
    });

    it("refreshAgent surfaces a failed exchange as an auth error", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ error: "bad" }), { status: 401 }))
      );
      await expect(refreshAgent(AGENT_CREDS)).rejects.toThrow(AuthError);
    });

    it("rejects a truncated successful agent refresh response", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ token: "bearer_agent" })))
      );
      await expect(refreshAgent(AGENT_CREDS)).rejects.toThrow(
        "agent token exchange returned a malformed response"
      );
    });
  });
});
