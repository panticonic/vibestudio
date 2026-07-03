import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createConnectDeepLink } from "@vibez1/shared/connect";
import { clearShellTokenCache } from "./rpcClient.js";

const panelFacadeMock = vi.hoisted(() => ({
  starts: [] as Array<{
    serverClient: { stream: (...args: unknown[]) => Promise<Response> };
    options: Record<string, unknown>;
  }>,
  closes: 0,
}));

const webrtcMock = vi.hoisted(() => ({
  instances: [] as Array<{
    config: {
      pairing: { room: string; fp: string; code?: string; sig: string; ice?: string };
      getToken: () => string;
      onPaired?: (credential: { deviceId: string; refreshToken: string }) => void | Promise<void>;
    };
    closed: boolean;
  }>,
  calls: [] as Array<{ room: string; method: string; args: unknown[]; token: string }>,
  targetCalls: [] as Array<{ room: string; targetId: string; method: string; args: unknown[] }>,
  streams: [] as Array<{ room: string; targetId: string; method: string; args: unknown[] }>,
  eventListeners: [] as Array<{
    event: string;
    listener: (payload: unknown, fromId: string) => void;
  }>,
  recoveryHandlers: [] as Array<{
    handler: (kind: "resubscribe" | "cold-recover") => void | Promise<void>;
  }>,
  activeWorkspace: "dev" as string | undefined,
}));

vi.mock("../main/panelAssetFacade.js", () => ({
  startPanelAssetFacade: vi.fn(
    async (
      serverClient: { stream: (...args: unknown[]) => Promise<Response> },
      options: Record<string, unknown> = {}
    ) => {
      panelFacadeMock.starts.push({ serverClient, options });
      return {
        port: 4242,
        close: async () => {
          panelFacadeMock.closes += 1;
        },
      };
    }
  ),
}));

vi.mock("./webrtcClient.js", () => ({
  WebRtcRpcClient: class {
    closed = false;

    constructor(readonly config: (typeof webrtcMock.instances)[number]["config"]) {
      webrtcMock.instances.push(this);
    }

    async ready(): Promise<void> {
      const suffix = this.config.pairing.room === "child-room" ? "child" : "cli";
      await this.config.onPaired?.({
        deviceId: `dev_${suffix}`,
        refreshToken: `refresh_${suffix}`,
      });
    }

    async call(method: string, args: unknown[] = []): Promise<unknown> {
      webrtcMock.calls.push({
        room: this.config.pairing.room,
        method,
        args,
        token: this.config.getToken(),
      });
      if (method === "workspace.getActive") return webrtcMock.activeWorkspace;
      if (method === "workspace.list") return [{ name: "dev", lastOpened: 1, running: true }];
      if (method === "workspace.select") {
        return {
          workspaceName: String(args[0] ?? "dev"),
          pairing: {
            deepLink:
              `vibez1://connect?room=child-room&fp=${"BB".repeat(32)}` +
              `&code=${"C".repeat(24)}&sig=${encodeURIComponent("wss://signal.example/")}` +
              "&v=2&ice=all",
          },
        };
      }
      if (method === "auth.getConnectionInfo") {
        return { serverId: "srv_webrtc", workspaceId: webrtcMock.activeWorkspace ?? null };
      }
      return undefined;
    }

    async callTarget(targetId: string, method: string, args: unknown[] = []): Promise<unknown> {
      webrtcMock.targetCalls.push({
        room: this.config.pairing.room,
        targetId,
        method,
        args,
      });
      return undefined;
    }

    async stream(targetId: string, method: string, args: unknown[] = []): Promise<Response> {
      webrtcMock.streams.push({
        room: this.config.pairing.room,
        targetId,
        method,
        args,
      });
      return new Response("stream-ok");
    }

    async onEvent(
      event: string,
      listener: (payload: unknown, fromId: string) => void
    ): Promise<() => void> {
      const entry = { event, listener };
      webrtcMock.eventListeners.push(entry);
      (
        globalThis as unknown as {
          __vibez1CliWebRtcEventListeners?: typeof webrtcMock.eventListeners;
        }
      ).__vibez1CliWebRtcEventListeners = webrtcMock.eventListeners;
      return () => {
        const index = webrtcMock.eventListeners.indexOf(entry);
        if (index >= 0) webrtcMock.eventListeners.splice(index, 1);
      };
    }

    async onRecovery(
      handler: (kind: "resubscribe" | "cold-recover") => void | Promise<void>
    ): Promise<() => void> {
      const entry = { handler };
      webrtcMock.recoveryHandlers.push(entry);
      (
        globalThis as unknown as {
          __vibez1CliWebRtcRecoveryHandlers?: typeof webrtcMock.recoveryHandlers;
        }
      ).__vibez1CliWebRtcRecoveryHandlers = webrtcMock.recoveryHandlers;
      return () => {
        const index = webrtcMock.recoveryHandlers.indexOf(entry);
        if (index >= 0) webrtcMock.recoveryHandlers.splice(index, 1);
      };
    }

    async close(): Promise<void> {
      this.closed = true;
    }
  },
}));

