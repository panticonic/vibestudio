import { createLaunchProgress } from "./launchProgress.js";
import { describe, expect, it, vi } from "vitest";
import type { TerminalBrowserExit } from "@vibestudio/shell-core/terminal/terminalBrowserHost";
import type { AppPrincipalGrantResponse } from "@vibestudio/service-schemas/auth";
import type { DeviceCredential, RpcClient } from "../rpcClient.js";
import type { RemoteWorkspaceEntry, RemoteWorkspaceSelector } from "../remoteClient.js";
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

function grant(buildKey = "build-1"): AppPrincipalGrantResponse {
  return {
    connectionGrant: "grant-token",
    expiresAt: Date.now() + 60_000,
    callerId: "app:apps/terminal-browser:dev",
    deviceId: credentials.deviceId,
    serverId: credentials.serverId,
    serverBootId: `boot_${"B".repeat(24)}`,
    workspaceId: "ws_system",
    app: {
      appId: "@workspace-apps/terminal-browser",
      source: "apps/terminal-browser",
      buildKey,
      effectiveVersion: "ev-1",
      artifacts: [
        {
          path: "index.mjs",
          role: "primary",
          contentType: "text/javascript",
          route: `/_a/${buildKey}/index.mjs`,
        },
      ],
    },
  };
}

function harness(results: Array<Awaited<ReturnType<TerminalSessionDependencies["runBrowser"]>>>) {
  const devices: Array<{
    credentials: DeviceCredential;
    release: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    workspaces: Array<{ credentials: DeviceCredential; close: ReturnType<typeof vi.fn> }>;
  }> = [];
  const routes: RemoteWorkspaceSelector[] = [];
  const progress: string[] = [];
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
      const workspaces: Array<{ credentials: DeviceCredential; close: ReturnType<typeof vi.fn> }> =
        [];
      devices.push({ credentials: device, release, close, workspaces });
      return {
        retainConnection: () => release,
        close,
        openControlConnection: vi.fn(),
        openWorkspaceConnection: vi.fn(async (workspace: DeviceCredential) => {
          const entry = { credentials: workspace, close: vi.fn(async () => undefined) };
          workspaces.push(entry);
          return { close: entry.close } as unknown as RpcClient;
        }),
      } as unknown as RpcClient;
    }),
    runGate: vi.fn(async () => ({
      target: "terminal" as const,
      status: "ready" as const,
      approvalsResolved: 0,
      launch: {
        status: "ready" as const,
        target: "terminal" as const,
        entity: { source: "apps/terminal-browser" } as never,
      },
    })),
    requestGrant: vi.fn(async () => grant()),
    loadModule: vi.fn(async () => ({ run: vi.fn() })),
    runBrowser: vi.fn(async () => {
      const next = results.shift();
      if (!next) throw new Error("no more scripted browser results");
      return next;
    }),
    openExternal: vi.fn(async () => undefined),
  };
  return { deps, devices, routes, progress };
}

const options = (deps: Partial<TerminalSessionDependencies>, progress: string[]) => ({
  credentials,
  server: { kind: "owned" as const, endpoint: "http://127.0.0.1:4000", logFile: "/tmp/x.log" },
  yes: false,
  stdin: process.stdin,
  stdout: process.stdout,
  progress: createLaunchProgress({ write: (line) => progress.push(line) }),
  dependencies: deps,
});

