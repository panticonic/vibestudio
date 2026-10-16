import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaunchedClient } from "@vibestudio/client-host-core";
import type { TerminalClientExit } from "@vibestudio/shell-core/terminal/terminalClientHost";
import type { ClientListing } from "@vibestudio/workspace-contracts/clients";
import type { DeviceCredential, RpcClient } from "../../src/cli/rpcClient.js";
import type { RemoteWorkspaceEntry, RemoteWorkspaceSelector } from "../../src/cli/remoteClient.js";
import { createLaunchProgress } from "./launchProgress.js";
import { TerminalHostState } from "./hostState.js";
import { isBuiltInCommand } from "./clientShims.js";
import { runTerminalSessions, type TerminalSessionDependencies } from "./terminalSessions.js";

const credentials = {
  schemaVersion: 6,
  phase: "workspace",
  kind: "device",
  transport: "local",
  url: "http://127.0.0.1:4000/_r/ws/personal",
  workspaceId: "ws_personal",
  workspaceName: "personal",
  serverId: `srv_${"S".repeat(24)}`,
  deviceId: `dev_${"D".repeat(24)}`,
  refreshToken: "R".repeat(43),
  pairedAt: 1,
} as DeviceCredential;

function routed(workspaceId: string, workspaceName: string): DeviceCredential {
  return {
    ...credentials,
    url: `http://127.0.0.1:4000/_r/ws/${workspaceName}`,
    workspaceId,
    workspaceName,
  } as DeviceCredential;
}

function entry(
  workspaceId: string,
  name: string,
  extra: Partial<RemoteWorkspaceEntry> = {}
): RemoteWorkspaceEntry {
  return { workspaceId, name, lastOpened: 0, running: true, pendingApprovalCount: 0, ...extra };
}

function launched(buildKey = "build-1"): LaunchedClient {
  return {
    client: {
      source: "clients/terminal-browser",
      id: "browser",
      runtime: "terminal",
      title: "Vibestudio Terminal",
      buildKey,
      executionDigest: "d".repeat(64),
      effectiveVersion: "1",
      hostAbi: "terminal-host-1",
      artifacts: [],
      grantedCapabilities: [],
      deniedOptional: [],
    },
    artifacts: [
      {
        path: "index.mjs",
        role: "primary",
        contentType: "text/javascript",
        integrity: `sha256-${"a".repeat(64)}`,
        handle: "/cache/index.mjs",
      },
    ],
    grant: {
      connectionGrant: "grant-token",
      expiresAt: 1_000_000,
      principalId: `client:browser:terminal:${credentials.deviceId}`,
      deviceId: credentials.deviceId,
      serverId: credentials.serverId,
      serverBootId: `boot_${"B".repeat(24)}`,
      workspaceId: "ws_system",
    },
  };
}

