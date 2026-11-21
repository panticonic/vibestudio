import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const world={kind:"native-image",id:"source",goal:"Retry only the failed owned job and preserve its verified original."};
const assignment={scope:"owned",request:"existing",goal:world.goal,path:"asset.png",format:"png"};
const job={id:"job-1",requestId:"existing",attempt:1,status:"failed",digest:null,error:"fixture error"};
const basis={head:"event:current",destination:"empty",generationAllowed:true,retryAllowed:true,saveAllowed:true,referencesApproved:true,job};
const decision={action:"retry",reason:"retry"};
const outcome={job:{...job,attempt:2,status:"succeeded",digest:"asset",error:null},original:{digest:"asset",bytes:74,mime:"image/png"}};
const saved={status:"saved",head:"application:new",path:assignment.path,digest:"asset"};
const report={assignment,basis,decision,outcome,saved};
const native={providerBoundary:"owned-deterministic-sse",transport:[]};
const effect=(service,method,args,result)=>({service,method,args,result});
function key(input){const text=JSON.stringify(input);return {complete:true,hash:createHash("sha256").update(text).digest("hex"),bytes:Buffer.byteLength(text)};}
function node(callId,parent,name,input,output,effects=[]){return {callId,record:{parent_call_id:parent,definition:{name},outcome:"done",
  inputs:Object.fromEntries(Object.entries(input).map(([k,v])=>[k,key(v)])),output:key(output),
  effects:effects.map(({args,result,...r})=>({...r,args:key(args),result:key(result)}))}};}
function trace(model){
 const {assignment,basis,decision,outcome,saved}=model;
 const first=effect("illustrationEvidence","discover",[],assignment),second=effect("illustrationEvidence","read",[assignment.scope],basis);
 const generation=outcome&&effect("illustrationJobs","run",[assignment.scope,basis.head,decision.action],outcome);
 const file=saved&&effect("illustrationOriginal","save",[assignment.scope,basis.head,outcome.job.id,outcome.original.digest],saved);
 const calls=[node("root",null,"runUserGoal",{goal:world.goal},model),node("review","root","generateOwnedIllustration",{goal:world.goal},model),
  node("discover","review","discoverIllustration",{},assignment,[first]),node("basis","review","inspectIllustrationBasis",{assignment},basis),
  node("native-basis","basis","readCurrentImagePlan",{assignment},basis,[second]),node("choose","review","chooseIllustrationAction",{assignment,basis},decision),
  ...(outcome?[node("run","review","runIllustrationJob",{assignment,basis,decision},outcome),
  node("job","run","readNativeImageOutcome",{assignment,basis,decision},outcome,[generation])]:[]),
  ...(saved?[node("save","review","retainIllustrationOriginal",{assignment,basis,outcome},saved),
  node("write","save","writeVerifiedOriginal",{assignment,basis,outcome},saved,[file])]:[])];
 return {calls,effects:[first,second,...(generation?[generation]:[]),...(file?[file]:[])]};
}
function validate(model,calls,effects,provider=native){return openTemplateGoalEvidence({provenance:{contextId:"owned"},diagnostics:{openGoalVerification:{
 caseId:world.id,goal:world.goal,contextId:"owned",...model,native:provider,effects,checks:new Proxy({},{get:()=>true}),passed:true}}},
 {calls,rootCallIds:["root"],report:{status:"workspace-skill-reviewed",skill:"nativeImage",outcome:model}},null,{assignment:world});}

test("accepts an exact retry, scoped native original and semantic workspace write",()=>{
 const {calls,effects}=trace(report);
 assert.ok(validate(report,calls,effects).checks.verifiedNativeOriginal);
 assert.throws(()=>validate(report,calls,effects,{providerBoundary:"unknown",transport:[]}),/Expected exact durable image/u);
 const wrong=structuredClone(effects);wrong.at(-1).args[3]="unverified digest";
 assert.throws(()=>validate(report,calls,wrong),/Expected exact durable image/u);
 const altered=structuredClone(calls);altered.at(-1).record.parent_call_id="review";
 assert.throws(()=>validate(report,altered,effects),/Expected exact durable image/u);
});
test("a declined attempt has no invented generation or source write",()=>{
 const model={...report,decision:{action:"hold",reason:"no-retry"},outcome:null,saved:null};
 const {calls,effects}=trace(model);
 assert.ok(validate(model,calls,effects).checks.preservedAuthorizedWorkspace);
 calls.push(node("invented","review","runIllustrationJob",{assignment,basis,decision},outcome));
 assert.throws(()=>validate(model,calls,effects),/Expected exact durable image/u);
});
