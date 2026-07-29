import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalSnapshotDigest,
  sha256Hex,
  type CanonicalSnapshotDigest,
} from "@vibestudio/content-addressing";
import type { ExactGitSnapshot } from "@vibestudio/git";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import {
  WorkspaceRootTemplateBootstrap,
  enumerateRootTemplateRepositories,
} from "./workspaceRootTemplateBootstrap.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function snapshot(
  entries: Array<{ path: string; text: string; mode?: 0o644 | 0o755 }>,
  commit = "a".repeat(40)
): ExactGitSnapshot {
  const bytesByPath = new Map(
    entries.map((entry) => [entry.path, new TextEncoder().encode(entry.text)])
  );
  const files = entries.map((entry) => {
    const bytes = bytesByPath.get(entry.path)!;
    return {
      path: entry.path,
      contentHash: sha256Hex(bytes),
      size: bytes.byteLength,
      mode: entry.mode ?? (0o644 as const),
    };
  });
  return {
    commit,
    snapshot: canonicalSnapshotDigest(
      files.map((file) => ({
        ...file,
        mode: file.mode === 0o755 ? 0o100755 : 0o100644,
      }))
    ),
    files,
    readFile: (filePath) => bytesByPath.get(filePath) ?? null,
  };
}

function fixture(rootSnapshot: ExactGitSnapshot) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "root-template-bootstrap-"));
  roots.push(root);
  const statePath = path.join(root, "state");
  fs.mkdirSync(path.join(statePath, "workspace-creation"), { recursive: true });
  const pin = {
    url: "git+https://example.test/base.git",
    ref: "refs/tags/v1",
    commit: rootSnapshot.commit,
    snapshot: rootSnapshot.snapshot as CanonicalSnapshotDigest,
  };
  fs.writeFileSync(
    path.join(statePath, "workspace-creation/v1.json"),
    JSON.stringify({ version: 1, workspaceId: "ws-1", rootTemplate: pin })
  );
  const acquire = vi.fn(async () => rootSnapshot);
  return {
    pin,
    acquire,
    bootstrap: new WorkspaceRootTemplateBootstrap({
      workspaceId: "ws-1",
      statePath,
      acquire,
    }),
  };
}

describe("WorkspaceRootTemplateBootstrap", () => {
  it("acquires exactly the pinned root and exposes its repositories without composition", async () => {
    const rootSnapshot = snapshot([
      {
        path: "meta/vibestudio.yml",
        text: `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\nextensions:\n  - source: extensions/template-composer\n`,
      },
      {
        // Bootstrap imports this opaque userland source but never parses it.
        path: "meta/template.yml",
        text: "not: [valid",
      },
      { path: "extensions/template-composer/package.json", text: "{}" },
      { path: "extensions/template-composer/index.ts", text: "export {};" },
      { path: "README.md", text: "repository tooling" },
    ]);
    const fx = fixture(rootSnapshot);

    await expect(fx.bootstrap.prepareInitialization()).resolves.toMatchObject({
      pin: fx.pin,
      repositories: [
        { repoPath: "extensions/template-composer", subdir: "extensions/template-composer" },
        { repoPath: "meta", subdir: "meta" },
      ],
    });
    expect(fx.acquire).toHaveBeenCalledExactlyOnceWith(fx.pin);
  });

  it("rejects container-root files instead of inventing an owner", () => {
    const rootSnapshot = snapshot([
      { path: "meta/vibestudio.yml", text: `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\n` },
      { path: "packages/tsconfig.json", text: "{}" },
    ]);
    expect(() => enumerateRootTemplateRepositories(rootSnapshot)).toThrow(
      /root of container section packages/
    );
  });

  it("fails closed when the acquired snapshot differs from the exact descriptor", async () => {
    const rootSnapshot = snapshot([
      { path: "meta/vibestudio.yml", text: `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\n` },
    ]);
    const fx = fixture(rootSnapshot);
    fx.acquire.mockResolvedValue({ ...rootSnapshot, commit: "b".repeat(40) });

    await expect(fx.bootstrap.prepareInitialization()).rejects.toThrow(
      /coordinates different from the creation descriptor/
    );
  });

  it("requires a flattened runtime manifest even when template source exists", async () => {
    const rootSnapshot = snapshot([
      {
        path: "meta/template.yml",
        text: `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\ntemplates:\n  use: []\n`,
      },
    ]);
    const fx = fixture(rootSnapshot);

    await expect(fx.bootstrap.prepareInitialization()).rejects.toThrow(
      /missing meta\/vibestudio\.yml/
    );
  });
});
