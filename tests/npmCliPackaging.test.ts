import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { assertPassthroughScriptsStaged } from "../scripts/build-npm-packages.mjs";

describe("npm CLI packaging", () => {
  it("stages the passthrough script tree into both published packages", () => {
    const buildScript = fs.readFileSync(path.resolve("scripts/build-npm-packages.mjs"), "utf8");
    const copies = buildScript.match(
      /copyTree\(path\.join\(repoRoot, "scripts\/cli"\), path\.join\(root, "scripts\/cli"\), defaultSkip\)/g
    );
    expect(copies).toHaveLength(2);
    expect(fs.existsSync(path.resolve("scripts/cli/remote-serve.mjs"))).toBe(true);
    expect(fs.existsSync(path.resolve("scripts/cli/lib/server-entry.mjs"))).toBe(true);
  });

  it("fails staging when a packaged passthrough dependency is absent", () => {
    const root = mkdtempSync(path.join(tmpdir(), "vibestudio-package-guard-"));
    for (const relative of [
      "scripts/cli/remote-serve.mjs",
      "scripts/cli/remote-doctor.mjs",
      "scripts/cli/lib/server-entry.mjs",
      "scripts/cli/lib/pair-server.mjs",
    ]) {
      const target = path.join(root, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, "");
    }
    expect(() => assertPassthroughScriptsStaged(root)).not.toThrow();
    fs.rmSync(path.join(root, "scripts/cli/lib/pair-server.mjs"));
    expect(() => assertPassthroughScriptsStaged(root)).toThrow(/pair-server\.mjs/);
  });
});
