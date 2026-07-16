import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { confineClaudeReadOnly } from "./claudeReadOnlyLaunch.js";

describe("confineClaudeReadOnly", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("mounts the host and context read-only with one explicit writable scratch root", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "claude-readonly-launch-"));
    roots.push(root);
    const profileDir = path.join(root, "launch-1");
    const contextDirectory = path.join(root, "context-1");
    const launch = confineClaudeReadOnly({
      argv: ["claude", "--channels", "server:vibestudio"],
      profileDir,
      contextDirectory,
      platform: "linux",
      pathValue: "/usr/bin",
    });

    expect(launch.command).toBe("/usr/bin/bwrap");
    expect(launch.args).toEqual(
      expect.arrayContaining([
        "--ro-bind",
        "/",
        "/",
        "--ro-bind",
        contextDirectory,
        contextDirectory,
        "--bind",
        profileDir,
        profileDir,
      ])
    );
    expect(launch.args.slice(-3)).toEqual(["claude", "--channels", "server:vibestudio"]);
    expect(launch.scratchDirectory).toBe(path.join(profileDir, "scratch"));
    expect(launch.env).toEqual({
      TMPDIR: "/tmp",
      VIBESTUDIO_LINKED_SCRATCH: path.join(profileDir, "scratch"),
    });
  });

  it("fails closed without the audited OS backend", () => {
    expect(() =>
      confineClaudeReadOnly({
        argv: ["claude"],
        profileDir: "/state/launch-1",
        contextDirectory: "/workspace/context-1",
        platform: "darwin",
      })
    ).toThrow(/no backend is supported/);
    expect(() =>
      confineClaudeReadOnly({
        argv: ["claude"],
        profileDir: "/state/launch-1",
        contextDirectory: "/workspace/context-1",
        platform: "linux",
        pathValue: "",
      })
    ).toThrow(/requires bubblewrap/);
  });

  it.runIf(process.platform === "linux" && existsSync("/usr/bin/bwrap"))(
    "enforces EROFS for native context writes while explicit scratch stays writable",
    () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "claude-readonly-exec-"));
      roots.push(root);
      const profileDir = path.join(root, "profile");
      const contextDirectory = path.join(root, "context");
      mkdirSync(profileDir);
      mkdirSync(contextDirectory);
      const launch = confineClaudeReadOnly({
        argv: ["/bin/sh", "-c", 'touch "$VIBESTUDIO_LINKED_SCRATCH/allowed"; touch ./blocked'],
        profileDir,
        contextDirectory,
      });

      const result = spawnSync(launch.command, launch.args, {
        env: { ...process.env, ...launch.env },
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Read-only file system/);
      expect(existsSync(path.join(launch.scratchDirectory, "allowed"))).toBe(true);
      expect(existsSync(path.join(contextDirectory, "blocked"))).toBe(false);
    }
  );
});
