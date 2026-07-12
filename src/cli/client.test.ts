import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createConnectDeepLink } from "@vibestudio/shared/connect";
import { clearShellTokenCache } from "./rpcClient.js";

const TEST_SERVER_ID = `srv_${"S".repeat(24)}`;
const TEST_SERVER_BOOT_ID = `boot_${"B".repeat(24)}`;
const TEST_DEVICE_ID = `dev_${"D".repeat(24)}`;
const TEST_REFRESH_TOKEN = "R".repeat(43);

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
  handlers: new Map<string, (args: unknown[], room: string) => unknown>(),
  activeWorkspace: "dev" as string | undefined,
  readyError: null as Error | null,
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
      if (webrtcMock.readyError) throw webrtcMock.readyError;
      await this.config.onPaired?.({
        deviceId: TEST_DEVICE_ID,
        refreshToken: TEST_REFRESH_TOKEN,
      });
    }

    async call(method: string, args: unknown[] = []): Promise<unknown> {
      const room = this.config.pairing.room;
      webrtcMock.calls.push({ room, method, args, token: this.config.getToken() });
      const handler = webrtcMock.handlers.get(method);
      if (handler) return handler(args, room);
      if (method === "workspace.getActive") return webrtcMock.activeWorkspace;
      if (method === "auth.getConnectionInfo") {
        return { serverId: TEST_SERVER_ID, workspaceId: webrtcMock.activeWorkspace ?? null };
      }
      if (method === "hubControl.listWorkspaces") {
        return [
          { workspaceId: "ws_dev", name: "dev", lastOpened: 1, running: true },
          { workspaceId: "ws_docs", name: "docs", lastOpened: 0, running: false },
        ];
      }
      if (method === "hubControl.routeWorkspace") {
        const workspace = String(
          (args[0] as { workspace?: string } | undefined)?.workspace ?? "dev"
        );
        return {
          workspace,
          workspaceId: `ws_${workspace}`,
          running: true,
          serverUrl: `webrtc://child-${workspace}/_workspace/${workspace}`,
          controlReach: {
            room: `control-${workspace}`,
            fp: "CC".repeat(32),
            sig: "wss://signal.example/",
            v: 2,
            ice: "all",
          },
          workspaceReach: {
            room: `child-${workspace}`,
            fp: "BB".repeat(32),
            sig: "wss://signal.example/",
            v: 2,
            ice: "all",
          },
          serverId: TEST_SERVER_ID,
          serverBootId: TEST_SERVER_BOOT_ID,
        };
      }
      return undefined;
    }

    async callTarget(targetId: string, method: string, args: unknown[] = []): Promise<unknown> {
      webrtcMock.targetCalls.push({ room: this.config.pairing.room, targetId, method, args });
      return webrtcMock.handlers.get(method)?.(args, this.config.pairing.room);
    }

    async stream(targetId: string, method: string, args: unknown[] = []): Promise<Response> {
      webrtcMock.streams.push({ room: this.config.pairing.room, targetId, method, args });
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
          __vibestudioCliWebRtcEventListeners?: typeof webrtcMock.eventListeners;
        }
      ).__vibestudioCliWebRtcEventListeners = webrtcMock.eventListeners;
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
          __vibestudioCliWebRtcRecoveryHandlers?: typeof webrtcMock.recoveryHandlers;
        }
      ).__vibestudioCliWebRtcRecoveryHandlers = webrtcMock.recoveryHandlers;
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
const ISSUER_FP = Array.from({ length: 32 }, () => "AA").join(":");
function pairing(code: string) {
  return {
    room: "room-1111-2222",
    fp: ISSUER_FP,
    code,
    sig: "wss://signal.example/",
    v: 2 as const,
    ice: "all" as const,
  };
}

function pairingInvite(code = "P".repeat(32)) {
  return {
    code,
    deepLink: createConnectDeepLink(pairing(code)),
    pairUrl: "https://vibestudio.app/pair#invite",
    room: "invite-room",
    fp: FP,
    sig: "wss://signal.example/",
    v: 2 as const,
    ice: "all" as const,
    serverUrl: "webrtc://invite-room/_workspace/dev",
    expiresAt: Date.now() + 60_000,
    expiresInMs: 60_000,
    serverId: TEST_SERVER_ID,
    serverBootId: TEST_SERVER_BOOT_ID,
  };
}

