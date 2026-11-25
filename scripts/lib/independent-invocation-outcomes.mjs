/** Native closed-function oracles for partial training; never infer correctness from execution success. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const matches = (ref, value) => {
  const text = JSON.stringify(value);
  return (
    text !== undefined &&
    ref?.complete === true &&
    ref.bytes === Buffer.byteLength(text) &&
    ref.hash === digest(text)
  );
};
const requireProof = (yes, message) => {
  if (!yes) throw Error(message);
};

/** A contract registration names actual authored code, not just a function name. */
export async function gadNativeReturnContracts(base) {
  const contracts = [];
  for (const [name, returns] of [
    ["interpretQuestion", "DurableQuestionJudgment"],
    ["evaluateRoster", "DurableParticipantJudgment"],
  ]) {
    const suffix =
      name === "interpretQuestion"
        ? "reviewDurableQuestion/reviewQuestion/interpretQuestion.nl"
        : "reviewDurableQuestion/reviewParticipant/evaluateRoster.nl";
    const file = path.join(base, "skills/gad-context/natlang", suffix);
    let source;
    try { source = await readFile(file, "utf8"); }
    catch(error) { if(error.code === "ENOENT") continue; throw error; }
    const [, frontmatter, body] = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/u.exec(source) ?? [];
    // A valid public entry may compose different helpers. Missing or changed
    // closed contracts disable this oracle; they never constrain the teacher route.
    if(body === undefined || !frontmatter.includes("returns: " + returns)) continue;
    // Loader preserves the final newline and strips the frontmatter separator.
    const instructions = JSON.stringify(body);
    contracts.push({
      name,
      source: suffix,
      returns,
      instructionsJson: instructions,
      instructions: {
        complete: true,
        hash: digest(instructions),
        bytes: Buffer.byteLength(instructions),
      },
      sourceFile: { path: file, sha256: digest(source) },
    });
  }
  return contracts;
}

