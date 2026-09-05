import { parseLineageKey } from "@vibestudio/shared/authority/contextIntegrity";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import {
  createTestServiceDispatcher,
  testAuthority,
} from "@vibestudio/shared/serviceDispatcherTestUtils";
import { createHostTerminalService } from "./hostTerminalService.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { AcquisitionCoordinator } from "./acquisitionCoordinator.js";

const pty = vi.hoisted(() => ({
  spawn: vi.fn(),
  data: (_data: string) => {},
  exit: (_event: { exitCode: number }) => {},
  write: vi.fn(),
  kill: vi.fn(),
  resize: vi.fn(),
}));
vi.mock("node-pty", () => ({ default: { spawn: (...args: unknown[]) => pty.spawn(...args) } }));
const services: ReturnType<typeof createHostTerminalService>[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  vi.clearAllMocks();
});
function fixture() {
  pty.spawn.mockImplementation(() => ({
    pid: 123,
    onData: (fn: typeof pty.data) => {
      pty.data = fn;
      return { dispose() {} };
    },
    onExit: (fn: typeof pty.exit) => {
      pty.exit = fn;
      return { dispose() {} };
    },
    write: pty.write,
    resize: pty.resize,
    kill: () => {
      pty.kill();
      pty.exit({ exitCode: 0 });
    },
  }));
  const recordContextIngestion = vi.fn(async (_ctx: ServiceContext, input: { key: string }) => {
    parseLineageKey(input.key);
  });
  const service = createHostTerminalService({
    workspaceId: "workspace-a",
    host: "test-host",
    shell: "/bin/sh",
    args: [],
    cwd: "/home/test",
    environment: {},
    recordContextIngestion,
  });
  services.push(service);
  const caller = createVerifiedCaller(
    "panel-a",
    "panel",
    {
      callerId: "panel-a",
      callerKind: "panel",
      repoPath: "panels/terminal",
      effectiveVersion: "v1",
      executionDigest: "a".repeat(64),
      requested: [
        {
          capability: "host-terminal.open",
          resource: { kind: "prefix", prefix: "host-terminal:" },
        },
      ],
    },
    null,
    { userId: "alice", handle: "alice" }
  );
  const connection = new AbortController();
  const ctx: ServiceContext = {
    caller,
    connectionId: "connection-a",
    connectionSignal: connection.signal,
  };
  const prepare = service.authorityPreparation!["hostTerminal.open"]!;
  const approve = async () => {
    const prepared = await prepare(ctx, [{ columns: 80, rows: 24 }]);
    ctx.preparedAuthority = {
      resolver: "hostTerminal.open",
      digest: "test-approved-digest",
      payload: prepared.payload,
    };
    return (await service.handler(ctx, "open", [{ columns: 80, rows: 24 }])) as {
      terminalSessionId: string;
    };
  };
  return { service, ctx, connection, prepare, approve, recordContextIngestion };
}
describe("host terminal native receiver", () => {
  it("withholds a read if its connection retires while ingestion is recorded", async () => {
    const { service, ctx, connection, approve, recordContextIngestion } = fixture();
    const { terminalSessionId } = await approve();
    let finish!: () => void;
    recordContextIngestion.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    pty.data("host output");
    const reading = service.handler(ctx, "read", [{ terminalSessionId, after: 0 }]);
    await vi.waitFor(() => expect(recordContextIngestion).toHaveBeenCalledOnce());
    connection.abort();
    finish();
    await expect(reading).rejects.toThrow("live connection");
  });
  it("keeps UTF-8 intact when a large output chunk rolls scrollback forward", async () => {
    const { service, ctx, approve } = fixture();
    const { terminalSessionId } = await approve();
    pty.data("€".repeat(800_000));
    const output = (await service.handler(ctx, "read", [
      { terminalSessionId, after: 0, maxBytes: 4 },
    ])) as { text: string; cursor: number };
    expect(output.text).toBe("€");
    expect(output.cursor % 3).toBe(0);
    expect(output.cursor).toBeGreaterThan(0);
  });

  it("requires a new critical confirmation for every open through the real dispatcher", async () => {
    const { service, ctx } = fixture();
    const directory = mkdtempSync(join(tmpdir(), "host-terminal-authority-"));
    const grantStore = new CapabilityGrantStore({ statePath: directory });
    const requestWithHandle = vi.fn((_request: unknown) => ({
      approvalId: "test-host-terminal",
      decision: Promise.resolve("once" as const),
      resolution: Promise.resolve({
        decision: "once" as const,
        resolver: { subject: { userId: "alice", handle: "alice" }, via: "shell" as const },
      }),
    }));
    const acquisition = new AcquisitionCoordinator({
      approvalQueue: { requestWithHandle, cancelForCaller: vi.fn() } as never,
      grantStore,
    });
    const dispatcher = createTestServiceDispatcher();
    const authorityTime = Date.now();
    dispatcher.setAuthorityResolver(({ caller, capability, resourceKey }) => {
      const resolved = testAuthority(caller, capability, resourceKey, authorityTime);
      return capability === "host-terminal.open"
        ? {
            ...resolved,
            grants: grantStore.grantsForSubjects(
              [
                resolved.context.authorizingOrigin.principal,
                `session:${resolved.context.session.id}`,
              ],
              capability
            ),
          }
        : resolved;
    });
    dispatcher.setAuthorityAcquirer({
      request: (input) => acquisition.request(input),
      acquire: (input, signal) => acquisition.requestAndWait(input, signal),
      consume: (id) => acquisition.consume(id),
      invalidate: (digest, runtimeId, principal) =>
        acquisition.invalidate(digest, runtimeId, principal),
    });
    dispatcher.registerService(service);
    dispatcher.markInitialized();
    try {
      for (let count = 0; count < 2; count++) {
        const result = (await dispatcher.dispatch(
          { ...ctx, authorityAcquisition: "wait" },
          "hostTerminal",
          "open",
          [{ columns: 80, rows: 24 }]
        )) as { terminalSessionId: string };
        await service.handler(ctx, "close", [{ terminalSessionId: result.terminalSessionId }]);
      }
      expect(requestWithHandle).toHaveBeenCalledTimes(2);
      expect(pty.spawn).toHaveBeenCalledTimes(2);
      expect(requestWithHandle.mock.calls[0]?.[0]).toMatchObject({ severity: "severe" });
    } finally {
      await service.stop();
      grantStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("prepares severe host-specific consent and refuses unapproved launch", async () => {
    const { service, ctx, prepare } = fixture();
    const prepared = await prepare(ctx, [{ columns: 80, rows: 24 }]);
    expect(prepared.selections).toEqual([
      expect.objectContaining({
        capability: "host-terminal.open",
        resourceKey: "host-terminal:test-host:workspace-a",
        challenge: expect.objectContaining({
          severity: "severe",
          title: expect.stringContaining("test-host"),
          description: expect.stringContaining("credentials"),
        }),
      }),
    ]);
    await expect(service.handler(ctx, "open", [{ columns: 80, rows: 24 }])).rejects.toThrow(
      "approved prepared state"
    );
    const dispatcher = createTestServiceDispatcher();
    dispatcher.setAuthorityResolver(({ caller, capability, resourceKey }) => ({
      ...testAuthority(caller, capability, resourceKey),
      grants: [],
    }));
    dispatcher.registerService(service);
    dispatcher.markInitialized();
    await expect(
      dispatcher.dispatch(ctx, "hostTerminal", "open", [{ columns: 80, rows: 24 }])
    ).rejects.toThrow();
    expect(pty.spawn).not.toHaveBeenCalled();
  });
  it("binds controls to the approved connection and retires before cleanup", async () => {
    const { service, ctx, approve, recordContextIngestion } = fixture();
    const { terminalSessionId } = await approve();
    pty.data("abcdefgh");
    expect(
      await service.handler(ctx, "read", [{ terminalSessionId, after: 0, maxBytes: 4 }])
    ).toMatchObject({ text: "abcd", cursor: 4 });
    expect(
      await service.handler(ctx, "read", [{ terminalSessionId, after: 4, maxBytes: 4 }])
    ).toMatchObject({ text: "efgh", cursor: 8 });
    expect(recordContextIngestion).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ classification: "external" })
    );
    pty.data("αβγ");
    expect(
      await service.handler(ctx, "read", [{ terminalSessionId, after: 8, maxBytes: 5 }])
    ).toMatchObject({ text: "αβ", cursor: 12 });
    expect(
      await service.handler(ctx, "read", [{ terminalSessionId, after: 12, maxBytes: 5 }])
    ).toMatchObject({ text: "γ", cursor: 14 });
    for (const [method, args] of [
      ["read", { terminalSessionId, after: 0 }],
      ["write", { terminalSessionId, sequence: 1, data: "bad" }],
      ["resize", { terminalSessionId, columns: 80, rows: 24 }],
      ["close", { terminalSessionId }],
    ] as const) {
      await expect(
        service.handler(
          { ...ctx, connectionId: "other", connectionSignal: new AbortController().signal },
          method,
          [args]
        )
      ).rejects.toThrow("does not belong");
    }
    await service.handler(ctx, "write", [{ terminalSessionId, sequence: 1, data: "hello" }]);
    await service.handler(ctx, "write", [{ terminalSessionId, sequence: 1, data: "hello" }]);
    expect(pty.write).toHaveBeenCalledTimes(1);
    await expect(
      service.handler(ctx, "write", [{ terminalSessionId, sequence: 3, data: "gap" }])
    ).rejects.toThrow("in sequence");
    await expect(
      service.handler(ctx, "write", [{ terminalSessionId, sequence: 1, data: "changed" }])
    ).rejects.toThrow("reused");
    const closing = service.handler(ctx, "close", [{ terminalSessionId }]);
    await expect(service.handler(ctx, "read", [{ terminalSessionId, after: 0 }])).rejects.toThrow(
      "does not belong"
    );
    expect(await closing).toEqual({ processExited: true, descendantCleanup: "unverified" });
    expect(pty.kill).toHaveBeenCalledTimes(1);
  });
  it("retires disconnected callers without exposing their session to another connection", async () => {
    const { service, ctx, connection, approve } = fixture();
    const { terminalSessionId } = await approve();
    connection.abort();
    await expect(
      service.handler({ ...ctx, connectionSignal: new AbortController().signal }, "read", [
        { terminalSessionId, after: 0 },
      ])
    ).rejects.toThrow("does not belong");
  });
  it("rejects approval completion after disconnect or service shutdown", async () => {
    const { service, ctx, connection, prepare } = fixture();
    const prepared = await prepare(ctx, [{ columns: 80, rows: 24 }]);
    ctx.preparedAuthority = {
      resolver: "hostTerminal.open",
      digest: "test",
      payload: prepared.payload,
    };
    connection.abort();
    await expect(service.handler(ctx, "open", [{ columns: 80, rows: 24 }])).rejects.toThrow(
      "live connection"
    );
    ctx.connectionSignal = new AbortController().signal;
    const next = await prepare(ctx, [{ columns: 80, rows: 24 }]);
    ctx.preparedAuthority.payload = next.payload;
    await service.stop();
    await expect(service.handler(ctx, "open", [{ columns: 80, rows: 24 }])).rejects.toThrow(
      "live connection"
    );
    expect(pty.spawn).not.toHaveBeenCalled();
  });
});
