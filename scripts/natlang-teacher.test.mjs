import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { parseArguments } from "./natlang-teacher.mjs";
import { verifySemantics, acquireCollectionLock } from "./lib/natlang-teacher-data.mjs";

test("teacher selection cannot collect protected partitions", () => {
  assert.equal(parseArguments(["--all", "--out", "out"]).model, "gpt-6-luna");
  assert.throws(() => parseArguments(["--all", "--out", "out", "--split", "test"]), /unknown/);
  assert.throws(() => parseArguments(["--all", "--template", "base", "--out", "out"]), /usage/);
  assert.throws(() => parseArguments(["--all", "--out", "out", "--limit", "NaN"]), /integer/);
});
test("semantic review is isolated from executor turns and rejects malformed judgments", async () => {
  let supplied;
  const result = {
    outcome: { kind: "returned", value: "answer" },
    observation: { result: "answer" },
  };
  const judge = async (request) => {
    supplied = request;
    return { calls: [["verify_result", { verdict: "rejected", reason: "unsupported" }]] };
  };
  assert.equal(
    (await verifySemantics(judge, { input: "question", expected: "reference" }, result)).verdict,
    "rejected"
  );
  assert.equal(supplied.messages.length, 2);
  assert.match(supplied.messages[1].content, /reference/);
  await assert.rejects(
    () => verifySemantics(async () => ({ text: "fine" }), {}, result),
    /no valid verdict/
  );
});

test("kernel collection lock excludes independent open descriptions and releases without unlinking", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "natlang-teacher-lock-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "lock"),
    release = acquireCollectionLock(file);
  assert.throws(() => acquireCollectionLock(file), /another collector owns it/);
  release();
  const again = acquireCollectionLock(file);
  again();
  assert.ok(fs.existsSync(file));
});
