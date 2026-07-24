import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { discoverPackageGraph } from "./packageGraph.js";
import { computeEffectiveVersions } from "./effectiveVersion.js";
import { setBuildSourceProvider, type BuildSourceProvider } from "./buildSource.js";
import { StateTransitionTrigger, type WorkspaceStateSource } from "./stateTrigger.js";
import type { ProtectedPublicationEvent } from "@vibestudio/shared/protectedPublicationEvents";

/**
 * Regression for multi-repository publication invalidation: one semantic
 * publication emits one atomic effect carrying every repository delta, all of
 * which must reach graph invalidation in one build-trigger pass.
 */
describe("StateTransitionTrigger — multi-repo group push", () => {
  let root: string;
  let workspaceRoot: string;
  let trigger: StateTransitionTrigger | null = null;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-grouppush-"));
    workspaceRoot = path.join(root, "workspace");
    for (const name of ["a", "b"]) {
      const dir = path.join(workspaceRoot, "packages", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name: `@workspace-packages/${name}`, version: "0.1.0", type: "module" })
      );
      fs.writeFileSync(path.join(dir, "index.ts"), "export const x = 1;\n");
    }
  });

  afterEach(() => {
    trigger?.stop();
    trigger = null;
    setBuildSourceProvider(null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  function makeEvent(stateHash: string): ProtectedPublicationEvent {
    return {
      publicationId: "publication:group",
      resultHostRefsBasisDigest: "host-refs:group",
      appliedAt: 42,
      workspaceStateHash: stateHash,
      changedPaths: ["packages/a/index.ts", "packages/b/index.ts"],
      repositories: ["packages/a", "packages/b"].map((repoPath) => ({
        repoPath,
        previousStateHash: "state:prev",
        nextStateHash: stateHash,
        fileChanges: [],
      })),
    };
  }

  it("processes every repository effect sharing one workspace state", async () => {
    const graph = discoverPackageGraph(workspaceRoot);
    const { evMap, contentHashes } = computeEffectiveVersions(graph, {});

    let publicationCb: ((event: ProtectedPublicationEvent) => void) | null = null;
    const source: WorkspaceStateSource & BuildSourceProvider = {
      ensureFresh: async () => ({ stateHash: "state:0" }),
      // New hashes per state so the touched unit registers as changed.
      unitHashes: async (stateHash, relPaths) =>
        Object.fromEntries(relPaths.map((relPath) => [relPath, `h:${relPath}:${stateHash}`])),
      resolveContextState: async () => "state:0",
      discoverGraph: async () => graph,
      onProtectedPublication: (cb) => {
        publicationCb = cb;
        return () => {};
      },
      recordBuild: async () => {},
      materializeForBuild: async () => ({ sourceRoot: workspaceRoot }),
    };

    trigger = new StateTransitionTrigger({
      graph,
      evMap,
      contentHashes,
      stateHash: "state:0",
      workspaceRoot,
      source,
    });

    const changed: string[] = [];
    trigger.on("change-detected", (e: { units: Array<{ relativePath: string }> }) => {
      for (const u of e.units) changed.push(u.relativePath);
    });
    trigger.start();
    expect(publicationCb).not.toBeNull();

    publicationCb!(makeEvent("state:X"));
    await trigger.whenSettled();

    // Both repository path deltas must reach graph invalidation.
    expect(changed).toContain("packages/a");
    expect(changed).toContain("packages/b");
  });

  it("settles graph state without waiting for speculative cache warming", async () => {
    const panelDir = path.join(workspaceRoot, "workers", "slow-worker");
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(
      path.join(panelDir, "package.json"),
      JSON.stringify({
        name: "@workspace-workers/slow-worker",
        version: "0.1.0",
        private: true,
        type: "module",
        vibestudio: { title: "Slow worker", entry: "index.ts" },
      })
    );
    fs.writeFileSync(
      path.join(panelDir, "index.ts"),
      "export default { fetch() { return new Response('ok'); } };\n"
    );

    const graph = discoverPackageGraph(workspaceRoot);
    const { evMap, contentHashes } = computeEffectiveVersions(graph, {});
    let publicationCb: ((event: ProtectedPublicationEvent) => void) | null = null;
    let releaseMaterialization!: () => void;
    const materializationReleased = new Promise<void>((resolve) => {
      releaseMaterialization = resolve;
    });
    let materializationStarted = false;
    const source: WorkspaceStateSource & BuildSourceProvider = {
      ensureFresh: async () => ({ stateHash: "state:X" }),
      unitHashes: async (stateHash, relPaths) =>
        Object.fromEntries(relPaths.map((relPath) => [relPath, `h:${relPath}:${stateHash}`])),
      resolveContextState: async () => "state:X",
      discoverGraph: async () => graph,
      onProtectedPublication: (cb) => {
        publicationCb = cb;
        return () => {};
      },
      recordBuild: async () => {},
      materializeForBuild: async () => {
        materializationStarted = true;
        await materializationReleased;
        return { sourceRoot: workspaceRoot };
      },
    };
    setBuildSourceProvider(source);

    trigger = new StateTransitionTrigger({
      graph,
      evMap,
      contentHashes,
      stateHash: "state:0",
      workspaceRoot,
      source,
    });
    trigger.start();
    publicationCb!({
      ...makeEvent("state:X"),
      changedPaths: ["workers/slow-worker/index.ts"],
      repositories: [
        {
          repoPath: "workers/slow-worker",
          previousStateHash: "state:prev",
          nextStateHash: "state:X",
          fileChanges: [],
        },
      ],
    });

    await vi.waitFor(() => expect(materializationStarted).toBe(true), { timeout: 500 });
    await Promise.race([
      trigger.whenSettled(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("graph settlement waited for cache warming")), 500)
      ),
    ]);
    expect(trigger.getState().stateHash).toBe("state:X");
    releaseMaterialization();
  });
});
