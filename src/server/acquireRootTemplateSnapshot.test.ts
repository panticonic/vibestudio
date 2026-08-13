import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalSnapshotDigest, sha256Hex } from "@vibestudio/content-addressing";
import type { GitClient } from "@vibestudio/git";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import {
  acquireRootTemplateSnapshot,
  discoverAndSeedRootTemplateSnapshotFromCheckout,
  seedRootTemplateSnapshotFromCheckout,
} from "./acquireRootTemplateSnapshot.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe("acquireRootTemplateSnapshot", () => {
  it("reuses an atomically published exact checkout after restart", async () => {
    const statePath = await fsp.mkdtemp(path.join(os.tmpdir(), "root-template-cache-"));
    roots.push(statePath);
    const bytes = new TextEncoder().encode("systemEpoch: 59\n");
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

  it("seeds an unpushed committed tree into the ordinary immutable acquisition coordinate", async () => {
    const statePath = await fsp.mkdtemp(path.join(os.tmpdir(), "root-template-local-seed-"));
    roots.push(statePath);
    const checkout = path.join(statePath, "unpublished-base");
    await fsp.mkdir(path.join(checkout, ".git"), { recursive: true });
    const bytes = new TextEncoder().encode("systemEpoch: 59\n");
    const commit = "c".repeat(40);
    const snapshot = canonicalSnapshotDigest([
      {
        path: "meta/template.yml",
        mode: 0o100644,
        size: bytes.byteLength,
        contentHash: sha256Hex(bytes),
      },
    ]);
    const pin: WorkspaceTemplatePin = {
      url: "git+https://example.test/workspace-base.git",
      ref: "refs/heads/candidate",
      commit,
      snapshot,
    };
    const clone = vi.fn(async () => undefined);
    const git = {
      clone,
      resolveCommit: vi.fn(async () => commit),
      getCurrentCommit: vi.fn(async () => commit),
      statusMatrix: vi.fn(async () => [["meta/template.yml", 1, 1, 1]]),
      readCommitTree: vi.fn(async () => [
        {
          path: "meta/template.yml",
          mode: 0o100644,
          type: "blob",
          oid: "d".repeat(40),
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

    await seedRootTemplateSnapshotFromCheckout({
      statePath,
      checkout,
      pin,
      git,
      sink,
    });
    const acquired = await acquireRootTemplateSnapshot({ statePath, pin, git, sink });

    expect(acquired).toMatchObject({ commit, snapshot });
    expect(clone).not.toHaveBeenCalled();
  });

  it("derives an unpushed branch checkpoint, excludes untracked files, and rejects tracked edits", async () => {
    const statePath = await fsp.mkdtemp(path.join(os.tmpdir(), "root-template-local-discovery-"));
    roots.push(statePath);
    const checkout = path.join(statePath, "candidate-base");
    await fsp.mkdir(path.join(checkout, ".git"), { recursive: true });
    const bytes = new TextEncoder().encode("systemEpoch: 59\n");
    const commit = "e".repeat(40);
    const status = vi.fn(async () => ({
      branch: "candidate",
      commit,
      dirty: true,
      files: [{ path: "notes.txt", status: "untracked", staged: false, unstaged: true }],
    }));
    const git = {
      status,
      getCurrentCommit: vi.fn(async () => commit),
      readCommitTree: vi.fn(async () => [
        {
          path: "meta/template.yml",
          mode: 0o100644,
          type: "blob",
          oid: "f".repeat(40),
          bytes,
        },
      ]),
    } as unknown as GitClient;
    const sink = {
      put: vi.fn(async (value: Uint8Array) => ({
        digest: sha256Hex(value),
        size: value.byteLength,
      })),
    };

    const discovered = await discoverAndSeedRootTemplateSnapshotFromCheckout({
      statePath,
      checkout,
      url: "git+https://example.test/workspace-base.git",
      git,
      sink,
    });

    expect(discovered.pin).toMatchObject({
      ref: "refs/heads/candidate",
      commit,
    });
    expect(discovered.untrackedPaths).toEqual(["notes.txt"]);
    expect(discovered.snapshot.snapshot).toBe(discovered.pin.snapshot);

    status.mockResolvedValueOnce({
      branch: "candidate",
      commit,
      dirty: true,
      files: [{ path: "meta/template.yml", status: "modified", staged: false, unstaged: true }],
    });
    await expect(
      discoverAndSeedRootTemplateSnapshotFromCheckout({
        statePath: path.join(statePath, "other-state"),
        checkout,
        url: "git+https://example.test/workspace-base.git",
        git,
        sink,
      })
    ).rejects.toThrow("tracked worktree changes: meta/template.yml");
  });
});
