import { writePooledArtifact } from "../server/buildV2/buildArtifactPool.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { storageCommands } from "./storageCommands.js";
import {
  getCentralDataPath,
  getProfileDataPath,
  getSharedDerivedDataPath,
} from "@vibestudio/env-paths";
import { createRemoteSmokeServerEnvironment } from "../../scripts/cli/lib/smoke-remote-server.mjs";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statfsSync: vi.fn(actual.statfsSync) };
});

const profileEnvironmentKeys = [
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "VIBESTUDIO_INSTANCE_ROOT",
  "VIBESTUDIO_SHARED_DERIVED_CACHE_DIR",
] as const;
const originalEnvironment = new Map(profileEnvironmentKeys.map((key) => [key, process.env[key]]));
const roots: string[] = [];

afterEach(() => {
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function invocation(flags: Record<string, string | boolean>) {
  return { positionals: [], flags, flagsMulti: () => [] };
}

interface ReportedRoot {
  kind: string;
  name: string;
  leasedEntries: number;
}

/**
 * Populate named shared, instance, or profile storage roots in one disposable account.
 */
function storageFixture(...populate: string[]): { testRoot: string; resolve(at: string): string } {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-storage-cli-"));
  roots.push(testRoot);
  const environment = createRemoteSmokeServerEnvironment(
    process.env,
    path.join(testRoot, "instance"),
    path.join(testRoot, "shared")
  );
  for (const key of profileEnvironmentKeys) process.env[key] = environment[key];
  const resolve = (at: string): string => {
    if (at.startsWith("instance/"))
      return path.join(getCentralDataPath(), at.slice("instance/".length));
    if (at.startsWith("shared/"))
      return path.join(getSharedDerivedDataPath(), at.slice("shared/".length));
    return path.join(getProfileDataPath(), at);
  };
  for (const at of populate) {
    const entry = path.join(resolve(at), "entry");
    fs.mkdirSync(entry, { recursive: true });
    fs.writeFileSync(path.join(entry, "payload"), Buffer.alloc(64 * 1024));
  }
  return { testRoot, resolve };
}

function runCommand(name: string, flags: Record<string, string | boolean>) {
  const command = storageCommands.find((candidate) => candidate.name === name)!;
  return command.run(invocation({ ...flags, json: true }), []);
}

function lastJson(log: ReturnType<typeof vi.spyOn>): { roots: ReportedRoot[] } {
  const calls = log.mock.calls;
  return JSON.parse(String(calls[calls.length - 1]?.[0]));
}

describe("storage commands", () => {
  it("collects pool-only links while keeping live build files and reports a dry run", async () => {
    const { resolve, testRoot } = storageFixture();
    const pool = resolve("shared/build-artifacts");
    const target = path.join(testRoot, "build", "bundle.js");
    await writePooledArtifact(pool, target, Buffer.from("immutable payload"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await runCommand("prune", {})).toBe(0);
    expect(fs.readFileSync(target, "utf8")).toBe("immutable payload");
    fs.rmSync(path.dirname(target), { recursive: true });
    expect(await runCommand("prune", { "dry-run": true })).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).artifactPool).toMatchObject({
      reclaimableFiles: process.platform === "win32" ? 0 : 1,
      removedFiles: 0,
    });
    expect(await runCommand("prune", {})).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).artifactPool.removedFiles).toBe(
      process.platform === "win32" ? 0 : 1
    );
  });

  it("reports and considers only the declared live-safe roots", async () => {
    // This case covers the size ceiling, independently of the machine's free-disk pressure.
    const disk = fs.statfsSync(os.tmpdir());
    vi.spyOn(fs, "statfsSync").mockReturnValue({ ...disk, bavail: 1024 * 1024 * 1024 });
    const { resolve } = storageFixture();
    const external = resolve("shared/external-deps/old");
    fs.mkdirSync(external, { recursive: true });
    fs.writeFileSync(path.join(external, "payload"), Buffer.alloc(64 * 1024));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const prune = storageCommands.find((command) => command.name === "prune")!;

    expect(await prune.run(invocation({ "dry-run": true, "max-gib": "0.25" }), [])).toBe(0);
    expect(fs.existsSync(external)).toBe(true);
    expect(log).toHaveBeenCalled();

    expect(await prune.run(invocation({ "max-gib": "0.25" }), [])).toBe(0);
    // The entry is below the ordinary ceiling, so explicitly testing deletion
    // belongs to the coordinator's targetBytes test rather than changing CLI
    // policy for a fixture.
    expect(fs.existsSync(external)).toBe(true);
  });

  it("never offers an offline-only root to prune", async () => {
    const { resolve } = storageFixture(
      "shared/external-deps",
      "instance/build-cache",
      "shared/npm-cache",
      "shared/npm-registry-downloads",
      "instance/transport-cache",
      "shared/build-artifacts",
      "instance/cas",
      "npm-cache"
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await runCommand("prune", { "max-gib": "0.25" })).toBe(0);

    // Pruning a CAS or an npm cache underneath a live instance corrupts state
    // that is not regenerable from the workspace alone, so the kind filter is
    // the whole safety story for this command.
    const considered = lastJson(log).roots;
    expect(considered.length).toBeGreaterThan(0);
    expect(considered.every((root) => root.kind === "live-safe")).toBe(true);
    expect(considered.map((root) => root.name)).toEqual(
      expect.arrayContaining(["shared external dependencies", "selected instance build cache"])
    );
    for (const offline of [
      "shared/npm-cache",
      "shared/npm-registry-downloads",
      "instance/transport-cache",
      "shared/build-artifacts",
      "instance/cas",
      "npm-cache",
    ]) {
      expect(fs.existsSync(path.join(resolve(offline), "entry"))).toBe(true);
    }
  });

  it("still accounts for offline-only roots in status", async () => {
    storageFixture(
      "shared/external-deps",
      "instance/cas",
      "shared/npm-registry-downloads",
      "instance/transport-cache"
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await runCommand("status", {})).toBe(0);

    const reported = lastJson(log).roots;
    expect(reported.find((root) => root.name === "shared npm registry downloads")).toMatchObject({
      kind: "live-safe",
      leasedEntries: 0,
    });
    const cas = reported.find((root) => root.name === "selected instance CAS");
    expect(cas).toMatchObject({ kind: "offline-only", leasedEntries: 0 });
    for (const name of ["selected instance transport derivatives"]) {
      expect(reported.find((root) => root.name === name)).toMatchObject({
        kind: "offline-only",
        leasedEntries: 0,
      });
    }
    expect(reported.find((root) => root.name === "shared external dependencies")).toMatchObject({
      kind: "live-safe",
    });
  });

  it.each(["0.1", "2048", "not-a-number"])(
    "rejects --max-gib %s as a usage error without touching the cache",
    async (maxGib) => {
      const { resolve } = storageFixture("shared/external-deps");
      vi.spyOn(console, "log").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});

      // A usage error must stay inside the command's own reporting: escaping to
      // the top-level handler would exit 1 with bare text, so a --json caller
      // would parse neither the error nor the exit code.
      expect(await runCommand("prune", { "max-gib": maxGib })).toBe(2);

      expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toEqual({
        error: "--max-gib must be a number from 0.25 to 1024",
        exitCode: 2,
      });
      expect(fs.existsSync(path.join(resolve("shared/external-deps"), "entry"))).toBe(true);
    }
  );

  it("accepts the documented --max-gib bounds", async () => {
    storageFixture("shared/external-deps");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    for (const maxGib of ["0.25", "1024"]) {
      expect(await runCommand("prune", { "max-gib": maxGib, "dry-run": true })).toBe(0);
    }
    expect(log).toHaveBeenCalledTimes(2);
  });
});
