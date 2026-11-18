import { expect, it, vi } from "vitest";
import { migrateWorkspaceHistory } from "./workspaceHistoryMigration.js";

const source = {
  source: "workers/workspace-source",
  className: "GadWorkspaceDO",
  objectKey: "workspace",
};
const destination = { ...source, className: "GadHistoryDO", objectKey: "canonical" };
const main = { kind: "event", eventId: "event:main" } as const;
const working = { kind: "application", applicationId: "application:working" } as const;
const plan = {
  main,
  contexts: [{ id: "context:A", committed: main, working }],
  steps: [main, working],
};

it("replays onto one destination and returns the exact migrated context after a lost reply", async () => {
  const nextByStep = new Map<unknown, string>([
    [main, "installed-main"],
    [working, "installed-working"],
  ]);
  let lost = true;
  const dispatch = vi.fn(async (target, method, input) => {
    if (target === source && method === "exportHistoryReplayPlan") return plan;
    if (target === source && method === "exportHistoryReplayStep") {
      return { step: { kind: input.kind, record: input } };
    }
    if (target === destination && method === "stageHistoryReplayStep") {
      return { head: nextByStep.get(input.step.kind === "event" ? main : working) };
    }
    if (target === destination && method === "finishHistoryReplay") {
      if (lost) {
        lost = false;
        throw new Error("Lost publication reply");
      }
      return { head: input.head };
    }
    throw new Error(`Unexpected migration operation ${method}`);
  });
  const args = { dispatch: { dispatch }, source, destination };
  await expect(migrateWorkspaceHistory(args)).rejects.toThrow("Lost publication reply");
  await expect(migrateWorkspaceHistory(args)).resolves.toEqual({
    main: "installed-main",
    contexts: [{ id: "context:A", committed: "installed-main", working: "installed-working" }],
  });
  expect(dispatch.mock.calls.filter(([, method]) => method === "finishHistoryReplay")).toEqual([
    [destination, "finishHistoryReplay", { eventId: main.eventId, head: "installed-main" }],
    [destination, "finishHistoryReplay", { eventId: main.eventId, head: "installed-main" }],
  ]);
});

it("keeps a replay staged if the source advances before installation", async () => {
  let reads = 0;
  const dispatch = vi.fn(async (_target, method, input) => {
    if (method === "exportHistoryReplayPlan") {
      return reads++ === 0 ? plan : { ...plan, contexts: [] };
    }
    if (method === "exportHistoryReplayStep") return { step: { kind: input.kind, record: input } };
    if (method === "stageHistoryReplayStep") return { head: "staged" };
    throw new Error(`Unexpected migration operation ${method}`);
  });
  await expect(
    migrateWorkspaceHistory({ dispatch: { dispatch }, source, destination })
  ).rejects.toThrow("Workspace source advanced during replay");
  expect(dispatch.mock.calls.some(([, method]) => method === "finishHistoryReplay")).toBe(false);
});
