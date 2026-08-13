import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { storageCommands } from "./storageCommands.js";

const originalXdg = process.env["XDG_CONFIG_HOME"];
const originalInstanceRoot = process.env["VIBESTUDIO_INSTANCE_ROOT"];
const roots: string[] = [];

afterEach(() => {
  if (originalXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = originalXdg;
  if (originalInstanceRoot === undefined) delete process.env["VIBESTUDIO_INSTANCE_ROOT"];
  else process.env["VIBESTUDIO_INSTANCE_ROOT"] = originalInstanceRoot;
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
 * Redirect every storage root into one disposable tree and populate the given
 * profile-relative paths.
 */
function storageFixture(...populate: string[]): { testRoot: string; resolve(at: string): string } {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-storage-cli-"));
  roots.push(testRoot);
  process.env["XDG_CONFIG_HOME"] = path.join(testRoot, "xdg");
  process.env["VIBESTUDIO_INSTANCE_ROOT"] = path.join(testRoot, "instance");
  const resolve = (at: string): string =>
    at.startsWith("instance/")
      ? path.join(testRoot, "instance", at.slice("instance/".length))
      : path.join(testRoot, "xdg", "vibestudio", at);
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
  it("reports and considers only the declared live-safe roots", async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-storage-cli-"));
    roots.push(testRoot);
    process.env["XDG_CONFIG_HOME"] = path.join(testRoot, "xdg");
    process.env["VIBESTUDIO_INSTANCE_ROOT"] = path.join(testRoot, "instance");
    const external = path.join(
      testRoot,
      "xdg",
      "vibestudio",
      "derived-cache",
      "external-deps",
      "old"
    );
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
      "derived-cache/external-deps",
      "instance/build-cache",
      "derived-cache/npm-cache",
      "derived-cache/build-artifacts",
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
      "derived-cache/npm-cache",
      "derived-cache/build-artifacts",
      "instance/cas",
      "npm-cache",
    ]) {
      expect(fs.existsSync(path.join(resolve(offline), "entry"))).toBe(true);
    }
  });

  it("still accounts for offline-only roots in status", async () => {
    storageFixture("derived-cache/external-deps", "instance/cas");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await runCommand("status", {})).toBe(0);

    const reported = lastJson(log).roots;
    const cas = reported.find((root) => root.name === "selected instance CAS");
    expect(cas).toMatchObject({ kind: "offline-only", leasedEntries: 0 });
    expect(reported.find((root) => root.name === "shared external dependencies")).toMatchObject({
      kind: "live-safe",
    });
  });

  it.each(["0.1", "2048", "not-a-number"])(
    "rejects --max-gib %s as a usage error without touching the cache",
    async (maxGib) => {
      const { resolve } = storageFixture("derived-cache/external-deps");
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
      expect(fs.existsSync(path.join(resolve("derived-cache/external-deps"), "entry"))).toBe(true);
    }
  );

  it("accepts the documented --max-gib bounds", async () => {
    storageFixture("derived-cache/external-deps");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    for (const maxGib of ["0.25", "1024"]) {
      expect(await runCommand("prune", { "max-gib": maxGib, "dry-run": true })).toBe(0);
    }
    expect(log).toHaveBeenCalledTimes(2);
  });
});
