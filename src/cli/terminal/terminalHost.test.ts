import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcConnectionStatus, RpcEnvelope } from "@vibestudio/rpc";
import type { TerminalBrowserHost } from "@vibestudio/shell-core/terminal/terminalBrowserHost";
import type { AppPrincipalGrantResponse } from "@vibestudio/service-schemas/auth";
import type { PrincipalTransportOptions, RpcClient } from "../rpcClient.js";
import {
  TerminalConnectionState,
  loadTerminalBrowserModule,
  readLocalFile,
  runTerminalBrowser,
} from "./terminalHost.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function grant(buildKey = "build-1", token = "grant-1"): AppPrincipalGrantResponse {
  return {
    connectionGrant: token,
    expiresAt: Date.now() + 60_000,
    callerId: "app:apps/terminal-browser:dev_1",
    deviceId: "dev_1",
    serverId: "srv",
    serverBootId: "boot",
    workspaceId: "ws_system",
    app: {
      appId: "@workspace-apps/terminal-browser",
      source: "apps/terminal-browser",
      buildKey,
      effectiveVersion: "ev",
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

function fakeTransport() {
  const statusListeners = new Set<(status: RpcConnectionStatus) => void>();
  let status: RpcConnectionStatus = "connected";
  let closed = false;
  const transport = {
    send: vi.fn(async (_envelope: RpcEnvelope) => undefined),
    onMessage: vi.fn(() => () => undefined),
    status: () => status,
    onStatusChange: (handler: (status: RpcConnectionStatus) => void) => {
      statusListeners.add(handler);
      return () => statusListeners.delete(handler);
    },
    isClosed: () => closed,
    close: vi.fn(async () => {
      closed = true;
    }),
    setStatus(next: RpcConnectionStatus) {
      status = next;
      for (const listener of [...statusListeners]) listener(next);
    },
  };
  return transport;
}

function fakeTty() {
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: true,
    setRawMode: vi.fn(function (this: { isRaw: boolean }, mode: boolean) {
      this.isRaw = mode;
    }),
    pause: vi.fn(),
  });
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: 80,
    rows: 24,
    write: vi.fn(),
  });
  return {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream & { write: ReturnType<typeof vi.fn> },
  };
}

function harness(module: { run: (host: TerminalBrowserHost) => Promise<unknown> }) {
  const transport = fakeTransport();
  const workspaceTransport = fakeTransport();
  let transportOptions: PrincipalTransportOptions | null = null;
  let workspaceOptions: Omit<PrincipalTransportOptions, "selfId" | "getToken"> | null = null;
  const device = {
    openPrincipalTransport: vi.fn(async (options: PrincipalTransportOptions) => {
      transportOptions = options;
      await options.getToken();
      return transport;
    }),
    call: vi.fn(async () => grant()),
  };
  const workspaceDevice = {
    openShellTransport: vi.fn(
      async (options: Omit<PrincipalTransportOptions, "selfId" | "getToken">) => {
        workspaceOptions = options;
        return workspaceTransport;
      }
    ),
  };
  const tty = fakeTty();
  const run = () =>
    runTerminalBrowser({
      device: device as unknown as RpcClient,
      workspaceDevice: workspaceDevice as unknown as RpcClient,
      grant: grant(),
      module: module as never,
      system: { id: "ws_system", name: "system" },
      workspace: { id: "ws_personal", name: "personal" },
      server: { kind: "owned", endpoint: "http://127.0.0.1:4000", logFile: "/tmp/server.log" },
      listWorkspaces: async () => [{ id: "ws_system", name: "system" }],
      openExternal: vi.fn(async () => undefined),
      stdin: tty.stdin,
      stdout: tty.stdout,
    });
  return {
    transport,
    workspaceTransport,
    device,
    tty,
    run,
    options: () => transportOptions!,
    workspaceOptions: () => workspaceOptions!,
  };
}

describe("TerminalConnectionState", () => {
  it("follows transport recovery and keeps an authoritative loss", () => {
    const state = new TerminalConnectionState("http://127.0.0.1:4000");
    const seen: string[] = [];
    state.subscribe((next) => seen.push(next.phase));
    state.transportStatus("app", "connecting");
    expect(state.current()).toMatchObject({ phase: "reconnecting" });
    state.transportStatus("workspace", "connecting");
    state.transportStatus("app", "connected");
    // Connected again only once every connection is.
    expect(state.current()).toMatchObject({ phase: "reconnecting" });
    state.transportStatus("workspace", "connected");
    state.lose("the local server exited (code 1)");
    state.transportStatus("app", "connected");
    expect(state.current()).toEqual({ phase: "lost", cause: "the local server exited (code 1)" });
    expect(seen).toEqual(["reconnecting", "connected", "lost"]);
  });
});

