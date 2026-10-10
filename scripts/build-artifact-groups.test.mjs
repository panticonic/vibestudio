import { test } from "node:test";
import assert from "node:assert/strict";
import { groupBuildArtifacts, buildArtifactGroups } from "./build-artifact-groups.mjs";

const artifact = (name, options = {}) => ({
  entryPoints: [`${name}.ts`],
  outfile: `dist/${name}.mjs`,
  format: "esm",
  bundle: true,
  ...options,
});

test("compatible entries share one graph while compiler realms retain their options", () => {
  const groups = groupBuildArtifacts([
    artifact("a"),
    artifact("b"),
    artifact("c", { format: "cjs" }),
    artifact("d", { external: ["native"] }),
  ]);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups[0].entryPoints, [
    { in: "a.ts", out: "a" },
    { in: "b.ts", out: "b" },
  ]);
  assert.deepEqual(groups[0].outExtension, { ".js": ".mjs" });
  assert.equal(groups[1].format, "cjs");
  assert.deepEqual(groups[2].external, ["native"]);
});

test("failure settles the owned compiler before returning and admits no later realm", async () => {
  let reject;
  const failure = new Error("compiler failure");
  const started = [];
  const pending = buildArtifactGroups(
    [artifact("a"), artifact("b", { format: "cjs" })],
    (config) => {
      started.push(config);
      return new Promise((_, fail) => {
        reject = fail;
      });
    }
  );
  assert.equal(started.length, 1);
  reject(failure);
  await assert.rejects(pending, (error) => error === failure);
  assert.equal(started.length, 1);
});
