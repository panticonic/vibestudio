import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@vibestudio/content-addressing";
import type { GitClient, GitCommitTreeEntry } from "./client.js";
import {
  acquireExactGitSnapshot,
  discoverExactGitSnapshot,
  discoverTrackedGitSnapshot,
  readExactGitSnapshot,
} from "./exact-snapshot.js";

const COMMIT = "a".repeat(40);
const blob = (path: string, text: string, mode = 0o100644): GitCommitTreeEntry => ({
  path,
  type: "blob",
  mode,
  oid: sha256Hex(new TextEncoder().encode(text)).slice(0, 40),
  bytes: new TextEncoder().encode(text),
});

function fakeGit(entries: GitCommitTreeEntry[], matrix?: Array<[string, number, number, number]>) {
  return {
    getCurrentCommit: vi.fn(async () => COMMIT),
    statusMatrix: vi.fn(
      async () =>
        matrix ?? entries.map((entry) => [entry.path, 1, 1, 1] as [string, number, number, number])
    ),
    readCommitTree: vi.fn(async () => entries),
  } as unknown as GitClient;
}

describe("readExactGitSnapshot", () => {
  it("stores verified content once and returns deterministic descriptors", async () => {
    const put = vi.fn(async (bytes: Uint8Array) => ({
      digest: sha256Hex(bytes),
      size: bytes.byteLength,
    }));
    const snapshot = await readExactGitSnapshot({
      git: fakeGit([blob("b.txt", "same"), blob("a.txt", "same", 0o100755)]),
      dir: "/checkout",
      commit: COMMIT,
      label: "projects/example",
      sink: { put },
    });
    expect(snapshot.files.map((file) => [file.path, file.mode])).toEqual([
      ["a.txt", 0o755],
      ["b.txt", 0o644],
    ]);
    expect(put).toHaveBeenCalledTimes(1);
    expect(snapshot.snapshot).toMatch(/^v1-sha256:[0-9a-f]{64}$/);
    expect(new TextDecoder().decode(snapshot.readFile("a.txt")!)).toBe("same");
  });

  it("keeps reserved and unrepresentable rejection classes distinct", async () => {
    const sink = { put: vi.fn() };
    await expect(
      readExactGitSnapshot({
        git: fakeGit([blob(".env", "secret")]),
        dir: "/checkout",
        commit: COMMIT,
        label: "projects/example",
        sink,
      })
    ).rejects.toThrow("paths excluded from the semantic snapshot (.env)");
    await expect(
      readExactGitSnapshot({
        git: fakeGit([{ path: "submodule", type: "commit", mode: 0o160000, oid: COMMIT }]),
        dir: "/checkout",
        commit: COMMIT,
        label: "projects/example",
        sink,
      })
    ).rejects.toThrow("entries the semantic workspace cannot represent");
  });

  it("reads the immutable commit tree without scanning the worktree", async () => {
    const git = fakeGit([blob("a", "x")], [["a", 1, 2, 1]]);
    await expect(
      readExactGitSnapshot({
        git,
        dir: "/checkout",
        commit: COMMIT,
        label: "projects/example",
        sink: {
          put: vi.fn(async (bytes: Uint8Array) => ({
            digest: sha256Hex(bytes),
            size: bytes.byteLength,
          })),
        },
      })
    ).resolves.toMatchObject({ commit: COMMIT });
    expect(git.statusMatrix).not.toHaveBeenCalled();
  });

  it("rejects content sink integrity mismatches", async () => {
    await expect(
      readExactGitSnapshot({
        git: fakeGit([blob("a", "x")]),
        dir: "/checkout",
        commit: COMMIT,
        label: "projects/example",
        sink: { put: vi.fn(async () => ({ digest: "wrong", size: 1 })) },
      })
    ).rejects.toThrow("content store integrity mismatch");
  });

  it("carves monorepo subtrees while preserving exact relative paths", async () => {
    const snapshot = await readExactGitSnapshot({
      git: fakeGit([blob("panels/news/index.ts", "news"), blob("meta/vibestudio.yml", "x")]),
      dir: "/checkout",
      commit: COMMIT,
      label: "panels/news",
      subdir: "panels/news",
      sink: {
        put: async (bytes) => ({ digest: sha256Hex(bytes), size: bytes.byteLength }),
      },
    });
    expect(snapshot.files.map((file) => file.path)).toEqual(["index.ts"]);
  });
});

