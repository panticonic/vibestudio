import { test } from "node:test";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  compactExecutableModules,
  executableSourceDigest,
  executableSourceFile,
  expandExecutableModules,
  verifyExecutableSourcePool,
  writeExecutableSources,
} from "./release-executable-sources.mjs";

function module(moduleId, source) {
  return {
    moduleId,
    contentDigest: executableSourceDigest(source),
    package: { kind: "first-party" },
    format: "ts",
    source,
  };
}

async function pool(run) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "executable-sources-"));
  try {
    await run(path.join(root, "executable-sources"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

test("a source shared by several modules is stored once and expands back exactly", async () => {
  await pool(async (directory) => {
    const shared = "export const shared = 1;\n";
    const modules = [module("a.ts", shared), module("b.ts", shared), module("c.ts", "export {};\n")];
    const { references, sources } = compactExecutableModules(modules);
    assert.equal(sources.size, 2);
    assert.ok(references.every((reference) => !("source" in reference)));
    await writeExecutableSources(directory, sources);
    assert.equal((await fsp.readdir(directory)).length, 2);
    // A second export of builds with the same modules adds nothing and does not fail.
    await writeExecutableSources(directory, sources);
    assert.equal((await fsp.readdir(directory)).length, 2);
    assert.deepEqual(await expandExecutableModules(references, directory), modules);
  });
});

test("a pooled source that is not the one its digest names is refused", async () => {
  await pool(async (directory) => {
    const original = module("a.ts", "export const a = 1;\n");
    const { references, sources } = compactExecutableModules([original]);
    await writeExecutableSources(directory, sources);
    // Replace the pooled file with a different, well-formed source.
    await fsp.rm(executableSourceFile(directory, original.contentDigest));
    const forged = new Map([[original.contentDigest, "export const a = 2;\n"]]);
    const { gzipSync } = await import("node:zlib");
    await fsp.writeFile(
      executableSourceFile(directory, original.contentDigest),
      gzipSync(Buffer.from([...forged.values()][0], "utf8"))
    );
    await assert.rejects(expandExecutableModules(references, directory), /does not match its digest/u);
    await assert.rejects(
      verifyExecutableSourcePool(directory, [original.contentDigest]),
      /does not match its digest/u
    );
  });
});

test("an inventory whose source does not match its digest cannot be compacted", () => {
  assert.throws(
    () => compactExecutableModules([{ ...module("a.ts", "x"), source: "y" }]),
    /does not match its digest/u
  );
});

test("the pool must hold exactly the sources the inventories name", async () => {
  await pool(async (directory) => {
    const { sources } = compactExecutableModules([module("a.ts", "a"), module("b.ts", "b")]);
    await writeExecutableSources(directory, sources);
    const [first, second] = [...sources.keys()];
    await verifyExecutableSourcePool(directory, [first, second]);
    await assert.rejects(verifyExecutableSourcePool(directory, [first]), /unreferenced/u);
    await fsp.rm(executableSourceFile(directory, second));
    await assert.rejects(verifyExecutableSourcePool(directory, [first, second]), /lacks/u);
    // No inventory names anything and there is no pool: nothing to prove.
    await verifyExecutableSourcePool(path.join(directory, "absent"), []);
  });
});
