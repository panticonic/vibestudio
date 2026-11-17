import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { parseArguments } from "./natlang-teacher.mjs";
import {
  replayDriver,
  trainingTurn,
  requestHash,
  eligibility,
  verifySemantics,
  acquireCollectionLock,
  validateEpisode,
  sha256,
} from "./lib/natlang-teacher-data.mjs";

const request = { messages: [{ role: "user", content: "a" }], tools: [], seed: 3 };
const turn = {
  invocation_id: "child",
  parent_call_id: "root",
  turn: 1,
  request,
  reply: {
    calls: [["return_result", { status: "success", result: "a" }]],
    raw_calls: [
      {
        id: "provider-id",
        type: "function",
        function: { name: "return_result", arguments: '{"status":"success","result":"a"}' },
      },
    ],
  },
};

test("teacher selection cannot collect protected partitions", () => {
  assert.equal(parseArguments(["--all", "--out", "out"]).model, "gpt-6-luna");
  assert.throws(() => parseArguments(["--all", "--out", "out", "--split", "test"]), /unknown/);
  assert.throws(() => parseArguments(["--all", "--template", "base", "--out", "out"]), /usage/);
  assert.throws(() => parseArguments(["--all", "--out", "out", "--limit", "NaN"]), /integer/);
});
test("replay matches concurrent calls by exact visible request and consumes every call", async () => {
  const second = {
    ...turn,
    request: { ...request, messages: [{ role: "user", content: "b" }] },
    reply: { text: "b" },
  };
  const replay = replayDriver([turn, second]);
  assert.deepEqual(await replay.driver(second.request), second.reply);
  assert.throws(() => replay.finish(), /unconsumed/);
  assert.deepEqual(await replay.driver(request), turn.reply);
  assert.deepEqual(replay.finish(), [requestHash(second.request), requestHash(request)]);
  await assert.rejects(() => replay.driver(request), /diverged/);
});
test("training preserves provider tool IDs, arguments, and exact context", () => {
  const row = trainingTurn(turn);
  assert.deepEqual(row.target.tool_calls, turn.reply.raw_calls);
  assert.deepEqual(row.messages, request.messages);
  assert.equal(row.parent_call_id, "root");
  assert.deepEqual(JSON.parse(row.request_canonical), {
    messages: request.messages,
    tools: request.tools,
  });
});
test("root success alone does not admit incomplete, failed-child, or zero-model runs", () => {
  const result = {
    status: "scored",
    outcome: { kind: "returned" },
    quality: 1,
    gates: { completed: true },
    traces: [{ outcome: "done", events: [] }],
    modelTurns: [turn],
  };
  assert.equal(eligibility(result), null);
  assert.equal(eligibility({ ...result, quality: 0.9 }), "quality-below-one");
  assert.equal(eligibility({ ...result, modelTurns: [] }), "no-model-turns");
  assert.equal(
    eligibility({ ...result, traces: [{ outcome: "failed", events: [] }] }),
    "failed-child-call"
  );
  assert.equal(
    eligibility({ ...result, modelTurns: [{ ...turn, reply: { truncated: true } }] }),
    "incomplete-model-turn"
  );
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

test("optional transport properties remain valid exact JSON after disk round trip", () => {
  const row = trainingTurn({
    ...turn,
    request: { ...request, messages: [{ role: "user", content: "a", name: undefined }] },
  });
  const disk = JSON.parse(JSON.stringify(row));
  assert.deepEqual(JSON.parse(disk.request_canonical), {
    messages: disk.messages,
    tools: disk.tools,
  });
});

test("generated tool IDs match the runtime's observation IDs when provider IDs are absent", () => {
  const row = trainingTurn({ ...turn, reply: { calls: turn.reply.calls } });
  assert.equal(row.target.tool_calls[0].id, "call_1_0");
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

test("resumption rejects foreign sources, changed targets, and incorrect case filenames", () => {
  const known = {
    id: "case",
    group: "world",
    split: "train",
    input_sha256: "input",
    source_ids: ["source"],
    source_groups: ["world"],
    source_revisions: ["rev"],
  };
  const binding = {
    cases: [known],
    source: { commit: "pin" },
    teacher: { model: "luna" },
    suite: { id: "suite", hash: "hash", path: "suite.ts" },
  };
  const id = sha256({ binding, case: known.id });
  const episode = {
    schema: "vibestudio.teacher-episode/1",
    id,
    source: binding.source,
    teacher: binding.teacher,
    suite: { id: "suite", hash: "hash" },
    case: {
      id: known.id,
      group: known.group,
      split: known.split,
      input_sha256: known.input_sha256,
    },
    source_ids: known.source_ids,
    source_groups: known.source_groups,
    source_revisions: known.source_revisions,
    turns: [trainingTurn(turn)],
    evaluation: {
      status: "scored",
      outcome: { kind: "returned" },
      quality: 1,
      gates: { ok: true },
      traces: [],
      modelTurns: [turn],
    },
    verification: { verdict: "accepted" },
    rejection: null,
  };
  assert.equal(validateEpisode(episode, binding, `${id}.json`), episode);
  assert.throws(
    () => validateEpisode({ ...episode, source: { commit: "other" } }, binding, `${id}.json`),
    /foreign/
  );
  assert.throws(
    () => validateEpisode({ ...episode, turns: [] }, binding, `${id}.json`),
    /capture changed/
  );
  assert.throws(() => validateEpisode(episode, binding, "other.json"), /identity/);
});
