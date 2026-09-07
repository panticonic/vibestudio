import { describe, expect, it, vi } from "vitest";
import { createRpcClient, isRpcConnectionLost, type RpcEnvelope } from "@vibestudio/rpc";
import { UiSessions, type UiIpcRuntime } from "./uiSessions.js";
import type { HostUiSession } from "./serverClient.js";

const caller = {
  callerId: "native-system-app",
  runtimeId: "shell-app",
  workspaceId: "system",
  callerKind: "app" as const,
};
const request: RpcEnvelope = {
  from: "shell-app",
  target: "worker:context:branch",
  destination: { kind: "workspace", workspaceId: "project" },
  delivery: { caller: { callerId: "forged", callerKind: "server" } },
  provenance: [],
  message: { type: "request", requestId: "r1", fromId: "shell-app", method: "read", args: [] },
};
function setup() {
  let listener: ((envelope: RpcEnvelope) => void) | undefined;
  const session: HostUiSession = {
    send: vi.fn(),
    close: vi.fn(async () => {}),
    isClosed: () => false,
    onMessage: vi.fn((next) => {
      listener = next;
      return vi.fn();
    }),
  };
  const runtime = {
    destination: { kind: "workspace", workspaceId: "project" },
    serverClient: { openHostUiSession: vi.fn(async () => session) },
  } as unknown as UiIpcRuntime;
  const resolve = vi.fn(async () => runtime as UiIpcRuntime | null);
  const deliver = vi.fn();
  const directory = new UiSessions(resolve, deliver);
  return {
    session,
    runtime,
    resolve,
    deliver,
    directory,
    incoming: (envelope: RpcEnvelope) => listener?.(envelope),
  };
}

