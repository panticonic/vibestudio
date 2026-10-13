import { mkdtemp, readFile, readdir } from "node:fs/promises";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import {
  createTerminalAppsService,
  SHELL_EXTENSION,
  TERMINAL_LAUNCH_ENV,
  type TerminalAppLaunchMaterial,
  type TerminalAppsServiceDeps,
} from "./terminalAppsService.js";
import { TERMINAL_APPS_RUN_PREPARATION } from "@vibestudio/service-schemas/terminalApps";

const SUBJECT = { userId: "alice", kind: "user" } as never;

function personCtx(source?: string): ServiceContext {
  return {
    caller: createVerifiedCaller("shell:laptop", "shell", null, null, SUBJECT),
    preparedAuthority: {
      resolver: TERMINAL_APPS_RUN_PREPARATION,
      payload: { source: source ?? null },
    } as never,
  };
}

async function harness(registryPath?: string) {
  const root = await mkdtemp(path.join(tmpdir(), "terminal-apps-"));
  const exits = new Map<string, (value: { exitCode: number | null; signal?: string }) => void>();
  const shellCalls: Array<{ method: string; args: unknown[]; ctx: ServiceContext }> = [];
  let pty = 0;
  const deadPtys = new Set<string>();
  let entity = 0;
  const retired: string[] = [];
  const events: Array<{ userId: string; sessions: unknown[] }> = [];
  const deps: TerminalAppsServiceDeps = {
    workspaceLabel: () => "Personal",
    registryPath: registryPath ?? path.join(root, "terminal-sessions.json"),
    launchDirectory: path.join(root, "launch"),
    nodeExecutable: () => "/runtime/node",
    gatewayUrl: () => "http://127.0.0.1:1234",
    resolveUnit: async (source) =>
      source === "terminal-apps/chat"
        ? { source, title: "Chat", icon: "💬", effectiveVersion: "abcdef0123456789" }
        : null,
    createEntity: vi.fn(async (_caller, spec) => ({
      id: `panel:${spec.key}`,
      kind: "panel" as const,
      source: { repoPath: "terminal-apps/chat", effectiveVersion: "ev" } as never,
      buildKey: "b".repeat(64),
      contextId: (spec as { contextId?: string }).contextId ?? `ctx-${++entity}`,
      targetId: `panel:${spec.key}`,
    })),
    retireEntity: vi.fn(async (id: string) => {
      retired.push(id);
    }),
    createContext: vi.fn(async () => "ctx-shell"),
    entityStateArgs: vi.fn(async () => ({ channelName: "kept" })),
    primaryArtifactPath: async () => "/builds/chat/bundle.js",
    grantConnection: vi.fn(() => "grant-token"),
    holdLease: vi.fn(),
    dispatch: vi.fn(async (ctx, service, method, args) => {
      expect([service, method]).toEqual(["extensions", "invoke"]);
      const [name, shellMethod, shellArgs] = args as [string, string, unknown[]];
      expect(name).toBe(SHELL_EXTENSION);
      shellCalls.push({ method: shellMethod, args: shellArgs, ctx });
      if (shellMethod === "open") return { sessionId: `pty-${++pty}` };
      if (shellMethod === "get") return { alive: !deadPtys.has(shellArgs[0] as string) };
      if (shellMethod === "awaitExit") {
        return new Promise((resolve, reject) => {
          exits.set(shellArgs[0] as string, resolve);
          ctx.signal?.addEventListener("abort", () => reject(ctx.signal!.reason));
        });
      }
      return undefined;
    }),
    emitToUser: (userId, _event, payload) => events.push({ userId, sessions: payload.sessions }),
  };
  const service = createTerminalAppsService(deps);
  const call = (method: string, ctx: ServiceContext, ...args: unknown[]) =>
    service.handler(ctx, method, args) as Promise<unknown>;
  return { root, deps, service, call, shellCalls, exits, retired, events, deadPtys };
}

