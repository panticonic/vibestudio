import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeMaterializedClaudeLaunch } from "@vibestudio/shared/claudeLaunchProfile";
const owned: string[] = [];
afterEach(() => {
  for (const directory of owned.splice(0)) rmSync(directory, { recursive: true, force: true });
});
describe("linked Claude contained profile retirement", () => {
  it("quarantines and retires only its exact profile, preserving sibling host files", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "claude-retirement-"));
    owned.push(root);
    const profileDir = path.join(root, "profile");
    mkdirSync(profileDir);
    const canary = path.join(root, "host-canary");
    writeFileSync(canary, "private host data");
    writeFileSync(path.join(profileDir, "guest-file"), "discard");
    // A guest link must never turn retirement into authority over the host file.
    symlinkSync(
      root,
      path.join(profileDir, "host-link"),
      process.platform === "win32" ? "junction" : "dir"
    );
    await removeMaterializedClaudeLaunch({ profileDir }, process.cwd());
    expect(existsSync(profileDir)).toBe(false);
    expect(existsSync(path.join(root, ".delete-profile"))).toBe(false);
    expect(readFileSync(canary, "utf8")).toBe("private host data");
    await removeMaterializedClaudeLaunch({ profileDir }, process.cwd());
  });
});
