import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { checkpointWorkspaceSource } from "../workspaceTemplateCheckpoint.js";

function git(directory: string, args: string[]): string {
  return execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const temporaryRoots = new Set<string>();

afterEach(() => {
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
  temporaryRoots.clear();
});

function repository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-template-checkpoint-"));
  temporaryRoots.add(root);
  git(root, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(root, "tracked.txt"), "committed\n");
  git(root, ["add", "tracked.txt"]);
  git(root, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "initial",
  ]);
  return root;
}

describe("development template checkpoint", () => {
  it("captures a detached linked worktree through native Git without mutating its checkout", async () => {
    const original = repository();
    const checkout = `${original}-linked`;
    const target = `${original}-checkpoint`;
    temporaryRoots.add(checkout);
    temporaryRoots.add(target);
    git(original, ["worktree", "add", "--detach", checkout, "HEAD"]);
    expect(fs.statSync(path.join(checkout, ".git")).isFile()).toBe(true);
    fs.writeFileSync(path.join(checkout, " leading space.txt"), "visible edit\n");
    const result = await checkpointWorkspaceSource({ checkout, target });
    expect(result.changedPaths).toEqual([" leading space.txt"]);
    expect(fs.statSync(path.join(target, ".git")).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(target, " leading space.txt"), "utf8")).toBe("visible edit\n");
    expect(git(checkout, ["rev-parse", "HEAD"])).toBe(git(original, ["rev-parse", "HEAD"]));
  });
  it("seals a clean checkout independently of later source edits", async () => {
    const checkout = repository();
    const target = `${checkout}-checkpoint`;
    temporaryRoots.add(target);
    const result = await checkpointWorkspaceSource({
      checkout,
      target,
    });

    expect(result).toEqual({
      checkout: target,
      sourceCheckout: checkout,
      changedPaths: [],
    });
    fs.writeFileSync(path.join(checkout, "tracked.txt"), "later edit\n");
    expect(fs.readFileSync(path.join(target, "tracked.txt"), "utf8")).toBe("committed\n");
  });

  it("commits visible tracked and untracked edits only in the instance-owned clone", async () => {
    const checkout = repository();
    const sourceHead = git(checkout, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(checkout, "tracked.txt"), "edited\n");
    fs.writeFileSync(path.join(checkout, "new.txt"), "new\n");
    fs.writeFileSync(path.join(checkout, "ignored.txt"), "ignored\n");
    fs.writeFileSync(path.join(checkout, ".gitignore"), "ignored.txt\n");
    const target = path.join(path.dirname(checkout), `${path.basename(checkout)}-checkpoint`);
    temporaryRoots.add(target);

    const result = await checkpointWorkspaceSource({
      checkout,
      target,
    });

    expect(result.changedPaths).toEqual([".gitignore", "new.txt", "tracked.txt"]);
    expect(fs.readFileSync(path.join(target, "tracked.txt"), "utf8")).toBe("edited\n");
    expect(fs.readFileSync(path.join(target, "new.txt"), "utf8")).toBe("new\n");
    expect(fs.existsSync(path.join(target, "ignored.txt"))).toBe(false);
    expect(git(target, ["rev-parse", "HEAD"])).not.toBe(sourceHead);
    expect(git(checkout, ["rev-parse", "HEAD"])).toBe(sourceHead);
    expect(git(checkout, ["status", "--porcelain"]).split("\n").filter(Boolean)).toHaveLength(3);
  });

  it("never promotes unignored dependency artifacts into template source", async () => {
    const checkout = repository();
    fs.mkdirSync(path.join(checkout, "node_modules", ".vite"), { recursive: true });
    fs.writeFileSync(path.join(checkout, "node_modules", ".vite", "results.json"), "{}\n");
    fs.writeFileSync(path.join(checkout, "source.ts"), "export const ready = true;\n");
    const target = path.join(path.dirname(checkout), `${path.basename(checkout)}-checkpoint`);
    temporaryRoots.add(target);

    const result = await checkpointWorkspaceSource({
      checkout,
      target,
    });

    expect(result.changedPaths).toEqual(["source.ts"]);
    expect(fs.readFileSync(path.join(target, "source.ts"), "utf8")).toContain("ready");
    expect(fs.existsSync(path.join(target, "node_modules"))).toBe(false);
  });
});