describe("reserved path policy", () => {
  const sink = {
    put: async (bytes: Uint8Array) => ({ digest: sha256Hex(bytes), size: bytes.byteLength }),
  };
  const withReserved = () => [blob("index.ts", "code"), blob(".env", "TOKEN=secret")];

  it("rejects a commit tracking reserved paths by default", async () => {
    await expect(
      readExactGitSnapshot({
        git: fakeGit(withReserved()),
        dir: "/checkout",
        commit: COMMIT,
        label: "projects/example",
        sink,
      })
    ).rejects.toThrow(/tracks paths excluded from the semantic snapshot/);
  });

  it("excludes reserved paths from the admitted set and the digest when asked", async () => {
    const snapshot = await readExactGitSnapshot({
      git: fakeGit(withReserved()),
      dir: "/checkout",
      commit: COMMIT,
      label: "workspace template base",
      sink,
      reservedPaths: "exclude",
    });
    expect(snapshot.files.map((file) => file.path)).toEqual(["index.ts"]);

    // The digest must be exactly the digest of the admitted set, so a template
    // pinned at discovery still verifies at acquisition.
    const withoutReserved = await readExactGitSnapshot({
      git: fakeGit([blob("index.ts", "code")]),
      dir: "/checkout",
      commit: COMMIT,
      label: "workspace template base",
      sink,
      reservedPaths: "exclude",
    });
    expect(snapshot.snapshot).toBe(withoutReserved.snapshot);
  });
});

