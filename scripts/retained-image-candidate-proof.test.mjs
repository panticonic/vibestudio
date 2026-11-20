import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const hash = text => createHash("sha256").update(text).digest("hex");
function ref(value) {
  const bytes = JSON.stringify(value);
  return { complete: true, bytes: Buffer.byteLength(bytes), hash: hash(bytes) };
}
function fixture(action) {
  const world = {id:"retained-image",kind:"image-candidate",goal:"Verify the original privately.",expected:{action}};
  const index = {channelId:"lane",owner:"ctx",briefs:[{id:"brief"}]};
  const snapshots = [{channelId:"lane",through:1,rows:[]},{channelId:"lane",through:2,rows:[]}];
  const plan = {briefId:"brief",mode:"current",acceptedFormats:["png"],historicalLabel:null,localHandoff:action==="stage"};
  const candidateId = action==="hold"?null:"candidate";
  const queue = ["candidate"];
  const original = candidateId?{id:"image-asset",digest:hash("bytes"),mime:"image/png",width:1,height:1,byteLength:5}:null;
  const assessment = {queue,candidates:[{id:queue[0],eligible:true,reasons:[]}]};
  const reads = [{candidateId:"candidate",rowId:"receipt",status:candidateId?"verified":"missing",original}];
  const decision = {action,candidateId,explanation:"Verified original."};
  const artifact = action==="stage"?JSON.stringify({scope:"private-local",briefId:plan.briefId,channelId:index.channelId,
    candidateId,frontier:2,nativeReceipt:reads[0].rowId,original}):null;
  const handoff = artifact?{path:"/.tmp/note/handoff.json",candidateId,digest:hash(artifact),assetDigest:original.digest,frontier:2}:null;
  const checks = Object.fromEntries(["exactImageFrontiers","exactImageBrief","groundedImageAssessment","independentlyReadImageOriginals",
    "groundedImageDecision","verifiedPrivateImageHandoff","preservedImageWorkspace","rejectedForeignImage"].map(key=>[key,true]));
  const proof = {contextId:"ctx",caseId:world.id,goal:world.goal,passed:true,checks,index,snapshots,plan,reads,decision,
    handoff,artifact,candidateId,queue};
  const outcome = {plan,assessment,reads,decision,handoff};
  const report = {status:"workspace-skill-reviewed",skill:"imageCandidate",outcome};
  const calls=[];
  const record=(name,parent,fields={})=>{
    const row={call_id:String(calls.length),parent_call_id:parent?.call_id,definition:{name},outcome:"done",...fields};
    calls.push({callId:row.call_id,record:row});
    return row;
  };
  const root=record("runUserGoal",null,{inputs:{goal:ref(world.goal)}});
  const workflow=record("workOnImageCandidateGoal",root,{inputs:{goal:ref(world.goal)}});
  const effect=(name,service,method,args,result)=>{
    const row={service,method,args:ref(args),result:ref(result)};
    const node=record(name,workflow,{effects:[row]});
    return {effect:row,node};
  };
  const listing=effect("discoverImageBriefs","imageCandidateBriefs","list",[],index);
  const frontiers=snapshots.map(row=>effect("readImageJournal","imageCandidateJournal","read",[index.channelId],row));
  record("chooseImageBrief",workflow,{inputs:{goal:ref(world.goal),index:ref(index)},output:ref(plan)});
  const assessed=record("assessImageAttempts",workflow,{
    inputs:{goal:ref(world.goal),plan:ref(plan),index:ref(index),earlier:ref(snapshots[0]),latest:ref(snapshots[1])},
    output:ref(assessment),
  });
  const source=effect("readImageOriginal","imageCandidateOriginal","read",[plan.briefId,queue[0]],reads[0]);
  const decided=record("decideImageHandoff",workflow,{
    inputs:{goal:ref(world.goal),plan:ref(plan),assessment:ref(assessment),reads:ref(reads)},
    output:ref(decision),
  });
  const staged=handoff?effect("stageImageHandoff","imageCandidateHandoff","stage",[{...outcome,handoff:null}],handoff):null;
  return {proof,listing,frontiers,assessed,source,decided,staged,validate(){
    workflow.output=ref(outcome);
    return openTemplateGoalEvidence({diagnostics:{openGoalVerification:proof},provenance:{contextId:"ctx"}},
      {calls,rootCallIds:[root.call_id],report},world.id,{assignment:world});
  }};
}

test("retained image export verifies the native candidate, frontier and private note through complete refs",()=>{
  for (const decision of ["stage","report","hold"]) assert.doesNotThrow(fixture(decision).validate);
  const faults=[
    sample=>{sample.listing.effect.result=sample.proof.index;},
    sample=>{sample.frontiers[1].effect.result=sample.frontiers[0].effect.result;},
    sample=>{sample.assessed.inputs.latest.complete=false;},
    sample=>{sample.source.effect.args=ref(["brief","different-image"]);},
    sample=>{sample.source.node.parent_call_id="spoofed";},
    sample=>{sample.decided.output=ref({...sample.proof.decision,candidateId:"other"});},
    sample=>{sample.staged.effect.result.hash=hash("different-note");},
    sample=>{sample.proof.artifact+=" ";},
  ];
  for (const fault of faults) {
    const sample=fixture("stage");
    fault(sample);
    assert.throws(sample.validate,/Expected the exact retained image frontier/u);
  }
});
