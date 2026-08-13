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
});
