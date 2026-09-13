import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildLocalGitMirror,
  canonicalUpstreamUrl,
  selfDevelopmentMirrorEnvironment,
} from "./selfDevelopmentAdoption.js";
import { LOCAL_GIT_MIRRORS_ENV } from "../server/services/localGitMirrors.js";

let root: string;
let checkout: string;

const git = (directory: string, ...args: string[]): string =>
  execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim();

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-adoption-"));
  checkout = path.join(root, "checkout");
  fs.mkdirSync(checkout);
  git(checkout, "init", "--initial-branch=main");
  git(checkout, "config", "user.email", "dev@vibestudio.test");
  git(checkout, "config", "user.name", "Dev");
  git(checkout, "remote", "add", "origin", "git@github.com:panticonic/vibestudio.git");
  fs.writeFileSync(path.join(checkout, ".gitignore"), "dist/\n");
  fs.writeFileSync(path.join(checkout, "committed.txt"), "committed\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-m", "first");
  // Everything below is the state a developer actually has on disk.
  fs.writeFileSync(path.join(checkout, "committed.txt"), "edited in the worktree\n");
  fs.writeFileSync(path.join(checkout, "untracked.txt"), "never committed\n");
  fs.mkdirSync(path.join(checkout, "dist"));
  fs.writeFileSync(path.join(checkout, "dist", "build.js"), "artifact\n");
  fs.mkdirSync(path.join(checkout, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(checkout, "node_modules", "left-pad", "index.js"), "dependency\n");
  fs.writeFileSync(path.join(checkout, ".git", "info", "exclude"), "private-notes.md\n");
  fs.writeFileSync(path.join(checkout, "private-notes.md"), "mine\n");
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("canonical upstream", () => {
  it("reads an SSH origin as its credential-free HTTPS identity", () => {
    expect(canonicalUpstreamUrl(checkout)).toBe("https://github.com/panticonic/vibestudio.git");
  });
});

describe("local mirror", () => {
  it("mirrors the working tree as exactly one commit", () => {
    const mirror = buildLocalGitMirror({
      checkout,
      url: "https://github.com/panticonic/vibestudio.git",
      target: path.join(root, "mirror.git"),
    });
    expect(git(mirror.checkout, "rev-list", "--count", "main")).toBe("1");
    expect(git(mirror.checkout, "symbolic-ref", "HEAD")).toBe("refs/heads/main");

    const files = git(mirror.checkout, "ls-tree", "-r", "--name-only", "main").split("\n");
    // The uncommitted edit is the point: self-development builds the tree the
    // developer has, not the one they last pushed.
    expect(git(mirror.checkout, "show", "main:committed.txt")).toBe("edited in the worktree");
    expect(files).toContain("untracked.txt");
    // Ignored artifacts, dependencies, and the developer's private excludes
    // are not source and never reach the adopted repository.
    expect(files).not.toContain("dist/build.js");
    expect(files.some((file) => file.startsWith("node_modules/"))).toBe(false);
    expect(files).not.toContain("private-notes.md");
  });

  it("leaves the developer's own repository untouched", () => {
    const before = git(checkout, "rev-parse", "HEAD");
    const status = git(checkout, "status", "--porcelain");
    buildLocalGitMirror({
      checkout,
      url: "https://github.com/panticonic/vibestudio.git",
      target: path.join(root, "second-mirror.git"),
    });
    expect(git(checkout, "rev-parse", "HEAD")).toBe(before);
    expect(git(checkout, "status", "--porcelain")).toBe(status);
    expect(git(checkout, "branch", "--list")).toBe("* main");
  });

  it("declares nothing when there is nothing to serve", () => {
    expect(selfDevelopmentMirrorEnvironment([])).toEqual({});
    expect(
      JSON.parse(
        selfDevelopmentMirrorEnvironment([{ url: "https://example.test/a.git", checkout }])[
          LOCAL_GIT_MIRRORS_ENV
        ]!
      )
    ).toEqual([{ url: "https://example.test/a.git", checkout }]);
  });
});
