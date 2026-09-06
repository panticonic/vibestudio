import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPnpmInvocation } from "../scripts/cli/lib/package-manager.mjs";

afterEach(() => vi.unstubAllEnvs());

it("runs pnpm's JavaScript entry directly and preserves shell-sensitive arguments", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pnpm entry with spaces "));
  try {
    const entry = path.join(root, "pnpm.cjs");
    writeFileSync(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
    vi.stubEnv("npm_execpath", entry);
    const args = [
      "--filter",
      "@vibestudio/extension-host",
      "space & ampersand",
      "%PATH%",
      'a"quote',
      "trailing\\",
    ];
    const invocation = createPnpmInvocation(args);
    expect(invocation.command).toBe(process.execPath);
    expect(
      JSON.parse(execFileSync(invocation.command, invocation.args, { encoding: "utf8" }))
    ).toEqual(args);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