describe("terminalApps launch service", () => {
  it("launches an app as a host-held panel runtime the person owns, through a one-shot launch file", async () => {
    const h = await harness();
    const entry = (await call(h, "launch", personCtx("terminal-apps/chat"), {
      source: "terminal-apps/chat",
      cols: 100,
      rows: 30,
      approvalsKey: "Ctrl-Space a",
    })) as { sessionId: string; principalId: string; shellSessionId: string; running: boolean };
    expect(entry).toMatchObject({
      kind: "app",
      title: "Chat",
      icon: "💬",
      running: true,
      shellSessionId: "pty-1",
    });
    expect(entry.principalId).toMatch(/^panel:nav-term-/);
    expect(h.deps.holdLease).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeEntityId: entry.principalId, authorizedBy: "shell:laptop" })
    );
    expect(h.deps.grantConnection).toHaveBeenCalledWith(entry.principalId, "shell:laptop", SUBJECT);

    const open = h.shellCalls.find((c) => c.method === "open")!;
    const request = open.args[0] as {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
    expect(open.ctx.caller.runtime).toEqual({ id: "terminal-apps", kind: "server" });
    expect(open.ctx.caller.subject).toBe(SUBJECT);
    expect(request.command).toBe("/runtime/node");
    expect(request.args).toEqual(["/builds/chat/bundle.js"]);
    expect(Object.keys(request.env).sort()).toEqual(["COLORTERM", TERMINAL_LAUNCH_ENV]);
    const material = JSON.parse(
      await readFile(request.env[TERMINAL_LAUNCH_ENV]!, "utf8")
    ) as TerminalAppLaunchMaterial;
    expect(material).toMatchObject({
      principalId: entry.principalId,
      grant: "grant-token",
      title: "Chat",
      approvalsKey: "Ctrl-Space a",
      sessionId: entry.sessionId,
    });
    expect(fs.statSync(request.env[TERMINAL_LAUNCH_ENV]!).mode & 0o777).toBe(0o600);
    expect(h.events.at(-1)).toMatchObject({ userId: "alice" });
    await h.service.stop();
  });

  it("retires the incarnation when the PTY exits, and relaunches with the same context and state", async () => {
    const h = await harness();
    const first = (await call(h, "launch", personCtx("terminal-apps/chat"), {
      source: "terminal-apps/chat",
      cols: 80,
      rows: 24,
    })) as { sessionId: string; principalId: string };
    h.exits.get("pty-1")!({ exitCode: 0 });
    await vi.waitFor(() => expect(h.retired).toContain(first.principalId));
    const listed = (await call(h, "list", personCtx())) as Array<{
      running: boolean;
      exit?: unknown;
    }>;
    expect(listed[0]).toMatchObject({ running: false, exit: { code: 0 }, shellSessionId: null });

    const resumed = (await call(h, "resume", personCtx("terminal-apps/chat"), {
      sessionId: first.sessionId,
      cols: 80,
      rows: 24,
    })) as { principalId: string; running: boolean };
    expect(resumed.running).toBe(true);
    expect(resumed.principalId).not.toBe(first.principalId);
    const spec = vi.mocked(h.deps.createEntity).mock.calls.at(-1)![1] as {
      contextId: string;
      stateArgs: unknown;
    };
    expect(spec.contextId).toBe("ctx-1");
    expect(spec.stateArgs).toEqual({ channelName: "kept" });
    await h.service.stop();
  });

  it("relaunches on resume when the PTY exited before the exit watch reported it", async () => {
    const h = await harness();
    const first = (await call(h, "launch", personCtx("terminal-apps/chat"), {
      source: "terminal-apps/chat",
      cols: 80,
      rows: 24,
    })) as { sessionId: string };
    h.deadPtys.add("pty-1");
    const resumed = (await call(h, "resume", personCtx("terminal-apps/chat"), {
      sessionId: first.sessionId,
      cols: 80,
      rows: 24,
    })) as { shellSessionId: string };
    expect(resumed.shellSessionId).toBe("pty-2");
    await h.service.stop();
  });

  it("launches a command shell in a chosen context and folder, with no entity or grant, and relaunches it as it was", async () => {
    const h = await harness();
    const entry = (await call(h, "launch", personCtx(), {
      command: "/bin/sh",
      args: ["-c", "make test"],
      cwd: "/ctx/pkg",
      label: "make test",
      contextId: "ctx-chosen",
      cols: 80,
      rows: 24,
    })) as { sessionId: string; kind: string; title: string; principalId?: string };
    expect(entry).toMatchObject({ kind: "shell", title: "make test", shellSessionId: "pty-1" });
    expect(entry.principalId).toBeUndefined();
    expect(h.deps.createEntity).not.toHaveBeenCalled();
    expect(h.deps.grantConnection).not.toHaveBeenCalled();
    expect(h.deps.createContext).not.toHaveBeenCalled();
    const open = h.shellCalls.find((c) => c.method === "open")!;
    expect(open.args[0]).toMatchObject({
      command: "/bin/sh",
      args: ["-c", "make test"],
      cwd: "/ctx/pkg",
      label: "make test",
      contextId: "ctx-chosen",
    });
    expect(await call(h, "list", personCtx())).toEqual([
      expect.objectContaining({ title: "make test" }),
    ]);

    h.exits.get("pty-1")!({ exitCode: 0 });
    await vi.waitFor(async () =>
      expect(await call(h, "list", personCtx())).toEqual([
        expect.objectContaining({ running: false }),
      ])
    );
    await call(h, "resume", personCtx(), { sessionId: entry.sessionId, cols: 80, rows: 24 });
    const reopen = h.shellCalls.filter((c) => c.method === "open")[1]!;
    expect(reopen.args[0]).toMatchObject({
      command: "/bin/sh",
      cwd: "/ctx/pkg",
      contextId: "ctx-chosen",
    });
    const restarted = (await call(h, "restart", personCtx(), {
      sessionId: entry.sessionId,
      cols: 80,
      rows: 24,
    })) as { sessionId: string; shellSessionId: string };
    expect(restarted).toMatchObject({ sessionId: entry.sessionId, shellSessionId: "pty-3" });
    expect(h.shellCalls.some((c) => c.method === "dispose" && c.args[0] === "pty-2")).toBe(true);
    await expect(
      call(h, "launch", personCtx("terminal-apps/chat"), {
        source: "terminal-apps/chat",
        command: "/bin/sh",
        cols: 80,
        rows: 24,
      })
    ).rejects.toThrow("takes no command");
    await h.service.stop();
  });

  it("keeps sessions per person and ends them for good on close", async () => {
    const h = await harness();
    const shell = (await call(h, "launch", personCtx(), { cols: 80, rows: 24 })) as {
      sessionId: string;
    };
    const bob: ServiceContext = {
      caller: createVerifiedCaller("shell:other", "shell", null, null, {
        userId: "bob",
        kind: "user",
      } as never),
    };
    expect(await call(h, "list", bob)).toEqual([]);
    await expect(call(h, "close", bob, shell.sessionId)).rejects.toMatchObject({ code: "ENOENT" });
    await call(h, "close", personCtx(), shell.sessionId);
    expect(h.shellCalls.some((c) => c.method === "dispose" && c.args[0] === "pty-1")).toBe(true);
    expect(await call(h, "list", personCtx())).toEqual([]);
    await h.service.stop();
  });

  it("starts after a restart with no program running, and stops without waiting on live PTYs", async () => {
    const h = await harness();
    await call(h, "launch", personCtx("terminal-apps/chat"), {
      source: "terminal-apps/chat",
      cols: 80,
      rows: 24,
    });
    await h.service.stop(); // aborts the pending exit watch instead of waiting on the PTY
    const again = await harness(h.deps.registryPath);
    const listed = (await call(again, "list", personCtx())) as Array<{ running: boolean }>;
    expect(listed).toHaveLength(1);
    expect(listed[0]!.running).toBe(false);
    await vi.waitFor(() => expect(again.retired).toHaveLength(1));
    await again.service.stop();
    expect(await readdir(again.root)).toBeDefined();
  });

  it("refuses runs the dispatcher did not prepare, and settings larger than 4 KB", async () => {
    const h = await harness();
    await expect(
      call(h, "launch", { caller: personCtx().caller }, { cols: 80, rows: 24 })
    ).rejects.toThrow(/prepared/);
    await expect(call(h, "setSettings", personCtx(), { blob: "x".repeat(5000) })).rejects.toThrow(
      /4096/
    );
    await call(h, "setSettings", personCtx(), { prefixKey: "C-a" });
    expect(await call(h, "getSettings", personCtx())).toEqual({ prefixKey: "C-a" });
    await h.service.stop();
  });
});

function call(
  h: Awaited<ReturnType<typeof harness>>,
  method: string,
  ctx: ServiceContext,
  ...args: unknown[]
) {
  return h.call(method, ctx, ...args);
}
