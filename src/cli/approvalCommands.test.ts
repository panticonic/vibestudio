import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventService } from "@vibestudio/shared/eventsService";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { encodeEventWatchRecord, type EventWatchRecord } from "@vibestudio/shared/events";
import { createApprovalQueue } from "../server/services/approvalQueue.js";
import { createShellApprovalService } from "../server/services/shellApprovalService.js";
import { approvalCommands } from "./approvalCommands.js";
import { parseInvocation } from "./commandTable.js";

const rpc = vi.hoisted(() => ({
  call: vi.fn(),
  callTarget: vi.fn(),
  streamReadable: vi.fn(),
  close: vi.fn(),
}));
const identity = vi.hoisted(() => vi.fn());
const openHub = vi.hoisted(() => vi.fn());
vi.mock("./rpcClient.js", () => ({
  RpcClient: vi.fn(function () {
    return rpc;
  }),
}));
vi.mock("./credentialStore.js", () => ({ loadCliIdentity: identity }));
vi.mock("./remoteClient.js", () => ({ openHubControlRpc: openHub }));

const base = {
  approvalId: "desktop-request",
  callerId: "panel:desktop-initiated",
  callerKind: "panel" as const,
  repoPath: "panels/example",
  effectiveVersion: "v1",
  requestedAt: 1,
  requestedByUserId: "alice",
};
const capability = {
  ...base,
  kind: "capability" as const,
  capability: "external.open",
  title: "Open external browser",
  allowedDecisions: ["once", "deny"] as const,
};

