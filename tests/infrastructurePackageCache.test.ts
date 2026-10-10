import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
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
  it("preserves incremental state on source changes and retires removed compiler outputs", () => {
    const cwd = fixture();
    write(cwd, "packages/base/tsconfig.build.json", JSON.stringify({ compilerOptions: {
      rootDir: "src", outDir: "dist", incremental: true, declaration: true,
    }, include: ["src/**/*.ts"], exclude: ["**/*.test.ts"] }));
    write(cwd, "packages/base/src/retired.ts", "export const retired = 1;");
    write(cwd, "packages/base/dist/retired.js", "old output");
    write(cwd, "packages/base/dist/retired.d.ts", "old declaration");
    write(cwd, "packages/base/tsconfig.build.tsbuildinfo", "owned compiler state");
    writeInfrastructurePackageCache(inspectInfrastructurePackageBuilds({ cwd, toolchainDigest: "toolchain" }));
    write(cwd, "packages/base/src/index.test.ts", "a test-only edit");
    expect(inspectInfrastructurePackageBuilds({ cwd, toolchainDigest: "toolchain" }).dirty).toEqual([]);
    fs.rmSync(path.join(cwd, "packages/base/src/retired.ts"));
    write(cwd, "packages/base/src/index.ts", "export const value = 2;");
    buildInfrastructurePackages({ cwd, toolchainDigest: "toolchain", log: () => {}, run: () => {
      expect(fs.readFileSync(path.join(cwd, "packages/base/tsconfig.build.tsbuildinfo"), "utf8")).toBe("owned compiler state");
      write(cwd, "packages/base/dist/index.js", "new output");
      write(cwd, "packages/base/dist/index.d.ts", "new declaration");
      write(cwd, "packages/consumer/dist/index.js", "new consumer output");
    } });
    expect(fs.existsSync(path.join(cwd, "packages/base/dist/retired.js"))).toBe(false);
    expect(fs.existsSync(path.join(cwd, "packages/base/dist/retired.d.ts"))).toBe(false);
    expect(inspectInfrastructurePackageBuilds({ cwd, toolchainDigest: "toolchain" }).dirty).toEqual([]);
  });

  it("tracks excluded sources when production actually imports them", () => {
    const cwd = fixture();
    write(cwd, "packages/base/tsconfig.build.json", JSON.stringify({ compilerOptions: { rootDir: "src", outDir: "dist" }, include: ["src/**/*.ts"], exclude: ["**/*.test.ts"] }));
    write(cwd, "packages/base/src/index.ts", 'export { value } from "./fixture.test.js";');
    write(cwd, "packages/base/src/fixture.test.ts", "export const value = 1;");
    writeInfrastructurePackageCache(inspectInfrastructurePackageBuilds({ cwd, toolchainDigest: "toolchain" }));
    write(cwd, "packages/base/src/fixture.test.ts", "export const value = 2;");
    expect(inspectInfrastructurePackageBuilds({ cwd, toolchainDigest: "toolchain" }).dirty.map((unit) => unit.name)).toEqual(["@vibestudio/base", "@vibestudio/consumer"]);
  });
  it("serializes independent builders and reuses the preceding exact output", async () => {
    const cwd = fixture();
    const moduleUrl = pathToFileURL(path.resolve("scripts/infrastructure-package-cache.mjs")).href;
    const run = () =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
        import { buildInfrastructurePackages } from ${JSON.stringify(moduleUrl)};
        import * as fs from 'node:fs';
        import * as path from 'node:path';
        const cwd = ${JSON.stringify(cwd)};
        const result = buildInfrastructurePackages({cwd, toolchainDigest:'toolchain', log:()=>{}, run:()=>{
          fs.appendFileSync(path.join(cwd,'executions'), 'build\\n');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200);
          for (const name of ['base','consumer']) {
            const destination=path.join(cwd,'packages',name,'dist');
            fs.mkdirSync(destination,{recursive:true});
            fs.writeFileSync(path.join(destination,'index.js'),'verified output');
          }
        }});
        console.log(JSON.stringify(result));
      `,
          ],
          { stdio: ["ignore", "pipe", "pipe"] }
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr))));
      });
    const results = (await Promise.all([run(), run()])).map((output) => JSON.parse(output));
    expect(results.map((result) => result.built.length).sort()).toEqual([0, 2]);
    expect(fs.readFileSync(path.join(cwd, "executions"), "utf8")).toBe("build\n");
    expect(inspectInfrastructurePackageBuilds({ cwd, toolchainDigest: "toolchain" }).dirty).toEqual(
      []
    );
  });
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

  it("releases build ownership after a failed compiler without publishing a cache receipt", () => {
    const cwd = fixture();
    expect(() =>
      buildInfrastructurePackages({
        cwd,
        toolchainDigest: "toolchain",
        log: () => {},
        run: () => {
          throw new Error("compiler failed");
        },
      })
    ).toThrow("compiler failed");
    expect(
      inspectInfrastructurePackageBuilds({ cwd, toolchainDigest: "toolchain" }).dirty
    ).toHaveLength(2);
    const recovered = buildInfrastructurePackages({
      cwd,
      toolchainDigest: "toolchain",
      log: () => {},
      run: () => {
        for (const name of ["base", "consumer"])
          write(cwd, `packages/${name}/dist/index.js`, "verified");
      },
    });
    expect(recovered.built).toHaveLength(2);
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
      run: (commandArgs) => {
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
