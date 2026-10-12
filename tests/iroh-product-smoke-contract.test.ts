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
    expect(desktop).toContain("waitForSystemNewPanel");
    expect(desktop).toContain("createAndWaitForNewPanel");
    expect(desktop).toContain("with Iroh pairing deep link");
  });

  it("prepares the source host and exact workspace release before the desktop acceptance budget", () => {
    const desktop = source("scripts/desktop-pairing-smoke.mjs");
    const templatesIndex = desktop.indexOf("await resolveDevelopmentTemplates({");
    const sourceBuildIndex = desktop.indexOf('"--source-server-prereqs"');
    const releaseStartIndex = desktop.indexOf("workspacePreparation = prepareWorkspaceRelease({");
    const releaseJoinIndex = desktop.indexOf("await workspacePreparation.completed;");
    const deadlineIndex = desktop.indexOf("deadlineMs = Date.now() + options.timeoutMs;");
    const acceptanceTimerIndex = desktop.indexOf("testDeadline = setTimeout(");
    expect(templatesIndex).toBeGreaterThan(0);
    expect(sourceBuildIndex).toBeGreaterThan(templatesIndex);
    expect(releaseStartIndex).toBeGreaterThan(sourceBuildIndex);
    expect(releaseJoinIndex).toBeGreaterThan(releaseStartIndex);
    expect(deadlineIndex).toBeGreaterThan(releaseJoinIndex);
    expect(acceptanceTimerIndex).toBeGreaterThan(deadlineIndex);
    expect(desktop).toContain("env: serverEnv");
    expect(desktop).toContain("serverEnv.VIBESTUDIO_HOST_ARTIFACT_ROOT = sourceGeneration;");
    expect(desktop).toContain("VIBESTUDIO_WORKSPACE_RELEASE_ROOT");
    expect(desktop).toContain('from "./lib/development-template-set.mjs"');
    expect(desktop).toContain(
      "Object.assign(serverEnv, developmentTemplateSetEnv(developmentTemplates));"
    );
    expect(desktop).toContain("processLifetime.requestStop();");
    expect(desktop).toContain("requestWorkspacePreparationStop();");
    expect(desktop).toContain("ownerSignal.aborted && isCancellationOnly(original)");
  });

  it("drives native Android approvals, panels, app relaunch, and server recovery over Iroh", () => {
    const mobile = source("scripts/cli/mobile-smoke.mjs");
    for (const marker of [
      "embedded-host-target-approval-required",
      "workspace-panel-materialized",
      "workspace-panel-webview-loaded",
      "workspace-panel-ready",
      "New panel in System",
      "workspace-recovery-complete",
      "server-restart",
    ]) {
      expect(mobile).toContain(marker);
    }
    expect(mobile).toContain("endpoint=${parsedLink.endpointId}");
    expect(mobile).toContain("ensureAndroidAvd");
    expect(mobile).toContain("never fall back to an AVD");
    expect(mobile).toContain("embedded-pairing-failed");
    expect(mobile).toContain("approval-action-accept-install-review");
    expect(mobile).toContain("launch-gate-accept");
    expect(mobile).toContain("embedded-host-target-approval-submitted");
    expect(source("apps/mobile/index.js")).toContain("embedded-host-target-approval-resolved");
    expect(mobile).toContain('readXmlAttribute(node, "enabled") === "false"');
    expect(mobile).toContain("managedConnectionDeadlineMs");
    expect(mobile).toContain("managedPanelDeadlineMs");
    expect(mobile).toContain("must not recreate the still-live WebView");
    expect(source("apps/mobile/index.js")).toContain("embedded-pairing-failed");

    const installIndex = mobile.indexOf("await runMobileInstall(options, lifetime)");
    const templatesIndex = mobile.indexOf("await resolveDevelopmentTemplates({");
    const sourceBuildIndex = mobile.indexOf('"--source-server-prereqs"');
    const workspaceReleaseIndex = mobile.indexOf(
      "workspacePreparation = prepareWorkspaceRelease({"
    );
    const workspaceReleaseJoinIndex = mobile.indexOf("await workspacePreparation.completed;");
    const serverBudgetIndex = mobile.indexOf(
      "const serverReadyDeadlineMs = Date.now() + options.timeoutMs"
    );
    expect(installIndex).toBeGreaterThan(0);
    expect(templatesIndex).toBeGreaterThan(installIndex);
    expect(sourceBuildIndex).toBeGreaterThan(templatesIndex);
    expect(workspaceReleaseIndex).toBeGreaterThan(sourceBuildIndex);
    expect(workspaceReleaseJoinIndex).toBeGreaterThan(workspaceReleaseIndex);
    expect(serverBudgetIndex).toBeGreaterThan(workspaceReleaseJoinIndex);
    expect(mobile).not.toContain("Math.max(1_000, deadlineMs - Date.now())");
    expect(mobile).toContain(
      "const child = spawnManaged(lifetime.acquire, command, args, options);"
    );
    expect(mobile).toContain("await runOwnedCommand(lifetime, process.execPath, args");
    expect(mobile).toContain("releaseHostBuildGeneration(hostGenerationRoot)");
  });
});