describe("runTerminalSessions", () => {
  it("attempts every connection cleanup and retains operation and cleanup failures", async () => {
    const { deps, devices, progress } = harness([{ kind: "exit", exit: { kind: "quit" } }]);
    const operation = new Error("browser failed");
    const workspace = new Error("workspace close failed");
    const device = new Error("device close failed");
    vi.mocked(deps.runBrowser).mockImplementation(async () => {
      devices[0]!.workspaces[0]!.close.mockRejectedValue(workspace);
      devices[0]!.close.mockRejectedValue(device);
      throw operation;
    });
    await expect(runTerminalSessions(options(deps, progress))).rejects.toMatchObject({
      errors: [operation, expect.objectContaining({ errors: [workspace, device] })],
    });
    expect(devices[0]!.release).toHaveBeenCalled();
    expect(devices[0]!.close).toHaveBeenCalled();
  });

  it("rejects quit when a workspace connection did not retire", async () => {
    const { deps, devices, progress } = harness([{ kind: "exit", exit: { kind: "quit" } }]);
    const failure = new Error("workspace close failed");
    vi.mocked(deps.runBrowser).mockImplementation(async () => {
      devices[0]!.workspaces[0]!.close.mockRejectedValue(failure);
      return { kind: "exit", exit: { kind: "quit" } };
    });
    await expect(runTerminalSessions(options(deps, progress))).rejects.toBe(failure);
    expect(devices[0]!.close).toHaveBeenCalled();
  });
  it("runs the browser from System, shows the Personal workspace by default, and returns its quit", async () => {
    const { deps, devices, routes, progress } = harness([{ kind: "exit", exit: { kind: "quit" } }]);
    await expect(runTerminalSessions(options(deps, progress))).resolves.toEqual({ kind: "quit" });
    expect(routes).toEqual([{ privateRole: "system" }, { privateRole: "personal" }]);
    expect(deps.requestGrant).toHaveBeenCalledWith(expect.anything(), "apps/terminal-browser");
    expect(deps.loadModule).toHaveBeenCalledWith(expect.anything(), grant().app);
    // The private pair is shown by role, never by its internal name.
    expect(vi.mocked(deps.runBrowser).mock.calls[0]![0]).toMatchObject({
      system: { id: "ws_system", name: "System" },
      workspace: { id: "ws_personal", name: "Personal" },
      server: { kind: "owned", logFile: "/tmp/x.log" },
    });
    // The gate, grant and module use the System connection; the shown
    // workspace gets its own connection from the same device.
    expect(devices).toHaveLength(1);
    expect(devices[0]!.credentials.workspaceId).toBe("ws_system");
    expect(devices[0]!.workspaces.map((entry) => entry.credentials.workspaceId)).toEqual([
      "ws_personal",
    ]);
    // Every connection is released and closed after the browser exits.
    expect(devices[0]!.workspaces[0]!.close).toHaveBeenCalled();
    expect(devices[0]!.release).toHaveBeenCalled();
    expect(devices[0]!.close).toHaveBeenCalled();
    expect(progress).toContain("Preparing the terminal browser in System…");
    expect(progress).toContain("Loading the terminal browser…");
    expect(progress.join("\n")).not.toMatch(/-ws_/);
    await expect(vi.mocked(deps.runBrowser).mock.calls[0]![0].listWorkspaces()).resolves.toEqual([
      { id: "ws_system", name: "System" },
      { id: "ws_personal", name: "Personal" },
      { id: "ws_lab", name: "Research lab" },
      { id: "ws_other", name: "other" },
    ]);
  });

  it("shows System through the System connection itself", async () => {
    const { deps, devices, progress } = harness([{ kind: "exit", exit: { kind: "quit" } }]);
    await runTerminalSessions({ ...options(deps, progress), workspace: { privateRole: "system" } });
    expect(devices[0]!.workspaces).toEqual([]);
    const call = vi.mocked(deps.runBrowser).mock.calls[0]![0];
    expect(call.workspaceDevice).toBe(call.device);
  });

  it("shows the chosen workspace on switch-workspace, still running the browser from System", async () => {
    const switched: TerminalBrowserExit = { kind: "switch-workspace", workspaceId: "ws_other" };
    const { deps, routes, progress } = harness([
      { kind: "exit", exit: switched },
      { kind: "exit", exit: { kind: "quit" } },
    ]);
    await runTerminalSessions(options(deps, progress));
    expect(routes).toEqual([
      { privateRole: "system" },
      { privateRole: "personal" },
      { privateRole: "system" },
      { workspaceId: "ws_other" },
    ]);
    expect(deps.runGate).toHaveBeenCalledTimes(2);
    expect(vi.mocked(deps.runBrowser).mock.calls[1]![0]).toMatchObject({
      system: { id: "ws_system", name: "System" },
      workspace: { id: "ws_other", name: "other" },
    });
  });

  it("reloads the module after the app is updated under a running browser", async () => {
    const { deps, progress } = harness([
      { kind: "app-updated" },
      { kind: "exit", exit: { kind: "connection-lost", cause: "server gone" } },
    ]);
    await expect(runTerminalSessions(options(deps, progress))).resolves.toEqual({
      kind: "connection-lost",
      cause: "server gone",
    });
    expect(deps.loadModule).toHaveBeenCalledTimes(2);
    expect(progress).toContain("The terminal app was updated; loading the new version…");
  });

  it("uses an explicitly requested workspace", async () => {
    const { deps, routes, progress } = harness([{ kind: "exit", exit: { kind: "quit" } }]);
    await runTerminalSessions({ ...options(deps, progress), workspace: "lab" });
    expect(routes).toEqual([{ privateRole: "system" }, "lab"]);
    expect(vi.mocked(deps.runBrowser).mock.calls[0]![0].workspace).toEqual({
      id: "ws_lab",
      name: "Research lab",
    });
  });

  it("reports a declined launch gate without starting the browser", async () => {
    const { deps, devices, progress } = harness([]);
    vi.mocked(deps.runGate).mockResolvedValueOnce({
      target: "terminal",
      status: "denied",
      approvalsResolved: 0,
    });
    await expect(runTerminalSessions(options(deps, progress))).rejects.toThrow(
      "Terminal startup was declined"
    );
    expect(deps.requestGrant).not.toHaveBeenCalled();
    expect(deps.runBrowser).not.toHaveBeenCalled();
    expect(devices[0]!.close).toHaveBeenCalled();
  });

  it("explains a workspace without a terminal app", async () => {
    const { deps, progress } = harness([]);
    vi.mocked(deps.runGate).mockResolvedValueOnce({
      target: "terminal",
      status: "unavailable",
      approvalsResolved: 0,
      launch: {
        status: "unavailable",
        target: "terminal",
        reason: "No terminal app is configured or selected",
      },
    });
    await expect(runTerminalSessions(options(deps, progress))).rejects.toThrow(
      /terminal browser is not available in System: No terminal app is configured.*hostTargets\.terminal\.app/
    );
  });
});
