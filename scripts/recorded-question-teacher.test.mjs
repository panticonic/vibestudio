import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const world={kind:"provenance-question",id:"source",goal:"Find the affected files and why this proposal was rejected."};
const assignment={id:"local",scope:"owned-project",goal:world.goal};
const phrase="cedar clock", ref="proposal-1";
const candidates=[{ref,rationale:"Try cedar clock in both rooms",tier:"stated",excerpt:"cedar clock"}];
const cohort={ref,complete:true,paths:[{path:"old.txt",count:1},{path:"retained.txt",count:1}]};
const withdrawn=[{path:"old.txt",ref:"counteraction-1",attempted:candidates[0].rationale,reason:"The second room lost the shared clock"}];
const evidence={cohort,withdrawn};
const selection={ref,blocker:null};
const answer={disposition:"caution",originalRationale:candidates[0].rationale,affected:["old.txt","retained.txt"],
  withdrawn:["old.txt"],reasons:[withdrawn[0].reason]};
const outcome={assignment,phrase,candidates,selection,evidence,answer};
function receipt(service,method,args,result){return {service,method,args,result};}
function value(input){const text=JSON.stringify(input);return {complete:true,bytes:Buffer.byteLength(text),hash:createHash("sha256").update(text).digest("hex")};}
function node(id,parent,name,input,output,effects=[]){
  return {callId:id,record:{parent_call_id:parent,definition:{name},outcome:"done",inputs:Object.fromEntries(Object.entries(input).map(([key,n])=>[key,value(n)])),
    output:value(output),effects:effects.map(({args,result,...effect})=>({...effect,args:value(args),result:value(result)}))}};
}
function proof(model){
  const {assignment,phrase,candidates,selection,evidence,answer}=model;
  const find=receipt("recordedQuestionDiscovery","discover",[],assignment), search=receipt("recordedQuestionDiscovery","search",[assignment.id,phrase],candidates);
  const cohort=evidence&&receipt("recordedQuestionGraph","cohort",[assignment.id,selection.ref],evidence.cohort);
  const blocked=evidence&&receipt("recordedQuestionGraph","rejections",[assignment.id,selection.ref,evidence.cohort],evidence.withdrawn);
  const calls=[node("root",null,"runUserGoal",{goal:world.goal},model),node("review","root","reviewRecordedQuestion",{goal:world.goal},model),
    node("discover","review","discoverRecordedQuestion",{},assignment,[find]),node("find","review","findRecordedProposal",{assignment,phrase},candidates),
    node("search","find","searchNativeRationale",{assignment,phrase},candidates,[search]),node("choose","review","selectRecordedProposal",{assignment,candidates},selection),
    ...(evidence?[node("collect","review","collectRecordedEvidence",{assignment,ref:selection.ref},evidence),
      node("cohort","collect","readWorkCohort",{assignment,ref:selection.ref},evidence.cohort,[cohort]),
      node("rejections","collect","readRejectionRecord",{assignment,ref:selection.ref,cohort:evidence.cohort},evidence.withdrawn,[blocked])]:[]),
    node("answer","review","answerRecordedQuestion",{assignment,candidates,selection,evidence},answer)];
  return {calls,effects:[find,search,...(evidence?[cohort,blocked]:[])]};
}
function run(outcome, calls, effects) {
  return openTemplateGoalEvidence({provenance:{contextId:"owned"},diagnostics:{openGoalVerification:{...outcome,caseId:world.id,goal:world.goal,contextId:"owned",effects,
    passed:true,checks:new Proxy({},{get:()=>true})}}},{rootCallIds:["root"],report:{status:"workspace-skill-reviewed",skill:"provenanceQuestion",outcome},calls},null,{assignment:world});
}

test("requires native scoped search, exact full cohort and actual held rationale",()=>{
  const {calls,effects}=proof(outcome);
  assert.ok(run(outcome,calls,effects).checks.verifiedNativeCounteractionRationale);
  const altered=structuredClone(calls);altered.find(x=>x.callId==="rejections").record.parent_call_id="review";
  assert.throws(()=>run(outcome,altered,effects),/Expected exact recorded question/u);
  const mismatched=structuredClone(effects);mismatched.at(-1).result[0].reason="Unrelated reason";
  assert.throws(()=>run(outcome,calls,mismatched),/Expected exact recorded question/u);
});
test("a missing local result creates no invented cohort or counteraction trace",()=>{
  const hold={...outcome,candidates:[],selection:{ref:null,blocker:"missing"},evidence:null,
    answer:{disposition:"missing",originalRationale:null,affected:[],withdrawn:[],reasons:[]}};
  const {calls,effects}=proof(hold);
  assert.ok(run(hold,calls,effects).checks.preservedLocalQuestionScope);
  calls.push(node("invented","review","collectRecordedEvidence",{assignment,ref},evidence));
  assert.throws(()=>run(hold,calls,effects),/Expected exact recorded question/u);
});
