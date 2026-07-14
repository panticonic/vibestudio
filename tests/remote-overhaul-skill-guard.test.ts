import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REQUIRED_SKILLS = [
  "workspace/skills/remote-access/SKILL.md",
  "workspace/apps/mobile/SKILL.md",
  "workspace/apps/shell/SKILL.md",
  "workspace/extensions/mobile-debug/SKILL.md",
  "workspace/extensions/react-native/SKILL.md",
  "workspace/extensions/git-bridge/SKILL.md",
] as const;

const NON_SOURCE_DIRECTORIES = new Set([
  ".git",
  ".turbo",
  ".vite",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

function read(file: string): string {
  return fs.readFileSync(path.join(process.cwd(), file), "utf8");
}

function skillFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !NON_SOURCE_DIRECTORIES.has(entry.name)) {
      out.push(...skillFiles(full));
    } else if (entry.name === "SKILL.md") out.push(full);
  }
  return out;
}

describe("remote/mobile overhaul skill coverage", () => {
  it("keeps the full-system smoke command wired", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.["smoke:full"]).toBe("node scripts/full-system-smoke.mjs");
    expect(fs.existsSync(path.join(process.cwd(), "scripts/full-system-smoke.mjs"))).toBe(true);
  });

  it("ships repo-local skills for touched app and extension units", () => {
    for (const file of REQUIRED_SKILLS) {
      expect(fs.existsSync(path.join(process.cwd(), file)), file).toBe(true);
    }
  });

  it("keeps iOS OAuth and native-host scanner wiring in place", () => {
    const mobilePkg = JSON.parse(read("apps/mobile/package.json")) as {
      dependencies?: Record<string, string>;
    };
    expect(mobilePkg.dependencies?.["react-native-vision-camera"]).toBeTruthy();
    expect(read("apps/mobile/index.js")).toContain("useCodeScanner");
    expect(read("apps/mobile/android/app/src/main/AndroidManifest.xml")).toContain(
      "android.permission.CAMERA"
    );
    expect(read("apps/mobile/ios/Vibestudio/VibestudioAuthSession.mm")).toContain(
      "ASWebAuthenticationSession"
    );
    expect(read("apps/mobile/ios/Vibestudio.xcodeproj/project.pbxproj")).toContain(
      "VibestudioAuthSession.mm in Sources"
    );
  });

  it("does not document deleted native mobile surfaces in active skills", () => {
    const forbidden = [
      ["rn", "-", "host", "-", "1"].join(""),
      ["prepare", "App", "Bundle"].join(""),
      ["pair", "Server"].join(""),
      ["select", "Workspace"].join(""),
      ["issue", "Connection", "Grant"].join(""),
      ["get", "Credentials"].join(""),
      ["local", "-", "server", "-", "creds", ".json"].join(""),
      ["webrtc", "-", "remote", ".json"].join(""),
    ];
    const misses: string[] = [];
    for (const file of skillFiles(path.join(process.cwd(), "workspace"))) {
      const text = fs.readFileSync(file, "utf8");
      for (const term of forbidden) {
        if (text.includes(term)) misses.push(`${path.relative(process.cwd(), file)}: ${term}`);
      }
    }
    expect(misses).toEqual([]);
  });
});
