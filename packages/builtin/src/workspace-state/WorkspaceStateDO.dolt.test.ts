/**
 * WorkspaceStateDO as a Dolt cell: what the commit discipline gives
 * (docs/dolt-redesign.md §4.2, §4.5) that the behavior tests in
 * `WorkspaceStateDO.test.ts` do not look at. All against `FakeDoltStorage`; the
 * real engine is `src/server/workspaceStateCelld.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { createWorkspaceStateTestDO } from "./testFixture.js";
import type { UnitAuthorityManifest } from "@vibestudio/shared/authorityManifest";

const SOURCE = "panels/example";
const AUTHORITY: UnitAuthorityManifest = { provides: [], requests: [], serviceRequests: [] };

const panel = (key: string) => ({
  nativeOwner: null,
  durableWorkQueues: [],
  kind: "panel" as const,
  source: { repoPath: SOURCE, effectiveVersion: "v1" },
  contextId: "ctx-1",
  key,
  activeBuildKey: "b".repeat(64),
  activeExecutionDigest: "a".repeat(64),
  activeAuthority: AUTHORITY,
});

const entry = (entity: { key: string; id: string }) => ({
  entryKey: entity.key,
  entityId: entity.id,
  source: SOURCE,
  contextId: "ctx-1",
});

async function workspace() {
  const made = await createWorkspaceStateTestDO();
  const messages = () => made.fake.dolt.log().map((commit) => commit.message);
  const open = (slotId: string, parent: string | null = null) => {
    const entity = made.instance.entityActivate(panel(`${slotId}-entry`));
    made.instance.slotCreate({ slotId, parentSlotId: parent, initialEntry: entry(entity) });
    return entity;
  };
  return { ...made, messages, open };
}

describe("WorkspaceStateDO commit discipline", () => {
  it("is a Dolt cell whose schema install is the first commit", async () => {
    const { fake, messages } = await workspace();
    expect(fake.dolt.branch.current()).toBe("main");
    expect(messages().at(-2)).toBe("schema: WorkspaceStateDO v1");
  });

  it("commits every mutation once, with a message rendered from what it wrote, and leaves the working set clean", async () => {
    const { instance, fake, messages, open } = await workspace();
    open("slot-a");
    expect(messages().slice(0, 2)).toEqual([
      expect.stringMatching(/^create slot slot-a$/u),
      expect.stringMatching(/^activate panel panel:/u),
    ]);
    instance.slotClose("slot-a");
    expect(messages()[0]).toBe("close panel slot-a (1 slots)");
    expect(fake.dolt.status()).toEqual([]);
  });

  it("makes no commit for an idempotent retry, a failed mutation, or a read", async () => {
    const { instance, fake, messages, open } = await workspace();
    const entity = open("slot-a");
    const before = messages();
    instance.entityActivate(panel("slot-a-entry"));
    instance.slotClose("slot-a");
    const afterClose = messages();
    instance.slotClose("slot-a");
    expect(messages()).toEqual(afterClose);
    expect(afterClose.length).toBe(before.length + 1);
    expect(() => instance.slotCommitPreparedNavigation({
      slotId: "slot-a",
      expectedCurrentEntityId: entity.id,
      mutation: { kind: "append", entry: entry(entity) },
    })).toThrow();
    instance.slotGet("slot-a");
    instance.panelTreeRootGroups({ limit: 10 });
    expect(messages()).toEqual(afterClose);
    expect(fake.dolt.status()).toEqual([]);
  });

  it("commits a nested mutation (template initialization) as one commit", async () => {
    const { instance, messages } = await workspace();
    const before = messages().length;
    instance.initializePanels([{ source: SOURCE }, { source: "panels/second" }]);
    expect(messages().length).toBe(before + 1);
    expect(messages()[0]).toBe("initialize 2 template panels");
  });

  it("closes and reopens a panel as two commits, and the close is undone by resetting to its parent", async () => {
    const { instance, fake, open } = await workspace();
    open("slot-a");
    const beforeClose = fake.dolt.hashOf("HEAD");
    instance.slotClose("slot-a");
    const closeCommit = fake.dolt.hashOf("HEAD");
    expect(closeCommit).not.toBe(beforeClose);
    // The runtime's cleanup of the closed panel (an outbox, local) finishes; then it is listed.
    instance.slotCloseCleanupAck(["slot-a"]);
    expect(instance.slotClosedRoots({}).items.map((item) => item.slotId)).toEqual(["slot-a"]);

    // The reverse patch of the close commit is exactly the SQL that reopens it.
    const reverse = fake.dolt.diff({ from: closeCommit, to: beforeClose });
    expect(reverse.patch.map((entry) => entry.table)).toEqual(["slots"]);

    // Reopening goes through the class (it checks the runtime incarnations), and is its own commit.
    for (const { entry: history } of instance.slotReopenPlan("slot-a").slots) {
      instance.entityActivate(panel(history.entry_key));
    }
    instance.slotReopen({ slotId: "slot-a", closedAt: instance.slotGet("slot-a")!.closed_at! });
    expect(fake.dolt.log()[0]?.message).toBe("reopen panel slot-a (1 slots)");
    expect(instance.slotGet("slot-a")?.closed_at).toBeNull();

    // And a hard reset to the commit before the close is the undo of it, whole.
    instance.slotClose("slot-a");
    expect(instance.slotGet("slot-a")?.closed_at).not.toBeNull();
    fake.dolt.reset({ hard: true, to: beforeClose });
    expect(instance.slotGet("slot-a")?.closed_at).toBeNull();
    expect(instance.slotGet("slot-a")?.current_entity_id).not.toBeNull();
  });

  it("keeps operational state out of every commit, and a reset does not rewind it", async () => {
    const { instance, fake, open } = await workspace();
    open("slot-a");
    const base = fake.dolt.hashOf("HEAD");
    const key = { source: SOURCE, className: "MyDO", objectKey: "k1" };
    instance.entityActivate({
      nativeOwner: null,
      durableWorkQueues: [],
      kind: "do",
      source: { repoPath: SOURCE, effectiveVersion: "v1" },
      contextId: "ctx-1",
      className: key.className,
      key: key.objectKey,
      activeBuildKey: "b".repeat(64),
      activeExecutionDigest: "a".repeat(64),
      activeAuthority: AUTHORITY,
    });
    instance.alarmAdoptWorker("driver-1");
    instance.alarmSet({ ...key, wakeAt: 42_000 });
    instance.lifecycleLeaseUpsert({ ...key, detail: { turnId: "t" } });
    instance.slotClose("slot-a");
    const revision = instance.panelTreeRootGroups({ limit: 10 }).revision;

    // None of the operational tables is in a diff against the first state.
    const changed = fake.dolt.diff({ from: base, to: "HEAD" }).summary.map((entry) => entry.toTable);
    expect(changed).toEqual(expect.arrayContaining(["entities", "slots"]));
    expect(changed).not.toContain("do_alarms");
    expect(changed).not.toContain("lifecycle_leases");
    expect(changed).not.toContain("panel_close_cleanup");
    expect(changed).not.toContain("local_workspace_meta");

    fake.dolt.reset({ hard: true, to: base });
    expect(instance.alarmNextWakeAt(0)).toBe(42_000);
    expect(instance.lifecycleListLeases()).toHaveLength(1);
    expect(instance.slotCloseCleanupPage({}).items.map((item) => item.slotId)).toEqual(["slot-a"]);
    // The reader-visible revision never goes backwards, though the tree did.
    expect(instance.panelTreeRootGroups({ limit: 10 }).revision).toBeGreaterThanOrEqual(revision);
  });

  it("survives a restart with the history it committed", async () => {
    const { instance, fake, open } = await workspace();
    open("slot-a");
    instance.slotClose("slot-a");
    const log = fake.dolt.log().map((commit) => commit.hash);
    const restarted = await createWorkspaceStateTestDO({ fake: await fake.restart() });
    expect(restarted.fake.dolt.log().map((commit) => commit.hash)).toEqual(log);
    expect(restarted.instance.slotGet("slot-a")?.closed_at).not.toBeNull();
    expect(restarted.fake.dolt.status()).toEqual([]);
  });
});