/** Native GAD snapshot + complete expected closed return, independent of the public composite report. */
export function gadNativeReturnEvidence(execution, exercise, workflow) {
  const world = workflow.assignment,
    proof = execution?.diagnostics?.openGoalVerification;
  if (world?.kind !== "gadDurableQuestion" || !Array.isArray(workflow.nativeReturnContracts))
    return null;
  const { history, roster, native } = proof?.diagnostics ?? {};
  requireProof(
    proof?.caseId === world.id &&
      proof.goal === world.goal &&
      proof.contextId === execution.provenance?.contextId,
    "Partial native proof differs from assigned goal/context"
  );
  const checks = proof.observedChecks ?? proof.checks ?? {};
  const nativeMessages = native?.messages;
  const validHistory =
    history &&
    Array.isArray(nativeMessages) &&
    checks.exactIndividualPublications === true &&
    history.through === (nativeMessages.at(-1)?.sequence ?? null) &&
    (history.complete
      ? isDeepStrictEqual(history.messages, nativeMessages)
      : world.expected.question === "history-incomplete" &&
        history.messages.length > 0 &&
        history.messages.length < nativeMessages.length &&
        isDeepStrictEqual(history.messages, nativeMessages.slice(-history.messages.length)));
  const expectedMessage =
    world.expected.message === null ? null : nativeMessages?.[world.expected.message];
  const question = { status: world.expected.question, message: expectedMessage };
  const member =
    world.expected.member === null
      ? null
      : roster?.members?.find(
          (row) => row.participantId === native?.roster?.[world.expected.member]?.participantId
        );
  const participant = { status: world.expected.participant, member };
  const invocations = [];
  for (const detail of exercise.calls) {
    const record = detail.record,
      contract = workflow.nativeReturnContracts.find((c) => c.name === record?.definition?.name);
    if (
      !contract ||
      record.outcome !== "done" ||
      !["agent", "crisp-agent"].includes(record.executor?.kind)
    )
      continue;
    const inputs =
      contract.name === "interpretQuestion"
        ? { goal: world.goal, history }
        : { goal: world.goal, question, roster };
    const expected = contract.name === "interpretQuestion" ? question : participant;
    const dispositionCheck =
      contract.name === "interpretQuestion"
        ? "exactQuestionDisposition"
        : "exactParticipantDisposition";
    const nativeReturnPath =
      contract.name === "interpretQuestion"
        ? ["actualResult", "question"]
        : ["actualResult", "participant"];
    const independent =
      checks[dispositionCheck] === true &&
      isDeepStrictEqual(proof.actualResult?.[nativeReturnPath[1]], expected) &&
      (contract.name === "interpretQuestion"
        ? validHistory
        : validHistory &&
          checks.exactRetainedRoster === true &&
          roster?.complete === true &&
          Array.isArray(native?.roster) &&
          roster.members.length === native.roster.length &&
          native.roster.every((entry) =>
            roster.members.some(
              (m) =>
                m.participantId === entry.participantId &&
                m.handle === entry.handle &&
                m.displayName === entry.displayName &&
                m.kind === "agent" &&
                !!m.joinedAt &&
                (m.leftAt !== null) === entry.inactive
            )
          ) &&
          isDeepStrictEqual(
            roster.members
              .filter((m) => m.leftAt === null)
              .map((m) => m.participantId)
              .sort(),
            [...native.active].sort()
          ));
    // Any authority-bearing effects anywhere in this closed pure subtree disqualify it.
    const descendants = new Set([record.call_id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const call of exercise.calls)
        if (descendants.has(call.record.parent_call_id) && !descendants.has(call.callId)) {
          descendants.add(call.callId);
          changed = true;
        }
    }
    if (
      !independent ||
      expectedMessage === undefined ||
      (member === undefined && contract.name === "evaluateRoster") ||
      exercise.calls.some(
        (call) => descendants.has(call.callId) && (call.record.effects?.length ?? 0) > 0
      ) ||
      record.definition.id !== "nl:" + contract.source ||
      record.definition.source !== contract.source ||
      record.definition.returns !== contract.returns ||
      !isDeepStrictEqual(record.definition.instructions, contract.instructions) ||
      !isDeepStrictEqual(Object.keys(record.inputs).sort(), Object.keys(inputs).sort()) ||
      !Object.entries(inputs).every(([key, value]) => matches(record.inputs[key], value)) ||
      !matches(record.output, expected)
    )
      continue;
    invocations.push({
      call_id: record.call_id,
      checks: {
        exactNativeInputs: true,
        completeNativeReturn: true,
        pureSubtree: true,
        exactAuthoredContract: true,
      },
      certificate: {
        schema: "natlang.independent-native-return/1",
        contract:
          contract.name === "interpretQuestion"
            ? "gad-question-judgment/1"
            : "gad-participant-judgment/1",
        definition: record.definition,
        inputs: record.inputs,
        output: record.output,
        expectedInputs: inputs,
        expectedInputJson: Object.fromEntries(
          Object.entries(inputs).map(([key, value]) => [key, JSON.stringify(value)])
        ),
        expectedReturn: expected,
        expectedReturnJson: JSON.stringify(expected),
        instructionsJson: contract.instructionsJson,
        checker: contract.sourceFile,
        nativeBinding: {
          returnPath: nativeReturnPath,
          inputPaths:
            contract.name === "interpretQuestion"
              ? { goal: ["goal"], history: ["diagnostics", "history"] }
              : {
                  goal: ["goal"],
                  question: ["actualResult", "question"],
                  roster: ["diagnostics", "roster"],
                },
          checkNames:
            contract.name === "interpretQuestion"
              ? ["exactIndividualPublications", dispositionCheck]
              : ["exactIndividualPublications", "exactRetainedRoster", dispositionCheck],
        },
      },
    });
  }
  return invocations.length
    ? {
        world: { context_id: proof.contextId, case_id: proof.caseId },
        checks: { independentNativeInvocations: true },
        evidence: { workspace: { proof } },
        invocations,
      }
    : null;
}
