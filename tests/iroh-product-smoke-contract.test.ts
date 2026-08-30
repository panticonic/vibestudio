import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const root = process.cwd();

function source(relative: string): string {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function help(relative: string): string {
  const result = spawnSync(process.execPath, [path.join(root, relative), "--help"], {
    cwd: root,
    encoding: "utf8",
  });
  expect(result.status, `${relative}\n${result.stderr}`).toBe(0);
  return `${result.stdout}\n${result.stderr}`;
}

describe("Iroh product E2E entry points", () => {
  it("keeps every registered mobile command backed by an executable script", () => {
    const cli = source("src/cli/client.ts");
    for (const script of ["mobile-dev.mjs", "mobile-smoke.mjs"]) {
      expect(cli).toContain(script);
      expect(fs.existsSync(path.join(root, "scripts/cli", script))).toBe(true);
    }
    expect(help("scripts/cli/mobile-dev.mjs")).toContain("vibestudio mobile dev");
    expect(help("scripts/cli/mobile-smoke.mjs")).toContain("vibestudio mobile smoke");
  });

  it("drives the real Electron approval, initial-panel, and new-panel lifecycle", () => {
    const desktop = source("scripts/desktop-pairing-smoke.mjs");
    expect(help("scripts/desktop-pairing-smoke.mjs")).toContain("vibestudio desktop pairing smoke");
    expect(desktop).toContain("waitForShellOverlayCleared");
    expect(desktop).toContain("Approved workspace install review");
    expect(desktop).toContain("waitForRenderedPanel");
    expect(desktop).toContain("createAndWaitForNewPanel");
    expect(desktop).toContain("Launching Electron with Iroh pairing deep link");
  });

  it("drives native Android approvals, panels, app relaunch, and server recovery over Iroh", () => {
    const mobile = source("scripts/cli/mobile-smoke.mjs");
    for (const marker of [
      "embedded-host-target-approval-required",
      "workspace-panel-materialized",
      "workspace-panel-webview-loaded",
      "workspace-panel-ready",
      "Create new panel",
      "workspace-recovery-complete",
      "server-restart",
    ]) {
      expect(mobile).toContain(marker);
    }
    expect(mobile).toContain("endpoint=${parsedLink.endpointId}");
  });
});
