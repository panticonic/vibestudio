import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildInfrastructurePackages,
  inspectInfrastructurePackageBuilds,
  writeInfrastructurePackageCache,
} from "../scripts/infrastructure-package-cache.mjs";

const temporaryDirectories: string[] = [];

function write(root: string, relative: string, content: string): void {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-infra-cache-"));
  temporaryDirectories.push(root);
  for (const relative of [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
  ]) {
    write(root, relative, `${relative}\n`);
  }
  write(
    root,
    "packages/base/package.json",
    JSON.stringify({ name: "@vibestudio/base", scripts: { build: "build-base" } })
  );
  write(root, "packages/base/src/index.ts", "export const value = 1;\n");
  write(
    root,
    "packages/bridge/package.json",
    JSON.stringify({
      name: "@vibestudio/bridge",
      dependencies: { "@vibestudio/base": "workspace:*" },
    })
  );
  write(root, "packages/bridge/src/index.ts", "export { value } from '@vibestudio/base';\n");
  write(
    root,
    "packages/consumer/package.json",
    JSON.stringify({
      name: "@vibestudio/consumer",
      scripts: { build: "build-consumer" },
      dependencies: { "@vibestudio/bridge": "workspace:*" },
    })
  );
  write(root, "packages/consumer/src/index.ts", "export { value } from '@vibestudio/bridge';\n");
  write(root, "packages/base/dist/index.js", "export const value = 1;\n");
  write(root, "packages/consumer/dist/index.js", "export { value } from '@vibestudio/bridge';\n");
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("infrastructure package cache", () => {
  it("reuses only exact input and output bytes", () => {
    const cwd = fixture();
    const initial = inspectInfrastructurePackageBuilds({ cwd, toolchainDigest: "toolchain" });
    expect(initial.dirty.map((state) => state.name)).toEqual([
      "@vibestudio/base",
      "@vibestudio/consumer",
    ]);
    writeInfrastructurePackageCache(initial);

    expect(inspectInfrastructurePackageBuilds({ cwd, toolchainDigest: "toolchain" }).dirty).toEqual(
      []
    );

    write(cwd, "packages/base/dist/index.js", "corrupted\n");
    const corruptOutput = inspectInfrastructurePackageBuilds({
      cwd,
      toolchainDigest: "toolchain",
    });
    expect(corruptOutput.dirty.map(({ name, reason }) => [name, reason])).toEqual([
      ["@vibestudio/base", "outputs changed"],
    ]);

    write(cwd, "packages/base/dist/index.js", "export const value = 1;\n");
    write(cwd, "packages/base/src/index.ts", "export const value = 2;\n");
    const changedDependency = inspectInfrastructurePackageBuilds({
      cwd,
      toolchainDigest: "toolchain",
    });
    expect(changedDependency.dirty.map((state) => state.name)).toEqual([
      "@vibestudio/base",
      "@vibestudio/consumer",
    ]);
  });

  it("fails closed for missing outputs and shared build-input changes", () => {
    const cwd = fixture();
    const initial = inspectInfrastructurePackageBuilds({ cwd, toolchainDigest: "toolchain" });
    writeInfrastructurePackageCache(initial);

    expect(
      inspectInfrastructurePackageBuilds({ cwd, toolchainDigest: "new-toolchain" }).dirty.map(
        (state) => state.name
      )
    ).toEqual(["@vibestudio/base", "@vibestudio/consumer"]);

    fs.rmSync(path.join(cwd, "packages/base/dist"), { recursive: true });
    expect(
      inspectInfrastructurePackageBuilds({ cwd, toolchainDigest: "toolchain" }).dirty.map(
        ({ name, reason }) => [name, reason]
      )
    ).toEqual([["@vibestudio/base", "outputs missing"]]);

    write(cwd, "packages/base/dist/index.js", "export const value = 1;\n");
    write(cwd, "pnpm-lock.yaml", "changed lock\n");
    expect(
      inspectInfrastructurePackageBuilds({ cwd, toolchainDigest: "toolchain" }).dirty.map(
        (state) => state.name
      )
    ).toEqual(["@vibestudio/base", "@vibestudio/consumer"]);
  });

  it("keeps source-only dependency bridges in pnpm's scheduling graph", () => {
    const cwd = fixture();
    const initial = inspectInfrastructurePackageBuilds({ cwd, toolchainDigest: "toolchain" });
    writeInfrastructurePackageCache(initial);
    write(cwd, "packages/consumer/dist/index.js", "corrupted\n");
    write(cwd, "packages/consumer/tsconfig.build.tsbuildinfo", "stale\n");

    let args: string[] = [];
    let buildInfoExistedWhenBuildStarted = true;
    buildInfrastructurePackages({
      cwd,
      run: (_command, commandArgs) => {
        args = commandArgs;
        buildInfoExistedWhenBuildStarted = fs.existsSync(
          path.join(cwd, "packages/consumer/tsconfig.build.tsbuildinfo")
        );
        write(
          cwd,
          "packages/consumer/dist/index.js",
          "export { value } from '@vibestudio/bridge';\n"
        );
      },
      log: () => {},
      toolchainDigest: "toolchain",
    });

    expect(args).toContain("@vibestudio/consumer");
    expect(args).toContain("@vibestudio/bridge");
    expect(args).not.toContain("@vibestudio/base");
    expect(buildInfoExistedWhenBuildStarted).toBe(false);
  });
});
