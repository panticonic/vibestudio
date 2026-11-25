import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  installedPackageGraphHash,
  installedPackageGraphHashSync,
} from "./installed-package-graph.mjs";

test("sync build and bounded async runtime drivers share exact graph traversal and cycle identity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "installed-graph-drivers-"));
  try {
    const modules = path.join(root, "node_modules");
    for (const [name, dependencies] of [
      ["first", { second: "*" }],
      ["second", { first: "*" }],
    ]) {
      const directory = path.join(modules, name);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(
        path.join(directory, "package.json"),
        JSON.stringify({ name, version: "1", dependencies })
      );
    }
    const sync = installedPackageGraphHashSync(modules, new Set(), {
      tree: () => assert.fail("registry packages have no editable source tree"),
    });
    const asynchronous = await installedPackageGraphHash(modules, new Set(), {
      tree: async () => assert.fail("unexpected local source"),
      io: { run: (operation) => operation() },
    });
    assert.equal(sync, asynchronous);
    fs.writeFileSync(
      path.join(modules, "second/package.json"),
      JSON.stringify({ name: "second", version: "2", dependencies: { first: "*" } })
    );
    assert.notEqual(installedPackageGraphHashSync(modules, new Set(), { tree: () => "" }), sync);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
