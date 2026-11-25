import { URL as NodeURL } from "node:url";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { openOutcomeGoalEvidence, reassessObservedReturnPresence, applicationEntryBinding } from "./export-live-workflow-teacher.mjs";
import {editorialReviewInput,coordinatedRevisionReviewInput,outcomeWorkspaceReviewInput,sourceContentReviewInput}from "./lib/source-claim-admission.mjs";

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
  const binding = { program: entry.program, callable: entry.callable, arguments: entry.arguments, resultType: entry.resultType };
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

test("editorial content review binds retained copy, current mission and exact approved citations",()=>{
 const goal="Correct the opening hours from the approved PDF.",original={path:"candidate.md",version:"before",text:"Old hours"},stored={path:"candidate.md",version:"current",text:"Approved hours"},mission={id:"owned",description:"Approved attachment: current.pdf."};
 const pdf={digest:"pdf-sha",citations:[{page:1,line:0,quote:"Hours: 09:00"}]};
 const proof={semanticReviewRequired:true,stored,snapshots:[{candidate:original,mission}],plan:{operation:"revise"},attempts:[{result:{status:"written"}}],sources:[{request:{document:"current.pdf"},pdf}],artifact:null};
 proof.semanticReviewInput={actual:{goal,retainedDocument:stored,originalDocument:original,currentObservation:original,currentMission:mission,approvedTextSources:[{document:"current.pdf",...pdf}],retainedHandoff:null},expected:{goal,fields:["Hours"],literalApprovedWording:false,operation:"revise",returnedDecisionRequired:false,retainedHandoffRequired:false},rubric:"Judge actual field facts, not example wording."};
 const world={kind:"editorial-packet",goal,fields:[{label:"Hours"}]};
 assert.equal(editorialReviewInput(proof,world),proof.semanticReviewInput);
 proof.semanticReviewInput.actual.retainedDocument={...stored,text:"Unobserved text"};
 assert.throws(()=>editorialReviewInput(proof,world),/actual stored copy/);
});

test("coordinated review binds exact atomic readback and signed source observations",()=>{
 const goal="Correct both door notes.",files=[{path:"a.md",text:"North door",version:"a"},{path:"approved.md",text:"Use north door",version:"source"}];
 const proof={semanticReviewRequired:true,attempts:[{receipt:{status:"applied"}}],snapshots:[{scope:{files}}],documents:files,nativeReadback:{files},reviewScope:files,report:{status:"updated"}};
 proof.semanticReviewInput={actual:{goal,documents:files,originalDocuments:files,currentObservedDocuments:files,returnedDecision:null},expected:{goal,editablePaths:["a.md"],returnedDecisionRequired:false},rubric:"Judge actual content against signed authority."};
 const world={kind:"coordinated-revision",goal,changes:[{path:"a.md"}]};
 assert.equal(coordinatedRevisionReviewInput(proof,world),proof.semanticReviewInput);
 proof.semanticReviewInput.actual.documents=[{...files[0],text:"Invented retained value"}];
 assert.throws(()=>coordinatedRevisionReviewInput(proof,world),/exact native batch/);
});

test("workspace outcome review binds requested answers or actual scoped edits",()=>{
 const goal="What time do the doors open?",files={"approved.md":"Doors open at 10:45."},answer={answer:"Doors open at 10:45.",citations:[]};
 const proof={semanticReviewRequired:true,contents:files,actualResult:answer};
 const world={kind:"outcome-workspace",goal,target:null,authority:"approved.md",files};
 proof.semanticReviewInput={actual:{goal,documents:files,originalDocuments:files,actualAnswer:answer},expected:{goal,target:null,authority:world.authority,returnedAnswerRequired:true},rubric:"Judge actual answer against the approved original."};
 assert.equal(outcomeWorkspaceReviewInput(proof,world),proof.semanticReviewInput);
 proof.semanticReviewInput.actual.actualAnswer={answer:"Opening is unobserved"};
 assert.throws(()=>outcomeWorkspaceReviewInput(proof,world),/actual retained content/);
});