describe("discoverTrackedGitSnapshot", () => {
  const sink = {
    put: async (bytes: Uint8Array) => ({ digest: sha256Hex(bytes), size: bytes.byteLength }),
  };

  it("selects v10 above v2 for a tracked tag glob and freezes the exact ref", async () => {
    const git = {
      resolveUrl: vi.fn(),
      clone: vi.fn(async () => undefined),
      listTags: vi.fn(async () => ["v1", "v10", "v2", "preview"]),
      checkout: vi.fn(async () => undefined),
      getCurrentCommit: vi.fn(async () => COMMIT),
      statusMatrix: vi.fn(async () => [["index.ts", 1, 1, 1]]),
      readCommitTree: vi.fn(async () => [blob("index.ts", "tracked")]),
    } as unknown as GitClient;

    const discovered = await discoverTrackedGitSnapshot({
      git,
      dir: "/checkout",
      url: "https://example.test/template.git",
      track: "refs/tags/v*",
      label: "template",
      sink,
    });

    expect(discovered.ref).toBe("refs/tags/v10");
    expect(git.checkout).toHaveBeenCalledWith("/checkout", "refs/tags/v10", {
      force: true,
    });
  });

  it("selects the release over its own prereleases for a tracked tag glob", async () => {
    const git = {
      resolveUrl: vi.fn(),
      clone: vi.fn(async () => undefined),
      listTags: vi.fn(async () => ["v1.0.0-rc1", "v1.0.0-rc2", "v1.0.0", "v0.9.0"]),
      checkout: vi.fn(async () => undefined),
      getCurrentCommit: vi.fn(async () => COMMIT),
      statusMatrix: vi.fn(async () => [["index.ts", 1, 1, 1]]),
      readCommitTree: vi.fn(async () => [blob("index.ts", "tracked")]),
    } as unknown as GitClient;

    const discovered = await discoverTrackedGitSnapshot({
      git,
      dir: "/checkout",
      url: "https://example.test/template.git",
      track: "refs/tags/v*",
      label: "template",
      sink,
    });

    // A trailing `-rc1` qualifies the release it hangs off, so it must never
    // be offered as an update above the finished release.
    expect(discovered.ref).toBe("refs/tags/v1.0.0");
  });

  it("orders prereleases of the same release among themselves", async () => {
    const git = {
      resolveUrl: vi.fn(),
      clone: vi.fn(async () => undefined),
      listTags: vi.fn(async () => ["v2.0.0-rc2", "v2.0.0-rc10", "v2.0.0-rc1"]),
      checkout: vi.fn(async () => undefined),
      getCurrentCommit: vi.fn(async () => COMMIT),
      statusMatrix: vi.fn(async () => [["index.ts", 1, 1, 1]]),
      readCommitTree: vi.fn(async () => [blob("index.ts", "tracked")]),
    } as unknown as GitClient;

    const discovered = await discoverTrackedGitSnapshot({
      git,
      dir: "/checkout",
      url: "https://example.test/template.git",
      track: "refs/tags/v*",
      label: "template",
      sink,
    });

    expect(discovered.ref).toBe("refs/tags/v2.0.0-rc10");
  });

  it("tracks a canonical branch without tag enumeration", async () => {
    const git = {
      clone: vi.fn(async () => undefined),
      resolveCommit: vi.fn(async () => COMMIT),
      getCurrentCommit: vi.fn(async () => COMMIT),
      statusMatrix: vi.fn(async () => [["index.ts", 1, 1, 1]]),
      readCommitTree: vi.fn(async () => [blob("index.ts", "tracked")]),
      listTags: vi.fn(),
      resolveUrl: vi.fn(),
    } as unknown as GitClient;

    const discovered = await discoverTrackedGitSnapshot({
      git,
      dir: "/checkout",
      url: "https://example.test/template.git",
      track: "refs/heads/stable",
      label: "template",
      sink,
    });

    expect(discovered.ref).toBe("refs/heads/stable");
    // Every acquisition path validates the remote URL before cloning; the
    // non-glob track branch used to be the one that skipped it.
    expect(git.resolveUrl).toHaveBeenCalledWith("https://example.test/template.git");
    expect(git.clone).toHaveBeenCalledWith(expect.objectContaining({ ref: "refs/heads/stable" }));
    expect(git.listTags).not.toHaveBeenCalled();
  });
});

describe("exact ref commit coordinates", () => {
  const sink = {
    put: async (bytes: Uint8Array) => ({ digest: sha256Hex(bytes), size: bytes.byteLength }),
  };

  function exactGit(observedCommit = COMMIT) {
    return {
      resolveUrl: vi.fn(),
      clone: vi.fn(async () => undefined),
      resolveCommit: vi.fn(async () => observedCommit),
      getCurrentCommit: vi.fn(async () => observedCommit),
      checkout: vi.fn(async () => undefined),
      statusMatrix: vi.fn(async () => [["index.ts", 1, 1, 1]]),
      readCommitTree: vi.fn(async () => [blob("index.ts", "tracked")]),
    } as unknown as GitClient;
  }

  it("discovers the peeled commit rather than an annotated tag object", async () => {
    const git = exactGit();
    const discovered = await discoverExactGitSnapshot({
      git,
      dir: "/checkout",
      url: "https://example.test/template.git",
      ref: "refs/tags/v1",
      label: "template",
      sink,
    });

    expect(discovered.commit).toBe(COMMIT);
    expect(git.resolveCommit).toHaveBeenCalledWith("/checkout", "refs/tags/v1");
  });

  it("verifies acquisition against the peeled commit", async () => {
    const git = exactGit();
    await expect(
      acquireExactGitSnapshot({
        git,
        dir: "/checkout",
        url: "https://example.test/template.git",
        ref: "refs/tags/v1",
        expectedCommit: COMMIT,
        label: "template",
        sink,
      })
    ).resolves.toMatchObject({ commit: COMMIT });
    expect(git.resolveCommit).toHaveBeenCalledWith("/checkout", "refs/tags/v1");
  });
});
