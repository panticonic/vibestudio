import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  persistentInstanceRoot,
  registerDevInstance,
  resolveDevInstance,
  unregisterDevInstance,
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
});

