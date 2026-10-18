import { describe, expect, it } from "vitest";
import { ApprovalFeed, serveDeviceDriver, type DeviceDriverTransport } from "./deviceDriver.js";
import type { PendingApproval } from "./approvals.js";

function fixture() {
  const listeners = new Map<string, (payload: unknown) => void>();
  const calls: Array<{ service: string; method: string; args: unknown[] }> = [];
  const transport: DeviceDriverTransport = {
    async call(service, method, args) {
      calls.push({ service, method, args });
      return { accepted: true };
    },
    onDirectEvent(event, listener) {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
  };
  const request = (callId: string, op: string, args: unknown = [{}]) =>
    listeners.get("development:device-drive-request")!({ callId, op, args });
  const cancel = (callId: string) => listeners.get("development:device-drive-cancel")!({ callId });
  const answers = () =>
    calls
      .filter((c) => c.method === "answer")
      .map(
        (c) =>
          c.args[0] as {
            callId: string;
            outcome: { ok: boolean; value?: unknown; failure?: { message?: string } };
          }
      );
  const settled = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { transport, calls, request, cancel, answers, settled, listeners };
}

describe("serveDeviceDriver", () => {
  it("registers after it is listening and answers an operation with its value", async () => {
    const f = fixture();
    const driver = await serveDeviceDriver({
      transport: f.transport,
      deviceKind: "terminal",
      ops: { binDirectory: async () => "/bin" },
    });
    expect(f.calls[0]).toMatchObject({
      service: "deviceDriver",
      method: "register",
      args: [{ deviceKind: "terminal" }],
    });
    f.request("c1", "binDirectory");
    await f.settled();
    expect(f.answers()).toEqual([{ callId: "c1", outcome: { ok: true, value: "/bin" } }]);
    await driver.close();
  });

  it("answers an operation the device lacks, and a failing one, with a failure", async () => {
    const f = fixture();
    await serveDeviceDriver({
      transport: f.transport,
      deviceKind: "desktop",
      ops: {
        list: async () => {
          throw new Error("boom");
        },
      },
    });
    f.request("c1", "shell");
    f.request("c2", "list");
    await f.settled();
    const [a, b] = f.answers();
    expect(a!.outcome.ok).toBe(false);
    expect(a!.outcome.failure?.message).toMatch(/does not implement shell/u);
    expect(b!.outcome.failure?.message).toBe("boom");
  });

  it("aborts an operation the server cancelled, and does not answer it", async () => {
    const f = fixture();
    let seen: AbortSignal | undefined;
    await serveDeviceDriver({
      transport: f.transport,
      deviceKind: "terminal",
      ops: {
        waitForText: (_args, signal) =>
          new Promise((_resolve, reject) => {
            seen = signal;
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      },
    });
    f.request("c1", "waitForText", [{ surfaceId: "s", text: "x" }]);
    await f.settled();
    f.cancel("c1");
    await f.settled();
    expect(seen?.aborted).toBe(true);
    expect(f.answers()).toEqual([]);
  });

  it("aborts and joins running operations when closed", async () => {
    const f = fixture();
    let finished = false;
    const driver = await serveDeviceDriver({
      transport: f.transport,
      deviceKind: "terminal",
      ops: {
        waitForText: (_args, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                finished = true;
                reject(signal.reason);
              },
              { once: true }
            );
          }),
      },
    });
    f.request("c1", "waitForText", [{ surfaceId: "s", text: "x" }]);
    await driver.close();
    expect(finished).toBe(true);
    expect(f.listeners.size).toBe(0);
  });
});

describe("ApprovalFeed", () => {
  const approval = (id: string) =>
    ({ approvalId: id, kind: "capability" }) as unknown as PendingApproval;

  it("hands each approval out once and wakes on a queue change", async () => {
    let pending = [approval("a1")];
    const feed = new ApprovalFeed(async () => pending);
    expect((await feed.next())?.approvalId).toBe("a1");
    const second = feed.next();
    pending = [approval("a1"), approval("a2")];
    feed.notify();
    expect((await second)?.approvalId).toBe("a2");
  });

  it("hands out an approval only once it is ready", async () => {
    const preparing = {
      approvalId: "a1",
      kind: "capability",
      lifecycle: { state: "preparing" },
    } as unknown as PendingApproval;
    let pending: PendingApproval[] = [preparing];
    const feed = new ApprovalFeed(async () => pending);
    const waiting = feed.next();
    await Promise.resolve();
    pending = [{ ...preparing, lifecycle: { state: "ready" } } as unknown as PendingApproval];
    feed.notify();
    expect((await waiting)?.approvalId).toBe("a1");
  });

  it("settles every waiter with null on release", async () => {
    const feed = new ApprovalFeed(async () => []);
    const waiting = feed.next();
    feed.release();
    expect(await waiting).toBeNull();
    expect(await feed.next()).toBeNull();
  });

  it("settles a waiter whose caller aborted, and does not hand it an approval", async () => {
    let pending: PendingApproval[] = [];
    const feed = new ApprovalFeed(async () => pending);
    const abort = new AbortController();
    const waiting = feed.next(abort.signal);
    const reason = new Error("test cancelled");
    abort.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    // The abandoned wait left nothing behind: the approval still goes to the next caller.
    pending = [approval("a1")];
    feed.notify();
    expect((await feed.next())?.approvalId).toBe("a1");
  });

  it("does not consume an approval read after its caller aborted", async () => {
    const abort = new AbortController();
    let reads = 0;
    const feed = new ApprovalFeed(async () => {
      if (reads++ === 0) abort.abort(new Error("gone"));
      return [approval("a1")];
    });
    await expect(feed.next(abort.signal)).rejects.toThrow("gone");
    expect((await feed.next())?.approvalId).toBe("a1");
  });
});

describe("a driver whose approval wait is pending", () => {
  it("is cancelled by the server and retires on close instead of waiting for an approval", async () => {
    const listeners = new Map<string, (payload: unknown) => void>();
    const answers: unknown[] = [];
    const feed = new ApprovalFeed(async () => []);
    const driver = await serveDeviceDriver({
      transport: {
        async call(_service, method, args) {
          if (method === "answer") answers.push(args[0]);
          return { accepted: true };
        },
        onDirectEvent(event, listener) {
          listeners.set(event, listener);
          return () => listeners.delete(event);
        },
      },
      deviceKind: "terminal",
      ops: { nextApproval: (_args, signal) => feed.next(signal) },
    });
    listeners.get("development:device-drive-request")!({
      callId: "c1",
      op: "nextApproval",
      args: [{}],
    });
    listeners.get("development:device-drive-request")!({
      callId: "c2",
      op: "nextApproval",
      args: [{}],
    });
    listeners.get("development:device-drive-cancel")!({ callId: "c1" });
    // c2 is still pending; closing must abort and join it.
    await driver.close();
    expect(answers).toEqual([]);
  });
});
