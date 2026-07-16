/**
 * Tests for GitAuthError from client.ts.
 *
 * The full GitClient requires isomorphic-git and a filesystem mock,
 * so we focus on the exported GitAuthError class which is cleanly testable.
 */

import type { HttpClient, StatusRow } from "isomorphic-git";
import git from "isomorphic-git";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GitAuthError } from "./client.js";
import { GitClient, type FsPromisesLike } from "./client.js";

describe("GitAuthError", () => {
  it("has correct name and message", () => {
    const error = new GitAuthError("Authentication failed");
    expect(error.name).toBe("GitAuthError");
    expect(error.message).toBe("Authentication failed");
  });

  it("is an instance of Error", () => {
    const error = new GitAuthError("auth error");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(GitAuthError);
  });

  it("stores optional statusCode", () => {
    const errorWithCode = new GitAuthError("Forbidden", 403);
    expect(errorWithCode.statusCode).toBe(403);

    const errorWithoutCode = new GitAuthError("No code");
    expect(errorWithoutCode.statusCode).toBeUndefined();
  });
});

describe("GitClient", () => {
  const http: HttpClient = {
    request: vi.fn(async (request) => ({
      url: request.url,
      method: request.method ?? "GET",
      statusCode: 200,
      statusMessage: "OK",
      headers: {},
      body: (async function* () {})(),
    })),
  };
  const fs = {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn(),
    readdir: vi.fn(),
    mkdir: vi.fn(),
    rmdir: vi.fn(),
    stat: vi.fn(),
    lstat: vi.fn(),
    readlink: vi.fn(),
    symlink: vi.fn(),
    chmod: vi.fn(),
  } satisfies FsPromisesLike;

  it("supports no-argument local repository inspection while keeping network adapter-gated", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "git-client-local-"));
    try {
      const client = new GitClient();
      await client.init(dir, "main");
      await expect(client.getCurrentBranch(dir)).resolves.toBe("main");
      await expect(
        client.clone({ url: "https://example.com/repo.git", dir: path.join(dir, "clone") })
      ).rejects.toThrow("host-mediated HTTP adapter");
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("supports an explicit full-history clone for re-publishable imports", async () => {
    const clone = vi.spyOn(git, "clone").mockResolvedValueOnce(undefined);
    const checkout = vi.spyOn(git, "checkout").mockResolvedValueOnce(undefined);
    const client = new GitClient(fs, { http });

    await client.clone({
      url: "https://example.com/source.git",
      dir: "/repo",
      ref: "main",
      fullHistory: true,
    });

    expect(clone).toHaveBeenCalledWith(
      expect.objectContaining({
        dir: "/repo",
        ref: "main",
        depth: undefined,
      })
    );
    expect(checkout).toHaveBeenCalledWith(expect.objectContaining({ dir: "/repo", ref: "main" }));
  });

  it("exposes the raw isomorphic-git status matrix", async () => {
    const matrix: StatusRow[] = [["src/app.ts", 1, 2, 1]];
    const statusMatrix = vi.spyOn(git, "statusMatrix").mockResolvedValueOnce(matrix);
    const client = new GitClient(fs, { http });

    await expect(client.statusMatrix("/repo")).resolves.toEqual(matrix);
    expect(statusMatrix).toHaveBeenCalledWith({
      fs: expect.any(Object),
      dir: "/repo",
    });
  });

  it("reads paths, bytes, and executable modes from one immutable commit tree", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "git-client-tree-"));
    try {
      const client = new GitClient();
      await client.init(dir, "main");
      await fsp.mkdir(path.join(dir, "src"), { recursive: true });
      await fsp.writeFile(path.join(dir, "src/app.ts"), "committed\n");
      await fsp.writeFile(path.join(dir, "run.sh"), "#!/bin/sh\nexit 0\n");
      await fsp.chmod(path.join(dir, "run.sh"), 0o755);
      await client.add(dir, "src/app.ts");
      await client.add(dir, "run.sh");
      const commitOid = await client.commit({
        dir,
        message: "Exact tree",
        author: { name: "Test", email: "test@example.com" },
      });

      await fsp.writeFile(path.join(dir, "src/app.ts"), "mutable checkout\n");
      await fsp.chmod(path.join(dir, "run.sh"), 0o644);

      const tree = await client.readCommitTree(dir, commitOid);
      expect(
        tree.map((entry) => ({
          path: entry.path,
          type: entry.type,
          mode: entry.mode,
          content: entry.type === "blob" ? Buffer.from(entry.bytes).toString("utf8") : null,
        }))
      ).toEqual([
        { path: "run.sh", type: "blob", mode: 0o100755, content: "#!/bin/sh\nexit 0\n" },
        { path: "src/app.ts", type: "blob", mode: 0o100644, content: "committed\n" },
      ]);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("requires callers to resolve a moving ref before reading a commit tree", async () => {
    const client = new GitClient(fs, { http });
    await expect(client.readCommitTree("/repo", "HEAD")).rejects.toThrow(
      /requires a full commit object id/
    );
  });

  it("resolves bounded per-path history against an exact revision", async () => {
    const log = vi.spyOn(git, "log").mockResolvedValueOnce([
      {
        oid: "commit:old-author",
        commit: {
          message: "Original authorship",
          parent: [],
          tree: "tree:one",
          author: {
            name: "Ada",
            email: "ada@example.com",
            timestamp: 1,
            timezoneOffset: 0,
          },
          committer: {
            name: "Ada",
            email: "ada@example.com",
            timestamp: 1,
            timezoneOffset: 0,
          },
        },
        payload: "",
      },
    ]);
    const client = new GitClient(fs, { http });

    await expect(
      client.getFileHistory("/repo", "src/untouched.ts", {
        ref: "commit:head",
        depth: 1,
      })
    ).resolves.toEqual([
      expect.objectContaining({
        commit: "commit:old-author",
        author: expect.objectContaining({ name: "Ada" }),
      }),
    ]);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        dir: "/repo",
        filepath: "src/untouched.ts",
        ref: "commit:head",
        follow: true,
        depth: 1,
      })
    );
  });

  it("exposes a discoverable method list", () => {
    const client = new GitClient(fs, { http });

    expect(client.methods).toEqual(
      expect.arrayContaining(["commit", "fetch", "push", "status", "statusMatrix"])
    );
  });

  it("rejects positional forms for canonical object-input methods", async () => {
    const client = new GitClient(fs, { http });
    const statusMatrix = vi.spyOn(git, "statusMatrix");
    const commit = vi.spyOn(git, "commit");
    const branch = vi.spyOn(git, "branch");

    await expect(client.status({ dir: "/repo" } as never)).rejects.toThrow(
      "git.status: expected status(dir: string)"
    );
    await expect(client.fetch("/repo" as never)).rejects.toThrow(
      "git.fetch: expected fetch({ dir: string, url?: string, remote?: string, ref?: string })"
    );
    await expect(client.pull("/repo" as never)).rejects.toThrow(
      "git.pull: expected pull({ dir: string, url?: string, remote?: string, ref?: string, remoteRef?: string })"
    );
    await expect(client.push("/repo" as never)).rejects.toThrow(
      "git.push: expected push({ dir: string, url?: string, remote?: string, ref?: string, remoteRef?: string, force?: boolean })"
    );
    await expect(client.commit("/repo" as never)).rejects.toThrow(
      "git.commit: expected commit({ dir: string, message: string, author?: { name: string, email: string } })"
    );
    await expect(client.createBranch("/repo" as never)).rejects.toThrow(
      "git.createBranch: expected createBranch({ dir: string, name: string, startPoint?: string, checkout?: boolean })"
    );
    expect(statusMatrix).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(branch).not.toHaveBeenCalled();
  });

  it("forwards canonical commit and createBranch option objects", async () => {
    const client = new GitClient(fs, { http });
    const commit = vi.spyOn(git, "commit").mockResolvedValueOnce("commit-sha");
    const branch = vi.spyOn(git, "branch").mockResolvedValueOnce(undefined);

    await expect(
      client.commit({
        dir: "/repo",
        message: "Ship it",
        author: { name: "Ada", email: "ada@example.com" },
      })
    ).resolves.toBe("commit-sha");
    await expect(
      client.createBranch({
        dir: "/repo",
        name: "feature/object-input",
        startPoint: "main",
        checkout: true,
      })
    ).resolves.toBeUndefined();

    expect(commit).toHaveBeenCalledWith({
      fs: expect.any(Object),
      dir: "/repo",
      message: "Ship it",
      author: { name: "Ada", email: "ada@example.com" },
    });
    expect(branch).toHaveBeenCalledWith({
      fs: expect.any(Object),
      dir: "/repo",
      ref: "feature/object-input",
      object: "main",
      checkout: true,
    });
  });

  it("forwards an operation-bound URL to every remote transport", async () => {
    const client = new GitClient(fs, { http });
    const fetch = vi.spyOn(git, "fetch").mockResolvedValueOnce({
      defaultBranch: null,
      fetchHead: null,
      fetchHeadDescription: null,
      headers: {},
    });
    const push = vi.spyOn(git, "push").mockResolvedValueOnce({
      ok: true,
      error: null,
      refs: {},
    });
    const pull = vi.spyOn(git, "pull").mockResolvedValueOnce(undefined);
    const fastForward = vi.spyOn(git, "fastForward").mockResolvedValueOnce(undefined);
    const url = "https://example.com/immutable.git";

    await client.fetch({ dir: "/repo", url, remote: "vibestudio-token", ref: "main" });
    await client.push({ dir: "/repo", url, remote: "vibestudio-token", ref: "main" });
    await client.pull({
      dir: "/repo",
      url,
      remote: "vibestudio-token",
      ref: "local",
      remoteRef: "main",
      author: { name: "Test User", email: "test@example.com" },
    });
    await client.fastForward({
      dir: "/repo",
      url,
      remote: "vibestudio-token",
      ref: "local",
      remoteRef: "main",
    });

    for (const transport of [fetch, push]) {
      expect(transport).toHaveBeenCalledWith(
        expect.objectContaining({ url, remote: "vibestudio-token", ref: "main" })
      );
    }
    for (const transport of [pull, fastForward]) {
      expect(transport).toHaveBeenCalledWith(
        expect.objectContaining({
          url,
          remote: "vibestudio-token",
          ref: "local",
          remoteRef: "main",
        })
      );
    }
  });

  it("refuses to create an unattributed commit", async () => {
    const commit = vi.spyOn(git, "commit");
    const client = new GitClient(fs, { http });

    await expect(client.commit({ dir: "/repo", message: "change" })).rejects.toThrow(
      /explicit author.*required/
    );
    expect(commit).not.toHaveBeenCalled();
  });
});
