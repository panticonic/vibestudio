import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getDeclaredRemoteForRepo,
  getDeclaredRemotesForRepo,
  isDeclaredRemoteRepoPath,
  normalizeWorkspaceRepoPath,
  removeDeclaredRemoteFromConfig,
  removeDeclaredUpstreamFromConfig,
  setDeclaredRemoteInConfig,
  setDeclaredUpstreamInConfig,
  syncDeclaredRemoteForRepo,
} from "./remotes.js";
import type { WorkspaceConfig } from "./types.js";

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-remotes-"));
}

function initRepo(workspaceRoot: string, repoPath: string): void {
  const repoDir = path.join(workspaceRoot, repoPath);
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init"], { cwd: repoDir, stdio: "pipe" });
}

describe("workspace remotes", () => {
  it("classifies only section/repo paths as declared-remote eligible", () => {
    expect(isDeclaredRemoteRepoPath("panels/chat")).toBe(true);
    expect(isDeclaredRemoteRepoPath("meta")).toBe(true);
    expect(isDeclaredRemoteRepoPath("projects/vault")).toBe(true);
    expect(isDeclaredRemoteRepoPath("packages")).toBe(false);
    expect(isDeclaredRemoteRepoPath("agents/scribe")).toBe(false);
    expect(isDeclaredRemoteRepoPath("packages/core/src")).toBe(false);
    expect(isDeclaredRemoteRepoPath("tmp-git-stash-test")).toBe(false);
    expect(isDeclaredRemoteRepoPath("../tmp-git-stash-test")).toBe(false);
  });

  it("rejects non-canonical aliases that would collide with a canonical repo path", () => {
    // `.`/`..`/empty segments must be rejected (not silently canonicalized) so a
    // single string backs the log id, ref, projection dir, and caches — matching
    // refService.validateRepoPath.
    for (const bad of [
      "panels/./chat",
      "panels//chat",
      "./panels/chat",
      "panels/chat/",
      "/panels/chat",
      "panels\\chat",
      "..",
      "a/../b",
    ]) {
      expect(isDeclaredRemoteRepoPath(bad), bad).toBe(false);
      expect(() => normalizeWorkspaceRepoPath(bad), bad).toThrow(/Invalid workspace repo path/);
    }
  });

  it("stores remote names as keys under the section/repo declaration", () => {
    const config: WorkspaceConfig = { id: "test", git: {} };

    const withOrigin = setDeclaredRemoteInConfig(config, "panels/chat", {
      name: "origin",
      url: "https://github.com/acme/chat.git",
    });
    const next = setDeclaredRemoteInConfig(withOrigin, "panels/chat", {
      name: "ci",
      url: "https://github.com/acme/chat-ci.git",
    });

    expect(next.git?.remotes?.["panels"]?.["chat"]).toEqual({
      origin: { url: "https://github.com/acme/chat.git" },
      ci: { url: "https://github.com/acme/chat-ci.git" },
    });
    expect(getDeclaredRemoteForRepo(next, "panels/chat")).toMatchObject({
      repoPath: "panels/chat",
      section: "panels",
      repoKey: "chat",
      name: "origin",
    });
    expect(getDeclaredRemoteForRepo(next, "panels/chat", "ci")).toMatchObject({
      name: "ci",
      url: "https://github.com/acme/chat-ci.git",
    });
    expect(getDeclaredRemotesForRepo(next, "panels/chat").map((remote) => remote.name)).toEqual([
      "ci",
      "origin",
    ]);
  });

  it("stores branch-specific remotes as object declarations", () => {
    const next = setDeclaredRemoteInConfig({ id: "test", git: {} }, "projects/bgkit", {
      name: "origin",
      url: "https://github.com/werg/bgkit.git",
      branch: "vibestudio-bridge",
    });

    expect(next.git?.remotes?.["projects"]?.["bgkit"]).toEqual({
      origin: {
        url: "https://github.com/werg/bgkit.git",
        branch: "vibestudio-bridge",
      },
    });
    expect(getDeclaredRemoteForRepo(next, "projects/bgkit")).toMatchObject({
      repoPath: "projects/bgkit",
      section: "projects",
      repoKey: "bgkit",
      name: "origin",
      url: "https://github.com/werg/bgkit.git",
      branch: "vibestudio-bridge",
    });
  });

  it("removes a named remote without removing the repo declaration", () => {
    const config = setDeclaredRemoteInConfig(
      setDeclaredRemoteInConfig({ id: "test", git: {} }, "panels/chat", {
        name: "origin",
        url: "https://github.com/acme/chat.git",
      }),
      "panels/chat",
      {
        name: "ci",
        url: "https://github.com/acme/chat-ci.git",
      }
    );

    const next = removeDeclaredRemoteFromConfig(config, "panels/chat", "ci");

    expect(next.git?.remotes?.["panels"]?.["chat"]).toEqual({
      origin: { url: "https://github.com/acme/chat.git" },
    });
  });

  it("prunes empty repo, section, and git maps after the last declaration is removed", () => {
    const withRemote = setDeclaredRemoteInConfig({ id: "test" }, "panels/chat", {
      name: "origin",
      url: "https://github.com/acme/chat.git",
    });

    expect(removeDeclaredRemoteFromConfig(withRemote, "panels/chat", "origin")).toEqual({
      id: "test",
    });
  });

  it("prunes the upstream tree without disturbing the remaining remote tree", () => {
    const withRemote = setDeclaredRemoteInConfig({ id: "test" }, "panels/chat", {
      name: "origin",
      url: "https://github.com/acme/chat.git",
    });
    const withUpstream = setDeclaredUpstreamInConfig(withRemote, "panels/chat", {
      remote: "origin",
      branch: "main",
    });

    expect(removeDeclaredUpstreamFromConfig(withUpstream, "panels/chat")).toEqual(withRemote);
  });

  it("rejects remote URLs with embedded credentials", () => {
    expect(() =>
      setDeclaredRemoteInConfig({ id: "test" }, "panels/chat", {
        name: "origin",
        url: "https://token@github.com/acme/chat.git",
      })
    ).toThrow("Remote URL must not contain embedded credentials");
  });

  it("rejects invalid remote branch names", () => {
    expect(() =>
      setDeclaredRemoteInConfig({ id: "test" }, "projects/bgkit", {
        name: "origin",
        url: "https://github.com/werg/bgkit.git",
        branch: "../main",
      })
    ).toThrow("Invalid remote branch");
  });

  it("materializes declared remotes into git config", async () => {
    const workspaceRoot = tempWorkspace();
    initRepo(workspaceRoot, "panels/chat");
    const config = setDeclaredRemoteInConfig(
      setDeclaredRemoteInConfig({ id: "test", git: {} }, "panels/chat", {
        name: "origin",
        url: "https://github.com/acme/chat.git",
      }),
      "panels/chat",
      {
        name: "ci",
        url: "https://github.com/acme/chat-ci.git",
      }
    );

    await syncDeclaredRemoteForRepo({ config, workspaceRoot, repoPath: "panels/chat" });

    const repoDir = path.join(workspaceRoot, "panels/chat");
    expect(
      execFileSync("git", ["remote", "get-url", "origin"], {
        cwd: repoDir,
        encoding: "utf-8",
      }).trim()
    ).toBe("https://github.com/acme/chat.git");
    expect(
      execFileSync("git", ["remote", "get-url", "ci"], {
        cwd: repoDir,
        encoding: "utf-8",
      }).trim()
    ).toBe("https://github.com/acme/chat-ci.git");
    expect(
      execFileSync("git", ["config", "remote.origin.vibestudio-managed"], {
        cwd: repoDir,
        encoding: "utf-8",
      }).trim()
    ).toBe("true");
  });

  it("applies a predeclared remote when the repo appears later", async () => {
    const workspaceRoot = tempWorkspace();
    const config = setDeclaredRemoteInConfig({ id: "test", git: {} }, "panels/future", {
      name: "origin",
      url: "https://github.com/acme/future.git",
    });

    await expect(
      syncDeclaredRemoteForRepo({
        config,
        workspaceRoot,
        repoPath: "panels/future",
      })
    ).resolves.toMatchObject({ applied: false });

    initRepo(workspaceRoot, "panels/future");
    await expect(
      syncDeclaredRemoteForRepo({
        config,
        workspaceRoot,
        repoPath: "panels/future",
      })
    ).resolves.toMatchObject({ applied: true });

    expect(
      execFileSync("git", ["remote", "get-url", "origin"], {
        cwd: path.join(workspaceRoot, "panels/future"),
        encoding: "utf-8",
      }).trim()
    ).toBe("https://github.com/acme/future.git");
  });
});