test("source content review binds native retained MDX and verified PDF handoff without altering observations",()=>{
 const goal="Correct the active vault instruction.",path="notice.mdx",evidence={originalDocuments:{[path]:"Old source"},observedDocuments:[{path,revision:"observed"}],retainedDocuments:{[path]:"Corrected source"},committedDocuments:{[path]:"Old source"},currentDocument:{path,revision:"current",source:"Corrected source",sourceHash:"native-hash",visible:"Corrected view",preview:[],binding:{panelId:"owned"}},writes:[{path,toSourceHash:"native-hash"}]};
 const proof={semanticReviewRequired:true,sourceContentEvidence:evidence,semanticReviewInput:{actual:{goal,...evidence},expected:{goal,editablePaths:[path]},rubric:"Judge actual source meaning and useful rendering against the request."}};
 assert.equal(sourceContentReviewInput(proof,{kind:"spectrolite",goal,writablePath:path}),proof.semanticReviewInput);
 const original=structuredClone(proof),handoff={status:"bound",source:{document:"approved.pdf",digest:"pdf-digest",citations:[{page:2,line:0,quote:"Approved value"}]}};
 const combined=sourceContentReviewInput({proof:{vault:proof,handoff}},{kind:"pdfVault",goal,vault:{writablePath:path}});
 assert.deepEqual(combined.actual.pdfHandoff,handoff);assert.deepEqual(proof,original);
 proof.semanticReviewInput.actual={...proof.semanticReviewInput.actual,retainedDocuments:{[path]:"Unobserved source"}};
 assert.throws(()=>sourceContentReviewInput(proof,{kind:"spectrolite",goal,writablePath:path}),/actual native documents/);
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


test("optional application receipts do not gate verified effects after a root exception",()=>{
 const make=()=>{
  const fixture=applicationFixture(),root=fixture.exercise.calls[0].record;
  root.outcome="error";root.error={name:"PostGoalFailure",message:"Follow-up failed after saved edit"};
  delete root.output;delete fixture.execution.diagnostics.openGoalVerification.actualResult;
  fixture.exercise.executionError=root.error;
  return fixture;
 };
 for(const requirement of ["dimensions","contract","both"]){
  const fixture=make(),proof=fixture.execution.diagnostics.openGoalVerification;
  if(requirement!=="contract")proof.outcomeDimensions={returnedValue:{required:false}};
  if(requirement!=="dimensions")proof.outcomeContract={returnedValue:{required:false}};
  const evidence=openOutcomeGoalEvidence(fixture.execution,fixture.exercise,"hours",fixture.workflow);
  assert.equal(evidence.checks.storedRequestedHours,true);
  assert.equal(Object.hasOwn(evidence.evidence.workspace,"applicationReturn"),false);
  assert.equal(fixture.exercise.calls[0].record.outcome,"error");
 }
 for(const mutate of [
  fixture=>{},
  fixture=>{fixture.execution.diagnostics.openGoalVerification.outcomeDimensions={returnedValue:{required:true}};},
  fixture=>{const p=fixture.execution.diagnostics.openGoalVerification;p.outcomeDimensions={returnedValue:{required:false}};p.outcomeContract={returnedValue:{required:true}};},
  fixture=>{const p=fixture.execution.diagnostics.openGoalVerification;p.outcomeDimensions={returnedValue:{required:false}};p.actualResult={revision:"invented"};},
  fixture=>{const p=fixture.execution.diagnostics.openGoalVerification;p.outcomeDimensions={returnedValue:{required:false}};fixture.exercise.applicationResult={revision:"invented"};},
  fixture=>{const p=fixture.execution.diagnostics.openGoalVerification;p.outcomeDimensions={returnedValue:{required:false}};fixture.exercise.calls[0].record.inputs.goal=reference("Different goal");},
 ]){const fixture=make();mutate(fixture);assert.throws(()=>openOutcomeGoalEvidence(fixture.execution,fixture.exercise,"hours",fixture.workflow));}
 const provided=applicationFixture(),proof=provided.execution.diagnostics.openGoalVerification;
 proof.outcomeDimensions={returnedValue:{required:false}};
 provided.exercise.applicationResult={revision:"invented"};
 assert.throws(()=>openOutcomeGoalEvidence(provided.execution,provided.exercise,"hours",provided.workflow));
 delete provided.exercise.applicationResult;
 provided.exercise.calls[0].record.output=reference({revision:"unobserved"});
 assert.throws(()=>openOutcomeGoalEvidence(provided.execution,provided.exercise,"hours",provided.workflow));
});

// This is a projection of the original failed export, not a hand-authored consumer fixture.
test("actual native-pass capture retains its declared nonvoid entry type", async()=>{
 const {readFile}=await import("node:fs/promises");
 const captured=JSON.parse(await readFile(new NodeURL("./fixtures/observed-entry-binding.json",import.meta.url),"utf8"));
 assert.equal(captured.originalCaptureSha256,"d4ebe34d092777633c2c1da8999b59c40bd3cf8fb8ac67c193de24c21280acbd");
 assert.equal(captured.exercise.entry.resultType,"OpenProblemOutcome");
 assert.deepEqual(applicationEntryBinding(captured.workflow.entry),captured.execution.diagnostics.openGoalVerification.entry);
 assert.deepEqual(applicationEntryBinding(captured.workflow.entry),captured.exercise.entry);
 assert.equal(openOutcomeGoalEvidence(captured.execution,captured.exercise,"actual",captured.workflow).checks,captured.execution.diagnostics.openGoalVerification.checks);
 for(const target of ["proof","capture"]){
  const changed=structuredClone(captured);
  (target==="proof"?changed.execution.diagnostics.openGoalVerification.entry:changed.exercise.entry).resultType="UnobservedReturn";
  assert.throws(()=>openOutcomeGoalEvidence(changed.execution,changed.exercise,"actual",changed.workflow));
 }
});

test("legacy absent-return reassessment preserves all checks and refuses genuine null or requested results",()=>{
 const original=()=>{const f=applicationFixture(),p=f.execution.diagnostics.openGoalVerification;
 p.actualResult=null;p.outcomeDimensions={returnedValue:{required:false}};p.outcomeContract={returnedValue:{required:false}};
 f.exercise.report=null;f.exercise.calls[0].record.outcome="error";delete f.exercise.calls[0].record.output;
 f.execution.diagnostics.natlangTeacher=f.exercise;return f;};
 const f=original(),before=structuredClone(f.execution);
 const derived=reassessObservedReturnPresence(f.execution);
 assert.equal(Object.hasOwn(f.execution.diagnostics.openGoalVerification,"actualResult"),false);
 assert.equal(derived.originalProof.actualResult,null);assert.equal(derived.originalProofSha256.length,64);
 assert.deepEqual(f.execution.diagnostics.openGoalVerification.checks,before.diagnostics.openGoalVerification.checks);
 assert.deepEqual(f.exercise,before.diagnostics.natlangTeacher);
 assert.equal(openOutcomeGoalEvidence(f.execution,f.exercise,"hours",f.workflow).checks.storedRequestedHours,true);
 for(const change of [f=>{f.exercise.applicationResult=null;},f=>{f.exercise.applicationResultKind="void";},
 f=>{f.execution.diagnostics.openGoalVerification.outcomeDimensions.returnedValue.required=true;},
 f=>{f.execution.diagnostics.openGoalVerification.outcomeContract.returnedValue.required=true;},
 f=>{f.execution.diagnostics.openGoalVerification.checks.storedRequestedHours=false;},
 f=>{f.exercise.calls[0].record.output=reference(null);},f=>{f.exercise.calls[0].record.outcome="done";}]){
  const f=original();change(f);assert.throws(()=>reassessObservedReturnPresence(f.execution));
 }
});
