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
import { openPanel, panelText, waitFor } from "../panels.js";

// Chat is part of the bootable base contract. Feature panels own their own
// lifecycle suites instead of becoming an implicit testkit dependency.
export const TARGET_PANEL_SOURCE = "panels/chat";

export const panelLifecycle = suite("panel-lifecycle", { timeoutMs: 60_000 })
  .test("panel tree is queryable and entries carry ids and titles", async () => {
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
