import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applicationSourceMaps } from "./build-artifact-contracts.mjs";
import { assertPublishedManifestTargets } from "./build-server-npm-package.mjs";

test("release map checks inspect application output without entering retained hosts or stock runtimes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-artifacts-"));
  try {
    for (const dir of ["assets", "node", "host-generations/live"])
      fs.mkdirSync(path.join(root, dir), { recursive: true });
    for (const file of [
      "assets/app.js.map",
      "node/npm.js.map",
      "host-generations/live/server.js.map",
    ])
      fs.writeFileSync(path.join(root, file), "{}");
    fs.symlinkSync(root, path.join(root, "host-generations/live/recursive"), "dir");
    fs.symlinkSync(
      path.join(root, "absent"),
      path.join(root, "host-generations/live/absent"),
      "dir"
    );
    assert.deepEqual(applicationSourceMaps(root), [path.join("assets", "app.js.map")]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("published npm files contain every declared package entry point", () => {
  const manifest = {
    name: "@example/client",
    main: "dist/index.js",
    types: "dist/index.d.ts",
    bin: { example: "bin/example.js" },
    exports: {
      ".": { worker: "./src/index.ts", default: "./dist/index.js" },
      "./*": { types: "./dist/*.d.ts", browser: "./src/*.ts" },
      "./extra": { default: "./src/extra.ts" },
    },
  };
  const published = [
    "dist/index.js",
    "dist/index.d.ts",
    "bin/example.js",
    "dist/api.d.ts",
    "src/index.ts",
    "src/api.ts",
    "src/extra.ts",
  ].map((file) => ({ path: file }));

  assert.doesNotThrow(() => assertPublishedManifestTargets(manifest, published));
  assert.throws(
    () =>
      assertPublishedManifestTargets(
        manifest,
        published.filter(({ path: file }) => file !== "src/extra.ts")
      ),
    /omits declared entry points: \.\/src\/extra\.ts/
  );
});

test("published package checks resolve legacy main entries and require exact executable paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-package-entries-"));
  try {
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    fs.mkdirSync(path.join(root, "lib"), { recursive: true });
    fs.writeFileSync(path.join(root, "index.js"), "module.exports = {};\n");
    fs.writeFileSync(path.join(root, "bin", "cli.js"), "process.exit(0);\n");
    fs.writeFileSync(path.join(root, "lib", "index.js"), "module.exports = {};\n");
    assert.doesNotThrow(() =>
      assertPublishedManifestTargets(
        { name: "legacy-package", main: "index", bin: { legacy: "bin/cli.js" } },
        ["index.js", "bin/cli.js", "lib/index.js"].map((file) => ({ path: file })),
        root
      )
    );
    assert.throws(
      () =>
        assertPublishedManifestTargets(
          { name: "missing-executable", bin: { legacy: "bin/cli" } },
          [{ path: "bin/cli.js" }],
          root
        ),
      /omits declared entry points: bin\/cli/
    );
    assert.doesNotThrow(() =>
      assertPublishedManifestTargets(
        { name: "directory-main", main: "lib" },
        ["index.js", "bin/cli.js", "lib/index.js"].map((file) => ({ path: file })),
        root
      )
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
