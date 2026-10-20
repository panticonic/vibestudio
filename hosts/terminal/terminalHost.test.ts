import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcConnectionStatus, RpcEnvelope } from "@vibestudio/rpc";
import type { LaunchedClient } from "@vibestudio/client-host-core";
import type { SupervisionChange } from "@vibestudio/shared/events";
import type {
  TerminalClientHost,
  TerminalClientUpdate,
} from "@vibestudio/shell-core/terminal/terminalClientHost";
import type { ClientCapability } from "@vibestudio/workspace-contracts/clients";
import type { PrincipalTransportOptions, RpcClient } from "../../src/cli/rpcClient.js";
import {
  TerminalConnectionState,
  TRUST_REVOKED_REASON,
  importClientModule,
  runTerminalClient,
} from "./terminalHost.js";

const DIGEST = "d".repeat(64);
const PRINCIPAL = "client:browser:terminal:dev_1";

function launched(
  options: { buildKey?: string; token?: string; granted?: ClientCapability[] } = {}
): LaunchedClient {
  const buildKey = options.buildKey ?? "build-1";
  return {
    client: {
      source: "clients/terminal-browser",
      id: "browser",
      runtime: "terminal",
      title: "Vibestudio Terminal",
      buildKey,
      executionDigest: DIGEST,
      effectiveVersion: "1",
      hostAbi: "terminal-host-1",
      artifacts: [],
      grantedCapabilities: options.granted ?? [],
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
      credential: options.token ?? "grant-1",
      principalId: PRINCIPAL,
      deviceId: "dev_1",
      serverId: "srv",
      serverBootId: "boot",
    },
  };
}

function supervisionChange(buildKey: string): SupervisionChange {
  return {
    identity: { kind: "client", entityId: "clients/terminal-browser" },
    source: "clients/terminal-browser",
    status: "running",
    lastError: null,
    artifact: { effectiveVersion: "2", buildKey, executionDigest: null },
    canRollback: true,
    change: "adopted",
    previousBuildKey: "build-1",
    previousEffectiveVersion: "1",
    client: { id: "browser", runtime: "terminal", grantedCapabilities: [] },
  } as SupervisionChange;
}

