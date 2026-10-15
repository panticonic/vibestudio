import { mkdtemp, readFile, readdir } from "node:fs/promises";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { ConnectionGrantService } from "@vibestudio/shared/connectionGrants";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import { cleanupRuntimeEntity } from "../runtimeEntityCleanup.js";
import {
  createVerifiedCaller,
  type ServiceContext,
  type ServiceDispatcher,
} from "@vibestudio/shared/serviceDispatcher";
import {
  createTerminalAppsService,
  SHELL_EXTENSION,
  TERMINAL_LAUNCH_ENV,
  type TerminalAppLaunchMaterial,
  type TerminalAppsServiceDeps,
} from "./terminalAppsService.js";
import { TERMINAL_APPS_RUN_PREPARATION } from "@vibestudio/service-schemas/terminalApps";
import {
  createTestServiceDispatcher,
  testAuthority,
} from "@vibestudio/shared/serviceDispatcherTestUtils";

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
  const exitFailures = new Map<string, (error: unknown) => void>();
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
    createContext: vi.fn(async () => `ctx-${++entity}`),
    entityStateArgs: vi.fn(async () => ({ channelName: "kept" })),
    primaryArtifactPath: vi.fn(async () => "/builds/chat/bundle.js"),
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
          exitFailures.set(shellArgs[0] as string, reject);
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
  return { root, deps, service, call, shellCalls, exits, exitFailures, retired, events, deadPtys };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function stoppedShell(h: Awaited<ReturnType<typeof harness>>) {
  const session = (await call(h, "launch", personCtx(), { cols: 80, rows: 24 })) as {
    sessionId: string;
  };
  const stopped = deferred<void>();
  const emit = h.deps.emitToUser;
  h.deps.emitToUser = (user, event, payload) => {
    emit(user, event, payload);
    if (payload.sessions.some((entry) => entry.sessionId === session.sessionId && !entry.running))
      stopped.resolve();
  };
  h.exits.get("pty-1")!({ exitCode: 0 });
  await stopped.promise;
  return session;
}

