import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import * as esbuild from "esbuild";
import { runtimeAppBuildOptions, runtimeAppCompilerOutput } from "../runtime-app-build.mjs";
import { groupBuildArtifacts } from "../build-artifact-groups.mjs";
import {
  RUNTIME_APP_HOST_EXPORTS,
  assertRuntimeAppPublication,
  captureRuntimeApp,
  readPublishedRuntimeApp,
  INTERNAL_DO_PROGRAM_ENTRIES,
  runtimeAppEntrypointSource,
} from "./runtime-app.mjs";

const classNames = INTERNAL_DO_PROGRAM_ENTRIES.map(({ className }) => className);
const compiled = () => ({
  bundle: classNames.map((name) => `export class ${name} {}`).join("\n") + "\nexport default {};\n",
  exports: [...RUNTIME_APP_HOST_EXPORTS, ...classNames],
});

test("the installed CJS loader excludes producer-only payload proof and dependency policy", async () => {
  const result = await esbuild.build({
    entryPoints: ["src/server/internalDOs/internalDoLoader.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
    write: false,
    minify: true,
    logLevel: "silent",
  });
  const source = result.outputFiles[0].text;
  for (const producerOnly of [
    "Runtime app must export exactly",
    "forbidden runtime dependency",
    "does not match its exact bytes",
    'Dynamic require of \\"',
    'require("process")',
  ])
    assert(
      !source.includes(producerOnly),
      `Installed loader retained producer-only code: ${producerOnly}`
    );
  assert(
    source.includes("vibestudio/internal-do-recipe/v1"),
    "Canonical class-bound runtime identity remains present"
  );
});

test("the real host compiler recipe publishes one module with every host entrypoint and class", async () => {
  const [options] = groupBuildArtifacts([runtimeAppBuildOptions({ minify: true })]);
  const result = await esbuild.build(options);
  const output = runtimeAppCompilerOutput(result);
  const publication = assertRuntimeAppPublication(captureRuntimeApp(output));
  assert.deepEqual([...publication.internalClasses].sort(), [...classNames].sort());
  assert.deepEqual(
    [...output.exports].sort(),
    [...RUNTIME_APP_HOST_EXPORTS, ...classNames].sort()
  );
  // One SES copy: a second evaluation of `ses` in one isolate family fails.
  assert.equal(publication.bundle.split("lockdown(").length > 1, true);
  const corrupted = { ...publication, bundle: publication.bundle + "// corruption" };
  assert.throws(() => assertRuntimeAppPublication(corrupted), /does not match its exact bytes/);
});

test("producer proves the exact exports and byte identity", () => {
  const output = compiled();
  const publication = captureRuntimeApp(output);
  assert.equal(publication.buildKey, createHash("sha256").update(output.bundle).digest("hex"));
  assert(Object.isFrozen(publication));
  assert.throws(
    () => assertRuntimeAppPublication({ ...publication, buildKey: "a".repeat(64) }),
    /does not match its exact bytes/
  );
});

test("development source maps remain external to the engine payload", async () => {
  const result = await esbuild.build(runtimeAppBuildOptions({ sourcemap: true }));
  const publication = captureRuntimeApp(runtimeAppCompilerOutput(result));
  assert.equal(result.outputFiles.filter((output) => output.path.endsWith(".map")).length, 1);
  assert(!publication.bundle.includes("sourceMappingURL=data:"));
  assert(publication.bundle.includes("sourceMappingURL="));
});

test("producer rejects missing or extra exports and forbidden dependencies", () => {
  for (const exports of [
    classNames,
    [...RUNTIME_APP_HOST_EXPORTS, ...classNames.slice(1)],
    [...RUNTIME_APP_HOST_EXPORTS, ...classNames, "Extra"],
  ]) {
    assert.throws(() => captureRuntimeApp({ ...compiled(), exports }), /must export exactly/);
  }
  const forbidden = compiled();
  forbidden.bundle += 'require("process")';
  assert.throws(() => captureRuntimeApp(forbidden), /forbidden runtime dependency/);
});

test("immutable consumer admission copies exact finite metadata", () => {
  const publication = structuredClone(captureRuntimeApp(compiled()));
  const admitted = readPublishedRuntimeApp(publication);
  publication.bundle = "mutated outside owner";
  assert.notEqual(admitted.bundle, publication.bundle);
  assert(Object.isFrozen(admitted));
  assert.throws(() => readPublishedRuntimeApp({ ...publication, extra: true }), /publication/);
  assert.throws(
    () => readPublishedRuntimeApp({ ...admitted, internalClasses: classNames.slice(1) }),
    /internal class inventory/
  );
});

test("bundled installed admission does not retain producer-only dependency sentinels", async () => {
  const result = await esbuild.build({
    stdin: {
      contents: 'export { readPublishedRuntimeApp } from "./runtime-app.mjs";',
      resolveDir: new URL(".", import.meta.url).pathname,
    },
    platform: "node",
    format: "cjs",
    bundle: true,
    minify: true,
    write: false,
  });
  const executable = result.outputFiles[0].text;
  assert(!executable.includes("throw Error('Dynamic require of \""));
  assert(!executable.includes("forbidden runtime dependency"));
  assert(executable.includes("Invalid runtime app"));
});

test("entry evaluates every class wrapper before the realm is locked down", () => {
  const entry = runtimeAppEntrypointSource();
  for (const { className, implementation } of INTERNAL_DO_PROGRAM_ENTRIES) {
    assert(entry.includes(`from ${JSON.stringify(implementation)}`));
    assert(entry.includes(`export const ${className} = internalDurableObjectClass(`));
    assert(
      entry.indexOf(`export const ${className}`) < entry.indexOf("initializeInternalDORealm();")
    );
  }
  assert(entry.trimEnd().endsWith("initializeInternalDORealm();"));
});
