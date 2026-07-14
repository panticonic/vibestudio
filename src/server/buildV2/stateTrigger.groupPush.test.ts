import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverPackageGraph } from "./packageGraph.js";
import { computeSourceClosures } from "./sourceClosure.js";
import type { BuildSourceProvider } from "./buildSource.js";
import {
  StateTransitionTrigger,
  type StateAdvancedEvent,
  type WorkspaceStateSource,
} from "./stateTrigger.js";

/**
 * Regression for the multi-repo group-push invalidation bug: a `push({ repoPaths:
 * [a, b] })` emits ONE state-advanced event per advanced repo, all carrying the
 * SAME composed workspace `stateHash` but DISTINCT per-repo `changedPaths`. The
 * trigger must process EVERY event for its own changed paths — deduping on
 * `stateHash` alone would drop every repo after the first, leaving its units'
 * content hashes / source digest stale.
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

  function makeEvent(repoPath: string, stateHash: string): StateAdvancedEvent {
    return {
      head: "main",
      stateHash,
      repoStateHash: stateHash,
      sinceStateHash: "state:prev",
      eventId: null,
      headHash: null,
      actor: null,
      transitionKind: "merge",
      changedPaths: [`${repoPath}/index.ts`],
      repoPath,
      fileChanges: [],
      editOps: [],
    };
  }

  it("processes BOTH repos when their events share one composed workspace stateHash", async () => {
    const graph = discoverPackageGraph(workspaceRoot);
    const { sourceMap, contentHashes } = computeSourceClosures(graph, {});

    let advanceCb: ((event: StateAdvancedEvent) => void) | null = null;
    const source: WorkspaceStateSource & BuildSourceProvider = {
      ensureFresh: async () => ({ stateHash: "state:0" }),
      // New hashes per state so the touched unit registers as changed.
      unitHashes: async (stateHash, relPaths) =>
        Object.fromEntries(relPaths.map((relPath) => [relPath, `h:${relPath}:${stateHash}`])),
      resolveHead: async () => "state:0",
      resolveContextView: async () => "state:0",
      discoverGraph: async () => graph,
      onStateAdvanced: (cb) => {
        advanceCb = cb;
        return () => {};
      },
      recordBuild: async () => {},
      materializeForBuild: async () => ({ sourceRoot: workspaceRoot }),
    };

    trigger = new StateTransitionTrigger({
      graph,
      sourceMap,
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
    expect(advanceCb).not.toBeNull();

    // The group push: two events, SAME composed workspace stateHash, different repos.
    advanceCb!(makeEvent("packages/a", "state:X"));
    advanceCb!(makeEvent("packages/b", "state:X"));
    await trigger.whenSettled();

    // BOTH repos must be invalidated — pre-fix, packages/b's event was dropped as
    // a stateHash duplicate and never reached unitsForChangedPaths.
    expect(changed).toContain("packages/a");
    expect(changed).toContain("packages/b");
  });
});
