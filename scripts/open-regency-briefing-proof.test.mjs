import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const hash = text => createHash("sha256").update(text).digest("hex");
function ref(value) {
  const text = JSON.stringify(value);
  return { complete:true,hash:hash(text),bytes:Buffer.byteLength(text) };
}
function example(action) {
  const world={id:"regency-proof",kind:"regency-briefing",goal:"Assess the Harbor reserve in Regency.",action};
  const index={realm:"realm"};
  const history={id:"saved",month:3};
  const opening={accounts:history,revision:"rev-before"};
  const current={accounts:history,revision:"rev-current"};
  const forecast={realm:index.realm,basis:current.revision,months:1,accounts:{id:"forecast",month:4}};
  const forecasts=[forecast];
  const claim={kind:"settlement",source:1,check:{kind:"region-grain-at-least",region:"harbor",amount:3}};
  const request={kind:"settlement",check:claim.check,current:forecast.accounts};
  const finding={decision:"supported",finding:"regional-reserves",evidenceIds:[forecast.accounts.id]};
  const result={claim,review:finding};
  const plan={horizons:[1],claims:[claim],localNote:action==="advance"||action==="stage",advance:action==="advance"?1:null,treasuryFloor:null};
  const decision={action,explanation:"The verified Harbor reserve supports the request."};
  const advance=action==="advance"?{id:"committed-turn",realm:index.realm,basis:current.revision,months:1,committed:{
    revision:"rev-next",accounts:{id:"saved-next",month:4},
  }}:null;
  const artifact=plan.localNote?JSON.stringify({scope:"private-local",realm:index.realm,current,advance}):null;
  const note=artifact?{path:"/.tmp/regency/handoff.json",digest:hash(artifact),realm:index.realm,
    revision:advance?.committed.revision??current.revision}:null;
  const proof={contextId:"ctx",passed:true,caseId:world.id,goal:world.goal,index,frontiers:[opening,current],plan,forecasts,
    witnesses:[{claim,request,result}],decision,advance,note,artifact,checks:Object.fromEntries([
      "exactRegencyAssignment","independentlyReadRegencyMemo","exactSavedRegencyFrontiers","exactRegencyForecasts","exactInstalledRegencyFindings",
      "groundedRegencyAction","verifiedRegencyAdvance","verifiedPrivateRegencyNote","preservedRegencyWorkspace","rejectedRegencyRetarget",
    ].map(key=>[key,true]))};
  const outcome={plan,opening,current,forecasts,findings:[result],decision,advance,note};
  const report={status:"workspace-skill-reviewed",skill:"regencyBriefing",outcome};
  const calls=[];
  const make=(name,parent,fields={})=>{
    const record={call_id:String(calls.length),parent_call_id:parent?.call_id,definition:{name},outcome:"done",...fields};
    calls.push({callId:record.call_id,record});
    return record;
  };
  const root=make("runUserGoal",null,{inputs:{goal:ref(world.goal)}});
  const skill=make("workOnRegencyBriefing",root,{inputs:{goal:ref(world.goal)}});
  const effect=(name,service,method,args,result)=>{
    const row={service,method,args:ref(args),result:ref(result)};
    make(name,skill,{effects:[row]});
    return row;
  };
  effect("findRegencyRealm","regencyAssignment","list",[],index);
  const reads=proof.frontiers.map(row=>effect("readRegencyAccounts","regencySaved","read",[index.realm],row));
  make("planRegencyReview",skill,{inputs:{goal:ref(world.goal),index:ref(index),opening:ref(opening),current:ref(current)},output:ref(plan)});
  const projection=effect("previewRegencySettlement","regencyForecast","preview",[index.realm,current.revision,1],forecast);
  const classified=make("qualifyRegencyClaim",skill,{inputs:{claim:ref(claim),opening:ref(opening),current:ref(current),forecasts:ref(forecasts)},output:ref(result)});
  const installed=make("reviewRealm",classified,{inputs:{review:ref(request)},output:ref(finding)});
  const subreview=make("inspectSettlement",installed);
  const decided=make("decideRegencyAction",skill,{inputs:{goal:ref(world.goal),plan:ref(plan),current:ref(current),index:ref(index),forecasts:ref(forecasts),
    findings:ref([result])},output:ref(decision)});
  const receipt=advance?effect("advanceOwnedRegency","regencyAdvance","commit",[index.realm,current.revision,1],advance):null;
  const stage=note?effect("stageRegencyNote","regencyNote","stage",[{...outcome,note:null}],note):null;
  return {reads,projection,installed,subreview,decided,receipt,stage,proof,validate(){
    skill.output=ref(outcome);
    return openTemplateGoalEvidence({diagnostics:{openGoalVerification:proof},provenance:{contextId:"ctx"}},
      {report,calls,rootCallIds:[root.call_id]},world.id,{assignment:world});
  }};
}

test("Regency export binds native previews, installed review receipts and the separately committed calendar",()=>{
  for(const action of ["advance","stage","report","hold"]) assert.doesNotThrow(example(action).validate);
  for(const fault of [
    sample=>{sample.reads[1].result=sample.reads[0].result;},
    sample=>{sample.projection.args=ref(["realm","stale",1]);},
    sample=>{sample.installed.inputs.review.complete=false;},
    sample=>{sample.subreview.parent_call_id="other";},
    sample=>{sample.decided.inputs.forecasts=ref([]);},
    sample=>{sample.receipt.result.hash=hash("predicted calendar");},
    sample=>{sample.stage.result.hash=hash("different note");},
    sample=>{sample.proof.artifact+=" ";},
  ]) {
    const sample=example("advance");
    fault(sample);
    assert.throws(sample.validate,/Expected exact Regency accounts/u);
  }
});
