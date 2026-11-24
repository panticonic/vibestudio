import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { openOutcomeGoalEvidence } from "./export-live-workflow-teacher.mjs";

const reference = value => {
  const json = JSON.stringify(value);
  return { complete: true, bytes: Buffer.byteLength(json),
    hash: createHash("sha256").update(json).digest("hex") };
};

function applicationFixture() {
  const goal = "Update the approved opening hours.";
  const entry = { program: "skills/documents/reconcileHours.nl", callable: "reconcileHours",
    arguments: { goal, approval: { opens: "09:30" } }, resultType: "RevisionReceipt" };
  const result = { revision: "observed-working-head" };
  const binding = { program: entry.program, callable: entry.callable, arguments: entry.arguments };
  const execution = { provenance: { contextId: "owned" }, diagnostics: {
    openGoalVerification: { passed: true, contextId: "owned", caseId: "hours", goal,
      entry: binding, actualResult: result, checks: { storedRequestedHours: true, preservedOtherCopy: true } },
  } };
  const exercise = { entry: binding, rootCallIds: ["actual"], calls: [{
    callId: "actual", record: { definition: { name: entry.callable },
      inputs: Object.fromEntries(Object.entries(entry.arguments).map(([name, value]) => [name, reference(value)])),
      output: reference(result) },
  }] };
  return { execution, exercise, workflow: { entry, assignment: { id: "hours", goal } } };
}

test("application admission binds named inputs and actual return without a generic report or child route", () => {
  const { execution, exercise, workflow } = applicationFixture();
  assert.deepEqual(openOutcomeGoalEvidence(execution, exercise, "hours", workflow).checks,
    execution.diagnostics.openGoalVerification.checks);
});

test("application admission rejects substituted inputs, results and failed independent outcomes", () => {
  for (const mutate of [
    fixture => { fixture.exercise.calls[0].record.inputs.approval = reference({ opens: "10:30" }); },
    fixture => { fixture.exercise.calls[0].record.output = reference({ revision: "unobserved" }); },
    fixture => { fixture.execution.diagnostics.openGoalVerification.checks.preservedOtherCopy = false; },
    fixture => { fixture.execution.diagnostics.openGoalVerification.entry.callable = "other"; },
  ]) {
    const fixture = applicationFixture();
    mutate(fixture);
    assert.throws(() => openOutcomeGoalEvidence(fixture.execution, fixture.exercise, "hours", fixture.workflow));
  }
});

test("independent goal proof survives an optional post-goal root failure without rewriting it",()=>{
 const fixture=applicationFixture(),root=fixture.exercise.calls[0].record;
 root.outcome="error";
 fixture.exercise.executionError={name:"PostGoalFailure",message:"Optional follow-up failed"};
 fixture.exercise.trainingEligible=false;
 const evidence=openOutcomeGoalEvidence(fixture.execution,fixture.exercise,"hours",fixture.workflow);
 assert.equal(evidence.checks.storedRequestedHours,true);
 assert.equal(root.outcome,"error");
 assert.equal(fixture.exercise.executionError.message,"Optional follow-up failed");
 fixture.execution.diagnostics.openGoalVerification.checks.storedRequestedHours=false;
 assert.throws(()=>openOutcomeGoalEvidence(fixture.execution,fixture.exercise,"hours",fixture.workflow));
});

test("workspace edit admission requires content review bound to actual retained bytes",()=>{
 const fixture=applicationFixture(),proof=fixture.execution.diagnostics.openGoalVerification;
 const original="Old hours.\n",replacement="Opening is 09:30.\n",concurrent="Protected desk note.\n",authority="Approved opening: 09:30.",sha=value=>createHash("sha256").update(value).digest("hex");
 fixture.workflow.assignment={...fixture.workflow.assignment,kind:"workspace-edit",destination:"notice.md",source:"decision.md",files:{"notice.md":original,"decision.md":authority},concurrentAddition:concurrent};
 fixture.workflow.requiresReview=true;
 proof.contents={"notice.md":replacement+concurrent,"decision.md":authority};
 proof.reads=[{path:"notice.md",version:sha(replacement+concurrent)}];
 proof.semanticReviewRequired=true;
 proof.semanticReviewInput={actual:{goal:proof.goal,documents:Object.entries(proof.contents).map(([path,text])=>({path,text})),documentEdits:[{path:"notice.md",originalText:original,originalSha256:sha(original),retainedText:replacement+concurrent,retainedSha256:sha(replacement+concurrent),editableOriginal:original,actualReplacement:replacement,protectedPrefix:"",protectedSuffix:concurrent,concurrentAddition:concurrent,authority:{path:"decision.md",text:authority,sha256:sha(authority)}}]},expected:{goal:proof.goal},rubric:"Verify the actual edited hours and reject unsupported facts."};
 assert.equal(openOutcomeGoalEvidence(fixture.execution,fixture.exercise,"hours",fixture.workflow).reviewInput,proof.semanticReviewInput);
 fixture.workflow.requiresReview=false;
 assert.throws(()=>openOutcomeGoalEvidence(fixture.execution,fixture.exercise,"hours",fixture.workflow),/declared before/);
 fixture.workflow.requiresReview=true;
 proof.semanticReviewInput.actual.documentEdits[0].retainedText="Unobserved replacement";
 assert.throws(()=>openOutcomeGoalEvidence(fixture.execution,fixture.exercise,"hours",fixture.workflow));
});


test("application source claims require an independent review bound to the returned answer", () => {
  const goal = "Check the approved opening hours.";
  const url = "https://example.org/hours";
  const text = "The approved opening time is 09:30 on weekdays.";
  const result = { status: "answered", question: goal, statements: [{ text: "Weekdays open at09:30.", cites: [{url,quote:text}] }] };
  const entry = {program:"skills/research/checkHours.nl",callable:"checkHours",arguments:{goal}};
  const input = {kind:"public-claims",actual:{goal,answer:JSON.stringify(result),sourceScope:null,citations:[{url,quote:text}],sources:[{url,title:"Hours",text,sha256:createHash("sha256").update(text).digest("hex")}]}};
  const proof = {passed:true,contextId:"owned",caseId:"hours",goal,entry,actualResult:result,checks:{exactReadback:true},semanticReviewRequired:true,semanticReviewInput:input,
    fetched:[{url,digest:input.actual.sources[0].sha256,page:{url,title:"Hours"}}]};
  const execution={provenance:{contextId:"owned"},diagnostics:{openGoalVerification:proof}};
  const exercise={entry,rootCallIds:["root"],calls:[{callId:"root",record:{definition:{name:entry.callable},inputs:{goal:reference(goal)},output:reference(result)}}]};
  const workflow={entry,requiresReview:true,assignment:{id:"hours",kind:"research",goal}};
  assert.equal(openOutcomeGoalEvidence(execution,exercise,"hours",workflow).reviewInput,input);
  workflow.requiresReview=false;
  assert.throws(()=>openOutcomeGoalEvidence(execution,exercise,"hours",workflow),/declared before teacher execution/);
  workflow.requiresReview=true;
  input.actual.answer=JSON.stringify({...result,status:"insufficient"});
  assert.throws(()=>openOutcomeGoalEvidence(execution,exercise,"hours",workflow),/actual application result/);
});
