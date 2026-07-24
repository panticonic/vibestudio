import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDevInstanceReady,
  devInstanceReadyPath,
  persistentInstanceRoot,
  publishDevInstanceReady,
  registerDevInstance,
  removeEphemeralInstanceRoot,
  resolveDevInstance,
  unregisterDevInstance,
  waitForDevInstanceReady,
} from "./instanceRegistry.js";

describe("developer instance registry", () => {
  let tempDir: string;
  let previousXdg: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-instance-registry-"));
    previousXdg = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = path.join(tempDir, "profile");
  });

  afterEach(() => {
    if (previousXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = previousXdg;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolves a live checkout-scoped instance without exposing another checkout", () => {
    const repoRoot = fs.mkdtempSync(path.join(tempDir, "repo-a-"));
    const otherRepo = fs.mkdtempSync(path.join(tempDir, "repo-b-"));
    const root = persistentInstanceRoot(repoRoot, "source");
    registerDevInstance({
      id: "source",
      root,
      repoRoot,
      supervisorPid: process.pid,
      kind: "server",
      lifecycle: "persistent",
      startedAt: 123,
    });

    expect(resolveDevInstance(repoRoot, "source")).toMatchObject({ id: "source", root });
    expect(() => resolveDevInstance(otherRepo, "source")).toThrow(/Unknown Vibestudio instance/u);

    unregisterDevInstance(repoRoot, "source");
    expect(() => resolveDevInstance(repoRoot, "source")).toThrow(/Unknown Vibestudio instance/u);
  });

  it("rejects ids that could escape the registry", () => {
    expect(() => persistentInstanceRoot(tempDir, "../escape")).toThrow(/Invalid instance id/u);
  });
  it("publishes an atomic CLI-ready barrier after instance pairing", async () => {
    const root = fs.mkdtempSync(path.join(tempDir, "instance-"));
    const instance = {
      id: "test",
      root,
      supervisorPid: process.pid,
      generationId: "a".repeat(32),
      startedAt: Date.now(),
    };

    publishDevInstanceReady(instance, { status: "paired", workspaceName: "dev" });
    await expect(waitForDevInstanceReady(instance)).resolves.toMatchObject({
      schemaVersion: 1,
      status: "paired",
      workspaceName: "dev",
    });
    expect(fs.statSync(devInstanceReadyPath(instance)).mode & 0o777).toBe(0o600);

    clearDevInstanceReady(instance);
    expect(fs.existsSync(devInstanceReadyPath(instance))).toBe(false);
  });

  it("ignores a prior supervisor generation until the current one publishes readiness", async () => {
    const root = fs.mkdtempSync(path.join(tempDir, "instance-"));
    const prior = {
      id: "test",
      root,
      supervisorPid: process.pid,
      generationId: "a".repeat(32),
    };
    const current = {
      ...prior,
      generationId: "b".repeat(32),
    };
    publishDevInstanceReady(prior, { status: "paired", workspaceName: "old" });

    const waiting = waitForDevInstanceReady(current);
    await new Promise((resolve) => setTimeout(resolve, 20));
    publishDevInstanceReady(current, { status: "paired", workspaceName: "current" });

    await expect(waiting).resolves.toMatchObject({
      instanceGeneration: current.generationId,
      workspaceName: "current",
    });
  });

  it("retries transient ephemeral-root removal races", () => {
    const rmSync = vi.fn<typeof fs.rmSync>();

    expect(removeEphemeralInstanceRoot("/tmp/exact-instance-root", { rmSync })).toBeNull();
    expect(rmSync).toHaveBeenCalledWith("/tmp/exact-instance-root", {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  });

  it("returns cleanup failures so callers can preserve the diagnostic root", () => {
    const failure = Object.assign(new Error("Directory not empty"), { code: "ENOTEMPTY" });
    const rmSync = vi.fn<typeof fs.rmSync>(() => {
      throw failure;
    });

    expect(removeEphemeralInstanceRoot("/tmp/exact-instance-root", { rmSync })).toBe(failure);
  });
});
