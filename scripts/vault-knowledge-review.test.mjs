import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {vaultKnowledgeReviewInput,sourceContentReviewInput} from "./lib/source-claim-admission.mjs";
import {openOutcomeGoalEvidence} from "./export-live-workflow-teacher.mjs";

function query(){
  const world={kind:"vaultWork",requestedReturnRequired:true,goal:"Which source authorizes the current opening time?",expected:{steps:[]}};
  const value={answer:"The signed rota provides the staffing commitment.",path:"incidental",reads:[],outcome:"diagnostic"};
  const proof={semanticReviewRequired:true,requestedAnswerRequired:true,actualResult:value,actorObservations:{
    views:[{path:"rota.mdx",revision:"r1",source:"Signed rota: staffing starts at 17:40."}],receipts:[]},
    events:[{kind:"inspect",path:"rota.mdx"}],journal:[{method:"inspect"}],
    final:{path:"index.mdx",revision:"r2"},handoff:null};
  const input={actual:{goal:world.goal,observations:{...proof.actorObservations,events:proof.events,
    journal:proof.journal,final:proof.final,handoff:proof.handoff},requestedAnswer:value.answer},
    expected:{goal:world.goal,requestedAnswerRequired:true},rubric:"Judge the requested answer against actual native observations."};
  proof.semanticReviewInput=input;
  return {world,value,proof,input};
}

test("vault queries review the captured answer and observations without report or reference-route gates",()=>{
  const {world,value,proof,input}=query();
  assert.equal(vaultKnowledgeReviewInput(proof,world,value),input);
  value.path="a different diagnostic path";value.outcome="another diagnostic enum";
  assert.equal(vaultKnowledgeReviewInput(proof,world,value),input);
});

test("vault query review cannot substitute another answer, goal or expected gold data",()=>{
  for(const change of [s=>s.input.actual.requestedAnswer="An uncaptured answer",
    s=>s.input.actual.goal="Another goal",s=>s.input.expected.answer="A hidden reference answer"]){
    const s=query();change(s);assert.throws(()=>vaultKnowledgeReviewInput(s.proof,s.world,s.value),/captured requested answer/);
  }
});

test("vault query review binds every native observation and chronology component",()=>{
  for(const field of ["views","receipts","events","journal","final","handoff"]){
    const s=query();s.input.actual=structuredClone(s.input.actual);
    s.input.actual.observations[field]=field==="final"?{path:"another.mdx"}:field==="handoff"?{receipt:"invented"}:[{forged:true}];
    assert.throws(()=>vaultKnowledgeReviewInput(s.proof,s.world,s.value),/actor-visible native observations/);
  }
});

test("empty answers and undeclared semantic review cannot enter query admission",()=>{
  const s=query();s.proof.semanticReviewRequired=false;
  assert.throws(()=>vaultKnowledgeReviewInput(s.proof,s.world,s.value),/actor-visible native observations/);
  s.proof.semanticReviewRequired=true;s.value.answer=" ";s.input.actual.requestedAnswer=" ";
  assert.throws(()=>vaultKnowledgeReviewInput(s.proof,s.world,s.value),/captured requested answer/);
});

test("vault query admission binds review to the original captured root return",()=>{
  const {world,value,proof,input}=query();
  world.id="opening-time";
  Object.assign(proof,{passed:true,caseId:world.id,goal:world.goal,contextId:"ctx",checks:{nativeSourceRead:true}});
  const blob=value=>{
    const text=JSON.stringify(value);
    return {complete:true,bytes:Buffer.byteLength(text),hash:createHash("sha256").update(text).digest("hex")};
  };
  const root={callId:"root",record:{inputs:{goal:blob(world.goal)},output:blob(value)}};
  const execution={provenance:{contextId:"ctx"},diagnostics:{openGoalVerification:proof}};
  const exercise={rootCallIds:["root"],calls:[root],applicationResult:value};
  const workflow={assignment:world,requiresReview:true};
  assert.equal(openOutcomeGoalEvidence(execution,exercise,world.id,workflow).reviewInput,input);
  root.record.output=blob({...value,answer:"A different captured answer"});
  assert.throws(()=>openOutcomeGoalEvidence(execution,exercise,world.id,workflow),/original user goal/);
});

test("vault source review also binds actual navigation and operation order",()=>{
  const world={kind:"vaultWork",requestedReturnRequired:false,goal:"Correct the card after reading the rota.",expected:{steps:[{kind:"write",path:"card.mdx"}]}};
  const proof={semanticReviewRequired:true,requestedAnswerRequired:false,events:[{kind:"write",path:"card.mdx"}],journal:[{method:"revise"}],hops:[],handoff:null};
  const evidence={events:proof.events,journal:proof.journal,navigationHops:proof.hops,handoff:proof.handoff,requestedAnswer:null};
  proof.sourceContentEvidence=evidence;
  proof.semanticReviewInput={actual:{goal:world.goal,...evidence},expected:{goal:world.goal,editablePaths:["card.mdx"],requestedAnswerRequired:false},rubric:"Judge actual retained content and requested operations."};
  assert.equal(sourceContentReviewInput(proof,world),proof.semanticReviewInput);
  proof.semanticReviewInput.actual.journal=[];proof.sourceContentEvidence.journal=[];
  assert.throws(()=>sourceContentReviewInput(proof,world),/actual actor navigation/);
});

