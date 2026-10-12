import { test } from "node:test";
import assert from "node:assert/strict";
import { reportAfterPackFailure } from "./electron-after-pack.mjs";

test("after-pack diagnostics render nested operation and cleanup failures", () => {
  const operationFailure = new Error("native dependency verification failed", {
    cause: new Error("SQLite errcode=5, errstr=database is locked"),
  });
  const cleanupFailure = new Error("owned package process exited with status 7");
  const failure = new AggregateError(
    [new AggregateError([operationFailure], "Installed release operation failed"), cleanupFailure],
    "Installed release operation failed",
    { cause: operationFailure }
  );
  let diagnostic;

  reportAfterPackFailure(failure, (message) => {
    diagnostic = message;
  });

  assert.match(diagnostic, /native dependency verification failed/);
  assert.match(diagnostic, /SQLite errcode=5, errstr=database is locked/);
  assert.match(diagnostic, /owned package process exited with status 7/);
});