describe("runTerminalBrowser", () => {
  it("hands the browser an app-principal host for System and a device session for the shown workspace", async () => {
    let received: TerminalBrowserHost | null = null;
    const { run, device, transport, workspaceTransport, options } = harness({
      run: async (host) => {
        received = host;
        return { kind: "quit" };
      },
    });
    await expect(run()).resolves.toEqual({ kind: "exit", exit: { kind: "quit" } });
    const host = received as unknown as TerminalBrowserHost;
    expect(host.contractVersion).toBe(2);
    expect(host.appId).toBe("app:apps/terminal-browser:dev_1");
    expect(host.rpc.selfId).toBe("app:apps/terminal-browser:dev_1");
    expect(host.system).toEqual({ id: "ws_system", name: "system" });
    expect(host.workspace).toEqual({ id: "ws_personal", name: "personal" });
    expect(host.workspaceRpc.selfId).toBe("shell:dev_1");
    expect(host.connectionState()).toEqual({ phase: "connected" });
    expect(await host.listWorkspaces()).toEqual([{ id: "ws_system", name: "system" }]);
    expect(options().selfId).toBe("app:apps/terminal-browser:dev_1");
    // The first authentication redeems the grant the launch already obtained.
    expect(device.call).not.toHaveBeenCalled();
    expect(transport.close).toHaveBeenCalled();
    expect(workspaceTransport.close).toHaveBeenCalled();
  });

  it("re-grants on reconnect and reports an app update as a reload", async () => {
    const { run, device, options } = harness({
      run: async (host) => {
        device.call.mockResolvedValueOnce(grant("build-1", "grant-2"));
        await expect(options().getToken()).resolves.toBe("grant-2");
        device.call.mockResolvedValueOnce(grant("build-2", "grant-3"));
        await expect(options().getToken()).rejects.toThrow("updated");
        expect(host.connectionState()).toMatchObject({ phase: "lost" });
        return { kind: "connection-lost", cause: "updated" };
      },
    });
    await expect(run()).resolves.toEqual({ kind: "app-updated" });
    expect(device.call).toHaveBeenCalledWith("auth.grantAppPrincipal", [
      { principal: "terminal-app", source: "apps/terminal-browser" },
    ]);
  });

  it("restores the terminal and closes the session when the browser throws", async () => {
    const { run, tty, transport } = harness({
      run: async () => {
        throw new Error("browser crashed");
      },
    });
    await expect(run()).rejects.toThrow("browser crashed");
    expect(tty.stdout.write).toHaveBeenCalledWith(expect.stringContaining("\x1b[?1049l"));
    expect(tty.stdin.isRaw).toBe(false);
    expect(transport.close).toHaveBeenCalled();
  });

  it("reports reconnecting while the workspace session recovers", async () => {
    const { run, workspaceTransport, workspaceOptions } = harness({
      run: async (host) => {
        expect(workspaceOptions().onTerminalClose).toBeDefined();
        workspaceTransport.setStatus("connecting");
        expect(host.connectionState()).toMatchObject({ phase: "reconnecting" });
        workspaceTransport.setStatus("connected");
        expect(host.connectionState()).toEqual({ phase: "connected" });
        return { kind: "quit" };
      },
    });
    await expect(run()).resolves.toEqual({ kind: "exit", exit: { kind: "quit" } });
  });

  it("reports the server's terminal close as a lost connection", async () => {
    const { run, options } = harness({
      run: async (host) => {
        options().onTerminalClose?.(new Error("credential revoked"));
        return {
          kind: "connection-lost",
          cause: (host.connectionState() as { cause: string }).cause,
        };
      },
    });
    await expect(run()).resolves.toEqual({
      kind: "exit",
      exit: { kind: "connection-lost", cause: "credential revoked" },
    });
  });
});

describe("loadTerminalBrowserModule", () => {
  it("imports the primary module fetched over the device connection", async () => {
    const device = {
      stream: vi.fn(
        async () =>
          new Response("export async function run() { return { kind: 'quit' }; }", { status: 200 })
      ),
    };
    const module = await loadTerminalBrowserModule(device as never, grant().app);
    await expect(module.run({} as never)).resolves.toEqual({ kind: "quit" });
    expect(device.stream).toHaveBeenCalledWith("main", "gateway.fetch", [
      { path: "/_a/build-1/index.mjs", method: "GET" },
    ]);
  });

  it("rejects a module without run(host)", async () => {
    const device = { stream: vi.fn(async () => new Response("export const x = 1;")) };
    await expect(loadTerminalBrowserModule(device as never, grant().app)).rejects.toThrow(
      "does not export run(host)"
    );
  });
});

describe("readLocalFile", () => {
  it("reads a chosen file with its name and media type", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-read-local-"));
    roots.push(root);
    const file = path.join(root, "notes.md");
    fs.writeFileSync(file, "# hi");
    await expect(readLocalFile(file)).resolves.toEqual({
      name: "notes.md",
      bytes: new Uint8Array(Buffer.from("# hi")),
      mimeType: "text/markdown",
    });
    await expect(readLocalFile(root)).rejects.toThrow("Not a regular file");
    await expect(readLocalFile(path.join(root, "missing"))).rejects.toThrow("No such file");
  });
});
