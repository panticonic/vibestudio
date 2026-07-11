/**
 * Tests for GitAuthError from client.ts.
 *
 * The full GitClient requires isomorphic-git and a filesystem mock,
 * so we focus on the exported GitAuthError class which is cleanly testable.
 */

import type { HttpClient, StatusRow } from "isomorphic-git";
import git from "isomorphic-git";
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

  it("exposes a discoverable method list", () => {
    const client = new GitClient(fs, { http });

    expect(client.methods).toEqual(
      expect.arrayContaining(["commit", "fetch", "push", "status", "statusMatrix"])
    );
  });

  it("validates status and fetch argument shapes before calling isomorphic-git", async () => {
    const client = new GitClient(fs, { http });
    const statusMatrix = vi.spyOn(git, "statusMatrix");

    await expect(client.status({ dir: "/repo" } as never)).rejects.toThrow(
      "git.status: expected status(dir: string)"
    );
    await expect(client.fetch("/repo" as never)).rejects.toThrow(
      "git.fetch: expected fetch({ dir: string, remote?: string, ref?: string })"
    );
    expect(statusMatrix).not.toHaveBeenCalled();
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
