import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, it, expect, vi } from "vitest";
import { ProblemReportingStore } from "./store";
import { UsageAnalytics, sendUsageTransmission } from "./usage";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import {
  USAGE_DESTINATION,
  UsagePingSchema,
  type UsagePing,
} from "@vibestudio/service-schemas/usageAnalytics";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
  vi.useRealTimers();
});
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "usage-counters-"));
  const store = new ProblemReportingStore(directory);
  const send = vi.fn(async (_ping: UsagePing, _signal: AbortSignal, _owner: string) => {});
  let counted = false;
  const usage = new UsageAnalytics(store, send, () => {
    if (counted) return false;
    counted = true;
    return true;
  });
  cleanup.push(
    () => rmSync(directory, { recursive: true, force: true }),
    () => store.close(),
    () => usage.stop()
  );
  return { store, usage, send };
}
it("does not send detailed usage while undecided or off and never treats shell reload as another usage startup", async () => {
  const { store, usage, send } = setup();
  expect(store.consent("alice").state).toBe("undecided");
  expect(usage.startup("alice")).toEqual({ observed: true });
  expect(usage.startup("alice")).toEqual({ observed: false });
  usage.record("alice", "report-draft");
  usage.flush();
  await Promise.resolve();
  expect(send).not.toHaveBeenCalled();
  store.decide("alice", 0, "off", "shell");
  usage.changed("alice");
  usage.record("alice", "report-preview");
  usage.flush();
  await Promise.resolve();
  expect(send).not.toHaveBeenCalled();
});
it("batches fixed usage while opted in and discards buffered counters on opt-out", async () => {
  const { store, usage, send } = setup();
  store.decide("alice", 0, "on", "shell");
  usage.startup("alice");
  usage.record("alice", "report-draft");
  usage.record("alice", "report-draft");
  usage.flush();
  await Promise.resolve();
  expect(send.mock.calls.map((call) => call[0])).toEqual([
    { schema: "vibestudio.usage.v1", counts: { startup: 1, "report-draft": 2 } },
  ]);
  usage.record("alice", "report-preview");
  store.decide("alice", 1, "off", "shell");
  usage.changed("alice");
  usage.flush();
  await Promise.resolve();
  expect(send).toHaveBeenCalledTimes(1);
  expect(
    UsagePingSchema.safeParse({
      schema: "vibestudio.usage.v1",
      counts: { "report-draft": 1 },
      machineKey: "secret",
    }).success
  ).toBe(false);
});
it("does not retry lost acknowledgements and sends fixed aggregate JSON without credentials or signatures", async () => {
  const { store, usage, send } = setup();
  store.decide("alice", 0, "on", "shell");
  send.mockRejectedValue(new Error("lost ACK"));
  usage.startup("alice");
  usage.flush();
  await Promise.resolve();
  await Promise.resolve();
  usage.startup("alice");
  usage.flush();
  await Promise.resolve();
  expect(send).toHaveBeenCalledTimes(1);
  const forwardHostFetch = vi.fn(async () => ({
    status: 204,
    statusText: "",
    headerPairs: [],
    finalUrl: USAGE_DESTINATION,
    body: new Uint8Array(),
  }));
  const ping: UsagePing = { schema: "vibestudio.usage.v1", counts: { "report-draft": 1 } };
  await sendUsageTransmission(
    { forwardHostFetch },
    { userId: "local-owner", handle: "private-handle" },
    ping,
    new AbortController().signal
  );
  expect(forwardHostFetch).toHaveBeenCalledWith(
    expect.objectContaining({
      url: USAGE_DESTINATION,
      method: "POST",
      body: JSON.stringify(ping),
      headers: { "content-type": "application/json" },
      credentialId: null,
    })
  );
});
it("counts opted-in runtime minutes and stops collecting them after opt-out", async () => {
  vi.useFakeTimers();
  const { store, usage, send } = setup();
  store.decide("alice", 0, "on", "shell");
  usage.startup("alice");
  await vi.advanceTimersByTimeAsync(60000);
  expect(send.mock.calls.map((call) => call[0])).toContainEqual({
    schema: "vibestudio.usage.v1",
    counts: { startup: 1, "reporting-runtime-minutes": 1 },
  });
  store.decide("alice", 1, "off", "shell");
  usage.changed("alice");
  const count = send.mock.calls.length;
  await vi.advanceTimersByTimeAsync(120000);
  expect(send).toHaveBeenCalledTimes(count);
});
it("counts known completed operations without inspecting arguments or sending arbitrary service names", async () => {
  const { store, usage, send } = setup();
  store.decide("alice", 0, "on", "shell");
  const ctx = {
    caller: createVerifiedCaller("shell-one", "shell", null, null, {
      userId: "alice",
      handle: "alice",
    }),
  };
  usage.serviceCompleted({ ctx, service: "app", method: "openShellSurface" });
  usage.serviceCompleted({ ctx, service: "view", method: "browserNavigate" });
  usage.serviceCompleted({ ctx, service: "private-workspace-title", method: "secret-user-code" });
  usage.flush();
  await Promise.resolve();
  expect(send.mock.calls.map((call) => call[0])).toEqual([
    { schema: "vibestudio.usage.v1", counts: { "shell-surface-open": 1, "browser-navigation": 1 } },
  ]);
});
it("starts detailed counting after explicit opt-in and aborts in-flight detailed delivery when consent is revoked", async () => {
  const { store, usage, send } = setup();
  usage.startup("alice");
  await Promise.resolve();
  expect(send).not.toHaveBeenCalled();
  store.decide("alice", 0, "on", "shell");
  usage.changed("alice");
  send.mockImplementation(
    async (_ping, signal) =>
      new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      )
  );
  usage.flush();
  await Promise.resolve();
  expect(send).toHaveBeenCalledTimes(1);
  const signal = send.mock.calls[0]![1];
  expect(signal.aborted).toBe(false);
  store.decide("alice", 1, "off", "shell");
  usage.changed("alice");
  expect(signal.aborted).toBe(true);
});