beforeEach(() => {
  vi.resetAllMocks();
  // An agent profile reaches only its workspace queue; device tests below add the hub.
  identity.mockReturnValue({ kind: "agent", workspaceName: "desktop-workspace" });
  rpc.close.mockResolvedValue(undefined);
  rpc.callTarget.mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function run(name: string, ...args: string[]): Promise<number> {
  const command = approvalCommands.find((candidate) => candidate.name === name)!;
  return command.run(parseInvocation(command, [...args, "--json"]), args);
}

function output(): unknown[] {
  return vi.mocked(console.log).mock.calls.map(([value]) => JSON.parse(String(value)));
}

describe("workspace approval CLI", () => {
  it("lists and shows desktop requests without an attached eval or caller filter", async () => {
    rpc.call.mockResolvedValue([capability]);
    expect(await run("list")).toBe(0);
    expect(await run("show", base.approvalId)).toBe(0);
    expect(output()).toEqual([
      [{ ...capability, source: "workspace" }],
      { ...capability, source: "workspace" },
    ]);
    expect(rpc.call.mock.calls).toEqual([
      ["shellApproval.listPending", []],
      ["shellApproval.listPending", []],
    ]);
    expect(rpc.close).toHaveBeenCalledTimes(2);
  });

  it("resolves the real waiting desktop operation through the existing queue", async () => {
    const events = new EventService();
    const scopeAccess = { isMember: (id: string) => id === "alice", isAdmin: () => false };
    const queue = createApprovalQueue({ eventService: events, scopeAccess });
    const service = createShellApprovalService({ approvalQueue: queue, scopeAccess });
    const context = {
      caller: {
        ...createVerifiedCaller("shell:external-cli", "shell"),
        subject: { userId: "alice", handle: "alice" },
      },
    };
    rpc.call.mockImplementation((method: string, args: unknown[]) =>
      service.handler(context, method.slice("shellApproval.".length), args)
    );
    const waiting = queue.request({ ...capability, allowedDecisions: ["once", "deny"] });
    try {
      expect(await run("list")).toBe(0);
      const id = queue.listPending()[0]!.approvalId;
      expect(await run("resolve", id, "once")).toBe(0);
      await expect(waiting).resolves.toBe("once");
      expect(queue.listPending()).toEqual([]);
      expect(await run("resolve", id, "once")).toBe(1);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining("No pending approval"));
    } finally {
      queue.cancelForCaller(base.callerId, new Error("test cleanup"));
      await waiting;
    }
  });

  it("preserves RPC rejection and closes the client", async () => {
    rpc.call.mockRejectedValue(new Error("not authorized to decide this request"));
    expect(await run("resolve", base.approvalId, "once")).toBe(1);
    expect(output()).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("not authorized"));
    expect(rpc.close).toHaveBeenCalledOnce();
  });

  it("rejects malformed responses before making a request", async () => {
    expect(await run("resolve", base.approvalId, "yes")).toBe(2);
    expect(await run("review", base.approvalId, '{"decision":"install"}')).toBe(2);
    expect(await run("rules", base.approvalId, '{"decision":"accept","selected":"all"}')).toBe(2);
    expect(await run("submit", base.approvalId, '{"token":42}')).toBe(2);
    expect(await run("review", base.approvalId, "{}", "--input")).toBe(2);
    expect(rpc.call).not.toHaveBeenCalled();
    expect(rpc.close).toHaveBeenCalledTimes(5);
  });

  it("passes exact offered review and rules selections to their typed methods", async () => {
    const receipt = {
      approvalId: "review-1",
      mode: "update",
      decision: "accepted",
      heading: "Updating parts",
      parts: [],
    };
    rpc.call.mockImplementation(async (method: string) => {
      if (method === "shellApproval.listPending") {
        return ["review-1", "rules-1"].map((approvalId) => ({ ...capability, approvalId }));
      }
      return method === "shellApproval.resolveInstallReview" ? receipt : undefined;
    });
    const review = {
      decision: "update",
      allowNow: [{ identityKey: "part-1", permissions: ["row-1"] }],
    };
    const rules = { decision: "accept", selected: ["facet-1"] };
    expect(await run("review", "review-1", JSON.stringify(review))).toBe(0);
    expect(await run("rules", "rules-1", JSON.stringify(rules))).toBe(0);
    expect(
      rpc.call.mock.calls.filter(([method]) => method !== "shellApproval.listPending")
    ).toEqual([
      ["shellApproval.resolveInstallReview", ["review-1", review]],
      ["shellApproval.resolveTaskRules", ["rules-1", rules]],
    ]);
    expect(output()[0]).toEqual(receipt);
  });

  it.each([
    ["client-config", "submitClientConfig"],
    ["credential-input", "submitCredentialInput"],
    ["secret-input", "submitSecretInput"],
  ])("submits %s fields without echoing their values", async (kind, method) => {
    const prompt = {
      ...base,
      kind,
      title: "Enter provider token",
      fields: [{ name: "token", label: "Token", type: "secret", required: true }],
      ...(kind === "client-config"
        ? {
            configId: "provider",
            authorizeUrl: "https://provider.test/auth",
            tokenUrl: "https://provider.test/token",
          }
        : {}),
      ...(kind === "credential-input"
        ? {
            credentialLabel: "Provider",
            audience: [],
            injection: { type: "header", name: "authorization", valueTemplate: "Bearer {token}" },
            accountIdentity: { providerUserId: "provider-account" },
            scopes: [],
          }
        : {}),
    };
    rpc.call.mockImplementation(async (called: string) =>
      called === "shellApproval.listPending" ? [prompt] : undefined
    );
    expect(await run("submit", base.approvalId, '{"token":"sensitive-value"}')).toBe(0);
    expect(rpc.call).toHaveBeenLastCalledWith(`shellApproval.${method}`, [
      base.approvalId,
      { token: "sensitive-value" },
    ]);
    expect(output()).toEqual([{ approvalId: base.approvalId, decision: "submit" }]);
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain("sensitive-value");
  });

  it("reads protected values from stdin without including them in output", async () => {
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () {
      yield Buffer.from('{"token":"stdin-secret"}');
      return undefined;
    });
    rpc.call.mockImplementation(async (method: string) =>
      method === "shellApproval.listPending"
        ? [
            {
              ...base,
              kind: "secret-input",
              title: "Enter token",
              fields: [{ name: "token", label: "Token", type: "secret", required: true }],
            },
          ]
        : undefined
    );
    expect(await run("submit", base.approvalId, "--input")).toBe(0);
    expect(rpc.call).toHaveBeenLastCalledWith("shellApproval.submitSecretInput", [
      base.approvalId,
      { token: "stdin-secret" },
    ]);
    expect(output()).toEqual([{ approvalId: base.approvalId, decision: "submit" }]);
  });

  it("rejects field submission to a decision prompt", async () => {
    rpc.call.mockResolvedValue([capability]);
    expect(await run("submit", base.approvalId, '{"value":"anything"}')).toBe(2);
    expect(rpc.call).toHaveBeenCalledTimes(1);
  });

  it("requires pairing without opening a connection", async () => {
    identity.mockReturnValue(null);
    expect(await run("watch")).toBe(3);
    expect(await run("list")).toBe(3);
    expect(openHub).not.toHaveBeenCalled();
    expect(rpc.streamReadable).not.toHaveBeenCalled();
    expect(rpc.call).not.toHaveBeenCalled();
  });
});

