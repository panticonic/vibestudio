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
  isLocalSystemTestHelpCommand,
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
    expect(
      parseSystemTestLauncherArgs([
        "--instance",
        "self-development",
        "--bootstrap-workspace",
        "dogfood-system-test",
        "doctor",
      ])
    ).toEqual({
      instanceId: "self-development",
      explicitInstance: true,
      bootstrapWorkspace: "dogfood-system-test",
      command: ["doctor"],
    });
    expect(parseSystemTestLauncherArgs(["list"])).toEqual({
      instanceId: "system-test",
      explicitInstance: false,
      command: ["list"],
    });
    expect(() =>
      parseSystemTestLauncherArgs(["--instance", "a", "--instance=b", "doctor"])
    ).toThrow(/only be specified once/u);
    expect(() =>
      parseSystemTestLauncherArgs([
        "--bootstrap-workspace=a",
        "--bootstrap-workspace",
        "b",
        "doctor",
      ])
    ).toThrow(/only be specified once/u);
  });

  it("recognizes only top-level launcher help as side-effect-free", () => {
    expect(isLocalSystemTestHelpCommand(["--help"])).toBe(true);
    expect(isLocalSystemTestHelpCommand(["-h"])).toBe(true);
    expect(isLocalSystemTestHelpCommand(["run", "--help"])).toBe(false);
    expect(isLocalSystemTestHelpCommand(["list", "--help"])).toBe(false);
    expect(isLocalSystemTestHelpCommand([])).toBe(false);
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

  it("reclaims a dead managed ephemeral generation and its copied workspace", async () => {
    const root = fs.mkdtempSync(path.join(tempDir, "stale-managed-"));
    const instance = registerDevInstance({
      id: "stale-managed",
      root,
      repoRoot,
      supervisorPid: 2_147_483_647,
      kind: "server",
      lifecycle: "ephemeral",
      startedAt: Date.now(),
    });
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
    fs.writeFileSync(path.join(root, "copied-workspace-data"), "owned by stale generation");

    await expect(stopManagedSystemTestInstance(repoRoot, instance.id)).resolves.toBe(true);
    expect(fs.existsSync(root)).toBe(false);
    await expect(stopManagedSystemTestInstance(repoRoot, instance.id)).resolves.toBe(false);
  });

  it("does not reclaim a dead unmanaged generation", async () => {
    const root = fs.mkdtempSync(path.join(tempDir, "stale-unmanaged-"));
    const instance = registerDevInstance({
      id: "stale-unmanaged",
      root,
      repoRoot,
      supervisorPid: 2_147_483_647,
      kind: "server",
      lifecycle: "ephemeral",
      startedAt: Date.now(),
    });

    await expect(stopManagedSystemTestInstance(repoRoot, instance.id)).resolves.toBe(false);
    expect(fs.existsSync(root)).toBe(true);
    unregisterDevInstance(repoRoot, instance.id);
  });
});