const FP = "AA".repeat(32);
function pairing(code: string) {
  return { room: "room-1111-2222", fp: FP, code, sig: "wss://signal.example/" };
}

function rpcResult(result: unknown): string {
  return JSON.stringify({
    from: "main",
    target: "dev_cli",
    delivery: { caller: { callerId: "server", callerKind: "server" } },
    provenance: [{ callerId: "server", callerKind: "server" }],
    message: { type: "response", requestId: "test-request", result },
  });
}

function rpcError(error: string): string {
  return JSON.stringify({
    from: "main",
    target: "dev_cli",
    delivery: { caller: { callerId: "server", callerKind: "server" } },
    provenance: [{ callerId: "server", callerKind: "server" }],
    message: { type: "response", requestId: "test-request", error },
  });
}

function rpcRequestMethod(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const message = (body as { message?: unknown }).message;
  if (!message || typeof message !== "object") return undefined;
  const method = (message as { method?: unknown }).method;
  return typeof method === "string" ? method : undefined;
}

describe("vibez1 CLI", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibez1-cli-"));
    vi.stubEnv("HOME", tmpDir);
    clearShellTokenCache();
    panelFacadeMock.starts.length = 0;
    panelFacadeMock.closes = 0;
    webrtcMock.instances.length = 0;
    webrtcMock.calls.length = 0;
    webrtcMock.targetCalls.length = 0;
    webrtcMock.streams.length = 0;
    webrtcMock.eventListeners.length = 0;
    webrtcMock.recoveryHandlers.length = 0;
    webrtcMock.activeWorkspace = "dev";
    delete (globalThis as unknown as { __vibez1CliWebRtcEventListeners?: unknown })
      .__vibez1CliWebRtcEventListeners;
    delete (globalThis as unknown as { __vibez1CliWebRtcRecoveryHandlers?: unknown })
      .__vibez1CliWebRtcRecoveryHandlers;
    delete (globalThis as unknown as { __vibez1HeadlessHostMock?: unknown })
      .__vibez1HeadlessHostMock;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("pairs from --url/--code and writes a 0600 device credential file", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify({ deviceId: "dev_cli", refreshToken: "refresh_cli" }));
      })
    );

    const { main } = await import("./client.js");
    const code = await main([
      "remote",
      "pair",
      "--url",
      "https://host.tailnet.ts.net",
      "--code",
      "A".repeat(24),
    ]);

    expect(code).toBe(0);
    expect(bodies).toEqual([
      {
        code: "A".repeat(24),
        label: expect.stringContaining("@"),
        platform: "desktop",
      },
    ]);
    const filePath = path.join(tmpDir, ".config", "vibez1", "cli-credentials.json");
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({
      schemaVersion: 1,
      kind: "device",
      url: "https://host.tailnet.ts.net",
      hubUrl: "https://host.tailnet.ts.net",
      deviceId: "dev_cli",
      refreshToken: "refresh_cli",
    });
    if (process.platform !== "win32") {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    }
  });

  it("pairs from a vibez1://connect link over WebRTC and stores the room credential", async () => {
    const { main } = await import("./client.js");
    const link = createConnectDeepLink(pairing("A".repeat(24)));
    await expect(main(["remote", "pair", link, "--label", "CLI test", "--json"])).resolves.toBe(0);
    expect(webrtcMock.instances).toHaveLength(1);
    expect(webrtcMock.instances[0]?.config.getToken()).toBe("A".repeat(24));

    const filePath = path.join(tmpDir, ".config", "vibez1", "cli-credentials.json");
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      kind: "device",
      url: "webrtc://room-1111-2222/_workspace/dev",
      hubUrl: "webrtc://room-1111-2222",
      workspaceName: "dev",
      deviceId: "dev_cli",
      refreshToken: "refresh_cli",
      pairing: {
        room: "room-1111-2222",
        fp: FP,
        sig: "wss://signal.example/",
        ice: "all",
        v: 2,
      },
    });
  });

  it("tightens an existing CLI credential file to 0600 when pairing", async () => {
    if (process.platform === "win32") return;
    const credentialDir = path.join(tmpDir, ".config", "vibez1");
    const filePath = path.join(credentialDir, "cli-credentials.json");
    fs.mkdirSync(credentialDir, { recursive: true });
    fs.writeFileSync(filePath, "{}", { mode: 0o644 });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ deviceId: "dev_cli", refreshToken: "refresh_cli" }))
      )
    );

    const { main } = await import("./client.js");
    const code = await main([
      "remote",
      "pair",
      "--url",
      "https://host.tailnet.ts.net",
      "--code",
      "A".repeat(24),
    ]);

    expect(code).toBe(0);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("logs out by removing the CLI credential file", async () => {
    const credentialDir = path.join(tmpDir, ".config", "vibez1");
    const filePath = path.join(credentialDir, "cli-credentials.json");
    fs.mkdirSync(credentialDir, { recursive: true });
    fs.writeFileSync(filePath, "{}");

    const { main } = await import("./client.js");
    await expect(main(["remote", "logout"])).resolves.toBe(0);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("shows the unified CLI groups in top-level help", async () => {
    const { main } = await import("./client.js");
    await expect(main(["--help"])).resolves.toBe(0);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("vibez1 remote pair"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("vibez1 mobile install"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("vibez1 mobile smoke"));
    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringContaining(["vibez1", "remote", "start"].join(" "))
    );
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("vibez1-client"));
  });

  it("keeps remote pairing available under the unified command", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ deviceId: "dev_cli", refreshToken: "refresh_cli" }))
      )
    );

    const { main } = await import("./client.js");
    await expect(
      main([
        "remote",
        "pair",
        "--url",
        "https://host.tailnet.ts.net",
        "--code",
        "A".repeat(24),
        "--json",
      ])
    ).resolves.toBe(0);

    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(JSON.parse(output)).toMatchObject({ url: "https://host.tailnet.ts.net" });
  });

  it("reports a failed or expired pairing code as an auth error (exit 3)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ error: "pairing code expired" }), { status: 401 })
      )
    );

    const { main } = await import("./client.js");
    await expect(
      main(["remote", "pair", "--url", "https://host.tailnet.ts.net", "--code", "A".repeat(24)])
    ).resolves.toBe(3);
  });

  it("rejects old top-level remote commands", async () => {
    const { main } = await import("./client.js");
    await expect(main(["pair", "--url", "https://host.tailnet.ts.net"])).resolves.toBe(2);
    expect(console.error).toHaveBeenCalledWith("Unknown command: pair");
  });

  it("checks the stored device refresh credential for status", async () => {
    const credentialDir = path.join(tmpDir, ".config", "vibez1");
    fs.mkdirSync(credentialDir, { recursive: true });
    fs.writeFileSync(
      path.join(credentialDir, "cli-credentials.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "device",
        url: "https://host.tailnet.ts.net/_workspace/dev",
        hubUrl: "https://host.tailnet.ts.net",
        workspaceName: "dev",
        deviceId: "dev_cli",
        refreshToken: "refresh_cli",
      })
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (String(url).endsWith("/_r/s/auth/refresh-shell")) {
          return new Response(
            JSON.stringify({
              shellToken: "shell_token",
              callerId: "shell:dev_cli",
              deviceId: "dev_cli",
              workspaceId: "ws_1",
              serverId: "srv_1",
            })
          );
        }
        return new Response(JSON.stringify({ ok: true, product: "vibez1", discoveryVersion: 1 }));
      })
    );

    const { main } = await import("./client.js");
    await expect(main(["remote", "status", "--json"])).resolves.toBe(0);
    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(JSON.parse(output)).toMatchObject({ workspaceId: "ws_1", serverId: "srv_1" });
  });

  it("selects a workspace from a WebRTC hub credential and stores the child room", async () => {
    const credentialDir = path.join(tmpDir, ".config", "vibez1");
    fs.mkdirSync(credentialDir, { recursive: true });
    fs.writeFileSync(
      path.join(credentialDir, "cli-credentials.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "device",
        url: "webrtc://hub-room",
        hubUrl: "webrtc://hub-room",
        deviceId: "dev_hub",
        refreshToken: "refresh_hub",
        pairing: {
          room: "hub-room",
          fp: FP,
          sig: "wss://signal.example/",
          ice: "all",
          v: 2,
        },
      })
    );

    const { main } = await import("./client.js");
    await expect(main(["remote", "select", "dev", "--json"])).resolves.toBe(0);

    expect(webrtcMock.calls).toContainEqual({
      room: "hub-room",
      method: "workspace.select",
      args: ["dev"],
      token: "refresh:dev_hub:refresh_hub",
    });
    const stored = JSON.parse(
      fs.readFileSync(path.join(credentialDir, "cli-credentials.json"), "utf8")
    );
    expect(stored).toMatchObject({
      url: "webrtc://child-room/_workspace/dev",
      hubUrl: "webrtc://hub-room",
      workspaceName: "dev",
      deviceId: "dev_child",
      refreshToken: "refresh_child",
      pairing: {
        room: "child-room",
        fp: "BB".repeat(32),
        sig: "wss://signal.example/",
        ice: "all",
        v: 2,
      },
      hubCredential: {
        url: "webrtc://hub-room",
        deviceId: "dev_hub",
        refreshToken: "refresh_hub",
        pairing: {
          room: "hub-room",
          fp: FP,
          sig: "wss://signal.example/",
        },
      },
    });
  });

  it("requires workspace selection before checking remote status", async () => {
    const credentialDir = path.join(tmpDir, ".config", "vibez1");
    fs.mkdirSync(credentialDir, { recursive: true });
    fs.writeFileSync(
      path.join(credentialDir, "cli-credentials.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "device",
        url: "https://host.tailnet.ts.net",
        hubUrl: "https://host.tailnet.ts.net",
        deviceId: "dev_cli",
        refreshToken: "refresh_cli",
      })
    );

    const { main } = await import("./client.js");
    await expect(main(["remote", "status", "--json"])).resolves.toBe(3);
    const output = vi
      .mocked(console.error)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(output).toContain("vibez1 remote select <workspace>");
  });

  it("reports missing credentials for status as an auth error (exit 3)", async () => {
    const { main } = await import("./client.js");
    await expect(main(["remote", "status", "--json"])).resolves.toBe(3);
  });

  it("rejects unknown flags as usage errors (exit 2)", async () => {
    const { main } = await import("./client.js");
    await expect(main(["remote", "status", "--bogus"])).resolves.toBe(2);
    await expect(main(["agent", "call", "--bogus"])).resolves.toBe(2);
  });

  it("creates a pairing invite using the stored device credential", async () => {
    const credentialDir = path.join(tmpDir, ".config", "vibez1");
    fs.mkdirSync(credentialDir, { recursive: true });
    fs.writeFileSync(
      path.join(credentialDir, "cli-credentials.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "device",
        url: "https://host.tailnet.ts.net",
        hubUrl: "https://host.tailnet.ts.net",
        deviceId: "dev_cli",
        refreshToken: "refresh_cli",
      })
    );
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        bodies.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
        if (String(url).endsWith("/_r/s/auth/refresh-shell")) {
          return new Response(JSON.stringify({ shellToken: "shell_token" }));
        }
        return new Response(
          rpcResult({
            code: "A".repeat(24),
            deepLink: createConnectDeepLink(pairing("A".repeat(24))),
            serverUrl: "https://host.tailnet.ts.net",
            expiresAt: 123,
            expiresInMs: 60_000,
            serverId: "srv",
            serverBootId: "boot",
            workspaceId: "ws",
          })
        );
      })
    );

    const { main } = await import("./client.js");
    await expect(main(["remote", "invite", "--ttl-ms", "60000", "--json"])).resolves.toBe(0);

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual({
      url: "https://host.tailnet.ts.net/_r/s/auth/refresh-shell",
      body: { deviceId: "dev_cli", refreshToken: "refresh_cli" },
    });
    expect(bodies[1]).toMatchObject({
      url: "https://host.tailnet.ts.net/rpc",
      body: {
        target: "main",
        message: {
          type: "request",
          method: "auth.createPairingInvite",
          args: [{ ttlMs: 60_000 }],
        },
      },
    });
    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(JSON.parse(output)).toMatchObject({
      code: "A".repeat(24),
      deepLink: createConnectDeepLink(pairing("A".repeat(24))),
    });
  });

  it("requires a hub credential before creating pairing invites", async () => {
    const credentialDir = path.join(tmpDir, ".config", "vibez1");
    fs.mkdirSync(credentialDir, { recursive: true });
    fs.writeFileSync(
      path.join(credentialDir, "cli-credentials.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "device",
        url: "https://host.tailnet.ts.net",
        deviceId: "dev_cli",
        refreshToken: "refresh_cli",
      })
    );

    const { main } = await import("./client.js");
    await expect(main(["remote", "invite", "--json"])).resolves.toBe(3);
    const output = vi
      .mocked(console.error)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(output).toContain("missing a hub URL");
  });

  it("pairs inline before starting the terminal app through the launch gate", async () => {
    const rpcMethods: string[] = [];
    const bodies: Array<{ url: string; body: unknown }> = [];
    const approval = {
      approvalId: "approval-1",
      kind: "unit-batch",
      callerId: "system:apps",
      callerKind: "system",
      repoPath: "apps/remote-cli",
      effectiveVersion: "ev-1",
      trigger: "startup",
      title: "Approve terminal app",
      description: "Approve before launch",
      units: [
        {
          unitKind: "app",
          unitName: "@workspace-apps/remote-cli",
          displayName: "Remote CLI",
          target: "terminal",
          source: { kind: "workspace-repo", repo: "apps/remote-cli", ref: "main" },
          ev: "terminal-ev",
          capabilities: ["connection-management"],
        },
      ],
      requestedAt: 1,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        bodies.push({ url: String(url), body });
        if (String(url).endsWith("/_r/s/auth/complete-pairing")) {
          return new Response(
            JSON.stringify({ deviceId: "dev_terminal", refreshToken: "refresh_terminal" })
          );
        }
        if (String(url).endsWith("/_r/s/workspaces/select")) {
          return new Response(
            JSON.stringify({
              workspaceName: "dev",
              serverUrl: "https://host.tailnet.ts.net/_workspace/dev",
              running: true,
            })
          );
        }
        if (String(url).endsWith("/_r/s/auth/refresh-shell")) {
          return new Response(JSON.stringify({ shellToken: "shell_token" }));
        }
        const method = rpcRequestMethod(body);
        rpcMethods.push(method ?? "");
        if (method === "workspace.hostTargets.beginLaunch") {
          return new Response(
            rpcResult({
              sessionId: "launch_terminal",
              target: "terminal",
              status: "approval-required",
              currentPhase: "review-trust",
              message: "Terminal launch needs approval.",
              timeline: [],
              approvals: [approval],
              approvalViews: [],
              approvalsResolved: 0,
              startedAt: 1,
              updatedAt: 1,
              settled: false,
            })
          );
        }
        if (method === "workspace.hostTargets.resolveLaunchSessionApproval") {
          return new Response(
            rpcResult({
              sessionId: "launch_terminal",
              target: "terminal",
              status: "ready",
              currentPhase: "connected",
              message: "Terminal app is ready.",
              timeline: [],
              approvals: [],
              approvalViews: [],
              approvalsResolved: 1,
              startedAt: 1,
              updatedAt: 2,
              settled: true,
              launch: {
                status: "ready",
                target: "terminal",
                appId: "@workspace-apps/remote-cli",
                buildKey: "build-terminal",
              },
            })
          );
        }
        return new Response(rpcError(`unexpected ${method ?? "<missing method>"}`), {
          status: 500,
        });
      })
    );

    const { main } = await import("./client.js");
    const code = await main([
      "terminal",
      "start",
      "--url",
      "https://host.tailnet.ts.net",
      "--code",
      "A".repeat(24),
      "--workspace",
      "dev",
      "--yes",
      "--json",
    ]);

    expect(code).toBe(0);
    expect(bodies[0]).toMatchObject({
      url: "https://host.tailnet.ts.net/_r/s/auth/complete-pairing",
      body: {
        code: "A".repeat(24),
        label: expect.stringContaining("Terminal on "),
        platform: "terminal",
      },
    });
    expect(rpcMethods).toEqual([
      "workspace.hostTargets.beginLaunch",
      "workspace.hostTargets.resolveLaunchSessionApproval",
    ]);
    const filePath = path.join(tmpDir, ".config", "vibez1", "cli-credentials.json");
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      kind: "device",
      url: "https://host.tailnet.ts.net/_workspace/dev",
      hubUrl: "https://host.tailnet.ts.net",
      workspaceName: "dev",
      deviceId: "dev_terminal",
      refreshToken: "refresh_terminal",
    });
    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(JSON.parse(output)).toMatchObject({ status: "ready", approvalsResolved: 1 });
  });

  it("points unpaired terminal users at the inline pairing command", async () => {
    const { main } = await import("./client.js");
    await expect(main(["terminal", "start"])).resolves.toBe(3);
    const output = vi
      .mocked(console.error)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(output).toContain("vibez1 terminal start --pair");
  });

  function writeCredentials(content?: string): void {
    const credentialDir = path.join(tmpDir, ".config", "vibez1");
    fs.mkdirSync(credentialDir, { recursive: true });
    fs.writeFileSync(
      path.join(credentialDir, "cli-credentials.json"),
      content ??
        JSON.stringify({
          schemaVersion: 1,
          kind: "device",
          url: "https://host.tailnet.ts.net/_workspace/dev",
          hubUrl: "https://host.tailnet.ts.net",
          workspaceName: "dev",
          deviceId: "dev_cli",
          refreshToken: "refresh_cli",
        })
    );
  }

  function writeWebRtcCredentials(refreshToken = "refresh_cli"): void {
    writeCredentials(
      JSON.stringify({
        schemaVersion: 1,
        kind: "device",
        url: "webrtc://room-1111-2222/_workspace/dev",
        hubUrl: "webrtc://room-1111-2222",
        workspaceName: "dev",
        deviceId: "dev_cli",
        refreshToken,
        pairing: {
          room: "room-1111-2222",
          fp: FP,
          sig: "wss://signal.example/",
          ice: "all",
          v: 2,
        },
      })
    );
  }

  function writeHeadlessHostMock(failStartMessage?: string): {
    path: string;
    state: {
      failStartMessage?: string;
      resolveConfig: Array<Record<string, unknown>>;
      configs: Array<Record<string, unknown>>;
      starts: number;
      stops: string[];
      connections: unknown[];
      bridgeSockets: unknown[];
      token?: string;
      serverEvents: Array<{ event: string; payload: unknown }>;
      resubscribes: number;
    };
  } {
    const state = {
      ...(failStartMessage ? { failStartMessage } : {}),
      resolveConfig: [] as Array<Record<string, unknown>>,
      configs: [] as Array<Record<string, unknown>>,
      starts: 0,
      stops: [] as string[],
      connections: [] as unknown[],
      bridgeSockets: [] as unknown[],
      token: undefined as string | undefined,
      serverEvents: [] as Array<{ event: string; payload: unknown }>,
      resubscribes: 0,
    };
    (globalThis as unknown as { __vibez1HeadlessHostMock: typeof state }).__vibez1HeadlessHostMock =
      state;
    const modulePath = path.join(tmpDir, `headless-host-mock-${Date.now()}.mjs`);
    fs.writeFileSync(
      modulePath,
      `
const state = globalThis.__vibez1HeadlessHostMock;
export class RemoteCdpHostBridgeSocket {
  constructor(options) {
    state.bridgeSockets.push(options);
    this.readyState = 1;
  }
  send() {}
  close() {}
  on() { return this; }
}
export function resolveConfig(overrides) {
  state.resolveConfig.push(overrides);
  return {
    ...overrides,
    auth: overrides.connectionFactory ? { kind: "injected" } : { kind: "token", token: overrides.token },
    label: overrides.label ?? "Headless",
    clientSessionId: overrides.clientSessionId ?? "headless-mock"
  };
}
export class HeadlessHost {
  constructor(config) {
    this.config = config;
    state.configs.push(config);
  }
  async start() {
    state.starts += 1;
    const connection = await this.config.connectionFactory();
    state.connections.push(connection);
    state.token = connection.getToken();
    connection.onServerEvent((event, payload) => state.serverEvents.push({ event, payload }));
    connection.onResubscribe(async () => { state.resubscribes += 1; });
    await connection.rpc.call("main", "panelRuntime.registerClient", [{ from: "mock" }]);
    await connection.rpc.call("main", "events.subscribe", ["panel:runtimeLeaseChanged"]);
    await connection.rpc.stream("main", "panelCdp.hostProvider.open", ["provider-session", this.config.clientSessionId]);
    this.config.bridgeSocketFactory("ws://ignored");
    for (const entry of globalThis.__vibez1CliWebRtcEventListeners ?? []) {
      if (entry.event === "panel:runtimeLeaseChanged") entry.listener({ slotId: "panel-1" }, "main");
    }
    for (const entry of globalThis.__vibez1CliWebRtcRecoveryHandlers ?? []) {
      await entry.handler("resubscribe");
    }
    if (state.failStartMessage) throw new Error(state.failStartMessage);
  }
  async stop(reason) {
    state.stops.push(reason);
  }
  get done() {
    return Promise.resolve();
  }
}
`
    );
    return { path: modulePath, state };
  }

  it("runs remote host over WebRTC using the injected RPC connection and CDP bridge stream", async () => {
    writeWebRtcCredentials("refresh_secret_for_host_123456");
    const headless = writeHeadlessHostMock();
    vi.stubEnv("VIBEZ1_HEADLESS_HOST_ENTRY", headless.path);

    const { main } = await import("./client.js");
    await expect(
      main(["remote", "host", "--label", "Headless CLI", "--idle-exit-min", "1", "--lean-browser"])
    ).resolves.toBe(0);

    expect(panelFacadeMock.starts).toHaveLength(1);
    expect(panelFacadeMock.starts[0]?.options).toMatchObject({
      stateDir: expect.stringContaining(path.join("vibez1", "headless-host", "panel-asset-facade")),
    });
    expect(panelFacadeMock.closes).toBe(1);
    expect(headless.state.starts).toBe(1);
    expect(headless.state.resolveConfig[0]).toMatchObject({
      serverUrl: "http://127.0.0.1:4242",
      label: "Headless CLI",
      idleExitMs: 60_000,
      leanBrowser: true,
    });
    expect(headless.state.configs[0]).toMatchObject({
      auth: { kind: "injected" },
      serverUrl: "http://127.0.0.1:4242",
      label: "Headless CLI",
    });
    expect(headless.state.token).toBe("refresh:dev_cli:refresh_secret_for_host_123456");
    expect(headless.state.bridgeSockets).toHaveLength(1);
    expect(headless.state.serverEvents).toEqual([
      { event: "panel:runtimeLeaseChanged", payload: { slotId: "panel-1" } },
    ]);
    expect(headless.state.resubscribes).toBe(1);
    expect(webrtcMock.calls).toEqual(
      expect.arrayContaining([
        {
          room: "room-1111-2222",
          method: "panelRuntime.registerClient",
          args: [{ from: "mock" }],
          token: "refresh:dev_cli:refresh_secret_for_host_123456",
        },
        {
          room: "room-1111-2222",
          method: "events.subscribe",
          args: ["panel:runtimeLeaseChanged"],
          token: "refresh:dev_cli:refresh_secret_for_host_123456",
        },
      ])
    );
    expect(webrtcMock.streams).toEqual(
      expect.arrayContaining([
        {
          room: "room-1111-2222",
          targetId: "main",
          method: "panelCdp.hostProvider.open",
          args: ["provider-session", expect.stringMatching(/^headless-/)],
        },
      ])
    );
    expect(webrtcMock.instances[0]?.closed).toBe(true);
  });

  it("redacts WebRTC refresh tokens from remote host startup failures", async () => {
    const refreshToken = "refresh_secret_for_redaction_987654321";
    writeWebRtcCredentials(refreshToken);
    const headless = writeHeadlessHostMock(
      `failed with refresh:dev_cli:${refreshToken} and Bearer abcdef1234567890`
    );
    vi.stubEnv("VIBEZ1_HEADLESS_HOST_ENTRY", headless.path);

    const { main } = await import("./client.js");
    await expect(main(["remote", "host"])).resolves.toBe(1);

    const output = vi
      .mocked(console.error)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(output).toContain("headless host failed to start");
    expect(output).not.toContain(refreshToken);
    expect(output).not.toContain(`refresh:dev_cli:${refreshToken}`);
    expect(output).not.toContain("abcdef1234567890");
    expect(output).toContain("refr…4321");
    expect(output).toContain("Bearer abcd…7890");
    expect(panelFacadeMock.closes).toBe(1);
    expect(webrtcMock.instances[0]?.closed).toBe(true);
  });

  it("prints per-command help for --help and -h (exit 0)", async () => {
    const { main } = await import("./client.js");
    await expect(main(["remote", "invite", "--help"])).resolves.toBe(0);
    await expect(main(["fs", "ls", "-h"])).resolves.toBe(0);

    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(output).toContain("vibez1 remote invite [--ttl-ms <milliseconds>]");
    expect(output).toContain("--ttl-ms <value>");
    expect(output).toContain("--json");
    expect(output).toContain("Emit JSON");
    expect(console.error).not.toHaveBeenCalled();
  });

  it("accepts --flag=value syntax for value flags", async () => {
    writeCredentials();
    const bodies: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init?: RequestInit) => {
        bodies.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
        if (String(url).endsWith("/_r/s/auth/refresh-shell")) {
          return new Response(JSON.stringify({ shellToken: "shell_token" }));
        }
        return new Response(
          rpcResult({
            code: "A".repeat(24),
            deepLink: createConnectDeepLink(pairing("A".repeat(24))),
          })
        );
      })
    );

    const { main } = await import("./client.js");
    await expect(main(["remote", "invite", "--ttl-ms=60000", "--json"])).resolves.toBe(0);
    expect(bodies[1]?.body).toMatchObject({
      target: "main",
      message: {
        type: "request",
        method: "auth.createPairingInvite",
        args: [{ ttlMs: 60_000 }],
      },
    });
  });

  it("accepts --flag=true|false for boolean flags and rejects other values", async () => {
    writeCredentials();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (String(url).endsWith("/_r/s/auth/refresh-shell")) {
          return new Response(JSON.stringify({ shellToken: "shell_token", workspaceId: "ws_1" }));
        }
        return new Response(JSON.stringify({ ok: true }));
      })
    );

    const { main } = await import("./client.js");
    await expect(main(["remote", "status", "--json=true"])).resolves.toBe(0);
    await expect(main(["remote", "status", "--json=banana"])).resolves.toBe(2);
  });

  it("rejects a non-numeric --ttl-ms as a usage error (exit 2)", async () => {
    writeCredentials();
    const { main } = await import("./client.js");
    await expect(main(["remote", "invite", "--ttl-ms", "soon", "--json"])).resolves.toBe(2);
  });

  it("treats corrupted credentials as not paired (exit 3, no crash)", async () => {
    writeCredentials("{not json");
    const { main } = await import("./client.js");
    await expect(main(["remote", "status", "--json"])).resolves.toBe(3);
    const output = vi
      .mocked(console.error)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(output).toContain("not paired");
  });
});
