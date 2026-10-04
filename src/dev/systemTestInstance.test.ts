import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  publishDevInstanceReady,
  registerDevInstance,
  unregisterDevInstance,
} from "./instanceRegistry.js";
import {
  ensureSystemTestInstance,
  isLocalSystemTestHelpCommand,
  managedMarkerPath,
  parseSystemTestLauncherArgs,
  stopManagedSystemTestInstance,
  systemTestInstanceEnvironment,
} from "./systemTestInstance.js";
import { DEFAULT_IROH_RELAYS } from "../server/irohRelayConfig.js";

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
      persistent: false,
      selfDevelopment: false,
      command: ["doctor", "--json"],
    });
    expect(
      parseSystemTestLauncherArgs(["--workspace", "personal", "run", "browser-import"])
    ).toEqual({
      instanceId: "system-test",
      explicitInstance: false,
      persistent: false,
      selfDevelopment: false,
      workspace: "personal",
      command: ["run", "browser-import"],
    });
    expect(parseSystemTestLauncherArgs(["--workspace=system", "list"]).workspace).toBe("system");
    expect(() => parseSystemTestLauncherArgs(["--workspace", "project", "list"])).toThrow(
      /personal or system/
    );
    expect(() =>
      parseSystemTestLauncherArgs(["--workspace", "personal", "--workspace", "system", "list"])
    ).toThrow(/only be specified once/);
    expect(
      parseSystemTestLauncherArgs(["--instance", "self-development", "--persistent", "doctor"])
    ).toEqual({
      instanceId: "self-development",
      explicitInstance: true,
      persistent: true,
      selfDevelopment: false,
      command: ["doctor"],
    });
    expect(parseSystemTestLauncherArgs(["list"])).toEqual({
      instanceId: "system-test",
      explicitInstance: false,
      persistent: false,
      selfDevelopment: false,
      command: ["list"],
    });
    // The adoption flag is the launcher's, never the test command's.
    expect(parseSystemTestLauncherArgs(["--self-development", "run", "x"])).toEqual({
      instanceId: "system-test",
      explicitInstance: false,
      persistent: false,
      selfDevelopment: true,
      command: ["run", "x"],
    });
    expect(() =>
      parseSystemTestLauncherArgs(["--instance", "a", "--instance=b", "doctor"])
    ).toThrow(/only be specified once/u);
  });

  it("recognizes launcher and subcommand help as side-effect-free", () => {
    expect(isLocalSystemTestHelpCommand(["--help"])).toBe(true);
    expect(isLocalSystemTestHelpCommand(["-h"])).toBe(true);
    expect(isLocalSystemTestHelpCommand(["run", "--help"])).toBe(true);
    expect(isLocalSystemTestHelpCommand(["list", "--help"])).toBe(true);
    expect(isLocalSystemTestHelpCommand(["run", "--", "--help"])).toBe(false);
    expect(isLocalSystemTestHelpCommand([])).toBe(false);
  });

  it("owns the public Phase-0 Iroh relay topology instead of inheriting overrides", () => {
    expect(
      systemTestInstanceEnvironment({ VIBESTUDIO_IROH_RELAYS: "https://stale.invalid/" })
    ).toEqual({
      VIBESTUDIO_IROH_RELAYS: DEFAULT_IROH_RELAYS.join(","),
      VIBESTUDIO_SYSTEM_TEST_INSTANCE: "1",
    });
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
    const marker = managedMarkerPath(instance);
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(
      marker,
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
    const marker = managedMarkerPath(instance);
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(
      marker,
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

  it("keeps managed stop owned beyond the former deadline until its actual supervisor exits", async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
      process.on('SIGTERM', () => process.send('stopping'));
      process.on('message', () => process.exit(0));
      process.send('ready');
      setInterval(() => {}, 1000);
    `,
      ],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] }
    );
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const ready = new Promise<void>((resolve) => child.once("message", () => resolve()));
    const root = fs.mkdtempSync(path.join(tempDir, "slow-managed-"));
    const instance = registerDevInstance({
      id: "slow-managed",
      root,
      repoRoot,
      supervisorPid: child.pid!,
      kind: "server",
      lifecycle: "ephemeral",
      startedAt: Date.now(),
    });
    const marker = managedMarkerPath(instance);
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(
      marker,
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
    let stopping: Promise<boolean> | undefined;
    try {
      await ready;
      const entered = new Promise<void>((resolve) => child.once("message", () => resolve()));
      vi.useFakeTimers();
      let settled = false;
      stopping = stopManagedSystemTestInstance(repoRoot, instance.id).then((value) => {
        settled = true;
        return value;
      });
      await entered;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe(false);
      expect(fs.existsSync(marker)).toBe(true);
      child.send("release");
      await closed;
      await vi.advanceTimersByTimeAsync(100);
      await expect(stopping).resolves.toBe(true);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      child.kill("SIGKILL");
      await closed;
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(100);
      await Promise.allSettled([stopping]);
      vi.useRealTimers();
      unregisterDevInstance(repoRoot, instance.id);
    }
  });

  it("refuses replacement generation cleanup while the original managed supervisor is retiring", async () => {
    const root = fs.mkdtempSync(path.join(tempDir, "changing-managed-"));
    const instance = registerDevInstance({
      id: "changing-managed",
      root,
      repoRoot,
      supervisorPid: process.pid,
      kind: "server",
      lifecycle: "ephemeral",
      startedAt: Date.now(),
    });
    const marker = managedMarkerPath(instance);
    const markerValue = (generationId: string) => ({
      schemaVersion: 1,
      instanceId: instance.id,
      generationId,
      repoDigest: createHash("sha256").update(fs.realpathSync(repoRoot)).digest("hex").slice(0, 16),
    });
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, JSON.stringify(markerValue(instance.generationId)));
    let replacement = "";
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid !== process.pid) throw new Error("Unexpected supervisor target");
      if (signal === "SIGTERM") {
        unregisterDevInstance(repoRoot, instance.id);
        replacement = registerDevInstance({
          id: instance.id,
          root,
          repoRoot,
          supervisorPid: process.pid,
          kind: "server",
          lifecycle: "ephemeral",
          startedAt: Date.now(),
        }).generationId;
        fs.writeFileSync(marker, JSON.stringify(markerValue(replacement)));
      }
      return true;
    });
    try {
      await expect(stopManagedSystemTestInstance(repoRoot, instance.id)).rejects.toMatchObject({
        code: "EOWNERSHIP",
      });
      expect(JSON.parse(fs.readFileSync(marker, "utf8")).generationId).toBe(replacement);
      expect(fs.existsSync(root)).toBe(true);
    } finally {
      kill.mockRestore();
      unregisterDevInstance(repoRoot, instance.id);
    }
  });
});
