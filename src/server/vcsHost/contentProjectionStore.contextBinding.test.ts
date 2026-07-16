/**
 * Context-binding projection cleanliness (docs/…channels-plan §6.2 / §9.6).
 *
 * `WorkspaceVcs.ensureContextFolder` drops `.vibestudio-context.json` at the
 * context folder root. It is host-owned bookkeeping, NOT workspace source, so
 * the VCS scan must never capture it: a context folder containing the binding
 * must produce exactly the same state (and file list) as the same folder
 * without it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  CONTEXT_BINDING_FILE,
  contextBinding,
  encodeContextBinding,
} from "@vibestudio/shared/contextBinding";

import { ContentProjectionStore } from "./contentProjectionStore.js";
import { putBytes, putTree } from "../services/blobstoreService.js";

describe("context binding is invisible to the VCS scan", () => {
  let root: string;
  let store: ContentProjectionStore;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "ctx-marker-"));
    store = new ContentProjectionStore({ blobsDir: path.join(root, "blobs") });
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("yields an identical state with or without the binding present", async () => {
    // Baseline: a folder with one tracked file, no binding.
    const cleanDir = path.join(root, "clean");
    await fsp.mkdir(path.join(cleanDir, "src"), { recursive: true });
    await fsp.writeFile(path.join(cleanDir, "src", "index.ts"), "export const x = 1;\n");
    const baseline = await store.localState(cleanDir);

    // Same tree, plus the host-owned binding at the root AND nested.
    const markedDir = path.join(root, "marked");
    await fsp.mkdir(path.join(markedDir, "src"), { recursive: true });
    await fsp.writeFile(path.join(markedDir, "src", "index.ts"), "export const x = 1;\n");
    await fsp.writeFile(
      path.join(markedDir, CONTEXT_BINDING_FILE),
      encodeContextBinding(contextBinding({ contextId: "ctx-1", workspaceId: "ws" }))
    );
    await fsp.writeFile(path.join(markedDir, "src", CONTEXT_BINDING_FILE), "{}\n");
    await fsp.mkdir(path.join(markedDir, ".gad"));
    await fsp.writeFile(
      path.join(markedDir, ".gad", "context-materialization.json"),
      '{"private":true}\n'
    );
    const marked = await store.localState(markedDir);

    // Binding never enters the scanned file set…
    expect(marked.files.map((f) => f.path)).toEqual(["src/index.ts"]);
    // …so the state hash is byte-for-byte identical to the binding-free tree.
    expect(marked.stateHash).toBe(baseline.stateHash);
  });

  it("treats every exact tree page as one snapshot, never later pages as mass deletion", async () => {
    const blobsDir = path.join(root, "blobs");
    const digest = (await putBytes(blobsDir, Buffer.from("shared body", "utf8"))).digest;
    const tree = await putTree(
      blobsDir,
      Array.from({ length: 1_001 }, (_, index) => ({
        name: `file-${String(index).padStart(4, "0")}.txt`,
        kind: "file" as const,
        contentHash: digest,
        mode: 33188,
      })),
      { root: true }
    );

    const files = await store.listStateFiles(tree.stateHash!);
    expect(files).toHaveLength(1_001);
    expect(files.at(-1)?.path).toBe("file-1000.txt");
  });

  it("reports unsafe source names instead of silently omitting them", async () => {
    if (process.platform === "win32") return;
    const dir = path.join(root, "unsafe");
    await fsp.mkdir(dir);
    await fsp.writeFile(path.join(dir, "bad\\name.ts"), "unsafe");
    const scanned = await store.localState(dir);
    expect(scanned.files).toEqual([]);
    expect(scanned.skipped).toEqual([
      expect.objectContaining({ path: "bad\\name.ts", kind: "inadmissible" }),
    ]);
  });
});