describe("terminalApps launch service", () => {
  it("admits one stopped-session start across simultaneous device resumes", async () => {
    const h = await harness();
    const session = await stoppedShell(h);
    const entered = deferred<void>();
    const opened = deferred<{ sessionId: string }>();
    const original = vi.mocked(h.deps.dispatch).getMockImplementation()!;
    vi.mocked(h.deps.dispatch)
      .mockClear()
      .mockImplementation(async (ctx, service, method, args) => {
        if (args[1] === "open") {
          entered.resolve();
          return opened.promise;
        }
        return original(ctx, service, method, args);
      });
    const first = call(h, "resume", personCtx(), {
      sessionId: session.sessionId,
      cols: 80,
      rows: 24,
    });
    await entered.promise;
    const second = call(h, "resume", personCtx(), {
      sessionId: session.sessionId,
      cols: 80,
      rows: 24,
    });
    opened.resolve({ sessionId: "pty-2" });
    const results = await Promise.all([first, second]);
    expect(results).toEqual([
      expect.objectContaining({ shellSessionId: "pty-2" }),
      expect.objectContaining({ shellSessionId: "pty-2" }),
    ]);
    expect(
      vi.mocked(h.deps.dispatch).mock.calls.filter((call) => call[3][1] === "open")
    ).toHaveLength(1);
    await h.service.stop();
  });

  it("retains a visible retryable session and retires all app resources after artifact lookup fails", async () => {
    const h = await harness();
    const failure = new Error("primary artifact missing");
    vi.mocked(h.deps.primaryArtifactPath).mockRejectedValueOnce(failure);
    await expect(
      call(h, "launch", personCtx("terminal-apps/chat"), {
        source: "terminal-apps/chat",
        cols: 80,
        rows: 24,
      })
    ).rejects.toBe(failure);
    expect(h.retired).toHaveLength(1);
    expect(await readdir(h.deps.launchDirectory)).toEqual([]);
    const entries = (await call(h, "list", personCtx())) as Array<{ sessionId: string }>;
    expect(entries).toEqual([
      expect.objectContaining({ running: false, failure: failure.message, shellSessionId: null }),
    ]);
    const restored = await call(h, "resume", personCtx("terminal-apps/chat"), {
      sessionId: entries[0]!.sessionId,
      cols: 80,
      rows: 24,
    });
    expect(restored).toMatchObject({ running: true });
    expect(restored).not.toHaveProperty("failure");
    expect(h.deps.createContext).toHaveBeenCalledTimes(1);
    await h.service.stop();
  });

  it("preserves both launch failure and rollback failure", async () => {
    const h = await harness();
    const launch = new Error("artifact lookup failed");
    const rollback = new Error("entity retirement failed");
    vi.mocked(h.deps.primaryArtifactPath).mockRejectedValueOnce(launch);
    vi.mocked(h.deps.retireEntity).mockRejectedValueOnce(rollback);
    await expect(
      call(h, "launch", personCtx("terminal-apps/chat"), {
        source: "terminal-apps/chat",
        cols: 80,
        rows: 24,
      })
    ).rejects.toMatchObject({ errors: [launch, rollback] });
    expect(await call(h, "list", personCtx())).toEqual([
      expect.objectContaining({ running: false, failure: "Terminal launch and rollback failed" }),
    ]);
    await h.service.stop();
  });

  it("preserves the known PTY until close disposal succeeds and lets the person retry", async () => {
    const h = await harness();
    const session = (await call(h, "launch", personCtx(), { cols: 80, rows: 24 })) as {
      sessionId: string;
    };
    const original = vi.mocked(h.deps.dispatch).getMockImplementation()!;
    const failure = new Error("could not stop PTY");
    vi.mocked(h.deps.dispatch).mockImplementationOnce(async () => {
      throw failure;
    });
    await expect(call(h, "close", personCtx(), session.sessionId)).rejects.toBe(failure);
    expect(await call(h, "list", personCtx())).toEqual([
      expect.objectContaining({ running: true, shellSessionId: "pty-1", failure: failure.message }),
    ]);
    vi.mocked(h.deps.dispatch).mockImplementation(original);
    await call(h, "close", personCtx(), session.sessionId);
    expect(await call(h, "list", personCtx())).toEqual([]);
    await h.service.stop();
  });

  it("keeps close ownership visible while disposal joins and orders a concurrent resume after close", async () => {
    const h = await harness();
    const session = (await call(h, "launch", personCtx(), { cols: 80, rows: 24 })) as {
      sessionId: string;
    };
    const entered = deferred<void>();
    const joined = deferred<void>();
    vi.mocked(h.deps.dispatch).mockImplementationOnce(async () => {
      entered.resolve();
      await joined.promise;
    });
    const closing = call(h, "close", personCtx(), session.sessionId);
    await entered.promise;
    expect(await call(h, "list", personCtx())).toEqual([
      expect.objectContaining({ running: true, shellSessionId: "pty-1" }),
    ]);
    const resuming = call(h, "resume", personCtx(), {
      sessionId: session.sessionId,
      cols: 80,
      rows: 24,
    });
    const rejected = expect(resuming).rejects.toMatchObject({ code: "ENOENT" });
    joined.resolve();
    await closing;
    await rejected;
    expect(await call(h, "list", personCtx())).toEqual([]);
    await h.service.stop();
  });

  it("keeps the previous incarnation running when restart cannot dispose its PTY", async () => {
    const h = await harness();
    const session = (await call(h, "launch", personCtx("terminal-apps/chat"), {
      source: "terminal-apps/chat",
      cols: 80,
      rows: 24,
    })) as { sessionId: string; principalId: string };
    const failure = new Error("disposal rejected");
    vi.mocked(h.deps.dispatch).mockRejectedValueOnce(failure);
    await expect(
      call(h, "restart", personCtx("terminal-apps/chat"), {
        sessionId: session.sessionId,
        cols: 80,
        rows: 24,
      })
    ).rejects.toBe(failure);
    expect(h.retired).toEqual([]);
    expect(h.deps.createEntity).toHaveBeenCalledTimes(1);
    expect(await call(h, "list", personCtx())).toEqual([
      expect.objectContaining({
        running: true,
        shellSessionId: "pty-1",
        principalId: session.principalId,
        failure: failure.message,
      }),
    ]);
    await h.service.stop();
  });

  it("does not turn an exit-observation failure into program exit", async () => {
    const h = await harness();
    const session = (await call(h, "launch", personCtx(), { cols: 80, rows: 24 })) as {
      sessionId: string;
    };
    const failurePublished = deferred<void>();
    const original = h.deps.emitToUser;
    h.deps.emitToUser = (user, event, payload) => {
      original(user, event, payload);
      if (payload.sessions.some((entry) => entry.failure)) failurePublished.resolve();
    };
    h.exitFailures.get("pty-1")!(new Error("RPC delivery failed"));
    await failurePublished.promise;
    expect(await call(h, "list", personCtx())).toEqual([
      expect.objectContaining({
        sessionId: session.sessionId,
        running: true,
        shellSessionId: "pty-1",
        failure: "Could not observe program exit: RPC delivery failed",
      }),
    ]);
    expect(h.retired).toEqual([]);
    const resumed = await call(h, "resume", personCtx(), {
      sessionId: session.sessionId,
      cols: 80,
      rows: 24,
    });
    expect(resumed).toMatchObject({ running: true, shellSessionId: "pty-1" });
    expect(resumed).not.toHaveProperty("failure");
    expect(h.shellCalls.filter((call) => call.method === "awaitExit")).toHaveLength(2);
    await h.service.stop();
  });
  it.each(["user", "code"])(
    "reviews one exact app run for a %s caller on launch, resume and restart",
    async (kind) => {
      const h = await harness();
      const caller =
        kind === "user"
          ? personCtx().caller
          : createVerifiedCaller(
              "panel:launcher",
              "panel",
              {
                callerId: "panel:launcher",
                callerKind: "panel",
                repoPath: "panels/terminal",
                effectiveVersion: "version-1",
                executionDigest: "a".repeat(64),
                requested: [
                  { capability: "terminal-apps.run", resource: { kind: "prefix", prefix: "" } },
                ],
              },
              null,
              SUBJECT
            );
      const dispatcher = createTestServiceDispatcher();
      const resolved = vi.fn<Parameters<ServiceDispatcher["setAuthorityResolver"]>[0]>(
        ({ caller: author, capability, resourceKey }) =>
          testAuthority(author, capability, resourceKey)
      );
      dispatcher.setAuthorityResolver(resolved);
      dispatcher.registerService(h.service);
      dispatcher.markInitialized();
      try {
        let sessionId: string | undefined;
        for (const method of ["launch", "resume", "restart"]) {
          const input = {
            ...(sessionId ? { sessionId } : { source: "terminal-apps/chat" }),
            cols: 80,
            rows: 24,
          };
          const preflight = await dispatcher.preflightAuthority(
            { caller },
            "terminalApps",
            method,
            [input]
          );
          expect(preflight.leaves.map(({ capability, tier }) => ({ capability, tier }))).toEqual([
            { capability: `service:terminalApps.${method}`, tier: "open" },
            { capability: "terminal-apps.run", tier: "gated" },
          ]);
          expect(resolved.mock.calls.at(-1)?.[0]).toMatchObject({
            capability: "terminal-apps.run",
            resourceKey: "terminal-app:terminal-apps/chat",
            challenge: {
              title: "Run Chat abcdef012345 in Personal?",
              details: [
                { label: "Workspace", value: "Personal" },
                { label: "Program", value: "Chat (terminal-apps/chat)" },
                { label: "Version", value: "abcdef012345" },
              ],
            },
          });
          const session = (await dispatcher.dispatch({ caller }, "terminalApps", method, [
            input,
          ])) as {
            sessionId: string;
          };
          sessionId = session.sessionId;
        }
      } finally {
        await h.service.stop();
      }
    }
  );

  it("refuses another person's session before revealing its command in a review", async () => {
    const h = await harness();
    try {
      const session = (await call(h, "launch", personCtx(), {
        command: "private-program",
        cols: 80,
        rows: 24,
      })) as { sessionId: string };
      const prepare = h.service.authorityPreparation![TERMINAL_APPS_RUN_PREPARATION]!;
      const caller = createVerifiedCaller("shell:bob", "shell", null, null, {
        kind: "user",
        userId: "bob",
      } as never);
      await expect(prepare({ caller }, [{ sessionId: session.sessionId }])).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await h.service.stop();
    }
  });

  it("keeps declared code authority admission on the exact prepared run leaf", async () => {
    const h = await harness();
    const caller = createVerifiedCaller(
      "panel:undeclared",
      "panel",
      {
        callerId: "panel:undeclared",
        callerKind: "panel",
        repoPath: "panels/terminal",
        effectiveVersion: "version-1",
        executionDigest: "a".repeat(64),
        requested: [],
      },
      null,
      SUBJECT
    );
    const dispatcher = createTestServiceDispatcher();
    dispatcher.registerService(h.service);
    dispatcher.markInitialized();
    try {
      const input = { source: "terminal-apps/chat", cols: 80, rows: 24 };
      await expect(
        dispatcher.preflightAuthority({ caller }, "terminalApps", "launch", [input])
      ).resolves.toMatchObject({
        decision: "denied",
        leaves: [
          { capability: "service:terminalApps.launch", status: "granted" },
          {
            capability: "terminal-apps.run",
            status: "denied",
            failure: { reasonCode: "fixed-code-not-requested" },
          },
        ],
      });
      await expect(
        dispatcher.dispatch({ caller }, "terminalApps", "launch", [input])
      ).rejects.toMatchObject({ code: "EACCES" });
      expect(h.shellCalls).toEqual([]);
    } finally {
      await h.service.stop();
    }
  });

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
    expect(entry.principalId).toBe(`panel:terminal-session-${entry.sessionId}`);
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
    const cache = new EntityCache();
    const grants = new ConnectionGrantService({ entityCache: cache });
    onTestFinished(async () => {
      try {
        await h.service.stop();
      } finally {
        grants.stop();
      }
    });
    const created = vi.mocked(h.deps.createEntity).getMockImplementation();
    if (!created) throw new Error("Missing harness runtime entity implementation");
    vi.mocked(h.deps.createEntity).mockImplementation(async (...args) => {
      const key = args[1].key;
      if (!key) throw new Error("Terminal runtime entity must provide its durable session key");
      const entity = await created(...args);
      cache._onActivate({
        id: entity.id,
        kind: "panel",
        source: entity.source,
        contextId: entity.contextId,
        key,
        createdAt: Date.now(),
        authoritySessionId: crypto.randomUUID(),
        status: "active",
        cleanupComplete: true,
        activeBuildKey: "b".repeat(64),
        activeExecutionDigest: "a".repeat(64),
        activeAuthority: { requests: [], provides: [] },
      });
      return entity;
    });
    const tokens: string[] = [];
    vi.mocked(h.deps.grantConnection).mockImplementation((principalId, issuedBy, subject) => {
      const { token } = grants.grant(principalId, issuedBy, { subject });
      tokens.push(token);
      return token;
    });
    vi.mocked(h.deps.retireEntity).mockImplementation(async (id) => {
      const active = cache.resolve(id);
      if (!active) throw new Error(`Missing runtime entity ${id}`);
      const retired = { ...active, status: "retired" as const, cleanupComplete: false };
      cache._onRetire(retired);
      await cleanupRuntimeEntity(retired, {
        connectionGrants: grants,
        retireAuthorityOwner: () => {},
        egressProxy: { dropCaller: async () => {} },
        approvalQueue: { cancelForCaller: () => {} },
        credentialSessionGrantStore: { dropForCaller: (_callerId) => 0 },
        tokenManager: { revokeToken: (_callerId) => false },
        releaseBlobRetentions: async () => {},
        getWorkerdManager: () => null,
        getFsService: () => null,
        getWebhookIngress: () => null,
      });
      h.retired.push(id);
    });
    const first = (await call(h, "launch", personCtx("terminal-apps/chat"), {
      source: "terminal-apps/chat",
      cols: 80,
      rows: 24,
    })) as { sessionId: string; principalId: string };
    expect(grants.redeem(tokens[0]!)).toMatchObject({ principalId: first.principalId });
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
    expect(resumed.principalId).toBe(first.principalId);
    expect(tokens[1]).not.toBe(tokens[0]);
    expect(grants.validate(tokens[0]!)).toBeNull();
    expect(grants.redeem(tokens[1]!)).toMatchObject({ principalId: first.principalId });
    expect(h.deps.grantConnection).toHaveBeenCalledTimes(2);
    const leases = vi.mocked(h.deps.holdLease).mock.calls;
    expect(leases[1]![0].connectionId).not.toBe(leases[0]![0].connectionId);
    const spec = vi.mocked(h.deps.createEntity).mock.calls.at(-1)![1] as {
      contextId: string;
      stateArgs: unknown;
    };
    expect(spec.contextId).toBe("ctx-1");
    expect(spec.stateArgs).toEqual({ channelName: "kept" });
    const restarted = (await call(h, "restart", personCtx("terminal-apps/chat"), {
      sessionId: first.sessionId,
      cols: 80,
      rows: 24,
    })) as { principalId: string };
    expect(restarted.principalId).toBe(first.principalId);
    expect(grants.validate(tokens[1]!)).toBeNull();
    expect(tokens[2]).not.toBe(tokens[1]);
    expect(grants.redeem(tokens[2]!)).toMatchObject({ principalId: first.principalId });
    await h.service.stop();
  });

  it("creates the session's context under the launching call's test policy", async () => {
    const h = await harness();
    const testPolicy = { policyId: "orchestrator-1", kind: "orchestrator" } as never;
    const testCtx = (source?: string): ServiceContext => {
      const ctx = personCtx(source);
      return { ...ctx, caller: { ...ctx.caller, testPolicy } };
    };
    const launched = (await call(h, "launch", testCtx("terminal-apps/chat"), {
      source: "terminal-apps/chat",
      cols: 80,
      rows: 24,
    })) as { principalId: string };
    expect(vi.mocked(h.deps.createContext).mock.calls.at(-1)![0]).toMatchObject({
      runtime: { id: "terminal-apps", kind: "server" },
      testPolicy,
    });
    // The app runs in that context, not in one it would create for itself.
    expect(vi.mocked(h.deps.createEntity).mock.calls.at(-1)![1]).toMatchObject({
      contextId: "ctx-1",
    });
    expect(launched.principalId).toMatch(/^panel:terminal-session-/);
    await call(h, "launch", testCtx(), { command: "/bin/sh", cols: 80, rows: 24 });
    expect(vi.mocked(h.deps.createContext).mock.calls.at(-1)![0]).toMatchObject({ testPolicy });
    await call(h, "launch", personCtx("terminal-apps/chat"), {
      source: "terminal-apps/chat",
      cols: 80,
      rows: 24,
    });
    expect(vi.mocked(h.deps.createContext).mock.calls.at(-1)![0]).not.toHaveProperty("testPolicy");
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
