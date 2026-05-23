import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, lstatSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { GitClient } from "@natstack/git";
import { ContextFolderManager } from "./contextFolderManager.js";
import type { WorkspaceNode } from "./types.js";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "natstack-context-folder-"));
  tempRoots.push(root);
  return root;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initGitRepo(cwd: string): void {
  try {
    git(cwd, ["init", "-b", "main"]);
  } catch {
    git(cwd, ["init"]);
    git(cwd, ["checkout", "-B", "main"]);
  }
}

function makeNode(repoPath: string): WorkspaceNode {
  return {
    name: path.basename(repoPath),
    path: repoPath,
    type: "directory",
    isGitRepo: true,
    children: [],
  } as WorkspaceNode;
}

describe("ContextFolderManager", () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      rmSync(tempRoots.pop()!, { recursive: true, force: true });
    }
  });

  it("symlinks git object storage so panel-side GitClient can read context repo status", async () => {
    const root = makeTempRoot();
    const sourcePath = path.join(root, "source");
    const contextsRoot = path.join(root, "contexts");
    const repoRel = "projects/default";
    const repoPath = path.join(sourcePath, repoRel);

    mkdirSync(repoPath, { recursive: true });
    writeFileSync(path.join(repoPath, "Welcome.mdx"), "# Welcome\n");
    initGitRepo(repoPath);
    git(repoPath, ["config", "user.name", "Test"]);
    git(repoPath, ["config", "user.email", "test@natstack.local"]);
    git(repoPath, ["add", "Welcome.mdx"]);
    git(repoPath, ["commit", "-m", "Initial commit"]);

    const manager = new ContextFolderManager({
      sourcePath,
      contextsRoot,
      getWorkspaceTree: async () => ({ children: [makeNode(repoRel)] }),
    });

    const contextPath = await manager.ensureContextFolder("ctx-test");
    const contextRepoPath = path.join(contextPath, repoRel);

    expect(lstatSync(path.join(contextRepoPath, ".git", "objects")).isSymbolicLink()).toBe(true);

    const client = new GitClient(fs, { token: "test" });
    await expect(client.status(contextRepoPath)).resolves.toMatchObject({
      branch: "main",
      dirty: false,
    });
  });

  it("lets context commits create loose objects in the shared source object store", async () => {
    const root = makeTempRoot();
    const sourcePath = path.join(root, "source");
    const contextsRoot = path.join(root, "contexts");
    const repoRel = "projects/default";
    const repoPath = path.join(sourcePath, repoRel);

    mkdirSync(repoPath, { recursive: true });
    writeFileSync(path.join(repoPath, "Welcome.mdx"), "# Welcome\n");
    initGitRepo(repoPath);
    git(repoPath, ["config", "user.name", "Test"]);
    git(repoPath, ["config", "user.email", "test@natstack.local"]);
    git(repoPath, ["add", "Welcome.mdx"]);
    git(repoPath, ["commit", "-m", "Initial commit"]);

    const manager = new ContextFolderManager({
      sourcePath,
      contextsRoot,
      getWorkspaceTree: async () => ({ children: [makeNode(repoRel)] }),
    });

    const contextPath = await manager.ensureContextFolder("ctx-test");
    const contextRepoPath = path.join(contextPath, repoRel);
    writeFileSync(path.join(contextRepoPath, "new-file.txt"), "from context\n");

    const client = new GitClient(fs, { token: "test" });
    await client.addAll(contextRepoPath);
    const sha = await client.commit({ dir: contextRepoPath, message: "Context commit" });

    await expect(
      fs.stat(path.join(repoPath, ".git", "objects", sha.slice(0, 2), sha.slice(2)))
    ).resolves.toBeTruthy();
  });

  it("copies branch refs so panel-side GitClient can checkout another branch", async () => {
    const root = makeTempRoot();
    const sourcePath = path.join(root, "source");
    const contextsRoot = path.join(root, "contexts");
    const repoRel = "projects/default";
    const repoPath = path.join(sourcePath, repoRel);

    mkdirSync(repoPath, { recursive: true });
    writeFileSync(path.join(repoPath, "Welcome.mdx"), "# Welcome\n");
    initGitRepo(repoPath);
    git(repoPath, ["config", "user.name", "Test"]);
    git(repoPath, ["config", "user.email", "test@natstack.local"]);
    git(repoPath, ["add", "Welcome.mdx"]);
    git(repoPath, ["commit", "-m", "Initial commit"]);
    git(repoPath, ["checkout", "-b", "branch-e2e"]);
    writeFileSync(path.join(repoPath, "Welcome.mdx"), "# Branch\n");
    git(repoPath, ["add", "Welcome.mdx"]);
    git(repoPath, ["commit", "-m", "Branch commit"]);
    git(repoPath, ["checkout", "main"]);

    const manager = new ContextFolderManager({
      sourcePath,
      contextsRoot,
      getWorkspaceTree: async () => ({ children: [makeNode(repoRel)] }),
    });

    const contextPath = await manager.ensureContextFolder("ctx-test");
    const contextRepoPath = path.join(contextPath, repoRel);
    const client = new GitClient(fs, { token: "test" });

    await client.checkout(contextRepoPath, "branch-e2e");
    await expect(client.status(contextRepoPath)).resolves.toMatchObject({
      branch: "branch-e2e",
      dirty: false,
    });
  });

  it("skips transient git lock files when copying context git state", async () => {
    const root = makeTempRoot();
    const sourcePath = path.join(root, "source");
    const contextsRoot = path.join(root, "contexts");
    const repoRel = "projects/default";
    const repoPath = path.join(sourcePath, repoRel);

    mkdirSync(repoPath, { recursive: true });
    writeFileSync(path.join(repoPath, "Welcome.mdx"), "# Welcome\n");
    initGitRepo(repoPath);
    git(repoPath, ["config", "user.name", "Test"]);
    git(repoPath, ["config", "user.email", "test@natstack.local"]);
    git(repoPath, ["add", "Welcome.mdx"]);
    git(repoPath, ["commit", "-m", "Initial commit"]);
    writeFileSync(path.join(repoPath, ".git", "index.lock"), "");
    writeFileSync(path.join(repoPath, ".git", "refs", "heads", "main.lock"), "");

    const manager = new ContextFolderManager({
      sourcePath,
      contextsRoot,
      getWorkspaceTree: async () => ({ children: [makeNode(repoRel)] }),
    });

    const contextPath = await manager.ensureContextFolder("ctx-test");
    const contextRepoPath = path.join(contextPath, repoRel);

    await expect(fs.stat(path.join(contextRepoPath, ".git", "index.lock"))).rejects.toThrow();
    await expect(
      fs.stat(path.join(contextRepoPath, ".git", "refs", "heads", "main.lock"))
    ).rejects.toThrow();
  });

  it("does not symlink git hooks into context repos", async () => {
    const root = makeTempRoot();
    const sourcePath = path.join(root, "source");
    const contextsRoot = path.join(root, "contexts");
    const repoRel = "projects/default";
    const repoPath = path.join(sourcePath, repoRel);

    mkdirSync(repoPath, { recursive: true });
    writeFileSync(path.join(repoPath, "Welcome.mdx"), "# Welcome\n");
    initGitRepo(repoPath);
    mkdirSync(path.join(repoPath, ".git", "hooks"), { recursive: true });
    writeFileSync(path.join(repoPath, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n");

    const manager = new ContextFolderManager({
      sourcePath,
      contextsRoot,
      getWorkspaceTree: async () => ({ children: [makeNode(repoRel)] }),
    });

    const contextPath = await manager.ensureContextFolder("ctx-test");
    const hooksPath = path.join(contextPath, repoRel, ".git", "hooks");
    expect(lstatSync(hooksPath).isSymbolicLink()).toBe(false);
    await expect(fs.stat(path.join(hooksPath, "pre-commit"))).resolves.toBeTruthy();
  });

  it("rejects shared object symlinks to external or sibling repo object stores", async () => {
    const root = makeTempRoot();
    const sourcePath = path.join(root, "source");
    const contextsRoot = path.join(root, "contexts");
    const repoA = "projects/a";
    const repoB = "projects/b";
    for (const repoRel of [repoA, repoB]) {
      const repoPath = path.join(sourcePath, repoRel);
      mkdirSync(repoPath, { recursive: true });
      writeFileSync(path.join(repoPath, "README.md"), repoRel);
      initGitRepo(repoPath);
      git(repoPath, ["config", "user.name", "Test"]);
      git(repoPath, ["config", "user.email", "test@natstack.local"]);
      git(repoPath, ["add", "README.md"]);
      git(repoPath, ["commit", "-m", "Initial commit"]);
    }

    const manager = new ContextFolderManager({
      sourcePath,
      contextsRoot,
      getWorkspaceTree: async () => ({ children: [makeNode(repoA), makeNode(repoB)] }),
    });

    const contextPath = await manager.ensureContextFolder("ctx-test");
    const objectsPath = path.join(contextPath, repoA, ".git", "objects");
    await fs.rm(objectsPath, { recursive: true, force: true });

    const externalObjects = path.join(root, "external-objects");
    mkdirSync(externalObjects, { recursive: true });
    symlinkSync(externalObjects, objectsPath, "dir");
    await expect(
      manager.isAllowedSharedGitObjectsSymlink({
        contextRoot: contextPath,
        symlinkPath: objectsPath,
        realTarget: await fs.realpath(objectsPath),
      })
    ).resolves.toBe(false);

    await fs.rm(objectsPath, { recursive: true, force: true });
    symlinkSync(path.join(sourcePath, repoB, ".git", "objects"), objectsPath, "dir");
    await expect(
      manager.isAllowedSharedGitObjectsSymlink({
        contextRoot: contextPath,
        symlinkPath: objectsPath,
        realTarget: await fs.realpath(objectsPath),
      })
    ).resolves.toBe(false);
  });

  it("repairs copied context object stores and preserves loose context-only objects", async () => {
    const root = makeTempRoot();
    const sourcePath = path.join(root, "source");
    const contextsRoot = path.join(root, "contexts");
    const repoRel = "projects/default";
    const repoPath = path.join(sourcePath, repoRel);

    mkdirSync(repoPath, { recursive: true });
    writeFileSync(path.join(repoPath, "Welcome.mdx"), "# Welcome\n");
    initGitRepo(repoPath);
    git(repoPath, ["config", "user.name", "Test"]);
    git(repoPath, ["config", "user.email", "test@natstack.local"]);
    git(repoPath, ["add", "Welcome.mdx"]);
    git(repoPath, ["commit", "-m", "Initial commit"]);

    const manager = new ContextFolderManager({
      sourcePath,
      contextsRoot,
      getWorkspaceTree: async () => ({ children: [makeNode(repoRel)] }),
    });

    const contextPath = await manager.ensureContextFolder("ctx-test");
    const objectsPath = path.join(contextPath, repoRel, ".git", "objects");
    await fs.rm(objectsPath, { recursive: true, force: true });
    mkdirSync(path.join(objectsPath, "12"), { recursive: true });
    writeFileSync(
      path.join(objectsPath, "12", "34567890123456789012345678901234567890"),
      "context-only"
    );

    await manager.repairSharedGitObjects(repoRel);

    expect(lstatSync(objectsPath).isSymbolicLink()).toBe(true);
    await expect(
      fs.readFile(
        path.join(repoPath, ".git", "objects", "12", "34567890123456789012345678901234567890"),
        "utf8"
      )
    ).resolves.toBe("context-only");
  });
});
