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

test("independent compiler realms run concurrently and retain result order", async () => {
  const finish = [];
  const pending = buildArtifactGroups(
    [artifact("a"), artifact("b", { format: "cjs" })],
    () => new Promise((resolve) => finish.push(resolve))
  );
  assert.equal(finish.length, 2);
  finish[1]("second");
  finish[0]("first");
  assert.deepEqual(await pending, ["first", "second"]);
});

test("a failed compiler joins admitted siblings before returning its original error", async () => {
  const failure = new Error("compiler failure");
  let finish;
  let settled = false;
  const pending = buildArtifactGroups(
    [artifact("a"), artifact("b", { format: "cjs" })],
    (config) => {
      if (config.format === "esm") throw failure;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
  );
  void pending.catch(() => {
    settled = true;
  });
  assert.equal(typeof finish, "function");
  await Promise.resolve();
  assert.equal(settled, false);
  finish("second");
  await assert.rejects(pending, (error) => error === failure);
});
