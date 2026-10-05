import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compactCompletedSystemTestTrajectories,
  loadSystemTestArtifact,
  saveSystemTestRun,
  systemTestRunDir,
  writeSystemTestArtifact,
  type StoredSystemTestRun,
} from "./systemTestStore.js";

const original = process.env["XDG_CONFIG_HOME"];
const roots: string[] = [];
afterEach(() => {
  if (original === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = original;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "system-test-evidence-"));
  roots.push(root);
  process.env["XDG_CONFIG_HOME"] = root;
  const runId = "run-resource-test";
  const run: StoredSystemTestRun = {
    schemaVersion: 2,
    runId,
    createdAt: Date.now(),
    serverUrl: "http://127.0.0.1:1",
    sessionName: "test",
    ownerId: "owner",
    contextId: "context",
    runnerEntityId: "runner",
    runnerTargetId: "target",
    artifactDir: systemTestRunDir(runId),
    config: { names: ["example"], all: false, concurrency: 1 },
  };
  saveSystemTestRun(run);
  return run;
}

describe("system-test evidence storage", () => {
  it("retains full trajectories losslessly compressed with private permissions", () => {
    const run = fixture();
    const value = { events: ["resource evidence".repeat(1000)] };
    const file = writeSystemTestArtifact(run.runId, "trajectory-example-full", value);
    expect(file.endsWith(".json.gz")).toBe(true);
    expect(loadSystemTestArtifact(run.runId, "trajectory-example-full")).toEqual(value);
    expect(fs.statSync(file).size).toBeLessThan(JSON.stringify(value).length / 10);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("archives legacy evidence only after its run has a terminal summary", async () => {
    const run = fixture();
    const value = { events: ["completed evidence".repeat(1000)] };
    const legacy = path.join(run.artifactDir, "trajectory-example-full.json");
    fs.writeFileSync(legacy, JSON.stringify(value), { mode: 0o600 });
    expect((await compactCompletedSystemTestTrajectories()).files).toBe(0);
    writeSystemTestArtifact(run.runId, "summary", { status: "completed" });
    expect((await compactCompletedSystemTestTrajectories({ dryRun: true })).files).toBe(1);
    expect(fs.existsSync(legacy)).toBe(true);
    const result = await compactCompletedSystemTestTrajectories();
    expect(result.files).toBe(1);
    expect(result.compressedBytes).toBeLessThan(result.originalBytes / 10);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(loadSystemTestArtifact(run.runId, "trajectory-example-full")).toEqual(value);
    expect((await compactCompletedSystemTestTrajectories()).files).toBe(0);
  });

  it("preserves an explicitly chosen export directory", async () => {
    const run = fixture();
    run.artifactDir = path.join(path.dirname(run.artifactDir), "caller-export");
    saveSystemTestRun(run);
    fs.mkdirSync(run.artifactDir);
    fs.writeFileSync(path.join(run.artifactDir, "trajectory-example-full.json"), "{}");
    writeSystemTestArtifact(run.runId, "summary", { status: "completed" });
    expect((await compactCompletedSystemTestTrajectories()).files).toBe(0);
  });
});
