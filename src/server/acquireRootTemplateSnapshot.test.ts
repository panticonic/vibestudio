import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalSnapshotDigest, sha256Hex } from "@vibestudio/content-addressing";
import type { GitClient } from "@vibestudio/git";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import { acquireRootTemplateSnapshot } from "./acquireRootTemplateSnapshot.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe("acquireRootTemplateSnapshot", () => {
  it("reuses an atomically published exact checkout after restart", async () => {
    const statePath = await fsp.mkdtemp(path.join(os.tmpdir(), "root-template-cache-"));
    roots.push(statePath);
    const bytes = new TextEncoder().encode("systemEpoch: 57\n");
    const contentHash = sha256Hex(bytes);
    const commit = "a".repeat(40);
    const pin: WorkspaceTemplatePin = {
      url: "git+https://example.test/workspace-base.git",
      ref: "refs/tags/v1",
      commit,
      snapshot: canonicalSnapshotDigest([
        {
          path: "meta/vibestudio.yml",
          mode: 0o100644,
          size: bytes.byteLength,
          contentHash,
        },
      ]),
    };
    const clone = vi.fn(async () => undefined);
    const git = {
      resolveUrl: vi.fn(),
      clone,
      resolveCommit: vi.fn(async () => commit),
      getCurrentCommit: vi.fn(async () => commit),
      statusMatrix: vi.fn(async () => [["meta/vibestudio.yml", 1, 1, 1]]),
      readCommitTree: vi.fn(async () => [
        {
          path: "meta/vibestudio.yml",
          mode: 0o100644,
          type: "blob",
          oid: "b".repeat(40),
          bytes,
        },
      ]),
      checkout: vi.fn(),
    } as unknown as GitClient;
    const sink = {
      put: vi.fn(async (value: Uint8Array) => ({
        digest: sha256Hex(value),
        size: value.byteLength,
      })),
    };

    const first = await acquireRootTemplateSnapshot({ statePath, pin, git, sink });
    const afterRestart = await acquireRootTemplateSnapshot({ statePath, pin, git, sink });

    expect(first).toMatchObject({ commit, snapshot: pin.snapshot });
    expect(afterRestart).toMatchObject({ commit, snapshot: pin.snapshot });
    expect(clone).toHaveBeenCalledTimes(1);
  });
});