describe("vibestudio CLI", () => {
  let tmpDir = "";

  function credentialPath(): string {
    return path.join(tmpDir, ".config", "vibestudio", "cli-credentials.json");
  }

  function writeCredentials(overrides: Record<string, unknown> = {}): void {
    fs.mkdirSync(path.dirname(credentialPath()), { recursive: true });
    fs.writeFileSync(
      credentialPath(),
      JSON.stringify({
        schemaVersion: 3,
        kind: "device",
        url: "webrtc://room-1111-2222/_workspace/dev",
        workspaceName: "dev",
        serverId: TEST_SERVER_ID,
        deviceId: TEST_DEVICE_ID,
        refreshToken: TEST_REFRESH_TOKEN,
        controlPairing: {
          room: "room-1111-2222",
          fp: FP,
          sig: "wss://signal.example/",
          ice: "all",
          v: 2,
        },
        workspacePairing: {
          room: "room-1111-2222",
          fp: FP,
          sig: "wss://signal.example/",
          ice: "all",
          v: 2,
        },
        pairedAt: 1,
        ...overrides,
      })
    );
  }

  function jsonOutput(): unknown {
    const lines = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
    return JSON.parse(lines[lines.length - 1]!);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-cli-"));
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
    webrtcMock.handlers.clear();
    webrtcMock.activeWorkspace = "dev";
    webrtcMock.readyError = null;
    delete (globalThis as unknown as { __vibestudioCliWebRtcEventListeners?: unknown })
      .__vibestudioCliWebRtcEventListeners;
    delete (globalThis as unknown as { __vibestudioCliWebRtcRecoveryHandlers?: unknown })
      .__vibestudioCliWebRtcRecoveryHandlers;
    delete (globalThis as unknown as { __vibestudioHeadlessHostMock?: unknown })
      .__vibestudioHeadlessHostMock;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("pairs from a WebRTC link and writes the only supported credential schema at 0600", async () => {
    const { main } = await import("./client.js");
    const link = createConnectDeepLink(pairing("A".repeat(32)));
    await expect(main(["remote", "pair", link, "--label", "CLI test", "--json"])).resolves.toBe(0);

    expect(webrtcMock.instances[0]?.config.getToken()).toBe("A".repeat(32));
    expect(JSON.parse(fs.readFileSync(credentialPath(), "utf8"))).toMatchObject({
      schemaVersion: 3,
      kind: "device",
      url: "webrtc://child-dev/_workspace/dev",
      workspaceName: "dev",
      serverId: TEST_SERVER_ID,
      deviceId: TEST_DEVICE_ID,
      refreshToken: TEST_REFRESH_TOKEN,
      controlPairing: {
        room: "control-dev",
        fp: "CC".repeat(32),
        sig: "wss://signal.example/",
      },
      workspacePairing: {
        room: "child-dev",
        fp: "BB".repeat(32),
        sig: "wss://signal.example/",
      },
    });
    expect(webrtcMock.calls).toContainEqual({
      room: "room-1111-2222",
      method: "hubControl.routeWorkspace",
      args: [{ workspace: "dev" }],
      token: "A".repeat(32),
    });
    if (process.platform !== "win32") {
      expect(fs.statSync(credentialPath()).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects removed URL/code pairing flags", async () => {
    const { main } = await import("./client.js");
    await expect(
      main(["remote", "pair", "--url", "https://host.example", "--code", "ABC"])
    ).resolves.toBe(2);
  });

  it("tightens an existing credential file when replacing it", async () => {
    if (process.platform === "win32") return;
    fs.mkdirSync(path.dirname(credentialPath()), { recursive: true });
    fs.writeFileSync(credentialPath(), "{}", { mode: 0o644 });
    const { main } = await import("./client.js");
    await expect(
      main(["remote", "pair", createConnectDeepLink(pairing("A".repeat(32)))])
    ).resolves.toBe(0);
    expect(fs.statSync(credentialPath()).mode & 0o777).toBe(0o600);
  });

  it("logs out by removing the device credential", async () => {
    writeCredentials();
    const { main } = await import("./client.js");
    await expect(main(["remote", "logout"])).resolves.toBe(0);
    expect(fs.existsSync(credentialPath())).toBe(false);
  });

  it("shows the unified command groups and no removed top-level pairing command", async () => {
    const { main } = await import("./client.js");
    await expect(main(["--help"])).resolves.toBe(0);
    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(output).toContain("vibestudio remote pair");
    expect(output).toContain("vibestudio remote invite-user");
    expect(output).toContain("vibestudio mobile install");
    await expect(main(["pair"])).resolves.toBe(2);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("vibestudio remote pair"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("vibestudio mobile install"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("vibestudio mobile smoke"));
    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringContaining(["vibestudio", "remote", "start"].join(" "))
    );
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("vibestudio-client"));
    expect(output).toContain("Getting started:");
    expect(output).toContain("remote — pairing, servers, workspaces");
    expect(output).not.toContain("agent turn");
  });

  it("routes the common help <group> spelling to group help", async () => {
    const { main } = await import("./client.js");
    await expect(main(["help", "remote"])).resolves.toBe(0);
    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(output).toContain("vibestudio remote");
    expect(output).toContain("vibestudio remote pair");
    expect(output).not.toContain("vibestudio mobile install");
  });

  it("prints the package version", async () => {
    const expected = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")).version;
    const { main } = await import("./client.js");
    await expect(main(["--version"])).resolves.toBe(0);
    expect(console.log).toHaveBeenCalledWith(expected);
  });

  it("reports rejected or expired WebRTC pairing as an auth error", async () => {
    webrtcMock.readyError = new Error("pairing code expired");
    const { main } = await import("./client.js");
    await expect(
      main(["remote", "pair", createConnectDeepLink(pairing("A".repeat(32))), "--json"])
    ).resolves.toBe(3);
    const output = vi
      .mocked(console.error)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(output).toContain("pairing code expired");
    expect(JSON.parse(output)).toMatchObject({
      error: expect.stringContaining("pairing code expired"),
      exitCode: 3,
    });
  });

  it("treats a bare remote pair as an actionable usage error", async () => {
    const { main } = await import("./client.js");
    await expect(main(["remote", "pair", "--json"])).resolves.toBe(2);
    const output = vi
      .mocked(console.error)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(output).toContain("vibestudio://connect link");
    expect(output).toContain('exitCode":2');
  });

  it("explains how to pair when remote status is unpaired", async () => {
    const { main } = await import("./client.js");
    await expect(main(["remote", "status", "--json"])).resolves.toBe(3);
    const output = vi
      .mocked(console.error)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(output).toContain("vibestudio remote pair");
    expect(output).toContain("desktop app");
  });

  it("rejects old top-level remote commands", async () => {
    const { main } = await import("./client.js");
    await expect(main(["pair", "--url", "https://host.tailnet.ts.net"])).resolves.toBe(2);
    expect(console.error).toHaveBeenCalledWith("Unknown command: pair");
  });

  it("checks status over the stored WebRTC device credential", async () => {
    writeCredentials();
    const { main } = await import("./client.js");
    await expect(main(["remote", "status", "--json"])).resolves.toBe(0);
    expect(jsonOutput()).toMatchObject({ workspaceId: "dev", serverId: TEST_SERVER_ID });
    expect(webrtcMock.calls).toContainEqual({
      room: "room-1111-2222",
      method: "auth.getConnectionInfo",
      args: [],
      token: `refresh:${TEST_DEVICE_ID}:${TEST_REFRESH_TOKEN}`,
    });
  });

  it("selects a workspace via hubControl while preserving the global device credential", async () => {
    writeCredentials();
    const { main } = await import("./client.js");
    await expect(main(["remote", "select", "docs", "--json"])).resolves.toBe(0);
    const stored = JSON.parse(fs.readFileSync(credentialPath(), "utf8"));
    expect(stored).toMatchObject({
      schemaVersion: 3,
      url: "webrtc://child-docs/_workspace/docs",
      workspaceName: "docs",
      serverId: TEST_SERVER_ID,
      deviceId: TEST_DEVICE_ID,
      refreshToken: TEST_REFRESH_TOKEN,
      controlPairing: {
        room: "control-docs",
        fp: "CC".repeat(32),
        sig: "wss://signal.example/",
        v: 2,
        ice: "all",
      },
      workspacePairing: {
        room: "child-docs",
        fp: "BB".repeat(32),
        sig: "wss://signal.example/",
        v: 2,
        ice: "all",
      },
    });
    expect(stored).not.toHaveProperty("hubUrl");
    expect(stored).not.toHaveProperty("hubCredential");
    await expect(main(["remote", "workspaces", "--json"])).resolves.toBe(0);
    expect(webrtcMock.calls).toContainEqual({
      room: "control-docs",
      method: "hubControl.listWorkspaces",
      args: [],
      token: `refresh:${TEST_DEVICE_ID}:${TEST_REFRESH_TOKEN}`,
    });
  });

  it("rejects workspace selection when the route changes server identity", async () => {
    writeCredentials();
    webrtcMock.handlers.set("hubControl.routeWorkspace", (_args, _room) => ({
      workspace: "docs",
      workspaceId: "ws_docs",
      running: true,
      serverUrl: "webrtc://child-docs/_workspace/docs",
      controlReach: {
        room: "control-docs",
        fp: "CC".repeat(32),
        sig: "wss://signal.example/",
        v: 2,
        ice: "all",
      },
      workspaceReach: {
        room: "child-docs",
        fp: "BB".repeat(32),
        sig: "wss://signal.example/",
        v: 2,
        ice: "all",
      },
      serverId: `srv_${"X".repeat(24)}`,
      serverBootId: TEST_SERVER_BOOT_ID,
    }));
    const before = fs.readFileSync(credentialPath(), "utf8");
    const { main } = await import("./client.js");

    await expect(main(["remote", "select", "docs", "--json"])).resolves.not.toBe(0);
    expect(fs.readFileSync(credentialPath(), "utf8")).toBe(before);
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain(
      "changed the paired server identity"
    );
  });

  it("rejects credentials that are unselected, corrupted, legacy, or structurally ambiguous", async () => {
    writeCredentials({ workspaceName: "", url: "webrtc://room-1111-2222" });
    const { main } = await import("./client.js");
    await expect(main(["remote", "status", "--json"])).resolves.toBe(3);

    fs.writeFileSync(credentialPath(), "{not json");
    await expect(main(["remote", "status", "--json"])).resolves.toBe(3);

    fs.writeFileSync(
      credentialPath(),
      JSON.stringify({ schemaVersion: 1, kind: "device", deviceId: "old", refreshToken: "old" })
    );
    await expect(main(["remote", "status", "--json"])).resolves.toBe(3);

    writeCredentials({ hubCredential: { deviceId: "legacy" } } as never);
    await expect(main(["remote", "status", "--json"])).resolves.toBe(3);

    writeCredentials({
      pairing: { ...pairing("A".repeat(32)), code: "must-not-persist" },
    } as never);
    await expect(main(["remote", "status", "--json"])).resolves.toBe(3);
  });

  it("reports missing credentials and unknown flags with stable exit codes", async () => {
    const { main } = await import("./client.js");
    await expect(main(["remote", "status", "--json"])).resolves.toBe(3);
    await expect(main(["remote", "status", "--bogus"])).resolves.toBe(2);
  });

  it("creates a same-account device invite through hubControl", async () => {
    writeCredentials();
    const invite = pairingInvite();
    webrtcMock.handlers.set("hubControl.pairDevice", (args) => ({
      userId: "usr_alice",
      handle: "alice",
      workspace: (args[0] as { workspace?: string })?.workspace ?? "dev",
      pairing: invite,
    }));
    const { main } = await import("./client.js");
    await expect(
      main(["remote", "pair-device", "--workspace", "dev", "--ttl-ms=60000", "--json"])
    ).resolves.toBe(0);
    expect(jsonOutput()).toMatchObject({ userId: "usr_alice", pairing: { code: invite.code } });
    expect(webrtcMock.calls).toContainEqual(
      expect.objectContaining({
        method: "hubControl.pairDevice",
        args: [{ workspace: "dev", ttlMs: 60_000 }],
      })
    );
  });

  it("invites a new user with explicit workspace grants", async () => {
    writeCredentials();
    webrtcMock.handlers.set("hubControl.inviteUser", (args) => ({
      user: { userId: "usr_bob", handle: "bob", displayName: "Bob", role: "member" },
      workspaces: (args[0] as { workspaces: string[] }).workspaces,
      pairing: pairingInvite("U".repeat(32)),
    }));
    const { main } = await import("./client.js");
    await expect(
      main([
        "remote",
        "invite-user",
        "--handle",
        "bob",
        "--display-name",
        "Bob",
        "--workspace",
        "dev",
        "--workspace",
        "docs",
        "--json",
      ])
    ).resolves.toBe(0);
    expect(jsonOutput()).toMatchObject({ workspaces: ["dev", "docs"] });
  });

  it("exposes discrete membership and device administration commands", async () => {
    writeCredentials();
    webrtcMock.handlers.set("hubControl.addWorkspaceMember", () => ({ added: true }));
    webrtcMock.handlers.set("hubControl.listWorkspaceMembers", () => ({
      workspace: "dev",
      workspaceId: "ws_dev",
      members: [{ userId: "usr_bob", handle: "bob", role: "member" }],
    }));
    webrtcMock.handlers.set("hubControl.listDevices", () => ({
      serverId: TEST_SERVER_ID,
      devices: [{ deviceId: TEST_DEVICE_ID, userId: "usr_alice", label: "CLI", createdAt: 1 }],
    }));
    const { main } = await import("./client.js");
    await expect(
      main(["remote", "add-member", "--workspace", "dev", "--handle", "bob", "--json"])
    ).resolves.toBe(0);
    await expect(main(["remote", "list-users", "--workspace", "dev", "--json"])).resolves.toBe(0);
    await expect(main(["remote", "list-devices", "--json"])).resolves.toBe(0);
    expect(webrtcMock.calls.map((call) => call.method)).toEqual(
      expect.arrayContaining([
        "hubControl.addWorkspaceMember",
        "hubControl.listWorkspaceMembers",
        "hubControl.listDevices",
      ])
    );
  });

  it("requires one member selector and reports a no-op removal as non-success", async () => {
    writeCredentials();
    const { main } = await import("./client.js");

    await expect(
      main([
        "remote",
        "remove-member",
        "--workspace",
        "dev",
        "--user-id",
        "usr_bob",
        "--handle",
        "bob",
        "--json",
      ])
    ).resolves.toBe(2);

    webrtcMock.handlers.set("hubControl.removeWorkspaceMember", () => ({
      removed: false,
      closedSessions: 0,
    }));
    await expect(
      main(["remote", "remove-member", "--workspace", "dev", "--handle", "bob", "--json"])
    ).resolves.toBe(1);
    expect(jsonOutput()).toMatchObject({ removed: false, closedSessions: 0 });
  });

  it("pairs inline before starting the terminal app", async () => {
    webrtcMock.handlers.set("workspace.hostTargets.beginLaunch", () => ({
      sessionId: "launch_terminal",
      target: "terminal",
      status: "ready",
      currentPhase: "connected",
      message: "Terminal app is ready.",
      timeline: [],
      approvals: [],
      approvalViews: [],
      approvalsResolved: 0,
      startedAt: 1,
      updatedAt: 2,
      settled: true,
      launch: {
        status: "ready",
        target: "terminal",
        appId: "@workspace-apps/remote-cli",
        buildKey: "build-terminal",
      },
    }));
    const { main } = await import("./client.js");
    const link = createConnectDeepLink(pairing("A".repeat(32)));
    await expect(main(["terminal", "start", "--pair", link, "--yes", "--json"])).resolves.toBe(0);
    expect(JSON.parse(fs.readFileSync(credentialPath(), "utf8"))).toMatchObject({
      schemaVersion: 3,
      workspaceName: "dev",
      deviceId: TEST_DEVICE_ID,
    });
    expect(jsonOutput()).toMatchObject({ status: "ready" });
  });

  it("points unpaired terminal users at the inline pairing command", async () => {
    const { main } = await import("./client.js");
    await expect(main(["terminal", "start"])).resolves.toBe(3);
    const output = vi
      .mocked(console.error)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(output).toContain("vibestudio terminal start --pair");
  });

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
    (
      globalThis as unknown as { __vibestudioHeadlessHostMock: typeof state }
    ).__vibestudioHeadlessHostMock = state;
    const modulePath = path.join(tmpDir, `headless-host-mock-${Date.now()}.mjs`);
    fs.writeFileSync(
      modulePath,
      `
const state = globalThis.__vibestudioHeadlessHostMock;
export class RemoteCdpHostBridgeSocket {
  constructor(options) { state.bridgeSockets.push(options); this.readyState = 1; }
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
  constructor(config) { this.config = config; state.configs.push(config); }
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
    for (const entry of globalThis.__vibestudioCliWebRtcEventListeners ?? []) {
      if (entry.event === "panel:runtimeLeaseChanged") entry.listener({ slotId: "panel-1" }, "main");
    }
    for (const entry of globalThis.__vibestudioCliWebRtcRecoveryHandlers ?? []) {
      await entry.handler("resubscribe");
    }
    if (state.failStartMessage) throw new Error(state.failStartMessage);
  }
  async stop(reason) { state.stops.push(reason); }
  get done() { return Promise.resolve(); }
}
`
    );
    return { path: modulePath, state };
  }

  it("runs the remote host through the canonical WebRTC connection", async () => {
    const refreshToken = "H".repeat(43);
    writeCredentials({ refreshToken });
    const headless = writeHeadlessHostMock();
    vi.stubEnv("VIBESTUDIO_HEADLESS_HOST_ENTRY", headless.path);
    const { main } = await import("./client.js");
    await expect(
      main(["remote", "host", "--label", "Headless CLI", "--idle-exit-min", "1", "--lean-browser"])
    ).resolves.toBe(0);

    expect(panelFacadeMock.starts).toHaveLength(1);
    expect(panelFacadeMock.closes).toBe(1);
    expect(headless.state.resolveConfig[0]).toMatchObject({
      serverUrl: "http://127.0.0.1:4242",
      label: "Headless CLI",
      idleExitMs: 60_000,
      leanBrowser: true,
    });
    expect(headless.state.token).toBe(`refresh:${TEST_DEVICE_ID}:${refreshToken}`);
    expect(headless.state.bridgeSockets).toHaveLength(1);
    expect(headless.state.resubscribes).toBe(1);
    expect(webrtcMock.streams).toContainEqual({
      room: "room-1111-2222",
      targetId: "main",
      method: "panelCdp.hostProvider.open",
      args: ["provider-session", expect.stringMatching(/^headless-/)],
    });
    expect(webrtcMock.instances[0]?.closed).toBe(true);
  });

  it("redacts device refresh secrets from remote-host failures", async () => {
    const refreshToken = "Z".repeat(43);
    writeCredentials({ refreshToken });
    const headless = writeHeadlessHostMock(
      `failed with refresh:${TEST_DEVICE_ID}:${refreshToken} and Bearer abcdef1234567890`
    );
    vi.stubEnv("VIBESTUDIO_HEADLESS_HOST_ENTRY", headless.path);
    const { main } = await import("./client.js");
    await expect(main(["remote", "host"])).resolves.toBe(1);
    const output = vi
      .mocked(console.error)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(output).toContain("headless host failed to start");
    expect(output).not.toContain(refreshToken);
    expect(output).not.toContain("abcdef1234567890");
    expect(output).toContain("refr…ZZZZ");
    expect(output).toContain("Bearer abcd…7890");
    expect(panelFacadeMock.closes).toBe(1);
  });

  it("rejects the removed raw URL/token remote-host path", async () => {
    const { main } = await import("./client.js");
    await expect(
      main([
        "remote",
        "host",
        "--url",
        "https://server.example/_workspace/dev",
        "--token",
        "secret",
      ])
    ).resolves.toBe(2);
  });

  it("renders help for the new explicit invite command without legacy admin flags", async () => {
    const { main } = await import("./client.js");
    await expect(main(["remote", "invite-user", "--help"])).resolves.toBe(0);
    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(output).toContain("vibestudio remote invite-user");
    expect(output).toContain("--handle <value>");
    expect(output).toContain("--workspace <value>");
    expect(output).not.toContain("--admin-token");
    expect(output).not.toContain("--url <value>");
  });

  it("rejects retired command aliases", async () => {
    const { main } = await import("./client.js");
    await expect(main(["remote", "server"])).resolves.toBe(2);
    await expect(main(["remote", "headless-host"])).resolves.toBe(2);
    await expect(main(["remote", "setup-signaling"])).resolves.toBe(2);
    await expect(main(["terminal", "launch"])).resolves.toBe(2);
  });

  it("supports equals syntax and strict boolean flag values", async () => {
    writeCredentials();
    webrtcMock.handlers.set("hubControl.pairDevice", () => ({
      userId: "usr_alice",
      handle: "alice",
      workspace: "dev",
      pairing: pairingInvite(),
    }));
    const { main } = await import("./client.js");
    await expect(main(["remote", "pair-device", "--ttl-ms=60000", "--json=true"])).resolves.toBe(0);
    await expect(main(["remote", "status", "--json=banana"])).resolves.toBe(2);
  });

  it("validates invite TTL bounds before transport", async () => {
    writeCredentials();
    const { main } = await import("./client.js");
    await expect(main(["remote", "pair-device", "--ttl-ms", "soon", "--json"])).resolves.toBe(2);
    await expect(main(["remote", "pair-device", "--ttl-ms", "1000", "--json"])).resolves.toBe(2);
    expect(webrtcMock.calls).toHaveLength(0);
  });
});
