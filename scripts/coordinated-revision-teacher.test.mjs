import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

function ref(value) {
  const text=JSON.stringify(value);
  return {complete:true,hash:createHash("sha256").update(text).digest("hex"),bytes:Buffer.byteLength(text)};
}
function fixture(race) {
  const world={id:"coordinated-revision-probe",kind:"coordinated-revision",goal:"Apply the signed wording to the local notice."};
  const contextId="owned";
  const file={path:"notice.md",version:"original",text:"Use south side.",fileId:"notice-file"};
  const rec={path:"approved.md",version:"signed",text:"Use north side.",fileId:"approved-file"};
  const initial={subject:"Notice",head:"working",files:[rec,file]};
  const draft={path:file.path,version:file.version,text:"Use north side."};
  const plan={status:"ready",destinations:[draft],explanation:"The signed approval is current."};
  const approved={required:["Use approved location"],observed:initial.files.map(x=>x.path+" @ "+x.version+"\n"+x.text),
    supported:["Use approved location"],missing:[]};
  const guideRevision="sk1_abcdef0123456789abcdef0123456789";
  const changed={...file,version:"later",text:"Use south side. The main desk has forms."};
  const updated=race?{...initial,head:"coedited",files:[rec,changed]}:null;
  const updatedAuthority=race?{...approved,observed:updated.files.map(x=>x.path+" @ "+x.version+"\n"+x.text)}:null;
  const reconciled=race?{...plan,destinations:[{path:file.path,version:changed.version,text:"Use north side. The main desk has forms."}]}:null;
  const applied={status:"applied",head:"applied-head",paths:[file.path]};
  const first=race?{status:"changed",head:updated.head,paths:[]}:applied;
  const final=race?applied:null;
  const outputDoc={...file,version:"applied",text:reconciled?.destinations[0].text??draft.text};
  const readback={head:applied.head,protectedMain:"main",files:[rec,outputDoc]};
  const outcome={initial,initialAuthority:approved,plan,first,updated,updatedAuthority,reconciled,final,readback};
  const checks=Object.fromEntries(["exactCoordinatedDocumentScope","exactCoordinatedAuthority","exactCoordinatedDrafts",
    "exactNativeRevisionRace","exactAtomicRevisionBasis","independentlyVerifiedRevisionBatch","exactRevisionEvidenceGuide",
    "protectedRevisionMain"].map(key=>[key,true]));
  const proof={caseId:world.id,goal:world.goal,contextId,checks,passed:true,report:outcome,guideRevision};
  const report={status:"workspace-skill-reviewed",skill:"coordinatedRevision",outcome};
  const calls=[];
  function node(name,parent,fields={},events=[]) {
    const record={call_id:String(calls.length),parent_call_id:parent?.call_id,definition:{name},outcome:"done",...fields};
    const row={callId:record.call_id,record,events};
    calls.push(row);return row;
  }
  const root=node("runUserGoal",null,{inputs:{goal:ref(world.goal)}}).record;
  const skill=node("reviseCoordinatedDocuments",root,{inputs:{goal:ref(world.goal)},output:ref(outcome)}).record;
  function effect(name,method,args,value){
    const item={service:"nativeCoordinatedRevision",method,args:ref(args),result:ref(value)};
    node(name,skill,{effects:[item]});
    return item;
  }
  function authority(scope,approval) {
    const parent=node("assessRevisionAuthority",skill,{inputs:{goal:ref(world.goal),scope:ref(scope)},output:ref(approval)}).record;
    const {required,observed,supported,missing}=approval;
    return node("checkSupport",parent,{inputs:{required:ref(required),observed:ref(observed)},output:ref({supported,missing})},
      [{kind:"skill_use",phase:"body_read",skill_name:"workspace-evidence",path:"SKILL.md",skill_revision:guideRevision}]);
  }
  const discover=effect("discoverRevisionDocuments","discover",[],initial);
  const review=authority(initial,approved);
  const planner=node("planCoordinatedRevision",skill,{inputs:{goal:ref(world.goal),scope:ref(initial),authority:ref(approved)},output:ref(plan)}).record;
  const choose=node("chooseRevision",planner,{inputs:{documents:ref(initial.files),research:ref(null)},output:ref(draft)}).record;
  const attempted=effect("applyRevisionBatch","revise",[initial.head,plan.destinations],first);
  let reconciledCall;
  if(race){
    effect("discoverRevisionDocuments","discover",[],updated);
    authority(updated,updatedAuthority);
    const recover=node("reconcileCoordinatedRevision",skill,{inputs:{
      goal:ref(world.goal),original:ref(initial),plan:ref(plan),latest:ref(updated),authority:ref(updatedAuthority),
    },output:ref(reconciled)}).record;
    reconciledCall=node("reconcileRevision",recover,{inputs:{original:ref(file),proposedText:ref(draft.text),latest:ref(changed),
      refreshedEvidence:ref(updated.files),research:ref(null)},output:ref(reconciled.destinations[0].text)}).record;
    effect("applyRevisionBatch","revise",[updated.head,reconciled.destinations],final);
  }
  const finalRead=effect("readCoordinatedRevision","readback",[],readback);
  return {proof,discover,review,choose,attempted,reconciledCall,finalRead,validate(){
    return openTemplateGoalEvidence({diagnostics:{openGoalVerification:proof},provenance:{contextId}},
      {report,calls,rootCallIds:[root.call_id]},world.id,{assignment:world});
  }};
}
test("document revision export binds signed scope, nested installed revision policies, CAS conflict and readback",()=>{
  assert.doesNotThrow(fixture(false).validate);
  assert.doesNotThrow(fixture(true).validate);
  for(const mutate of [
    f=>{f.discover.result=f.proof.report.initial;},
    f=>{f.review.events[0].skill_revision="sk1_different";},
    f=>{f.choose.inputs.documents=ref([]);},
    f=>{f.attempted.args=ref(["older",f.proof.report.plan.destinations]);},
    f=>{f.reconciledCall.inputs.latest=ref(f.proof.report.initial.files[1]);},
    f=>{f.finalRead.result.complete=false;},
  ]){
    const row=fixture(true);
    mutate(row);
    assert.throws(row.validate,/Expected native atomic document revision and independently bound authorization\/readback/u);
  }
});