function finiteStream(records: EventWatchRecord[]): import("@vibestudio/rpc").DecodedFramedStream {
  return {
    status: 200,
    statusText: "OK",
    headers: [],
    finalUrl: "",
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const record of records) controller.enqueue(encodeEventWatchRecord(record));
        controller.close();
      },
    }),
  };
}

const hubReview = {
  ...base,
  approvalId: "hub-revoke",
  callerId: "shell:cli-device",
  kind: "capability" as const,
  capability: "devices.revoke",
  title: "Revoke device",
  allowedDecisions: ["once", "deny"] as const,
};

function hubRpc() {
  return { call: vi.fn(), streamReadable: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
}

describe("hub approvals for a paired device", () => {
  let hub: ReturnType<typeof hubRpc>;
  beforeEach(() => {
    hub = hubRpc();
    openHub.mockResolvedValue(hub);
    identity.mockReturnValue({ kind: "device", phase: "workspace", workspaceName: "w" });
  });

  it("lists hub and workspace approvals together, labelled by source", async () => {
    rpc.call.mockResolvedValue([capability]);
    hub.call.mockResolvedValue([hubReview]);
    expect(await run("list")).toBe(0);
    expect(output()).toEqual([
      [
        { ...capability, source: "workspace" },
        { ...hubReview, source: "hub" },
      ],
    ]);
    expect(rpc.close).toHaveBeenCalledOnce();
    expect(hub.close).toHaveBeenCalledOnce();
  });

  it("routes a decision to the queue that owns the approval", async () => {
    rpc.call.mockResolvedValue([capability]);
    hub.call.mockImplementation(async (method: string) =>
      method === "shellApproval.listPending" ? [hubReview] : undefined
    );
    expect(await run("resolve", hubReview.approvalId, "once")).toBe(0);
    expect(hub.call).toHaveBeenCalledWith("shellApproval.resolve", ["hub-revoke", "once"]);
    expect(rpc.call).not.toHaveBeenCalledWith("shellApproval.resolve", expect.anything());
    expect(await run("resolve", "missing", "once")).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("No pending approval"));
  });

  it("serves an account-phase device from the hub alone", async () => {
    identity.mockReturnValue({ kind: "device", phase: "account" });
    hub.call.mockResolvedValue([hubReview]);
    expect(await run("list")).toBe(0);
    expect(output()).toEqual([[{ ...hubReview, source: "hub" }]]);
    expect(rpc.call).not.toHaveBeenCalled();
  });

  it("closes the workspace connection when the hub cannot be reached", async () => {
    openHub.mockRejectedValue(new Error("hub unreachable"));
    expect(await run("list")).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("hub unreachable"));
    expect(rpc.close).toHaveBeenCalledOnce();
  });

  it("watches both queues, tags records by source, and joins both on stop", async () => {
    const watching = { kind: "watching", events: ["shell-approval:pending-changed"], epoch: "e" };
    const snapshot = (pending: unknown[]) => ({
      kind: "snapshot",
      event: "shell-approval:pending-changed",
      sequence: 0,
      payload: { pending },
    });
    const open =
      (records: unknown[]) =>
      async (_t: string, _m: string, _a: unknown[], { signal }: { signal: AbortSignal }) => ({
        status: 200,
        statusText: "OK",
        headers: [],
        finalUrl: "",
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            for (const record of records) {
              controller.enqueue(encodeEventWatchRecord(record as EventWatchRecord));
            }
            signal.addEventListener("abort", () => controller.close());
          },
        }),
      });
    rpc.streamReadable.mockImplementation(open([watching, snapshot([capability])]));
    hub.streamReadable.mockImplementation(open([watching, snapshot([hubReview])]));
    const seen: Array<{ source: string; kind: string }> = [];
    vi.mocked(console.log).mockImplementation((line) => {
      seen.push(JSON.parse(String(line)));
      if (seen.filter((r) => r.kind === "snapshot").length === 2) process.emit("SIGTERM");
    });
    expect(await run("watch")).toBe(0);
    expect(seen.map((r) => r.source).sort()).toEqual(["hub", "hub", "workspace", "workspace"]);
    expect(rpc.close).toHaveBeenCalledOnce();
    expect(hub.close).toHaveBeenCalledOnce();
  });

  it("propagates one queue's watch failure and stops the other", async () => {
    const hang = async (
      _t: string,
      _m: string,
      _a: unknown[],
      { signal }: { signal: AbortSignal }
    ) => ({
      status: 200,
      statusText: "OK",
      headers: [],
      finalUrl: "",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener("abort", () => controller.close());
        },
      }),
    });
    rpc.streamReadable.mockImplementation(hang);
    hub.streamReadable.mockRejectedValue(new Error("hub watch failed"));
    expect(await run("watch")).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("hub watch failed"));
    expect(rpc.close).toHaveBeenCalledOnce();
    expect(hub.close).toHaveBeenCalledOnce();
  });
});

