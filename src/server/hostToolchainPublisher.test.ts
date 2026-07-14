import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { HostToolchainPublisher } from "./hostToolchainPublisher.js";
import { parseSha256 } from "@vibestudio/shared/execution/identity";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("HostToolchainPublisher", () => {
  it.runIf(process.platform !== "win32")(
    "publishes an immutable launcher that works with an empty ambient PATH",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "vs-toolchain-"));
      roots.push(root);
      const cli = path.join(root, "client.mjs");
      fs.writeFileSync(cli, 'console.log(`owned:${process.argv.slice(2).join(":")}`);');
      const pnpmRoot = path.join(root, "pnpm-package");
      fs.mkdirSync(path.join(pnpmRoot, "bin"), { recursive: true });
      fs.writeFileSync(
        path.join(pnpmRoot, "bin", "pnpm.cjs"),
        'console.log(`pnpm:${process.argv.slice(2).join(":")}`);'
      );
      const pluginRoot = path.join(root, "plugin");
      fs.mkdirSync(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
      fs.writeFileSync(
        path.join(pluginRoot, ".claude-plugin", "plugin.json"),
        '{"name":"vibestudio"}'
      );
      const publisher = new HostToolchainPublisher(root);
      const manifest = publisher.publish({
        hostBuildId: parseSha256("1".repeat(64)),
        vibestudioVersion: "1.2.3",
        runtimePath: process.execPath,
        runtimeVersion: process.version,
        cliPath: cli,
        packageManagerRoot: pnpmRoot,
        packageManagerEntry: "bin/pnpm.cjs",
        packageManagerVersion: "10.0.0",
        pluginRoot,
        createdAt: 1,
      });
      const active = publisher.active()!;
      const output = execFileSync(
        path.join(active.dir, "bin", "vibestudio"),
        ["terminal", "list"],
        {
          env: { PATH: "" },
          encoding: "utf8",
        }
      );
      expect(output.trim()).toBe("owned:terminal:list");
      expect(
        execFileSync(path.join(active.dir, "bin", "pnpm"), ["build"], {
          env: { PATH: "" },
          encoding: "utf8",
        }).trim()
      ).toBe("pnpm:build");
      expect(active.manifest).toEqual(manifest);
      expect(
        publisher.extensionEnvironment({ PATH: "/fake" })["PATH"]?.split(path.delimiter)[0]
      ).toBe(path.join(active.dir, "bin"));
    }
  );

  it("fails closed when an active artifact is modified", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vs-toolchain-"));
    roots.push(root);
    const cli = path.join(root, "client.mjs");
    fs.writeFileSync(cli, "export {};");
    const pnpmRoot = path.join(root, "pnpm-package");
    fs.mkdirSync(path.join(pnpmRoot, "bin"), { recursive: true });
    fs.writeFileSync(path.join(pnpmRoot, "bin", "pnpm.cjs"), "export {};");
    const pluginRoot = path.join(root, "plugin");
    fs.mkdirSync(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, ".claude-plugin", "plugin.json"),
      '{"name":"vibestudio"}'
    );
    const publisher = new HostToolchainPublisher(root);
    publisher.publish({
      hostBuildId: parseSha256("2".repeat(64)),
      vibestudioVersion: "1",
      runtimePath: process.execPath,
      runtimeVersion: process.version,
      cliPath: cli,
      packageManagerRoot: pnpmRoot,
      packageManagerEntry: "bin/pnpm.cjs",
      packageManagerVersion: "10.0.0",
      pluginRoot,
    });
    const active = publisher.active()!;
    fs.appendFileSync(path.join(active.dir, "cli", "client.mjs"), "// tamper");
    expect(() => publisher.active()).toThrow("artifact digest mismatch");
  });
});
