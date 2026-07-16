import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverPackageGraph } from "./packageGraph.js";
import { computeEffectiveVersions } from "./effectiveVersion.js";
import type { BuildSourceProvider } from "./buildSource.js";
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
});