test("artifact-only vault handoffs retain meaning review without inventing a returned answer",()=>{
 const s=query();s.world.requestedReturnRequired=false;s.proof.requestedAnswerRequired=false;s.input.expected.requestedAnswerRequired=false;s.input.actual.requestedAnswer=null;
 assert.equal(vaultKnowledgeReviewInput(s.proof,s.world,undefined),s.input);
 assert.equal(vaultKnowledgeReviewInput(s.proof,s.world,{answer:"An incidental explanation"}),s.input);
 s.world.requestedReturnRequired=true;assert.throws(()=>vaultKnowledgeReviewInput(s.proof,s.world,undefined),/captured requested answer/);
});
test("mixed edit-and-question source review binds the actual requested answer as well as native source",()=>{
 const world={kind:"vaultWork",goal:"Can the approved wording go on the pocket card? Make only the permitted correction.",requestedReturnRequired:true,expected:{steps:[{kind:"write",path:"card.mdx"}]}};
 const value={answer:"The consent allows this exact pocket-card correction."};
 const proof={semanticReviewRequired:true,requestedAnswerRequired:true,events:[],journal:[],hops:[],handoff:null};
 const evidence={events:proof.events,journal:proof.journal,navigationHops:proof.hops,handoff:null,requestedAnswer:value.answer};
 proof.sourceContentEvidence=evidence;proof.semanticReviewInput={actual:{goal:world.goal,...evidence},expected:{goal:world.goal,editablePaths:["card.mdx"],requestedAnswerRequired:true},rubric:"Judge actual content and the requested answer."};
 assert.equal(sourceContentReviewInput(proof,world,value),proof.semanticReviewInput);
 assert.throws(()=>sourceContentReviewInput(proof,world,undefined),/captured requested answer obligation/);
 const forged=structuredClone(proof);forged.sourceContentEvidence.requestedAnswer="A different answer";forged.semanticReviewInput.actual.requestedAnswer="A different answer";
 assert.throws(()=>sourceContentReviewInput(forged,world,value),/captured requested answer obligation/);
 proof.requestedAnswerRequired=false;assert.throws(()=>sourceContentReviewInput(proof,world,value),/captured requested answer obligation/);
});

test("mixed vault edit admission compares reviewed answer to the original captured application result",()=>{
 const world={id:"mixed-native-answer",kind:"vaultWork",goal:"Can the approved wording go on the pocket card? Make only the permitted correction.",requestedReturnRequired:true,expected:{steps:[{kind:"write",path:"card.mdx"}]}};
 const value={answer:"Yes, this exact pocket-card correction is permitted."};
 const proof={caseId:world.id,goal:world.goal,contextId:"ctx",passed:true,checks:{nativeRetained:true},actualResult:value,semanticReviewRequired:true,requestedAnswerRequired:true,events:[],journal:[],hops:[],handoff:null};
 const evidence={events:proof.events,journal:proof.journal,navigationHops:proof.hops,handoff:null,requestedAnswer:value.answer};
 proof.sourceContentEvidence=evidence;proof.semanticReviewInput={actual:{goal:world.goal,...evidence},expected:{goal:world.goal,editablePaths:["card.mdx"],requestedAnswerRequired:true},rubric:"Judge the actual requested answer and retained source."};
 const blob=value=>{const text=JSON.stringify(value);return {complete:true,bytes:Buffer.byteLength(text),hash:createHash("sha256").update(text).digest("hex")};};
 const root={callId:"root",record:{inputs:{goal:blob(world.goal)},output:blob(value)}};
 const execution={provenance:{contextId:"ctx"},diagnostics:{openGoalVerification:proof}};
 const exercise={rootCallIds:["root"],calls:[root],applicationResult:value};
 const workflow={assignment:world,requiresReview:true};
 assert.equal(openOutcomeGoalEvidence(execution,exercise,world.id,workflow).reviewInput,proof.semanticReviewInput);
 proof.sourceContentEvidence.requestedAnswer="A swapped claim";proof.semanticReviewInput.actual.requestedAnswer="A swapped claim";
 assert.throws(()=>openOutcomeGoalEvidence(execution,exercise,world.id,workflow),/captured requested answer obligation/);
 proof.sourceContentEvidence.requestedAnswer=value.answer;proof.semanticReviewInput.actual.requestedAnswer=value.answer;
 root.record.output=blob({answer:"Different actual captured return"});
 assert.throws(()=>openOutcomeGoalEvidence(execution,exercise,world.id,workflow),/original user goal/);
 root.record.output=blob(value);delete proof.actualResult;
 assert.throws(()=>openOutcomeGoalEvidence(execution,exercise,world.id,workflow),/original user goal|captured requested answer obligation/);
});
