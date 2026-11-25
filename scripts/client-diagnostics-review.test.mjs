import assert from "node:assert/strict";
import {test} from "node:test";
import {createHash} from "node:crypto";
import {openOutcomeGoalEvidence} from "./export-live-workflow-teacher.mjs";
import {clientDiagnosticsReviewInput} from "./lib/source-claim-admission.mjs";

function fixture(){
 const world={kind:"clientDiagnostics",goal:"Compare Visitors first, Staff second. Where do they report?"};
 const value={channel:null,decision:{outcome:"healthy",answer:"Visitors: Sand Door. Staff: Pump Room.",evidenceIds:["incidental"]},handoff:null};
 const observations={catalog:[{id:"visitor"},{id:"staff"}],views:[{surface:{id:"visitor"},text:"Wait by Sand Door."},{surface:{id:"staff"},text:"Report to Pump Room."}],
  trace:[{kind:"observe",surface:"visitor"},{kind:"observe",surface:"staff"}],journal:[{method:"observe",args:["visitor"]},{method:"observe",args:["staff"]}],
  final:{visitor:{text:"Wait by Sand Door."},staff:{text:"Report to Pump Room."}},channel:{durable:[]},handoff:null};
 const input={actual:{goal:world.goal,observations,requestedAnswer:value.decision.answer},expected:{goal:world.goal,requestedAnswerRequired:true},rubric:"Judge actual requested facts and order, ignoring incidental report labels."};
 const proof={semanticReviewRequired:true,requestedAnswerRequired:true,clientObservations:observations,catalog:observations.catalog,trace:observations.trace,journal:observations.journal,final:observations.final,durable:[],handoff:null,semanticReviewInput:input};
 return {world,value,proof,input};
}

test("correct client answer is reviewed independently of an unrequested classification and receipt IDs",()=>{
 const f=fixture();assert.equal(clientDiagnosticsReviewInput(f.proof,f.world,f.value),f.input);
 f.value.decision.outcome="local-disagreement";f.value.decision.evidenceIds=["different-diagnostic"];
 assert.equal(clientDiagnosticsReviewInput(f.proof,f.world,f.value),f.input);
 assert.deepEqual(f.input.expected,{goal:f.world.goal,requestedAnswerRequired:true});
});

test("substituted answers, native observations, handoffs and hidden gold requirements are refused",()=>{
 for(const change of [f=>{f.value.decision.answer="Invented station";},f=>{f.input.actual.requestedAnswer="Invented station";},
  f=>{f.input.actual.observations={...f.proof.clientObservations,views:[]};},f=>{f.proof.final={invented:true};},
  f=>{f.proof.handoff={audience:"crew",decision:{answer:"Uncaptured note"}};},f=>{f.input.expected.outcome="local-disagreement";},
  f=>{f.proof.semanticReviewRequired=false;},f=>{f.value.decision.answer=" ";}]){
  const f=fixture();change(f);assert.throws(()=>clientDiagnosticsReviewInput(f.proof,f.world,f.value));
 }
});

test("retained handoff review binds the actual audience and note text without requiring its classification enum",()=>{
 const f=fixture();f.world.handoff="crew";f.proof.requestedAnswerRequired=false;f.input.expected.requestedAnswerRequired=false;f.input.actual.requestedAnswer=null;f.proof.handoff={audience:"crew",decision:{outcome:"healthy",answer:"Use Pump Room"},receipt:"native"};
 f.proof.clientObservations.handoff={audience:"crew",answer:"Use Pump Room"};
 assert.equal(clientDiagnosticsReviewInput(f.proof,f.world,null),f.input);
 f.proof.clientObservations.handoff.answer="Unstored note";
 assert.throws(()=>clientDiagnosticsReviewInput(f.proof,f.world,f.value));
});


test("whole application admission requires declared review and binds the actual requested answer",()=>{
 const f=fixture(),reference=value=>{const raw=JSON.stringify(value);return {complete:true,bytes:Buffer.byteLength(raw),hash:createHash("sha256").update(raw).digest("hex")};};
 const entry={program:"skills/gad-context/natlang/workOnClientDiagnostics.nl",callable:"workOnClientDiagnostics",resultType:"ClientDiagnosticResult",arguments:{goal:f.world.goal}};
 const binding={program:entry.program,callable:entry.callable,arguments:entry.arguments,resultType:entry.resultType};
 const proof={...f.proof,passed:true,checks:{joinedNative:true,resolvedClientGoal:true},contextId:"owned",caseId:"client-case",goal:f.world.goal,entry:binding,actualResult:f.value};
 const execution={provenance:{contextId:"owned"},diagnostics:{openGoalVerification:proof}};
 const exercise={entry:binding,rootCallIds:["root"],calls:[{callId:"root",record:{definition:{name:entry.callable},inputs:{goal:reference(f.world.goal)},output:reference(f.value)}}]};
 const workflow={entry,assignment:{...f.world,id:"client-case"},requiresReview:true};
 assert.equal(openOutcomeGoalEvidence(execution,exercise,"client-case",workflow).reviewInput,f.input);
 workflow.requiresReview=false;
 assert.throws(()=>openOutcomeGoalEvidence(execution,exercise,"client-case",workflow),/declared before/);
 workflow.requiresReview=true;exercise.calls[0].record.output=reference({...f.value,decision:{...f.value.decision,answer:"Substituted"}});
 assert.throws(()=>openOutcomeGoalEvidence(execution,exercise,"client-case",workflow));
});
