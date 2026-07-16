/**
 * Build-unit content addresses are resolved from the canonical content tree.
 * They must remain byte-identical to the shared manifest implementation,
 * because build effective versions and cache keys consume these values.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { buildWorktreeManifest } from "@vibestudio/content-addressing";
import { mirrorWorktreeTree, putBytes } from "../../../src/server/services/blobstoreService.js";
import { createProtectedRefStore } from "../../../src/server/services/protectedRefStore.js";
import { WorkspaceVcs } from "../../../src/server/vcsHost/workspaceVcs.js";

const FILE_MODE = 33188;
const EXECUTABLE_MODE = 33261;
const UNIT_PATHS = [
  "packages/foo",
  "panels/chat",
  "panels/chat/src",
  "skills/onboarding",
  "meta",
  "meta/vibestudio.yml",
  "panels/missing",
];

describe("WorkspaceVcs build-unit hashes from canonical content", () => {
  let root: string;
  let blobsDir: string;
  let vcs: WorkspaceVcs;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "unit-hashes-"));
    blobsDir = path.join(root, "blobs");
    const refs = createProtectedRefStore({
      statePath: path.join(root, "refs"),
      gate: async () => {},
    });
    vcs = new WorkspaceVcs({
      workspaceId: "test-workspace",
      blobsDir,
      workspaceRoot: path.join(root, "workspace"),
      contextProjectionsRoot: path.join(root, ".context-projections", "v5"),
      buildSourcesRoot: path.join(root, "build-sources"),
      refs,
    });
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  async function contentState(files: Array<{ path: string; text: string; mode?: number }>) {
    const listing = await Promise.all(
      files.map(async (file) => ({
        path: file.path,
        contentHash: (await putBytes(blobsDir, Buffer.from(file.text, "utf8"))).digest,
        mode: file.mode ?? FILE_MODE,
      }))
    );
    const manifest = buildWorktreeManifest(listing);
    const mirrored = await mirrorWorktreeTree(blobsDir, listing, {
      expectStateHash: manifest.stateHash,
    });
    return { manifest, stateHash: mirrored.stateHash };
  }

  const initialFiles = () => [
    { path: "packages/foo/package.json", text: '{ "name": "@workspace/foo" }\n' },
    { path: "packages/foo/run.sh", text: "#!/bin/sh\necho hi\n", mode: EXECUTABLE_MODE },
    { path: "panels/chat/package.json", text: '{ "name": "@workspace-panels/chat" }\n' },
    { path: "panels/chat/src/index.tsx", text: "export const Chat = () => null;\n" },
    { path: "skills/onboarding/SKILL.md", text: "# Onboarding\n" },
    { path: "meta/vibestudio.yml", text: "name: test\n" },
  ];

  it("matches the shared manifest implementation for directories, files, and absent paths", async () => {
    const state = await contentState(initialFiles());

    expect(await vcs.unitHashes(state.stateHash, UNIT_PATHS)).toEqual(
      Object.fromEntries(
        UNIT_PATHS.map((unitPath) => [unitPath, state.manifest.subtreeHash(unitPath)])
      )
    );
  });

  it("changes only the touched unit and its ancestors", async () => {
    const before = await contentState(initialFiles());
    const after = await contentState(
      initialFiles().map((file) =>
        file.path === "panels/chat/src/index.tsx"
          ? { ...file, text: "export const Chat = () => 1;\n" }
          : file
      )
    );

    const hashesBefore = await vcs.unitHashes(before.stateHash, UNIT_PATHS);
    const hashesAfter = await vcs.unitHashes(after.stateHash, UNIT_PATHS);

    expect(hashesAfter["panels/chat"]).not.toBe(hashesBefore["panels/chat"]);
    expect(hashesAfter["panels/chat/src"]).not.toBe(hashesBefore["panels/chat/src"]);
    expect(hashesAfter["packages/foo"]).toBe(hashesBefore["packages/foo"]);
    expect(hashesAfter["skills/onboarding"]).toBe(hashesBefore["skills/onboarding"]);
    expect(hashesAfter["meta"]).toBe(hashesBefore["meta"]);
    expect(hashesAfter["meta/vibestudio.yml"]).toBe(hashesBefore["meta/vibestudio.yml"]);
    expect(hashesAfter["panels/missing"]).toBeNull();
  });
});
