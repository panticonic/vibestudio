import type { TestApp } from "../../setup/electronSetup";
import fs from "node:fs";
import path from "node:path";
/**
 * Panel Lifecycle E2E Tests
 *
 * Only the persistence test remains here: it restarts the app, which cannot
 * run in-system. The rest of the lifecycle coverage (panel creation, focus
 * management, panel loading state) now lives in @workspace/testkit
 * (workspace/packages/testkit/src/suites/panelLifecycle.ts).
 */

import { test, expect } from "@playwright/test";
import {
  ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE,
  ensureHostedShellReady,
  createPanel,
  getPanelTree,
  hasElectronDisplay,
  launchTestApp,
  approvePendingWorkspaceCreationReview,
  approvePendingStartupUnits,
  createManagedTestWorkspace,
  removeManagedTestWorkspace,
  getPanelReadiness,
  rebuildPanel,
  executePanelScript,
} from "../../setup/electronSetup";

test.skip(!hasElectronDisplay(), ELECTRON_DISPLAY_UNAVAILABLE_MESSAGE);

test.describe("Panel Rebuild Lifecycle", () => {
  test("CDP keep-loaded delivery preserves the rebuilt panel target", async () => {
    test.setTimeout(300_000);
    const workspacePath = await createManagedTestWorkspace({
      configureSource(sourceRoot) {
        const manifestPath = path.join(sourceRoot, "panels/chat/package.json");
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
          vibestudio: { authority: { requests: unknown[] } };
        };
        manifest.vibestudio.authority.requests.push({
          capability: "panel.inspect",
          resource: { kind: "prefix", prefix: "panel:tree/" },
          tier: "gated",
          evidence: "bounded-dynamic",
        });
        fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      },
    });
    let testApp: Awaited<ReturnType<typeof launchTestApp>> | null = null;

    try {
      testApp = await launchTestApp({ workspace: workspacePath, launchTimeout: 180_000 });
      await approvePendingStartupUnits(testApp);
      await approvePendingWorkspaceCreationReview(testApp);
      const caller = await ensureHostedShellReady(testApp, { panelSource: "panels/chat" });

      const targetId = caller.panelId;
      await rebuildPanel(testApp, targetId);
      await expect
        .poll(async () => (await getPanelReadiness(testApp!, targetId)).presentation.state, {
          timeout: 120_000,
        })
        .toBe("ready");

      await executePanelScript<void>(
        testApp,
        caller.panelId,
        `(async () => {
          const { getPanelHandle } = await globalThis.__vibestudioRequireAsync__("@workspace/runtime");
          const handle = getPanelHandle(${JSON.stringify(caller.panelId)});
          const session = await handle.cdp.session();
          globalThis.__e2eRetainedCdpSession = session;
          await session.page.locator("body").innerText();
        })()`
      );
      const before = await getPanelReadiness(testApp, targetId);
      expect(before.presentation.state).toBe("ready");
      if (before.presentation.state !== "ready") throw new Error("Expected ready CDP target");

      await expect
        .poll(
          () =>
            testApp!.app.evaluate(
              async (_electron, { workspaceId, targetId }) => {
                const api = await globalThis.__testApi?.forWorkspace(workspaceId);
                if (!api) throw new Error("Test API not available");
                const snapshot = (await api.rpcCall("panelRuntime", "getSnapshot", [])) as {
                  leases: Array<{ slotId: string; keepLoaded?: boolean }>;
                };
                return (
                  snapshot.leases.find((lease) => lease.slotId === targetId)?.keepLoaded === true
                );
              },
              { workspaceId: testApp!.workspaceId, targetId }
            ),
          { timeout: 30_000, intervals: [50, 100, 250] }
        )
        .toBe(true);

      const body = await executePanelScript<string>(
        testApp,
        caller.panelId,
        `(async () => {
          const session = globalThis.__e2eRetainedCdpSession;
          if (!session) throw new Error("Retained CDP session missing");
          return session.page.locator("body").innerText();
        })()`
      );
      expect(body.length).toBeGreaterThan(0);
      const after = await getPanelReadiness(testApp, targetId);
      expect(after.presentation).toMatchObject({
        state: "ready",
        webContentsId: before.presentation.webContentsId,
      });
    } finally {
      if (testApp) await testApp.cleanup();
      removeManagedTestWorkspace(workspacePath);
    }
  });

  test("visible desktop rebuild replaces the exact attempt and reaches ready", async () => {
    test.setTimeout(300_000);
    const workspacePath = await createManagedTestWorkspace();
    let testApp: Awaited<ReturnType<typeof launchTestApp>> | null = null;

    try {
      testApp = await launchTestApp({ workspace: workspacePath, launchTimeout: 180_000 });
      await approvePendingStartupUnits(testApp);
      await approvePendingWorkspaceCreationReview(testApp);

      const before = await ensureHostedShellReady(testApp, { panelSource: "panels/chat" });
      expect(before.presentation.state).toBe("ready");
      expect(before.runtimeEntityId).toBeTruthy();

      const result = await rebuildPanel(testApp, before.panelId);
      expect(result).toMatchObject({
        panelId: before.panelId,
        operation: "rebuild",
        rebuilt: true,
      });

      try {
        await expect
          .poll(
            async () => (await getPanelReadiness(testApp!, before.panelId)).presentation.state,
            {
              timeout: 120_000,
            }
          )
          .toBe("ready");
      } catch (error) {
        const readiness = await getPanelReadiness(testApp, before.panelId);
        throw new Error(
          `Replacement panel did not become ready:\n${JSON.stringify(readiness, null, 2)}`,
          { cause: error }
        );
      }
      const after = await getPanelReadiness(testApp, before.panelId);
      expect(after.runtimeEntityId).not.toBe(before.runtimeEntityId);
      expect(after.presentation).toMatchObject({ state: "ready" });
      if (before.presentation.state !== "ready" || after.presentation.state !== "ready") {
        throw new Error("Expected ready presentations before and after rebuild");
      }
      expect(after.presentation.attemptId).not.toBe(before.presentation.attemptId);
    } finally {
      if (testApp) await testApp.cleanup();
      removeManagedTestWorkspace(workspacePath);
    }
  });
});

