import { GitServer } from "./server.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-dev-mirror-"));
  tempRoots.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", "main"]);
  configureUser(dir);
}

function configureUser(dir: string): void {
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test User"]);
}

function commitFile(dir: string, filePath: string, content: string, message: string): string {
  const abs = path.join(dir, filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

function mirrorRuntime(server: GitServer) {
  return server as unknown as {
    syncToDevTarget: (args: {
      repo: string;
      repoDir: string;
      branch: string;
      commit: string;
    }) => void;
    syncGitFastForward: (args: {
      repo: string;
      repoDir: string;
      branch: string;
      commit: string;
      mirror: { targetDir: string; mode: "git-fast-forward"; branchPrefix?: string };
      targetDir: string;
    }) => Promise<void>;
    runDevMirror: (args: unknown) => Promise<void>;
    devMirrorQueues: Map<string, Promise<void>>;
  };
}

function mirrorEventSpy() {
  return vi.spyOn(console, "log").mockImplementation(() => undefined);
}

function parsedMirrorEvents(
  spy: ReturnType<typeof mirrorEventSpy>
): Array<Record<string, unknown>> {
  return spy.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.startsWith("[mirror] "))
    .map((line) => JSON.parse(line.slice("[mirror] ".length)) as Record<string, unknown>);
}

describe("GitServer dev mirrors", () => {
  it("uses the default dev mirror for repos without an explicit mirror", async () => {
    const server = new GitServer({
      defaultDevMirror: {
        targetDir: "/template",
        mode: "rsync-delete",
      },
    });
    const runtimeServer = mirrorRuntime(server);
    const mirrorSpy = vi.spyOn(runtimeServer, "runDevMirror").mockResolvedValue(undefined);

    runtimeServer.syncToDevTarget({
      repo: "projects/new-project",
      repoDir: "/workspace/source/projects/new-project",
      branch: "main",
      commit: "abc123",
    });
    await Promise.all([...runtimeServer.devMirrorQueues.values()]);

    expect(mirrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: "projects/new-project",
        targetDir: "/template/projects/new-project",
        mirror: {
          targetDir: "/template",
          mode: "rsync-delete",
        },
      })
    );
  });

  it("prefers an explicit dev mirror over the default mirror", async () => {
    const server = new GitServer({
      devMirrors: {
        "projects/natstack": {
          targetDir: "/checkout",
          mode: "git-fast-forward",
        },
      },
      defaultDevMirror: {
        targetDir: "/template",
        mode: "rsync-delete",
      },
    });
    const runtimeServer = mirrorRuntime(server);
    const mirrorSpy = vi.spyOn(runtimeServer, "runDevMirror").mockResolvedValue(undefined);

    runtimeServer.syncToDevTarget({
      repo: "projects/natstack",
      repoDir: "/workspace/source/projects/natstack",
      branch: "main",
      commit: "abc123",
    });
    await Promise.all([...runtimeServer.devMirrorQueues.values()]);

    expect(mirrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: "projects/natstack",
        targetDir: "/checkout",
        mirror: {
          targetDir: "/checkout",
          mode: "git-fast-forward",
        },
      })
    );
  });

  it("fast-forwards a clean git target, records changed paths, and writes the sentinel", async () => {
    const root = tmpDir();
    const targetDir = path.join(root, "target");
    const repoDir = path.join(root, "source");
    initRepo(targetDir);
    commitFile(targetDir, "a.txt", "one\n", "initial");
    git(root, ["clone", targetDir, repoDir]);
    configureUser(repoDir);
    const commit = commitFile(repoDir, "a.txt", "two\n", "update");
    const server = mirrorRuntime(new GitServer());
    const logSpy = mirrorEventSpy();

    await server.syncGitFastForward({
      repo: "projects/natstack",
      repoDir,
      branch: "main",
      commit,
      mirror: { targetDir, mode: "git-fast-forward" },
      targetDir,
    });

    expect(git(targetDir, ["rev-parse", "HEAD"])).toBe(commit);
    expect(fs.readFileSync(path.join(targetDir, "a.txt"), "utf8")).toBe("two\n");
    expect(
      fs.readFileSync(path.join(targetDir, ".git", "natstack", "dogfood-last-applied"), "utf8")
    ).toBe(`${commit}\n`);
    expect(parsedMirrorEvents(logSpy)).toContainEqual(
      expect.objectContaining({
        event: "applied",
        sha: commit,
        changedPaths: ["a.txt"],
      })
    );
  });

  it("skips a dirty git target without changing HEAD", async () => {
    const root = tmpDir();
    const targetDir = path.join(root, "target");
    const repoDir = path.join(root, "source");
    initRepo(targetDir);
    const base = commitFile(targetDir, "a.txt", "one\n", "initial");
    git(root, ["clone", targetDir, repoDir]);
    configureUser(repoDir);
    const commit = commitFile(repoDir, "a.txt", "two\n", "update");
    fs.writeFileSync(path.join(targetDir, "dirty.txt"), "dirty\n", "utf8");
    const server = mirrorRuntime(new GitServer());
    const logSpy = mirrorEventSpy();

    await server.syncGitFastForward({
      repo: "projects/natstack",
      repoDir,
      branch: "main",
      commit,
      mirror: { targetDir, mode: "git-fast-forward" },
      targetDir,
    });

    expect(git(targetDir, ["rev-parse", "HEAD"])).toBe(base);
    expect(parsedMirrorEvents(logSpy)).toContainEqual(
      expect.objectContaining({
        event: "skipped-dirty",
        dirtyPaths: ["dirty.txt"],
      })
    );
  });

  it("creates a dogfood branch on non-fast-forward without writing the sentinel", async () => {
    const root = tmpDir();
    const targetDir = path.join(root, "target");
    const repoDir = path.join(root, "source");
    initRepo(targetDir);
    commitFile(targetDir, "a.txt", "one\n", "initial");
    git(root, ["clone", targetDir, repoDir]);
    configureUser(repoDir);
    const sourceCommit = commitFile(repoDir, "a.txt", "source\n", "source");
    commitFile(targetDir, "a.txt", "target\n", "target");
    const server = mirrorRuntime(new GitServer());
    const logSpy = mirrorEventSpy();

    await server.syncGitFastForward({
      repo: "projects/natstack",
      repoDir,
      branch: "main",
      commit: sourceCommit,
      mirror: { targetDir, mode: "git-fast-forward" },
      targetDir,
    });

    const branchName = `dogfood/${sourceCommit.slice(0, 12)}`;
    expect(git(targetDir, ["rev-parse", branchName])).toBe(sourceCommit);
    expect(fs.existsSync(path.join(targetDir, ".git", "natstack", "dogfood-last-applied"))).toBe(
      false
    );
    expect(parsedMirrorEvents(logSpy)).toContainEqual(
      expect.objectContaining({
        event: "branch-created",
        sha: sourceCommit,
        branch: branchName,
      })
    );
  });

  it("fetches the accepted commit, not the current branch tip", async () => {
    const root = tmpDir();
    const targetDir = path.join(root, "target");
    const repoDir = path.join(root, "source");
    initRepo(targetDir);
    commitFile(targetDir, "a.txt", "one\n", "initial");
    git(root, ["clone", targetDir, repoDir]);
    configureUser(repoDir);
    const acceptedCommit = commitFile(repoDir, "a.txt", "two\n", "accepted");
    const laterCommit = commitFile(repoDir, "a.txt", "three\n", "later");
    const server = mirrorRuntime(new GitServer());
    mirrorEventSpy();

    await server.syncGitFastForward({
      repo: "projects/natstack",
      repoDir,
      branch: "main",
      commit: acceptedCommit,
      mirror: { targetDir, mode: "git-fast-forward" },
      targetDir,
    });

    expect(git(targetDir, ["rev-parse", "HEAD"])).toBe(acceptedCommit);
    expect(git(repoDir, ["rev-parse", "HEAD"])).toBe(laterCommit);
    expect(fs.readFileSync(path.join(targetDir, "a.txt"), "utf8")).toBe("two\n");
  });
});
