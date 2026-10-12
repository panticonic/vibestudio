import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  assertRuntimeScriptDependencies,
  completeRuntimeScriptClosure,
} from "./npm-runtime-script-closure.mjs";

test("stages transitive import, export, require, and literal dynamic-import closure", () => {
  const root = fixtureRoot();
  try {
    const source = path.join(root, "source");
    const staged = path.join(root, "package");
    write(source, "scripts/cli/entry.mjs", `import "./runtime.mjs";\n`);
    write(
      source,
      "scripts/cli/runtime.mjs",
      `export { value } from "../shared/exported.mjs";\n` +
        `const local = require("../shared/required.cjs");\n` +
        `const resolved = require("../shared/required-index");\n` +
        `await import("../shared/dynamic.mjs");\n` +
        `await import("declared-tool/subpath");\n` +
        `import "node:fs";\n`
    );
    write(source, "scripts/shared/exported.mjs", `export const value = 1;\n`);
    write(source, "scripts/shared/required.cjs", `module.exports = 2;\n`);
    write(source, "scripts/shared/required-index.js", `module.exports = 3;\n`);
    write(source, "scripts/shared/dynamic.mjs", `export const loaded = true;\n`);
    write(staged, "scripts/cli/entry.mjs", `import "./runtime.mjs";\n`);

    const result = completeRuntimeScriptClosure({ sourceRoot: source, packageRoot: staged });
    assert.deepEqual(result.files, [
      "scripts/cli/entry.mjs",
      "scripts/cli/runtime.mjs",
      "scripts/shared/dynamic.mjs",
      "scripts/shared/exported.mjs",
      "scripts/shared/required-index.js",
      "scripts/shared/required.cjs",
    ]);
    assert.deepEqual([...result.bareImports], ["declared-tool"]);
    for (const relative of result.files) {
      assert.deepEqual(
        fs.readFileSync(path.join(staged, relative)),
        fs.readFileSync(path.join(source, relative))
      );
    }

    fs.mkdirSync(path.join(staged, "vendor/declared-tool"), { recursive: true });
    fs.writeFileSync(
      path.join(staged, "package.json"),
      JSON.stringify({ dependencies: {}, optionalDependencies: {} })
    );
    assertRuntimeScriptDependencies({
      packageRoot: staged,
      importedPackages: result.bareImports,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fails on a missing transitive helper before staging later work", () => {
  const root = fixtureRoot();
  try {
    const source = path.join(root, "source");
    const staged = path.join(root, "package");
    write(source, "scripts/cli/entry.mjs", `import "../missing-helper.mjs";\n`);
    write(staged, "scripts/cli/entry.mjs", `import "../missing-helper.mjs";\n`);

    assert.throws(
      () => completeRuntimeScriptClosure({ sourceRoot: source, packageRoot: staged }),
      /Missing local runtime import \.\.\/missing-helper\.mjs/u
    );
    assert.equal(fs.existsSync(path.join(staged, "scripts/missing-helper.mjs")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("includes literal TypeScript loader targets in the runtime closure", () => {
  const root = fixtureRoot();
  try {
    const source = path.join(root, "source");
    const staged = path.join(root, "package");
    write(
      source,
      "scripts/cli/entry.mjs",
      `const { tsImport: loadTs } = await import("tsx/esm/api");\n` +
        `await loadTs("../typed-helper.ts", import.meta.url);\n`
    );
    write(
      source,
      "scripts/typed-helper.ts",
      `import type { Erased } from "missing-type-only";\n` +
        `export type { Erased } from "also-missing-type-only";\n` +
        `export const value: number = 1;\n`
    );
    write(
      staged,
      "scripts/cli/entry.mjs",
      fs.readFileSync(path.join(source, "scripts/cli/entry.mjs"))
    );

    const result = completeRuntimeScriptClosure({ sourceRoot: source, packageRoot: staged });
    assert.deepEqual(result.files, ["scripts/cli/entry.mjs", "scripts/typed-helper.ts"]);
    assert.deepEqual([...result.bareImports], ["tsx"]);
    assert.deepEqual(
      fs.readFileSync(path.join(staged, "scripts/typed-helper.ts")),
      fs.readFileSync(path.join(source, "scripts/typed-helper.ts"))
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects local imports escaping the package and source scripts boundaries", () => {
  const root = fixtureRoot();
  try {
    const source = path.join(root, "source");
    const staged = path.join(root, "package");
    write(source, "scripts/cli/entry.mjs", `import "../../../outside.mjs";\n`);
    write(staged, "scripts/cli/entry.mjs", `import "../../../outside.mjs";\n`);

    assert.throws(
      () => completeRuntimeScriptClosure({ sourceRoot: source, packageRoot: staged }),
      /escapes its allowed root/u
    );
    assert.equal(fs.existsSync(path.join(root, "outside.mjs")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects local imports through node_modules instead of validating a bare dependency", () => {
  const root = fixtureRoot();
  try {
    const source = path.join(root, "source");
    const staged = path.join(root, "package");
    write(
      source,
      "scripts/cli/entry.mjs",
      `import "../../node_modules/local-package/index.mjs";\n`
    );
    write(
      staged,
      "scripts/cli/entry.mjs",
      `import "../../node_modules/local-package/index.mjs";\n`
    );
    write(staged, "node_modules/local-package/index.mjs", `export {};\n`);

    assert.throws(
      () => completeRuntimeScriptClosure({ sourceRoot: source, packageRoot: staged }),
      /outside allowed artifact paths: \.\.\/\.\.\/node_modules\/local-package\/index\.mjs/u
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a bare runtime import absent from package dependencies and vendor", () => {
  const root = fixtureRoot();
  try {
    const staged = path.join(root, "package");
    write(staged, "package.json", JSON.stringify({ dependencies: { present: "^1.0.0" } }));
    assert.throws(
      () =>
        assertRuntimeScriptDependencies({
          packageRoot: staged,
          importedPackages: new Set(["missing"]),
        }),
      /undeclared runtime packages: missing/u
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixtureRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "npm-script-closure-"));
}

function write(root, relative, contents) {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents);
}
