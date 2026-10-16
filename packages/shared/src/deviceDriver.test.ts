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
  const answers = () => calls.filter((c) => c.method === "answer").map((c) => c.args[0] as { callId: string; outcome: { ok: boolean; value?: unknown; failure?: { message?: string } } });
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
    expect(f.calls[0]).toMatchObject({ service: "deviceDriver", method: "register", args: [{ deviceKind: "terminal" }] });
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
  const approval = (id: string) => ({ approvalId: id, kind: "capability" }) as unknown as PendingApproval;

  it("hands each approval out once and wakes on a queue change", async () => {
    let pending = [approval("a1")];
    const feed = new ApprovalFeed(async () => pending);
    expect((await feed.next())?.approvalId).toBe("a1");
    const second = feed.next();
    pending = [approval("a1"), approval("a2")];
    feed.notify();
    expect((await second)?.approvalId).toBe("a2");
  });

  it("settles every waiter with null on release", async () => {
    const feed = new ApprovalFeed(async () => []);
    const waiting = feed.next();
    feed.release();
    expect(await waiting).toBeNull();
    expect(await feed.next()).toBeNull();
  });
});