type PanelTreeEntry = Awaited<ReturnType<typeof getPanelTree>>[number];

function flattenPanelTree(entries: PanelTreeEntry[]): PanelTreeEntry[] {
  return entries.flatMap((entry) => [
    entry,
    ...flattenPanelTree(entry.children as PanelTreeEntry[]),
  ]);
}

type DurablePanelEntry = {
  id: string;
  source: string | null;
};

async function getDurablePanelTree(owner: TestApp): Promise<DurablePanelEntry[]> {
  const { app } = owner;
  return app.evaluate(
    async (_electron, { workspaceId }) => {
      const testApi = await globalThis.__testApi?.forWorkspace(workspaceId);
      if (!testApi) throw new Error("Test API not available");

      type RootGroup = { ownerUserId: string | null };
      type TreeNode = { slotId: string; childCount: number; source?: string };
      type RootGroupsPage = {
        groups: RootGroup[];
        nextCursor: string | null;
      };
      type TreePage = {
        nodes: TreeNode[];
        nextCursor: string | null;
      };

      const groups: RootGroup[] = [];
      let groupCursor: string | undefined;
      do {
        const page = (await testApi.rpcCall("workspace-state", "panelTree.rootGroups", [
          { cursor: groupCursor, limit: 200 },
        ])) as RootGroupsPage;
        groups.push(...page.groups);
        groupCursor = page.nextCursor ?? undefined;
      } while (groupCursor);

      const result: DurablePanelEntry[] = [];
      const readGroup = async (
        group:
          | { kind: "roots"; ownerUserId: string | null }
          | { kind: "children"; parentSlotId: string }
      ): Promise<void> => {
        let cursor: string | undefined;
        do {
          const page = (await testApi.rpcCall("workspace-state", "panelTree.page", [
            { group, cursor, limit: 200 },
          ])) as TreePage;
          for (const node of page.nodes) {
            result.push({ id: node.slotId, source: node.source ?? null });
            if (node.childCount > 0) {
              await readGroup({ kind: "children", parentSlotId: node.slotId });
            }
          }
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
      };

      for (const group of groups) {
        await readGroup({ kind: "roots", ownerUserId: group.ownerUserId });
      }
      return result;
    },
    { workspaceId: owner.workspaceId }
  );
}

async function waitForRestorablePanelTree(owner: TestApp): Promise<PanelTreeEntry[]> {
  let tree: PanelTreeEntry[] = [];
  let lastError = "";
  await expect
    .poll(
      async () => {
        try {
          tree = await getPanelTree(owner);
          return flattenPanelTree(tree).length;
        } catch (error) {
          // Electron can replace its automation execution context while the
          // workspace-owned shell is adopted. Readiness is the first stable,
          // non-empty authoritative panel-tree snapshot, not elapsed time.
          const message = error instanceof Error ? error.message : String(error);
          if (message !== lastError) {
            lastError = message;
            console.warn(`[panel-persistence] waiting for main test API: ${message}`);
          }
          return 0;
        }
      },
      { timeout: 60_000 }
    )
    .toBeGreaterThan(0);
  return tree;
}

test.describe("Panel Persistence", () => {
  // This test launches the app twice, so it needs a longer timeout
  test("panels persist across app restarts", async () => {
    test.setTimeout(480_000); // Double cold app launch plus graceful server teardown.
    const workspacePath = await createManagedTestWorkspace();
    let testApp: Awaited<ReturnType<typeof launchTestApp>> | null = null;

    try {
      // First session: create panels
      testApp = await launchTestApp({
        workspace: workspacePath,
        launchTimeout: 180_000,
      });
      await approvePendingStartupUnits(testApp);
      await approvePendingWorkspaceCreationReview(testApp);

      await ensureHostedShellReady(testApp, { panelSource: "panels/chat" });
      const seededTree = await waitForRestorablePanelTree(testApp);
      const created = await createPanel(testApp, seededTree[0]!.id, "about/help", {
        name: "persistence-check",
        focus: false,
      });
      await expect
        .poll(async () =>
          (await getDurablePanelTree(testApp!)).some((panel) => panel.id === created.id)
        )
        .toBe(true);

      const initialPanels = await getDurablePanelTree(testApp);
      // Save workspace path for restart
      // Close app using cleanup (which has a timeout to prevent hanging)
      await testApp.cleanup();
      testApp = null;

      // Restart with same workspace
      testApp = await launchTestApp({
        workspace: workspacePath,
        launchTimeout: 180_000,
      });
      await approvePendingStartupUnits(testApp);
      await approvePendingWorkspaceCreationReview(testApp);

      await ensureHostedShellReady(testApp, { panelSource: "panels/chat" });
      await waitForRestorablePanelTree(testApp);
      const restoredPanels = await getDurablePanelTree(testApp);

      expect(restoredPanels).toEqual(initialPanels);
    } finally {
      if (testApp) {
        await testApp.cleanup();
      }
      removeManagedTestWorkspace(workspacePath);
    }
  });
});
