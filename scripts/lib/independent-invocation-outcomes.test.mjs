import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  gadNativeReturnContracts,
  gadNativeReturnEvidence,
} from "./independent-invocation-outcomes.mjs";
const ref = (value) => {
  const text = JSON.stringify(value);
  return {
    complete: true,
    hash: createHash("sha256").update(text).digest("hex"),
    bytes: Buffer.byteLength(text),
  };
};
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "native-partial-oracle-"));
  for (const name of ["reviewQuestion/interpretQuestion", "reviewParticipant/evaluateRoster"]) {
    const file = path.join(root, "skills/gad-context/natlang/reviewDurableQuestion", name + ".nl");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      "---\nreturns: " +
        (name.endsWith("interpretQuestion")
          ? "DurableQuestionJudgment"
          : "DurableParticipantJudgment") +
        "\n---\nReturn the actual complete native judgment.\n"
    );
  }
  const contracts = await gadNativeReturnContracts(root),
    goal = "If a current question exists, review its participant.",
    history = {
      channelId: "owned",
      receipt: "history",
      through: null,
      complete: true,
      messages: [],
    };
  const native = {
    messages: [],
    roster: [{ participantId: "p1", handle: "sound-desk", displayName: "Sound", inactive: true }],
    active: [],
  };
  const roster = {
    channelId: "owned",
    receipt: "roster",
    complete: true,
    members: [
      {
        participantId: "p1",
        handle: "sound-desk",
        displayName: "Sound",
        kind: "agent",
        joinedAt: "earlier",
        leftAt: "now",
      },
    ],
  };
  const question = { status: "no-question", message: null },
    participant = { status: "absent", member: null };
  const world = {
    kind: "gadDurableQuestion",
    id: "actual-owned-case",
    goal,
    expected: { question: "no-question", message: null, participant: "inactive", member: 0 },
  };
  const calls = contracts.map((contract, i) => ({
    callId: "call" + i,
    record: {
      call_id: "call" + i,
      parent_call_id: "root",
      definition: {
        id: "nl:" + contract.source,
        name: contract.name,
        source: contract.source,
        returns: contract.returns,
        instructions: contract.instructions,
      },
      executor: { kind: "agent" },
      outcome: "done",
      effects: [],
      inputs: Object.fromEntries(
        Object.entries(i ? { goal, question, roster } : { goal, history }).map(([key, value]) => [
          key,
          ref(value),
        ])
      ),
      output: ref(i ? participant : question),
    },
  }));
  const proof = {
    caseId: world.id,
    contextId: "ctx",
    goal,
    actualResult: { question, participant },
    checks: {
      exactIndividualPublications: true,
      exactRetainedRoster: true,
      exactQuestionDisposition: true,
      exactParticipantDisposition: false,
    },
    diagnostics: { history, roster, native },
  };
  return {
    root,
    world,
    workflow: { assignment: world, nativeReturnContracts: contracts },
    exercise: { calls },
    execution: { provenance: { contextId: "ctx" }, diagnostics: { openGoalVerification: proof } },
    proof,
  };
}
for (const mutation of [
  null,
  "wrong-return",
  "foreign-input",
  "wrong-instructions",
  "effect",
  "descendant-effect",
  "failed-native-check",
  "missing-native-history",
  "wrong-goal",
  "unsupported-domain",
])
  test(
    "native oracle " + (mutation ?? "certifies the correct child while retaining failed sibling"),
    async () => {
      const f = await fixture();
      try {
        const leaf = f.exercise.calls[0].record;
        if (mutation === "wrong-return") leaf.output = ref({ status: "current", message: null });
        if (mutation === "foreign-input") leaf.inputs.goal = ref("Other user");
        if (mutation === "wrong-instructions")
          leaf.definition.instructions = ref("Invent a result");
        if (mutation === "effect") leaf.effects = [{ service: "write", method: "mutate" }];
        if (mutation === "descendant-effect")
          f.exercise.calls.push({
            callId: "nested",
            record: {
              call_id: "nested",
              parent_call_id: leaf.call_id,
              outcome: "done",
              effects: [{ service: "write", method: "mutate" }],
            },
          });
        if (mutation === "failed-native-check") f.proof.checks.exactQuestionDisposition = false;
        if (mutation === "missing-native-history") delete f.proof.diagnostics.history;
        if (mutation === "wrong-goal") f.proof.goal = "Other user";
        if (mutation === "unsupported-domain") f.world.kind = "other";
        if (mutation === "wrong-goal")
          assert.throws(() => gadNativeReturnEvidence(f.execution, f.exercise, f.workflow));
        else {
          const result = gadNativeReturnEvidence(f.execution, f.exercise, f.workflow);
          if (mutation) assert.equal(result, null);
          else {
            assert.deepEqual(
              result.invocations.map((i) => i.call_id),
              ["call0"]
            );
            assert.equal(result.evidence.workspace.proof.checks.exactParticipantDisposition, false);
          }
        }
      } finally {
        await rm(f.root, { recursive: true, force: true });
      }
    }
  );

test("missing known helpers does not prescribe a public program route",async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"native-partial-alternative-"));
 try{assert.deepEqual(await gadNativeReturnContracts(root),[]);}finally{await rm(root,{recursive:true,force:true});}
});