describe("approval watch ownership", () => {
  it("streams existing desktop prompts and subsequent changes, then cancels and joins on SIGTERM", async () => {
    const events = new EventService();
    let released = false;
    const records: unknown[] = [];
    const initialSigint = process.listenerCount("SIGINT");
    const initialSigterm = process.listenerCount("SIGTERM");
    rpc.streamReadable.mockImplementation(
      async (_target, _method, [topics, watchId], { signal }) => {
        const response = events.openWatch({
          callerId: "shell:external-cli",
          callerKind: "shell",
          connectionId: "cli-watch",
          watchId,
          userId: "alice",
          events: topics,
          snapshots: { "shell-approval:pending-changed": () => [{ pending: [capability] }] },
          onClosed: () => {
            released = true;
          },
        });
        return {
          status: 200,
          statusText: "OK",
          headers: [],
          finalUrl: "",
          body: response.body!.pipeThrough(new TransformStream(), { signal }),
        };
      }
    );
    vi.mocked(console.log).mockImplementation((line) => {
      const record = JSON.parse(String(line));
      records.push(record);
      if (record.kind === "snapshot") {
        events.emit("shell-approval:pending-changed", { pending: [] });
      } else if (record.kind === "event") {
        process.emit("SIGTERM");
      }
    });
    expect(await run("watch")).toBe(0);
    expect(records).toEqual([
      expect.objectContaining({ kind: "watching", epoch: expect.any(String) }),
      expect.objectContaining({ kind: "snapshot", payload: { pending: [capability] } }),
      expect.objectContaining({ kind: "event", payload: { pending: [] } }),
    ]);
    expect(released).toBe(true);
    expect(rpc.streamReadable).toHaveBeenCalledWith(
      "main",
      "events.watch",
      [["shell-approval:pending-changed", "shell-approval:resolved"], expect.any(String)],
      { signal: expect.any(AbortSignal), bodyIdleTimeoutMs: null }
    );
    expect(rpc.streamReadable.mock.calls[0]![3].signal.aborted).toBe(true);
    expect(rpc.close).toHaveBeenCalledOnce();
    expect(process.listenerCount("SIGINT")).toBe(initialSigint);
    expect(process.listenerCount("SIGTERM")).toBe(initialSigterm);
  });

  it("fails on unexpected termination rather than leaving a stranded watcher", async () => {
    rpc.streamReadable.mockResolvedValue(
      finiteStream([
        { kind: "watching", events: ["shell-approval:pending-changed"], epoch: "epoch-1" },
        {
          kind: "snapshot",
          event: "shell-approval:pending-changed",
          sequence: 0,
          payload: { pending: [] },
        },
      ])
    );
    expect(await run("watch")).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("closed unexpectedly"));
    expect(rpc.close).toHaveBeenCalledOnce();
  });

  it("propagates the original streamReadable failure and closes its client", async () => {
    rpc.streamReadable.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: [],
      finalUrl: "",
      body: new ReadableStream({
        start(controller) {
          controller.error(new Error("provider disconnected"));
        },
      }),
    });
    expect(await run("watch")).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("provider disconnected"));
    expect(rpc.close).toHaveBeenCalledOnce();
  });

  it("cancels a streamReadable that violates acknowledgement order", async () => {
    const cancel = vi.fn();
    rpc.streamReadable.mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: [],
      finalUrl: "",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            encodeEventWatchRecord({
              kind: "event",
              event: "shell-approval:pending-changed",
              sequence: 1,
              payload: { pending: [] },
            })
          );
        },
        cancel,
      }),
    });
    expect(await run("watch")).toBe(1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("before its acknowledgement")
    );
    expect(rpc.close).toHaveBeenCalledOnce();
  });
});
