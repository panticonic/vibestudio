/**
 * Panel lifecycle suite — in-system port of tests/e2e/flows/panelLifecycle.spec.ts.
 *
 * Strengthened vs. the outside version: instead of smoke-checking whatever the
 * launcher created, it opens a real panel and asserts tree membership, load
 * state, snapshot readability and clean teardown. The "panels persist across
 * app restarts" outside test is intentionally NOT ported — it restarts the
 * host this suite runs in.
 */
import { panelTree } from "@workspace/runtime";
import { suite } from "../run.js";
import { expect } from "../expect.js";
import { evalInPanel, openPanel, panelText, waitFor } from "../panels.js";

// Chat is part of the bootable base contract. Feature panels own their own
// lifecycle suites instead of becoming an implicit testkit dependency.
export const TARGET_PANEL_SOURCE = "panels/chat";

export const panelLifecycle = suite("panel-lifecycle", {
  timeoutMs: 60_000,
  usesPanelAutomation: true,
})
  .test("panel tree is queryable and entries carry ids and titles", async (t) => {
    // A fresh headless context has no visible ancestor. Establish the exact
    // root fixture this query needs instead of assuming launcher state exists.
    const root = await openPanel(TARGET_PANEL_SOURCE, { parentId: null, focus: false });
    t.defer(() => root.close().then(() => undefined));
    const groups = await panelTree.rootGroups({ limit: 1 });
    expect(groups.groups.length, "owner group count").toBeGreaterThanOrEqual(1);
    const page = await panelTree.page({
      group: { kind: "roots", ownerUserId: groups.groups[0]!.ownerUserId },
      limit: 1,
    });
    expect(page.entries.length, "panel count").toBeGreaterThanOrEqual(1);
    expect(typeof page.entries[0]!.node.slotId, "panel id").toBe("string");
    expect(typeof page.entries[0]!.node.title, "panel title").toBe("string");
  })
  .test("opening a panel adds it to the tree as a child", async (t) => {
    const handle = await openPanel(TARGET_PANEL_SOURCE);
    t.defer(() => handle.close().then(() => undefined));
    expect((await panelTree.path(handle.id)) !== null, "opened panel present").toBeTruthy();
  })
  .test("opened panel reports loaded and yields a readable snapshot", async (t) => {
    const handle = await openPanel(TARGET_PANEL_SOURCE);
    t.defer(() => handle.close().then(() => undefined));
    expect((await handle.observe()).phase, "panel phase").toBe("ready");
    const text = await waitFor(async () => (await panelText(handle)) || undefined, {
      label: "panel renders visible text",
    });
    expect(text.length, "snapshot text length").toBeGreaterThan(0);
  })
  .test("rebuild replaces the runtime and the same handle automates the ready replacement", async (t) => {
    const handle = await openPanel(TARGET_PANEL_SOURCE);
    t.defer(() => handle.close().then(() => undefined));

    const before = await handle.observe();
    expect(before.phase, "initial panel phase").toBe("ready");
    expect(typeof before.runtimeEntityId, "initial runtime entity id").toBe("string");

    const rebuilt = await handle.rebuild();
    expect(rebuilt.panelId, "stable panel slot id").toBe(handle.id);
    expect(rebuilt.phase, "rebuilt panel phase").toBe("ready");
    expect(typeof rebuilt.runtimeEntityId, "replacement runtime entity id").toBe("string");
    expect(rebuilt.runtimeEntityId, "replacement runtime entity").not.toBe(
      before.runtimeEntityId
    );
    expect(rebuilt.attemptId, "replacement attempt").not.toBe(before.attemptId);

    const marker = await evalInPanel<string>(
      handle,
      `(() => {
        document.documentElement.dataset.testkitRebuild = "automated";
        return document.documentElement.dataset.testkitRebuild;
      })()`
    );
    expect(marker, "CDP automation result from replacement runtime").toBe("automated");

    const afterAutomation = await handle.observe();
    expect(afterAutomation.runtimeEntityId, "automated runtime entity").toBe(
      rebuilt.runtimeEntityId
    );
    expect(afterAutomation.phase, "automated panel phase").toBe("ready");
  })
  .test("closing a panel removes it from the tree", async () => {
    const handle = await openPanel(TARGET_PANEL_SOURCE);
    await handle.close();
    await waitFor(
      async () => {
        return (await panelTree.path(handle.id)) === null || undefined;
      },
      { label: "panel removed from tree" }
    );
  })
  .test("self handle is available and reports a workspace panel", async () => {
    const self = panelTree.self();
    expect(typeof self.id, "self id").toBe("string");
    expect(self.kind, "self kind").toBe("workspace");
  });
