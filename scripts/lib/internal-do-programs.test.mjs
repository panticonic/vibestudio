import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import * as esbuild from "esbuild";
import { internalDoBuildOptions, internalDoCompilerOutputs } from "../internal-do-build.mjs";
import { groupBuildArtifacts } from "../build-artifact-groups.mjs";
import {
  captureInternalDoPrograms,
  assertInternalDoProgramsPublication,
  readPublishedInternalDoPrograms,
  INTERNAL_DO_PROGRAM_ENTRIES,
  internalDoEntrypointSource,
} from "./internal-do-programs.mjs";

const compiled = () =>
  Object.fromEntries(
    INTERNAL_DO_PROGRAM_ENTRIES.map(({ className }) => [
      className,
      { bundle: `export class ${className} {}\n`, exports: [className] },
    ])
  );

test("the real host compiler recipe publishes exactly the four isolated class entrypoints", async () => {
  const [options] = groupBuildArtifacts([internalDoBuildOptions({ minify: true })]);
  const result = await esbuild.build(options);
  const outputs = internalDoCompilerOutputs(result);
  const publication = assertInternalDoProgramsPublication(captureInternalDoPrograms(outputs));
  assert.deepEqual(
    Object.keys(publication.programs).sort(),
    INTERNAL_DO_PROGRAM_ENTRIES.map(({ className }) => className).sort()
  );
  for (const { className } of INTERNAL_DO_PROGRAM_ENTRIES) {
    assert.deepEqual(outputs[className].exports, [className]);
  }
  const corrupted = structuredClone(publication);
  corrupted.programs.WorkspaceDO.bundle += "// publication corruption";
  assert.throws(
    () => assertInternalDoProgramsPublication(corrupted),
    /does not match its exact bytes/
  );
});

test("producer proves each actual class export and byte identity", () => {
  const outputs = compiled();
  const publication = captureInternalDoPrograms(outputs);
  for (const [className, program] of Object.entries(publication.programs)) {
    assert.equal(
      program.buildKey,
      createHash("sha256").update(outputs[className].bundle).digest("hex")
    );
    assert(Object.isFrozen(program));
  }
  const altered = structuredClone(publication);
  altered.programs.EvalDO.bundle += "// corrupted";
  assert.throws(
    () => assertInternalDoProgramsPublication(altered),
    /does not match its exact bytes/
  );
  const wrongKey = structuredClone(publication);
  wrongKey.programs.EvalDO.buildKey = "a".repeat(64);
  assert.throws(
    () => assertInternalDoProgramsPublication(wrongKey),
    /does not match its exact bytes/
  );
});

test("development source maps remain external to every engine payload", async () => {
  const result = await esbuild.build(internalDoBuildOptions({ sourcemap: true }));
  const publication = captureInternalDoPrograms(internalDoCompilerOutputs(result));
  assert.equal(
    result.outputFiles.filter((output) => output.path.endsWith(".map")).length,
    INTERNAL_DO_PROGRAM_ENTRIES.length
  );
  for (const program of Object.values(publication.programs)) {
    assert(!program.bundle.includes("sourceMappingURL=data:"));
    assert(program.bundle.includes("sourceMappingURL="));
  }
});
test("producer rejects wrong/multiple exports, missing classes and forbidden dependencies", () => {
  for (const exports of [[], ["WorkspaceDO"], ["EvalDO", "WorkspaceDO"]]) {
    const outputs = compiled();
    outputs.EvalDO.exports = exports;
    assert.throws(() => captureInternalDoPrograms(outputs), /only its reviewed class/);
  }
  const missing = compiled();
  delete missing.EvalDO;
  assert.throws(() => captureInternalDoPrograms(missing), /compiler output inventory/);
  const forbidden = compiled();
  forbidden.EvalDO.bundle += 'require("process")';
  assert.throws(() => captureInternalDoPrograms(forbidden), /forbidden workerd runtime dependency/);
});
test("immutable consumer admission copies exact finite metadata without a second payload proof", () => {
  const publication = structuredClone(captureInternalDoPrograms(compiled()));
  const admitted = readPublishedInternalDoPrograms(publication);
  publication.programs.EvalDO.bundle = "mutated outside owner";
  assert.notEqual(admitted.programs.EvalDO.bundle, publication.programs.EvalDO.bundle);
  assert(Object.isFrozen(admitted.programs));
  assert.throws(
    () => readPublishedInternalDoPrograms({ ...publication, extra: true }),
    /program collection/
  );
});
test("bundled installed admission does not retain producer-only dependency sentinels", async () => {
  const result = await esbuild.build({
    stdin: {
      contents: 'export { readPublishedInternalDoPrograms } from "./internal-do-programs.mjs";',
      resolveDir: new URL(".", import.meta.url).pathname,
    },
    platform: "node",
    format: "cjs",
    bundle: true,
    minify: true,
    write: false,
  });
  const executable = result.outputFiles[0].text;
  // The unchanged CJS artifact gate must not find producer policy as live
  // runtime data. Producer validation still rejects it in the tests above.
  assert(!executable.includes("throw Error('Dynamic require of \""));
  assert(!executable.includes("forbidden workerd runtime dependency"));
  assert(executable.includes("Invalid internal DO"));
});
test("catalog entrypoints retain dependency-before-lockdown ordering and export one class", () => {
  for (const { className, implementation } of INTERNAL_DO_PROGRAM_ENTRIES) {
    const entry = internalDoEntrypointSource(className);
    assert(entry.includes(`export { ${className} } from ${JSON.stringify(implementation)}`));
    assert(entry.indexOf("export {") < entry.indexOf("initializeInternalDORealm();"));
    assert(!entry.includes('from "./index'));
  }
  assert.throws(() => internalDoEntrypointSource("UnknownDO"), /not a reviewed product export/);
});
