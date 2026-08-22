import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { exactUserlandRoot } from "./exactUserlandRoot";

const REQUIRED_SKILLS = [
  "skills/remote-access/SKILL.md",
  "apps/mobile/SKILL.md",
  "apps/shell/SKILL.md",
  "extensions/mobile-debug/SKILL.md",
  "extensions/react-native/SKILL.md",
  "extensions/git-bridge/SKILL.md",
] as const;

const NON_SOURCE_DIRECTORIES = new Set(["node_modules", "dist", "coverage", ".vite"]);

function read(file: string): string {
  const root = file.startsWith("apps/mobile/") ? process.cwd() : exactUserlandRoot;
  return fs.readFileSync(path.join(root, file), "utf8");
}

function readHost(file: string): string {
  return fs.readFileSync(path.join(process.cwd(), file), "utf8");
}

function readBase(file: string): string {
  return fs.readFileSync(path.join(exactUserlandRoot, file), "utf8");
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
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.["smoke:full"]).toBe("node scripts/full-system-smoke.mjs");
    expect(fs.existsSync(path.join(process.cwd(), "scripts/full-system-smoke.mjs"))).toBe(true);
  });

  it("ships repo-local skills for touched app and extension units", () => {
    for (const file of REQUIRED_SKILLS) {
      expect(fs.existsSync(path.join(exactUserlandRoot, file)), file).toBe(true);
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
    for (const file of skillFiles(exactUserlandRoot)) {
      const text = fs.readFileSync(file, "utf8");
      for (const term of forbidden) {
        if (text.includes(term)) misses.push(`${path.relative(exactUserlandRoot, file)}: ${term}`);
      }
    }
    expect(misses).toEqual([]);
  });

  it("keeps every active remote-server guide on the local-or-SSH deployment lifecycle", () => {
    const hostGuides = [
      "README.md",
      "docs/cli.md",
      "docs/webrtc-deployment.md",
      "docs/remote-ux-overhaul-plan.md",
    ];
    const baseGuides = ["skills/remote-access/SKILL.md", "skills/onboarding/REMOTE_SERVER.md"];

    for (const file of hostGuides) {
      expect(readHost(file), file).toContain("remote deploy local");
      expect(readHost(file), file).toContain("remote deploy pairing");
    }
    for (const file of baseGuides) {
      expect(readBase(file), file).toContain("remote deploy local");
      expect(readBase(file), file).toContain("remote deploy pairing");
    }
    expect(readHost("docs/remote-ux-overhaul-plan.md")).toContain("<user@host|local>");
    expect(readHost("README.md").match(/vibestudio remote deploy local/g)?.length).toBeGreaterThan(
      1
    );
  });

  it("documents renewable root ownership and the real desktop/mobile device paths", () => {
    const renewableHostGuides = [
      "README.md",
      "STATE_DIRECTORY.md",
      "docs/cli.md",
      "docs/webrtc-deployment.md",
      "docs/webrtc-local-e2e.md",
      "docs/multi-user-wp0-user-identity-spec.md",
      "docs/multi-user-wp1-hub-control-plane.md",
    ];
    for (const file of renewableHostGuides) {
      expect(readHost(file), file).toMatch(/renew|replace/i);
    }
    for (const file of ["skills/remote-access/SKILL.md", "skills/onboarding/REMOTE_SERVER.md"]) {
      expect(readBase(file), file).toMatch(/renew|replace/i);
    }

    const help = readBase("about/help/index.tsx");
    expect(help).toContain("Paired devices → Connect a device");
    expect(help).toContain("Settings → Devices → Connect another device");
    expect(readHost("apps/mobile/README.md")).toContain(
      "Settings** → **Devices** → **Connect another device"
    );
    expect(readBase("apps/mobile/README.md")).toContain(
      "Settings** → **Devices** → **Connect another"
    );
    expect(readBase("apps/mobile/SKILL.md")).toContain("hubControl.pairDevice");
    expect(readBase("apps/shell/SKILL.md")).toMatch(
      /never tell the\s+user to pair again merely to switch workspaces/
    );
    expect(readBase("skills/onboarding/REMOTE_SERVER.md")).toContain(
      "Selecting another remote workspace reuses this identity without pairing again."
    );
  });

  it("rejects the stale setup and child-pairing claims from active documentation", () => {
    const activeHostDocs = [
      "README.md",
      "STATE_DIRECTORY.md",
      "docs/cli.md",
      "docs/webrtc-deployment.md",
      "docs/webrtc-local-e2e.md",
      "docs/remote-ux-overhaul-plan.md",
    ];
    const activeBaseDocs = [
      "skills/remote-access/SKILL.md",
      "skills/onboarding/REMOTE_SERVER.md",
      "apps/mobile/SKILL.md",
      "apps/shell/SKILL.md",
    ];
    const stale = [
      "Deploy or manage a remote server over SSH/systemd",
      "Deploy itself does not consume or print an invite",
      "rotates the identity and therefore requires devices to re-pair",
      "pairing-activations.json",
      "**Pair another device**",
      "**Hidden** — local",
    ];
    const misses: string[] = [];
    for (const file of activeHostDocs) {
      const text = readHost(file);
      for (const phrase of stale) if (text.includes(phrase)) misses.push(`${file}: ${phrase}`);
    }
    for (const file of activeBaseDocs) {
      const text = readBase(file);
      for (const phrase of stale) if (text.includes(phrase)) misses.push(`${file}: ${phrase}`);
    }
    expect(misses).toEqual([]);
  });
});
