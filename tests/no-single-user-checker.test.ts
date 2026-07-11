import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { collectFindings, scanRepository } from "../scripts/check-no-single-user.mjs";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function ruleIds(text: string, relFile = "src/example.ts"): string[] {
  return collectFindings({ text, relFile }).map((finding: { rule: string }) => finding.rule);
}

describe("multi-user cutover regression rules", () => {
  it("rejects every retired pairing and desktop-server surface", () => {
    expect(ruleIds("auth.createPairingInvite();")).toContain("generic-device-invite");
    expect(ruleIds("exchangePairingCode(code);")).toContain("generic-device-invite");
    expect(ruleIds('run("vibestudio remote invite");')).toContain("generic-device-invite");
    expect(ruleIds('fetch("/_r/s/auth/issue-device");')).toContain("human-admin-bootstrap");
    expect(
      ruleIds("const store = credential.hubCredential;", "src/cli/credentialStore.ts")
    ).toContain("nested-hub-credential");
    expect(ruleIds("new LocalServerManager();")).toContain("workspace-local-server-manager");
    expect(ruleIds("push.sendToUsers(userIds, payload);")).toContain("user-wide-push-fanout");
    expect(ruleIds('process.env.VIBESTUDIO_FORCE_WORKSPACE_SERVER = "1";')).toContain(
      "forced-workspace-process-role"
    );
    expect(ruleIds("const ready = { adminToken: token };", "src/main/startup.ts")).toContain(
      "ready-file-credential-secret"
    );
    expect(ruleIds("const ready = { pairingCode: code };", "src/cli/start.ts")).toContain(
      "ready-file-credential-secret"
    );
    expect(ruleIds("const credential = { hubUrl: url };", "src/cli/credentialStore.ts")).toContain(
      "nested-hub-credential"
    );
    expect(
      ruleIds("vibestudio remote deploy user@host --workspace default", "docs/deploy.md")
    ).toContain("deploy-time-workspace-selection");
  });

  it("accepts the canonical split user and device invite commands", () => {
    expect(ruleIds('run("vibestudio remote invite-user");')).not.toContain("generic-device-invite");
    expect(ruleIds("hubControl.pairDevice();")).not.toContain("generic-device-invite");
  });

  it("scans userland source and current documentation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "no-single-user-check-"));
    temporaryRoots.push(root);
    fs.mkdirSync(path.join(root, "workspace", "skills", "example"), { recursive: true });
    fs.mkdirSync(path.join(root, "skills", "agent"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "workspace", "skills", "example", "SKILL.md"),
      "Run `vibestudio remote invite`.",
      "utf8"
    );
    fs.writeFileSync(
      path.join(root, "skills", "agent", "RECIPES.md"),
      "Run `vibestudio remote invite`.",
      "utf8"
    );
    fs.writeFileSync(path.join(root, "README.md"), "No legacy here.\n", "utf8");

    expect(scanRepository(root)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "workspace/skills/example/SKILL.md",
          rule: "generic-device-invite",
        }),
        expect.objectContaining({
          file: "skills/agent/RECIPES.md",
          rule: "generic-device-invite",
        }),
      ])
    );
  });
});
