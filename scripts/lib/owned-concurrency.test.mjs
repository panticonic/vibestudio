import assert from "node:assert/strict";
import { test } from "node:test";
import { forEachOwnedConcurrent } from "./owned-concurrency.mjs";

test("bounds admission and joins all work", async () => {
  let active = 0;
  let peak = 0;
  const visited = [];
  await forEachOwnedConcurrent([0, 1, 2, 3, 4], 2, async (value) => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setImmediate(resolve));
    visited.push(value);
    active--;
  });
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.deepEqual(visited.sort(), [0, 1, 2, 3, 4]);
});

test("joins admitted failures and stops admitting after failure", async () => {
  const first = new Error("first");
  const second = new Error("second");
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let settled = false;
  const visited = [];
  const operation = forEachOwnedConcurrent([0, 1, 2], 2, async (value) => {
    visited.push(value);
    if (value === 0) throw first;
    await pending;
    throw second;
  });
  const joined = assert
    .rejects(operation, (error) => {
      assert.deepEqual(error.errors, [first, second]);
      assert.equal(error.cause, first);
      return true;
    })
    .then(() => {
      settled = true;
    });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  release();
  await joined;
  assert.deepEqual(visited, [0, 1]);
});

test("validates admission even for an empty batch", async () => {
  await assert.rejects(
    forEachOwnedConcurrent([], 0, async () => {}),
    TypeError
  );
});
