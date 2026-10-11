import { test } from "node:test";
import assert from "node:assert/strict";
import { withOwnedCleanup } from "./build-server-npm-package.mjs";

test("owned release cleanup attempts every resource and preserves operation and cleanup failures", async () => {
  const operationFailure = new Error("template preparation failed");
  const firstCleanupFailure = new Error("node_modules cleanup failed");
  const secondCleanupFailure = new Error("runtime cleanup failed");
  const attempted = [];

  await assert.rejects(
    withOwnedCleanup(
      async () => {
        throw operationFailure;
      },
      [
        async () => {
          attempted.push("node_modules");
          throw firstCleanupFailure;
        },
        async () => {
          attempted.push("runtime");
          throw secondCleanupFailure;
        },
        async () => {
          attempted.push("lockfile");
        },
      ],
      "release cleanup failed"
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual([...error.errors], [
        operationFailure,
        firstCleanupFailure,
        secondCleanupFailure,
      ]);
      assert.equal(error.cause, operationFailure);
      return true;
    }
  );

  assert.deepEqual(attempted.sort(), ["lockfile", "node_modules", "runtime"]);
});

test("owned cleanup rethrows a lone preparation failure unchanged", async () => {
  const operationFailure = new Error("installation failed");
  await assert.rejects(
    withOwnedCleanup(async () => {
      throw operationFailure;
    }, [], "unused"),
    (error) => error === operationFailure
  );
});
