import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  publishDevInstanceReady,
  registerDevInstance,
  unregisterDevInstance,
} from "./instanceRegistry.js";
import {
  ensureSystemTestInstance,
  parseSystemTestLauncherArgs,
  stopManagedSystemTestInstance,
} from "./systemTestInstance.js";

describe("self-provisioning system-test instance", () => {
  let tempDir: string;
  let repoRoot: string;
  let previousXdg: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-system-test-instance-"));
    repoRoot = fs.mkdtempSync(path.join(tempDir, "repo-"));
    previousXdg = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = path.join(tempDir, "profile");
  });

  afterEach(() => {
    if (previousXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = previousXdg;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("extracts one stable instance id without forwarding launcher flags", () => {
    expect(parseSystemTestLauncherArgs(["doctor", "--instance", "incident-a", "--json"])).toEqual({
      instanceId: "incident-a",
      explicitInstance: true,
      command: ["doctor", "--json"],
    });
    expect(parseSystemTestLauncherArgs(["list"])).toEqual({
      instanceId: "system-test",
      explicitInstance: false,
      command: ["list"],
    });
    expect(() =>
      parseSystemTestLauncherArgs(["--instance", "a", "--instance=b", "doctor"])
    ).toThrow(/only be specified once/u);
  });

  it("reuses an explicitly selected ready server without taking ownership", async () => {
    const root = fs.mkdtempSync(path.join(tempDir, "instance-"));
    const instance = registerDevInstance({
      id: "existing",
      root,
      repoRoot,
      supervisorPid: process.pid,
      kind: "server",
      lifecycle: "persistent",
      startedAt: Date.now(),
    });
    publishDevInstanceReady(instance, { status: "paired", workspaceName: "dev" });

    await expect(
      ensureSystemTestInstance(repoRoot, "existing", { explicitInstance: true })
    ).resolves.toMatchObject({
      instance: { id: "existing" },
      ready: { status: "paired", workspaceName: "dev" },
      created: false,
      managed: false,
    });
    await expect(stopManagedSystemTestInstance(repoRoot, "existing")).rejects.toThrow(
      /not created by pnpm system-test/u
    );

    unregisterDevInstance(repoRoot, "existing");
  });

  it("retains managed ownership when reusing an instance after launcher recovery", async () => {
    const root = fs.mkdtempSync(path.join(tempDir, "instance-"));
    const instance = registerDevInstance({
      id: "managed",
      root,
      repoRoot,
      supervisorPid: process.pid,
      kind: "server",
      lifecycle: "ephemeral",
      startedAt: Date.now(),
    });
    publishDevInstanceReady(instance, { status: "paired", workspaceName: "dev" });
    fs.writeFileSync(
      path.join(root, "system-test-managed.json"),
      JSON.stringify({
        schemaVersion: 1,
        instanceId: instance.id,
        generationId: instance.generationId,
        repoDigest: createHash("sha256")
          .update(fs.realpathSync(repoRoot))
          .digest("hex")
          .slice(0, 16),
      })
    );

    await expect(
      ensureSystemTestInstance(repoRoot, "managed", { explicitInstance: true })
    ).resolves.toMatchObject({
      instance: { id: "managed" },
      created: false,
      managed: true,
    });

    unregisterDevInstance(repoRoot, "managed");
  });

  it("does not silently reuse an unmanaged default instance", async () => {
    const root = fs.mkdtempSync(path.join(tempDir, "instance-"));
    const instance = registerDevInstance({
      id: "system-test",
      root,
      repoRoot,
      supervisorPid: process.pid,
      kind: "server",
      lifecycle: "ephemeral",
      startedAt: Date.now(),
    });
    publishDevInstanceReady(instance, { status: "paired", workspaceName: "dev" });

    await expect(ensureSystemTestInstance(repoRoot, "system-test")).rejects.toThrow(
      /owned by another workflow/u
    );

    unregisterDevInstance(repoRoot, "system-test");
  });
});