type RunResult = Awaited<ReturnType<TerminalSessionDependencies["runClient"]>>;

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function harness(results: RunResult[], listings: ClientListing[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-sessions-test-"));
  scratch.push(dir);
  const hostState = new TerminalHostState(path.join(dir, "host.json"));
  const devices: Array<{
    credentials: DeviceCredential;
    release: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    call: ReturnType<typeof vi.fn>;
    workspaces: Array<{ credentials: DeviceCredential; close: ReturnType<typeof vi.fn> }>;
  }> = [];
  const watches: Array<{
    listeners: Map<string, Array<() => void>>;
    subscribeAll: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const routes: RemoteWorkspaceSelector[] = [];
  const progress: string[] = [];
  const cache = { retain: vi.fn(async () => []) };
  const deps: TerminalSessionDependencies = {
    route: vi.fn(async (_creds, selector) => {
      routes.push(selector);
      if (typeof selector === "string") return routed(`ws_${selector}`, selector);
      return "workspaceId" in selector
        ? routed(selector.workspaceId, selector.workspaceId.replace(/^ws_/, ""))
        : routed(`ws_${selector.privateRole}`, selector.privateRole);
    }),
    listWorkspaces: vi.fn(async () => [
      entry("ws_system", "system-ws_S1", { privateRole: "system" }),
      entry("ws_personal", "personal-ws_P1", { privateRole: "personal" }),
      entry("ws_lab", "lab", { displayName: "Research lab" }),
      entry("ws_other", "other"),
    ]),
    createDevice: vi.fn((device: DeviceCredential) => {
      const release = vi.fn(async () => undefined);
      const close = vi.fn(async () => undefined);
      const call = vi.fn(async () => listings);
      const workspaces: Array<{ credentials: DeviceCredential; close: ReturnType<typeof vi.fn> }> =
        [];
      devices.push({ credentials: device, release, close, call, workspaces });
      return {
        retainConnection: () => release,
        close,
        call,
        openControlConnection: vi.fn(),
        openWorkspaceConnection: vi.fn(async (workspace: DeviceCredential) => {
          const entry = { credentials: workspace, close: vi.fn(async () => undefined) };
          workspaces.push(entry);
          return { close: entry.close } as unknown as RpcClient;
        }),
      } as unknown as RpcClient;
    }),
    createDelivery: vi.fn(
      () =>
        ({
          launcher: {},
          cache,
          grants: { acquire: vi.fn() },
          descriptor: { host: "terminal", hostVersion: "1", runtimes: {}, capabilities: [] },
        }) as never
    ),
    runGate: vi.fn(async () => ({
      status: "ready" as const,
      launched: launched(),
      approvalsResolved: 0,
    })),
    importModule: vi.fn(async () => ({ run: vi.fn() })),
    runClient: vi.fn(async () => {
      const next = results.shift();
      if (!next) throw new Error("no more scripted client results");
      return next;
    }),
    openEvents: vi.fn(async () => {
      const listeners = new Map<string, Array<() => void>>();
      const watch = {
        listeners,
        subscribeAll: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      };
      watches.push(watch);
      return {
        events: {
          on: (name: string, listener: () => void) => {
            listeners.set(name, [...(listeners.get(name) ?? []), listener]);
            return () => undefined;
          },
          subscribeAll: watch.subscribeAll,
        } as never,
        close: watch.close,
      };
    }),
    openExternal: vi.fn(async () => undefined),
  };
  return { deps, devices, routes, progress, cache, hostState, watches, dir };
}

const options = (h: ReturnType<typeof harness>, extra: Record<string, unknown> = {}) => ({
  credentials,
  select: { default: true as const },
  server: { kind: "owned" as const, endpoint: "http://127.0.0.1:4000", logFile: "/tmp/x.log" },
  yes: false,
  stdin: process.stdin,
  stdout: process.stdout,
  progress: createLaunchProgress({ write: (line) => h.progress.push(line) }),
  hostVersion: "1.2.3",
  hostState: h.hostState,
  shims: {
    state: h.hostState,
    isBuiltIn: isBuiltInCommand(["terminal", "open", "clients"]),
    directory: path.join(h.dir, "bin"),
  },
  dependencies: h.deps,
  ...extra,
});

const quit: RunResult = { kind: "exit", exit: { kind: "quit" } };

function listing(overrides: Partial<ClientListing> = {}): ClientListing {
  return {
    source: "clients/chat-terminal",
    id: "chat",
    runtime: "terminal",
    title: "Chat",
    hostAbi: "terminal-host-1",
    status: "available",
    isDefault: false,
    trusted: false,
    intents: [{ name: "open", kind: "foreground" }],
    terminalCommand: "chat",
    activeBuildKey: "b",
    canRollback: false,
    ...overrides,
  };
}

describe("runTerminalSessions", () => {
  it("attempts every connection cleanup and retains operation and cleanup failures", async () => {
    const h = harness([quit]);
    const operation = new Error("client failed");
    const workspace = new Error("workspace close failed");
    const device = new Error("device close failed");
    vi.mocked(h.deps.runClient).mockImplementation(async () => {
      h.devices[0]!.workspaces[0]!.close.mockRejectedValue(workspace);
      h.devices[0]!.close.mockRejectedValue(device);
      throw operation;
    });
    await expect(runTerminalSessions(options(h))).rejects.toMatchObject({
      errors: [operation, expect.objectContaining({ errors: [workspace, device] })],
    });
    expect(h.devices[0]!.release).toHaveBeenCalled();
    expect(h.devices[0]!.close).toHaveBeenCalled();
    expect(h.watches[0]!.close).toHaveBeenCalled();
  });

  it("rejects quit when a workspace connection did not retire", async () => {
    const h = harness([quit]);
    const failure = new Error("workspace close failed");
    vi.mocked(h.deps.runClient).mockImplementation(async () => {
      h.devices[0]!.workspaces[0]!.close.mockRejectedValue(failure);
      return quit;
    });
    await expect(runTerminalSessions(options(h))).rejects.toBe(failure);
    expect(h.devices[0]!.close).toHaveBeenCalled();
  });

  it("launches the default client from System, shows Personal by default, and returns its quit", async () => {
    const h = harness([quit]);
    await expect(runTerminalSessions(options(h))).resolves.toEqual({ kind: "quit" });
    expect(h.routes).toEqual([{ privateRole: "system" }, { privateRole: "personal" }]);
    expect(vi.mocked(h.deps.runGate).mock.calls[0]![1]).toMatchObject({
      select: { default: true },
    });
    expect(h.deps.importModule).toHaveBeenCalledWith(launched());
    // Only the running build's artifacts stay cached.
    expect(h.cache.retain).toHaveBeenCalledWith(
      new Map([["build-1", [`sha256-${"a".repeat(64)}`]]])
    );
    // The private pair is shown by role, never by its internal name.
    expect(vi.mocked(h.deps.runClient).mock.calls[0]![0]).toMatchObject({
      launched: launched(),
      system: { id: "ws_system", name: "System" },
      workspace: { id: "ws_personal", name: "Personal" },
      server: { kind: "owned", logFile: "/tmp/x.log" },
    });
    // The launch, download, grant and principal session use the System
    // connection; the shown workspace gets its own from the same device.
    expect(h.devices).toHaveLength(1);
    expect(h.devices[0]!.credentials.workspaceId).toBe("ws_system");
    expect(h.devices[0]!.workspaces.map((e) => e.credentials.workspaceId)).toEqual(["ws_personal"]);
    expect(h.devices[0]!.workspaces[0]!.close).toHaveBeenCalled();
    expect(h.devices[0]!.release).toHaveBeenCalled();
    expect(h.devices[0]!.close).toHaveBeenCalled();
    expect(h.progress).toContain("Preparing the client in System…");
    expect(h.progress).toContain("Loading Vibestudio Terminal…");
    expect(h.progress.join("\n")).not.toMatch(/-ws_/);
    await expect(vi.mocked(h.deps.runClient).mock.calls[0]![0].listWorkspaces()).resolves.toEqual([
      { id: "ws_system", name: "System" },
      { id: "ws_personal", name: "Personal" },
      { id: "ws_lab", name: "Research lab" },
      { id: "ws_other", name: "other" },
    ]);
  });

  it("launches the client the person named, with its intent", async () => {
    const h = harness([quit]);
    const select = { id: "chat", intent: "open-conversation", params: { channel: "c1" } };
    await runTerminalSessions(options(h, { select }));
    expect(vi.mocked(h.deps.runGate).mock.calls[0]![1]).toMatchObject({ select });
  });

  it("shows System through the System connection itself", async () => {
    const h = harness([quit]);
    await runTerminalSessions(options(h, { workspace: { privateRole: "system" } }));
    const call = vi.mocked(h.deps.runClient).mock.calls[0]![0];
    expect(call.workspaceDevice).toBe(call.device);
    // Personal is reached only so the gate asks about it too, then closed.
    expect(h.devices[0]!.workspaces.map((e) => e.credentials.workspaceId)).toEqual(["ws_personal"]);
    expect(h.devices[0]!.workspaces[0]!.close).toHaveBeenCalled();
  });

  it("asks about Personal in the same launch as System, over the connection that then shows it", async () => {
    const h = harness([quit]);
    await runTerminalSessions(options(h));
    expect(h.devices[0]!.workspaces).toHaveLength(1);
    const companions = vi.mocked(h.deps.createDelivery).mock.calls[0]![0].companions;
    expect(companions).toHaveLength(1);
    expect(vi.mocked(h.deps.runClient).mock.calls[0]![0].workspaceDevice).toBe(companions![0]);
    // A waiting launch listens to both workspaces' events.
    expect(h.watches).toHaveLength(2);
    for (const watch of h.watches) {
      expect(watch.subscribeAll).toHaveBeenCalledWith(
        expect.arrayContaining(["clients:changed", "supervision:changed"])
      );
    }
  });

  it("shows the chosen workspace on switch-workspace, still running the client from System", async () => {
    const switched: TerminalClientExit = { kind: "switch-workspace", workspaceId: "ws_other" };
    const h = harness([{ kind: "exit", exit: switched }, quit]);
    await runTerminalSessions(options(h));
    expect(h.routes).toEqual([
      { privateRole: "system" },
      { privateRole: "personal" },
      { privateRole: "system" },
      { workspaceId: "ws_other" },
      { privateRole: "personal" },
    ]);
    expect(h.deps.runGate).toHaveBeenCalledTimes(2);
    expect(vi.mocked(h.deps.runClient).mock.calls[1]![0]).toMatchObject({
      system: { id: "ws_system", name: "System" },
      workspace: { id: "ws_other", name: "other" },
    });
  });

  it("launches again after a restart, as a plain open of the same client", async () => {
    const h = harness([
      { kind: "restart" },
      { kind: "exit", exit: { kind: "connection-lost", cause: "server gone" } },
    ]);
    const select = { id: "chat", intent: "open-conversation", params: { channel: "c1" } };
    await expect(runTerminalSessions(options(h, { select }))).resolves.toEqual({
      kind: "connection-lost",
      cause: "server gone",
    });
    expect(h.deps.importModule).toHaveBeenCalledTimes(2);
    expect(vi.mocked(h.deps.runGate).mock.calls[1]![1]).toMatchObject({ select: { id: "chat" } });
    expect(h.progress).toContain("The client was updated; loading the new version…");
  });

  it("exits with a clear message when trust is withdrawn and the client cannot run without it", async () => {
    const h = harness([]);
    vi.mocked(h.deps.runGate)
      .mockResolvedValueOnce({ status: "ready", launched: launched(), approvalsResolved: 0 })
      .mockResolvedValueOnce({
        status: "unavailable",
        reason: "needs device-session, which is not granted",
        missing: { capabilities: ["device-session"] },
        approvalsResolved: 0,
      });
    // The result carries the client's title from the launch.
    vi.mocked(h.deps.runClient).mockResolvedValueOnce({ kind: "trust-revoked" });
    await expect(runTerminalSessions(options(h))).rejects.toThrow(
      "Vibestudio no longer trusts Vibestudio Terminal to act as this device"
    );
    expect(h.deps.runClient).toHaveBeenCalledTimes(1);
  });

  it("launches again without the capability when trust is withdrawn only for an optional power", async () => {
    const h = harness([{ kind: "trust-revoked" } as RunResult, quit]);
    await expect(runTerminalSessions(options(h))).resolves.toEqual({ kind: "quit" });
    expect(h.deps.runGate).toHaveBeenCalledTimes(2);
    expect(h.deps.runClient).toHaveBeenCalledTimes(2);
  });

  it("follows clients:changed while the client runs: the command table and shims reconcile", async () => {
    const h = harness([], [listing()]);
    vi.mocked(h.deps.runClient).mockImplementation(async () => {
      const systemWatch = h.watches[0]!;
      expect(h.hostState.commandClient("chat")).toBe("chat");
      h.devices[0]!.call.mockResolvedValue([listing({ terminalCommand: "talk" })]);
      for (const listener of systemWatch.listeners.get("clients:changed") ?? []) listener();
      await vi.waitFor(() => expect(h.hostState.commandClient("talk")).toBe("chat"));
      return quit;
    });
    await runTerminalSessions(options(h));
    expect(h.hostState.commandClient("chat")).toBeNull();
  });

  it("uses an explicitly requested workspace", async () => {
    const h = harness([quit]);
    await runTerminalSessions(options(h, { workspace: "lab" }));
    expect(h.routes).toEqual([{ privateRole: "system" }, "lab", { privateRole: "personal" }]);
    expect(vi.mocked(h.deps.runClient).mock.calls[0]![0].workspace).toEqual({
      id: "ws_lab",
      name: "Research lab",
    });
  });

  it("reports a declined launch gate without starting the client", async () => {
    const h = harness([]);
    vi.mocked(h.deps.runGate).mockResolvedValueOnce({ status: "denied", approvalsResolved: 0 });
    await expect(runTerminalSessions(options(h))).rejects.toThrow("Startup was declined");
    expect(h.deps.importModule).not.toHaveBeenCalled();
    expect(h.deps.runClient).not.toHaveBeenCalled();
    expect(h.devices[0]!.close).toHaveBeenCalled();
  });

  it("names what a client needs when this terminal cannot run it", async () => {
    const h = harness([]);
    vi.mocked(h.deps.runGate).mockResolvedValueOnce({
      status: "unavailable",
      reason: "chat needs a capability this host lacks",
      missing: { capabilities: ["camera"] },
      approvalsResolved: 0,
    });
    await expect(runTerminalSessions(options(h))).rejects.toThrow(
      /cannot run in this terminal: chat needs a capability this host lacks \(needs capability camera\)/
    );
    expect(h.deps.importModule).not.toHaveBeenCalled();
  });
});