function fakeEvents() {
  const listeners = new Set<(change: SupervisionChange) => void>();
  return {
    subscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => undefined),
    on: vi.fn((_event: "supervision:changed", listener: (change: SupervisionChange) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    emit(change: SupervisionChange) {
      for (const listener of [...listeners]) listener(change);
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

function harness(
  module: { run: (host: TerminalClientHost) => Promise<unknown> },
  options: { granted?: ClientCapability[]; development?: boolean } = {}
) {
  const transport = fakeTransport();
  const workspaceTransport = fakeTransport();
  let transportOptions: PrincipalTransportOptions | null = null;
  let workspaceOptions: Omit<PrincipalTransportOptions, "selfId" | "getToken"> | null = null;
  const device = {
    openPrincipalTransport: vi.fn(async (opened: PrincipalTransportOptions) => {
      transportOptions = opened;
      await opened.getToken();
      return transport;
    }),
  };
  const workspaceDevice = {
    openShellTransport: vi.fn(
      async (opened: Omit<PrincipalTransportOptions, "selfId" | "getToken">) => {
        workspaceOptions = opened;
        return workspaceTransport;
      }
    ),
  };
  const events = fakeEvents();
  const state = { get: vi.fn(async () => ({ saved: true })), set: vi.fn(async () => undefined) };
  const tty = fakeTty();
  const run = () =>
    runTerminalClient({
      device: device as unknown as RpcClient,
      workspaceDevice: workspaceDevice as unknown as RpcClient,
      launched: launched(options.granted ? { granted: options.granted } : {}),
      module: module as never,
      system: { id: "ws_system", name: "system" },
      workspace: { id: "ws_personal", name: "personal" },
      server: { kind: "owned", endpoint: "http://127.0.0.1:4000", logFile: "/tmp/server.log" },
      events,
      hostState: { isDevelopment: () => options.development === true },
      state,
      listWorkspaces: async () => [{ id: "ws_system", name: "system" }],
      openExternal: vi.fn(async () => undefined),
      stdin: tty.stdin,
      stdout: tty.stdout,
    });
  return {
    transport,
    workspaceTransport,
    device,
    events,
    state,
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
    state.transportStatus("client", "connecting");
    expect(state.current()).toMatchObject({ phase: "reconnecting" });
    state.transportStatus("workspace", "connecting");
    state.transportStatus("client", "connected");
    // Connected again only once every connection is.
    expect(state.current()).toMatchObject({ phase: "reconnecting" });
    state.transportStatus("workspace", "connected");
    state.lose("the local server exited (code 1)");
    state.transportStatus("client", "connected");
    expect(state.current()).toEqual({ phase: "lost", cause: "the local server exited (code 1)" });
    expect(seen).toEqual(["reconnecting", "connected", "lost"]);
  });
});

describe("runTerminalClient", () => {
  it("hands the client its principal host for System and a device session for the shown workspace", async () => {
    let received: TerminalClientHost | null = null;
    const { run, transport, workspaceTransport, options, state } = harness({
      run: async (host) => {
        received = host;
        return { kind: "quit" };
      },
    });
    await expect(run()).resolves.toEqual({ kind: "exit", exit: { kind: "quit" } });
    const host = received as unknown as TerminalClientHost;
    expect(host.client).toEqual({
      id: "browser",
      source: "clients/terminal-browser",
      buildKey: "build-1",
      grantedCapabilities: [],
    });
    expect(host.intent).toBeNull();
    expect(host.rpc.selfId).toBe(PRINCIPAL);
    expect(host.system).toEqual({ id: "ws_system", name: "system" });
    expect(host.workspace).toEqual({ id: "ws_personal", name: "personal" });
    expect(host.workspaceRpc.selfId).toBe("shell:dev_1");
    expect(host.connectionState()).toEqual({ phase: "connected" });
    expect(await host.listWorkspaces()).toEqual([{ id: "ws_system", name: "system" }]);
    expect(await host.state.get()).toEqual({ saved: true });
    expect(options().selfId).toBe(PRINCIPAL);
    expect(state.get).toHaveBeenCalled();
    expect(transport.close).toHaveBeenCalled();
    expect(workspaceTransport.close).toHaveBeenCalled();
  });

  it("exposes a host module only when its capability was granted", async () => {
    const seen: Array<Pick<TerminalClientHost, "files" | "clipboard" | "notify">> = [];
    for (const granted of [
      [],
      ["clipboard", "notifications", "local-files"],
    ] as ClientCapability[][]) {
      const { run } = harness(
        {
          run: async (host) => {
            seen.push({ files: host.files, clipboard: host.clipboard, notify: host.notify });
            return { kind: "quit" };
          },
        },
        { granted }
      );
      await run();
    }
    expect(seen[0]).toEqual({ files: undefined, clipboard: undefined, notify: undefined });
    expect(Object.keys(seen[1]!.files ?? {}).sort()).toEqual([
      "download",
      "read",
      "saveText",
      "upload",
    ]);
    expect(seen[1]!.clipboard).toBeDefined();
    expect(seen[1]!.notify).toBeDefined();
    // Granting one module does not expose the others.
    const only: Array<Pick<TerminalClientHost, "files" | "clipboard" | "notify">> = [];
    const { run } = harness(
      {
        run: async (host) => {
          only.push({ files: host.files, clipboard: host.clipboard, notify: host.notify });
          return { kind: "quit" };
        },
      },
      { granted: ["clipboard"] }
    );
    await run();
    expect(only[0]!.clipboard).toBeDefined();
    expect(only[0]!.files).toBeUndefined();
    expect(only[0]!.notify).toBeUndefined();
  });

  it("presents the launch's credential on every authentication", async () => {
    const { run, options } = harness({
      run: async () => {
        const first = await options().getToken();
        await expect(options().getToken()).resolves.toBe(first);
        return { kind: "quit" };
      },
    });
    await run();
  });

  it("restores the terminal and closes the session when the client throws", async () => {
    const { run, tty, transport } = harness({
      run: async () => {
        throw new Error("client crashed");
      },
    });
    await expect(run()).rejects.toThrow("client crashed");
    expect(tty.stdout.write).toHaveBeenCalledWith(expect.stringContaining("\x1b[?1049l"));
    expect(tty.stdin.isRaw).toBe(false);
    expect(transport.close).toHaveBeenCalled();
  });

  it("an authentication cancelled by its owner does not end the client", async () => {
    const authentication = new AbortController();
    const reason = new Error("reconnect superseded");
    const { run, options } = harness({
      run: async (host) => {
        authentication.abort(reason);
        await expect(options().getToken(authentication.signal)).rejects.toBe(reason);
        expect(host.signal.aborted).toBe(false);
        return { kind: "quit" };
      },
    });
    await expect(run()).resolves.toEqual({ kind: "exit", exit: { kind: "quit" } });
  });

  it("joins both transports and retains independent cleanup failures", async () => {
    const clientFailure = new Error("client crashed");
    const releaseFailure = new Error("terminal restore failed");
    const closeFailure = new Error("transport close failed");
    const { run, tty, transport, workspaceTransport } = harness({
      run: async () => {
        tty.stdout.write.mockImplementation(() => {
          throw releaseFailure;
        });
        throw clientFailure;
      },
    });
    transport.close.mockRejectedValueOnce(closeFailure);
    const failure = await run().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      clientFailure,
      releaseFailure,
      closeFailure,
    ]);
    expect(workspaceTransport.close).toHaveBeenCalledOnce();
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

  it("treats a session closed with trust-revoked as withdrawn trust, not a lost connection", async () => {
    const { run, options } = harness({
      run: async (host) => {
        options().onTerminalClose?.(new Error(TRUST_REVOKED_REASON));
        // The client sees an ordinary end and leaves; the host knows why.
        return {
          kind: "connection-lost",
          cause: (host.connectionState() as { cause: string }).cause,
        };
      },
    });
    await expect(run()).resolves.toEqual({ kind: "trust-revoked" });
  });

  it("offers a newer build to the client and re-enters it only when the client asks", async () => {
    let announced: TerminalClientUpdate | null = null;
    const { run, events } = harness({
      run: async (host) => {
        expect(host.update.pending()).toBeNull();
        expect(() => host.update.restartAtSafePoint()).toThrow("no update");
        host.update.onUpdate((update) => {
          announced = update;
        });
        events.emit(supervisionChange("build-2"));
        expect(announced).toEqual({
          buildKey: "build-2",
          effectiveVersion: "2",
          previousBuildKey: "build-1",
        });
        expect(host.update.pending()).toEqual(announced);
        // Nothing was adopted: the client keeps its connection until it asks.
        expect(host.connectionState()).toEqual({ phase: "connected" });
        host.update.restartAtSafePoint();
        return { kind: "quit" };
      },
    });
    await expect(run()).resolves.toEqual({ kind: "restart" });
    expect(events.subscribe).toHaveBeenCalledWith("supervision:changed");
    expect(events.unsubscribe).toHaveBeenCalledWith("supervision:changed");
  });

  it("ignores a build that is already running and other clients' builds", async () => {
    const { run, events } = harness({
      run: async (host) => {
        events.emit(supervisionChange("build-1"));
        events.emit({ ...supervisionChange("build-9"), source: "clients/other" });
        expect(host.update.pending()).toBeNull();
        return { kind: "quit" };
      },
    });
    await expect(run()).resolves.toEqual({ kind: "exit", exit: { kind: "quit" } });
  });

  it("adopts a rebuild at once in development mode, without asking the client", async () => {
    const asked = vi.fn();
    const { run, events } = harness(
      {
        run: async (host) => {
          host.update.onUpdate(asked);
          events.emit(supervisionChange("build-2"));
          // The host ended the client's connection so it settles by itself.
          expect(host.connectionState()).toMatchObject({ phase: "lost" });
          return { kind: "connection-lost", cause: "restarting" };
        },
      },
      { development: true }
    );
    await expect(run()).resolves.toEqual({ kind: "restart" });
    expect(asked).not.toHaveBeenCalled();
  });
});

describe("importClientModule", () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  function cached(source: string, name = "index.mjs"): LaunchedClient {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-import-test-"));
    scratch.push(dir);
    const file = path.join(dir, name);
    fs.writeFileSync(file, source);
    const base = launched();
    return { ...base, artifacts: [{ ...base.artifacts[0]!, path: name, handle: file }] };
  }

  it("imports the verified module from the cache, by its own file", async () => {
    const module = await importClientModule(
      cached("export async function run() { return { kind: 'quit' }; }")
    );
    await expect(module.run({} as never)).resolves.toEqual({ kind: "quit" });
  });

  it("rejects a module without run(host)", async () => {
    await expect(importClientModule(cached("export const x = 1;"))).rejects.toThrow(
      "does not export run(host)"
    );
  });

  it("requires exactly one primary .mjs entry", async () => {
    const base = cached("export async function run() {}");
    await expect(
      importClientModule({
        ...base,
        artifacts: [...base.artifacts, ...base.artifacts],
      })
    ).rejects.toThrow("no single ESM entry module");
    await expect(
      importClientModule({
        ...base,
        artifacts: [{ ...base.artifacts[0]!, path: "index.js" }],
      })
    ).rejects.toThrow("no single ESM entry module");
  });
});
