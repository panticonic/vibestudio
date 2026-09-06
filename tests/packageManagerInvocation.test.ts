import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPnpmInvocation, execPnpmSync } from "../scripts/cli/lib/package-manager.mjs";

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

it("executes the package manager through the portable launcher and propagates failure", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pnpm execution "));
  try {
    const entry = path.join(root, "pnpm.cjs");
    writeFileSync(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
    vi.stubEnv("npm_execpath", entry);
    expect(
      JSON.parse(execPnpmSync(["literal & value", "%PATH%"], { encoding: "utf8" }) as string)
    ).toEqual(["literal & value", "%PATH%"]);
    writeFileSync(entry, "process.stderr.write('failed install');process.exit(7)");
    expect(() => execPnpmSync([], { encoding: "utf8" })).toThrow(/pnpm failed \(7\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "win32").each(["", "node_modules/.bin"])(
  "launches a Windows pnpm.cmd shim at %s without npm_execpath",
  (layout) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pnpm command shim "));
    try {
      const entry = path.join(root, "entry.cjs");
      writeFileSync(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
      const bin = path.join(root, layout);
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        path.join(bin, "pnpm.cmd"),
        `@echo off\r\n"${process.execPath}" "${entry}" %*\r\n`
      );
      vi.stubEnv("npm_execpath", "");
      vi.stubEnv("PATH", bin + path.delimiter + process.env["PATH"]);
      const args = ["--filter", "space & ampersand", "%PATH%", 'a"quote', "trailing\\"];
      expect(JSON.parse(execPnpmSync(args, { encoding: "utf8" }) as string)).toEqual(args);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);
