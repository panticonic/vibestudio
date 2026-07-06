/**
 * Context-marker projection cleanliness (docs/…channels-plan §6.2 / §9.6).
 *
 * `WorkspaceVcs.ensureContextFolder` drops `.vibestudio-context.json` at the
 * context folder root. It is host-owned bookkeeping, NOT workspace source, so
 * the VCS scan must never capture it: a context folder containing the marker
 * must produce exactly the same state (and file list) as the same folder
 * without it — i.e. it projects/diffs clean.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { WorktreeStore } from "./worktreeStore.js";
import { CONTEXT_MARKER_FILE } from "./paths.js";

describe("context marker is invisible to the VCS scan", () => {
  let root: string;
  let store: WorktreeStore;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "ctx-marker-"));
    store = new WorktreeStore({
      blobsDir: path.join(root, "blobs"),
      gad: {
        call: () => {
          throw new Error("localState must not consult the gad store");
        },
      },
    } as unknown as ConstructorParameters<typeof WorktreeStore>[0]);
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("yields an identical state with or without the marker present", async () => {
    // Baseline: a folder with one tracked file, no marker.
    const cleanDir = path.join(root, "clean");
    await fsp.mkdir(path.join(cleanDir, "src"), { recursive: true });
    await fsp.writeFile(path.join(cleanDir, "src", "index.ts"), "export const x = 1;\n");
    const baseline = await store.localState(cleanDir);

    // Same tree, plus the host-owned marker at the root AND nested.
    const markedDir = path.join(root, "marked");
    await fsp.mkdir(path.join(markedDir, "src"), { recursive: true });
    await fsp.writeFile(path.join(markedDir, "src", "index.ts"), "export const x = 1;\n");
    await fsp.writeFile(
      path.join(markedDir, CONTEXT_MARKER_FILE),
      JSON.stringify({ contextId: "ctx-1", workspaceId: "ws", serverUrl: "http://127.0.0.1:9" })
    );
    await fsp.writeFile(path.join(markedDir, "src", CONTEXT_MARKER_FILE), "{}\n");
    const marked = await store.localState(markedDir);

    // Marker never enters the scanned file set…
    expect(marked.files.map((f) => f.path)).toEqual(["src/index.ts"]);
    // …so the state hash is byte-for-byte identical to the marker-free tree.
    expect(marked.stateHash).toBe(baseline.stateHash);
  });
});
