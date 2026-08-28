import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as esbuild from "esbuild";
import { createDependencyEnvironmentResolvePlugin } from "./builder.js";

function writePackage(nodeModules: string, name: string, marker: string): void {
  const root = path.join(nodeModules, ...name.split("/"));
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name, version: "1.0.0", type: "module", exports: "./index.js" })
  );
  fs.writeFileSync(
    path.join(root, "index.js"),
    `export const marker = ${JSON.stringify(marker)};\n`
  );
}

describe("dependency-environment resolver", () => {
  it("uses the prepared environment instead of node_modules above materialized source", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-hermetic-build-"));
    try {
      const ambientModules = path.join(root, "node_modules");
      const ownedModules = path.join(root, "owned", "node_modules");
      const sourceDir = path.join(root, "workspace", "source");
      fs.mkdirSync(sourceDir, { recursive: true });
      writePackage(ambientModules, "example-dependency", "ambient");
      writePackage(ownedModules, "example-dependency", "owned");
      const entry = path.join(sourceDir, "entry.js");
      fs.writeFileSync(
        entry,
        'import { marker } from "example-dependency"; export default marker;\n'
      );

      const result = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        format: "esm",
        write: false,
        plugins: [createDependencyEnvironmentResolvePlugin([ownedModules])],
      });
      const output = result.outputFiles[0]?.text ?? "";
      expect(output).toContain('var marker = "owned"');
      expect(output).not.toContain("ambient");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an ambient dependency absent from the prepared environment", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-hermetic-build-"));
    try {
      const ambientModules = path.join(root, "node_modules");
      const ownedModules = path.join(root, "owned", "node_modules");
      const sourceDir = path.join(root, "workspace", "source");
      fs.mkdirSync(ownedModules, { recursive: true });
      fs.mkdirSync(sourceDir, { recursive: true });
      writePackage(ambientModules, "ambient-only", "ambient");
      const entry = path.join(sourceDir, "entry.js");
      fs.writeFileSync(entry, 'import "ambient-only";\n');

      await expect(
        esbuild.build({
          entryPoints: [entry],
          bundle: true,
          write: false,
          logLevel: "silent",
          plugins: [createDependencyEnvironmentResolvePlugin([ownedModules])],
        })
      ).rejects.toThrow("Dependency ambient-only is not present in the prepared build environment");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts package sources reached through an owned workspace symlink", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-hermetic-build-"));
    try {
      const ownedModules = path.join(root, "owned", "node_modules");
      const packageSource = path.join(root, "packages", "linked-dependency");
      const sourceDir = path.join(root, "workspace", "source");
      fs.mkdirSync(ownedModules, { recursive: true });
      fs.mkdirSync(packageSource, { recursive: true });
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.writeFileSync(
        path.join(packageSource, "package.json"),
        JSON.stringify({
          name: "linked-dependency",
          version: "1.0.0",
          type: "module",
          exports: "./index.js",
        })
      );
      fs.writeFileSync(path.join(packageSource, "value.js"), 'export const marker = "linked";\n');
      fs.writeFileSync(
        path.join(packageSource, "index.js"),
        'export { marker } from "./value.js";\n'
      );
      fs.symlinkSync(packageSource, path.join(ownedModules, "linked-dependency"), "dir");
      const entry = path.join(sourceDir, "entry.js");
      fs.writeFileSync(
        entry,
        'import { marker } from "linked-dependency"; export default marker;\n'
      );

      const result = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        format: "esm",
        write: false,
        plugins: [createDependencyEnvironmentResolvePlugin([ownedModules])],
      });
      expect(result.outputFiles[0]?.text ?? "").toContain('var marker = "linked"');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
