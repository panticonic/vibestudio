import { describe, expect, it, vi } from "vitest";
import { isRpcConnectionLost, type RpcEnvelope } from "@vibestudio/rpc";
import { WorkspaceUiSessions, type WorkspaceIpcRuntime } from "./workspaceUiSessions.js";
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
    workspaceId: "project",
    serverClient: { openHostUiSession: vi.fn(async () => session) },
  } as unknown as WorkspaceIpcRuntime;
  const resolve = vi.fn(async () => runtime as WorkspaceIpcRuntime | null);
  const deliver = vi.fn();
  const directory = new WorkspaceUiSessions(resolve, deliver);
  return {
    session,
    runtime,
    resolve,
    deliver,
    directory,
    incoming: (envelope: RpcEnvelope) => listener?.(envelope),
  };
}
describe("WorkspaceUiSessions", () => {
  it("preserves exact target and full protocol while replacing renderer authority", async () => {
    const { directory, runtime, session } = setup();
    expect(await directory.admit(caller, "project")).toBe(runtime);
    expect(await directory.session(caller, runtime)).toBe(session);
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
  it("does not open sessions for ordinary apps or accept mismatched admission", async () => {
    const { directory, runtime, resolve } = setup();
    resolve.mockResolvedValueOnce(null);
    await expect(directory.require(caller, "project")).rejects.toThrow("not admitted");
    await expect(directory.admit(caller, "other")).rejects.toThrow("another workspace");
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