function rendererClient(fixture: ReturnType<typeof setup>) {
  const listeners = new Set<(envelope: RpcEnvelope) => void>();
  fixture.deliver.mockImplementation((_caller, envelope: RpcEnvelope) => {
    for (const listener of listeners) listener(envelope);
  });
  return createRpcClient({
    selfId: caller.runtimeId,
    workspaceId: caller.workspaceId,
    callerKind: "shell",
    transport: {
      send: async (envelope) => {
        const runtime = await fixture.directory.require(caller, envelope.destination!);
        const session = await fixture.directory.session(caller, runtime);
        await session.send(fixture.directory.envelope(caller, runtime, envelope));
      },
      onMessage(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  });
}
describe("UiSessions", () => {
  it("carries hub traffic on its admitted owner session without inventing a workspace", async () => {
    const { directory, runtime, incoming, deliver } = setup();
    runtime.destination = { kind: "hub" };
    await directory.session(caller, runtime);
    const sent = directory.envelope(caller, runtime, {
      ...request,
      destination: { kind: "hub" },
      target: "main",
    });
    expect(sent.destination).toBeUndefined();
    expect(sent.delivery.caller).toEqual({ callerId: "shell-app", callerKind: "shell" });
    incoming({ ...request, message: { type: "response", requestId: "r1", result: "approved" } });
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
    expect(deliver.mock.calls[0]?.[1]).toMatchObject({
      from: "hub",
      destination: { kind: "workspace", workspaceId: "system" },
      delivery: { caller: { callerId: "hub", callerKind: "server" } },
    });
    expect(deliver.mock.calls[0]?.[1].delivery.caller.workspaceId).toBeUndefined();
    await directory.close();
  });

  it("cannot admit a workspace named hub as the hub owner", async () => {
    const { directory, runtime } = setup();
    runtime.destination = { kind: "workspace", workspaceId: "hub" };
    await expect(directory.admit(caller, { kind: "hub" })).rejects.toThrow("another owner");
    expect(runtime.serverClient.openHostUiSession).not.toHaveBeenCalled();
    await directory.close();
  });

  it("preserves exact target and full protocol while replacing renderer authority", async () => {
    const { directory, runtime, session } = setup();
    expect(await directory.admit(caller, { kind: "workspace", workspaceId: "project" })).toBe(
      runtime
    );
    const admittedSession = await directory.session(caller, runtime);
    expect(admittedSession).not.toBe(session);
    const sent = directory.envelope(caller, runtime, request);
    expect(sent.target).toBe("worker:context:branch");
    expect(sent.destination).toEqual({ kind: "workspace", workspaceId: "project" });
    expect(sent.delivery.caller).toEqual({
      callerId: "shell-app",
      callerKind: "shell",
      workspaceId: "project",
    });
    expect(sent.message).toEqual(request.message);
    await directory.close();
  });
  it("qualifies callback and event delivery without changing protocol messages", async () => {
    const { directory, runtime, incoming, deliver } = setup();
    await directory.session(caller, runtime);
    incoming(request);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalled());
    expect(deliver.mock.calls[0]?.[1]).toMatchObject({
      target: "shell-app",
      destination: { kind: "workspace", workspaceId: "system" },
      delivery: { caller: { workspaceId: "project" } },
      message: request.message,
    });
    await directory.close();
  });
  it("rechecks admission on incoming traffic and closes revoked sessions", async () => {
    const { directory, runtime, session, resolve, incoming, deliver } = setup();
    await directory.session(caller, runtime);
    resolve.mockRejectedValue(new Error("membership revoked"));
    incoming(request);
    await vi.waitFor(() => expect(session.close).toHaveBeenCalledOnce());
    expect(deliver).not.toHaveBeenCalled();
    await directory.close();
  });
  it("rejects a pending call when its own response discovers revoked admission", async () => {
    const fixture = setup();
    const rpc = rendererClient(fixture);
    const call = rpc.call("main", "workspace.read", [], {
      destination: fixture.runtime.destination,
    });
    await vi.waitFor(() => expect(fixture.session.send).toHaveBeenCalledOnce());
    const sent = vi.mocked(fixture.session.send).mock.calls[0]![0];
    if (sent.message.type !== "request") throw new Error("Expected an RPC request");
    fixture.resolve.mockRejectedValue(new Error("membership revoked"));
    fixture.incoming({
      ...sent,
      from: sent.target,
      target: sent.from,
      message: {
        type: "response",
        requestId: sent.message.requestId,
        result: "must not be delivered",
      },
    });

    await expect(call).rejects.toMatchObject({ code: "CONNECTION_LOST" });
    expect(fixture.session.close).toHaveBeenCalledOnce();
    await fixture.directory.close();
  });
  it("rejects a pending call when its response discovers a replacement owner", async () => {
    const fixture = setup();
    const rpc = rendererClient(fixture);
    const call = rpc.call("main", "workspace.read", [], {
      destination: fixture.runtime.destination,
    });
    await vi.waitFor(() => expect(fixture.session.send).toHaveBeenCalledOnce());
    const sent = vi.mocked(fixture.session.send).mock.calls[0]![0];
    if (sent.message.type !== "request") throw new Error("Expected an RPC request");
    fixture.resolve.mockResolvedValue({
      ...fixture.runtime,
      serverClient: { openHostUiSession: vi.fn() },
    } as unknown as UiIpcRuntime);
    fixture.incoming({
      ...sent,
      from: sent.target,
      target: sent.from,
      message: { type: "response", requestId: sent.message.requestId, result: "stale" },
    });

    await expect(call).rejects.toMatchObject({ code: "CONNECTION_LOST" });
    expect(fixture.session.close).toHaveBeenCalledOnce();
    await fixture.directory.close();
  });
  it("rejects pending renderer calls and streams when admission is revoked", async () => {
    const fixture = setup();
    const rpc = rendererClient(fixture);
    const options = { destination: fixture.runtime.destination };
    const call = rpc.call("main", "workspace.read", [], options);
    await vi.waitFor(() => expect(fixture.session.send).toHaveBeenCalledOnce());
    const stream = rpc.stream("main", "gateway.fetch", [], options);
    await vi.waitFor(() => expect(fixture.session.send).toHaveBeenCalledTimes(2));

    fixture.resolve.mockResolvedValue(null);
    await fixture.directory.admit(caller, fixture.runtime.destination);

    await expect(call).rejects.toMatchObject({
      code: "CONNECTION_LOST",
      errorKind: "transport",
    });
    await expect(stream).rejects.toMatchObject({
      code: "CONNECTION_LOST",
      errorKind: "transport",
    });
    expect(fixture.session.close).toHaveBeenCalledOnce();
    await fixture.directory.close();
  });
  it("aborts only the replaced owner's native readable streams", async () => {
    const fixture = setup();
    const projectAbort = vi.fn();
    fixture.session.streamReadable = vi.fn(
      (_envelope, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              projectAbort();
              reject(new Error("project stream aborted"));
            },
            { once: true }
          );
        })
    ) as HostUiSession["streamReadable"];
    const projectSession = await fixture.directory.session(caller, fixture.runtime);
    const projectStream = projectSession.streamReadable!(request, null, null);

    const siblingSession = {
      ...fixture.session,
      close: vi.fn(async () => {}),
      streamReadable: vi.fn(
        () =>
          new Promise(() => {
            /* A distinct workspace owner remains live. */
          })
      ),
    };
    const siblingRuntime = {
      destination: { kind: "workspace", workspaceId: "sibling" },
      serverClient: { openHostUiSession: vi.fn(async () => siblingSession) },
    } as unknown as UiIpcRuntime;
    await fixture.directory.session(caller, siblingRuntime);
    const sibling = (await fixture.directory.session(caller, siblingRuntime)).streamReadable!(
      { ...request, destination: siblingRuntime.destination },
      null,
      null
    );

    const replacement = {
      ...fixture.runtime,
      serverClient: {
        openHostUiSession: vi.fn(async () => ({
          send: vi.fn(),
          close: vi.fn(async () => {}),
          isClosed: () => false,
          onMessage: vi.fn(() => vi.fn()),
        })),
      },
    } as unknown as UiIpcRuntime;
    await fixture.directory.session(caller, replacement);

    await expect(projectStream).rejects.toThrow("project stream aborted");
    expect(projectAbort).toHaveBeenCalledOnce();
    expect(siblingSession.close).not.toHaveBeenCalled();
    void sibling.catch(() => undefined);
    await fixture.directory.close();
  });
  it("errors an active native response body when its admission is revoked", async () => {
    const fixture = setup();
    fixture.session.streamReadable = vi.fn(async (_envelope, signal) => ({
      status: 200,
      statusText: "OK",
      headers: [] as [string, string][],
      finalUrl: "https://example.test/data",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener(
            "abort",
            () => controller.error(new Error("active body aborted")),
            { once: true }
          );
        },
      }),
    })) as HostUiSession["streamReadable"];
    const session = await fixture.directory.session(caller, fixture.runtime);
    const response = await session.streamReadable!(request, null, null);
    const reading = response.body.getReader().read();

    fixture.resolve.mockResolvedValue(null);
    await fixture.directory.admit(caller, fixture.runtime.destination);

    await expect(reading).rejects.toThrow("active body aborted");
    expect(fixture.session.close).toHaveBeenCalledOnce();
    await fixture.directory.close();
  });
  it("keeps an ended response attached until its duplex upload also finishes", async () => {
    const fixture = setup();
    let ownedSignal: AbortSignal | null | undefined;
    fixture.session.streamReadable = vi.fn(async (_envelope, signal) => {
      ownedSignal = signal;
      return {
        status: 204,
        statusText: "No Content",
        headers: [] as [string, string][],
        finalUrl: "https://example.test/upload",
        body: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
      };
    }) as HostUiSession["streamReadable"];
    const session = await fixture.directory.session(caller, fixture.runtime);
    const upload = new ReadableStream<Uint8Array>({
      start() {
        /* Deliberately remains open after the response ends. */
      },
    });
    const response = await session.streamReadable!(request, null, upload);
    await expect(response.body.getReader().read()).resolves.toEqual({
      done: true,
      value: undefined,
    });

    const replacement = {
      ...fixture.runtime,
      serverClient: {
        openHostUiSession: vi.fn(async () => ({
          send: vi.fn(),
          close: vi.fn(async () => {}),
          isClosed: () => false,
          onMessage: vi.fn(() => vi.fn()),
        })),
      },
    } as unknown as UiIpcRuntime;
    await fixture.directory.session(caller, replacement);

    expect(ownedSignal?.aborted).toBe(true);
    await fixture.directory.close();
  });
  it("aborts an unfinished upload when the native response body errors", async () => {
    const fixture = setup();
    let responseController!: ReadableStreamDefaultController<Uint8Array>;
    let ownedSignal: AbortSignal | null | undefined;
    fixture.session.streamReadable = vi.fn(async (_envelope, signal) => {
      ownedSignal = signal;
      return {
        status: 200,
        statusText: "OK",
        headers: [] as [string, string][],
        finalUrl: "https://example.test/upload",
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            responseController = controller;
          },
        }),
      };
    }) as HostUiSession["streamReadable"];
    const uploadCancelled = vi.fn();
    const upload = new ReadableStream<Uint8Array>({ cancel: uploadCancelled });
    const session = await fixture.directory.session(caller, fixture.runtime);
    const response = await session.streamReadable!(request, null, upload);
    const reading = response.body.getReader().read();

    responseController.error(new Error("remote stream failed"));

    await expect(reading).rejects.toThrow("remote stream failed");
    await vi.waitFor(() => expect(uploadCancelled).toHaveBeenCalledOnce());
    expect(ownedSignal?.aborted).toBe(true);
    await fixture.directory.close();
  });
  it("rejects a pending renderer call before replacing its owner session", async () => {
    const fixture = setup();
    const rpc = rendererClient(fixture);
    const call = rpc.call("main", "workspace.read", [], {
      destination: fixture.runtime.destination,
    });
    await vi.waitFor(() => expect(fixture.session.send).toHaveBeenCalledOnce());
    const replacement = {
      ...fixture.runtime,
      serverClient: {
        openHostUiSession: vi.fn(async () => ({
          send: vi.fn(),
          close: vi.fn(async () => {}),
          isClosed: () => false,
          onMessage: vi.fn(() => vi.fn()),
        })),
      },
    } as unknown as UiIpcRuntime;

    await fixture.directory.session(caller, replacement);

    await expect(call).rejects.toMatchObject({ code: "CONNECTION_LOST" });
    expect(fixture.session.close).toHaveBeenCalledOnce();
    await fixture.directory.close();
  });
  it("does not open sessions for ordinary apps or accept mismatched admission", async () => {
    const { directory, runtime, resolve } = setup();
    resolve.mockResolvedValueOnce(null);
    await expect(
      directory.require(caller, { kind: "workspace", workspaceId: "project" })
    ).rejects.toThrow("not admitted");
    await expect(
      directory.admit(caller, { kind: "workspace", workspaceId: "other" })
    ).rejects.toThrow("another owner");
    expect(runtime.serverClient.openHostUiSession).not.toHaveBeenCalled();
    await directory.close();
  });
  it("closes a session that finishes opening after renderer destruction", async () => {
    const { directory, runtime, session } = setup();
    let complete!: (session: HostUiSession) => void;
    vi.mocked(runtime.serverClient.openHostUiSession).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const opening = directory.session(caller, runtime);
    const rejection = expect(opening).rejects.toSatisfy(
      (error: unknown) =>
        isRpcConnectionLost(error) &&
        error instanceof Error &&
        error.message === "Workspace UI session was released while opening"
    );
    const closing = directory.closeCaller(caller.callerId);
    complete(session);
    await Promise.all([rejection, closing]);
    expect(session.close).toHaveBeenCalledOnce();
    await directory.close();
  });
});
