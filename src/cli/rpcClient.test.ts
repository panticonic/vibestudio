import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "./output.js";
import { RpcClient, clearShellTokenCache, refreshAgent, refreshShell } from "./rpcClient.js";

// Intercept the lazily-imported WS client so push/stream selection can be
// asserted without opening a real socket.
const wsMocks = vi.hoisted(() => ({
  ctor: vi.fn(),
  onEvent: vi.fn(async () => () => {}),
  stream: vi.fn(async () => new Response("streamed")),
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

function rpcError(error: string, errorCode?: string): string {
  return JSON.stringify({
    from: "main",
    target: CREDS.deviceId,
    delivery: { caller: { callerId: "server", callerKind: "server" } },
    provenance: [{ callerId: "server", callerKind: "server" }],
    message: { type: "response", requestId: "test-request", error, errorCode },
  });
}

describe("rpcClient", () => {
  beforeEach(() => {
    clearShellTokenCache();
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
        return new Response(rpcError("boom", "ENOENT"));
      })
    );
    const client = new RpcClient(CREDS);
    await expect(client.call("fs.readFile", ["/missing"])).rejects.toMatchObject({
      name: "RpcError",
      message: "boom",
      errorCode: "ENOENT",
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
