import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const hash=text=>createHash("sha256").update(text).digest("hex");
function ref(value){
  const text=JSON.stringify(value);
  return {complete:true,hash:hash(text),bytes:Buffer.byteLength(text)};
}
function fixture(status,note) {
  const world={id:"owned-slot-fixture",kind:"launch-state",goal:"Reconcile this owned panel's saved launch settings.",outcome:status,note};
  const contextId="owned";
  const attempt=status==="applied"||status==="rejected";
  const plan={panelId:"active",direction:status==="confirmed"?"read":status==="rejected"?"test":"write",patch:{count:7},retain:note};
  const index=[{panelId:"active",purpose:"active"},{panelId:"archive",purpose:"archive"}];
  const opening={panelId:"active",contextId,entryKey:"entry",digest:"opening",state:{count:3}};
  const current={...opening,digest:"current",state:{count:3,owner:"active"}};
  const readback=status==="applied"?{...current,digest:"written",state:{count:7,owner:"active"}}:current;
  const decision={attempt,reason:"Checked native slot basis."};
  const request=attempt?{goal:world.goal,ceiling:[],operations:[{id:"exact",label:"Owned state"}]}:null;
  const witness=attempt?{operationId:"exact",decision:"allowed",leaves:[]}:null;
  const review=attempt?{status:"eligible",held:[],protectedLeaves:[],reviews:[{observation:witness,outside:[],disposition:"eligible"}]}:null;
  const preflight=attempt?{request,report:review}:null;
  const effect=attempt?{panelId:"active",basis:current.digest,kind:status==="rejected"?"invalid":"saved",state:status==="applied"?readback.state:null}:null;
  const result={status,summary:"Independently checked persisted launch state."};
  const artifact=note?JSON.stringify({visibility:"private-local",opening,current,readback,effect,result}):null;
  const handoff=note?{path:"/.tmp/private/handoff.json",digest:hash(artifact)}:null;
  const checks=Object.fromEntries(["exactLaunchSlot","reconciledLaunchScope","exactLaunchPreflight","exactNativePatchResult",
    "independentLaunchReadback","exactLaunchDecision","protectedLaunchSiblings","exactPrivateLaunchNote","rejectedLaunchRetarget"].map(key=>[key,true]));
  const proof={caseId:world.id,goal:world.goal,contextId,checks,passed:true,index,plan,frames:[opening,current],readback,request,witness,
    decision,effect,result,handoff,artifact};
  const outcome={plan,opening,current,decision,preflight,effect,readback,result,handoff};
  const report={status:"workspace-skill-reviewed",skill:"panelLaunchState",outcome};
  const calls=[];
  function node(name,parent,fields={}){
    const record={call_id:String(calls.length),parent_call_id:parent?.call_id,definition:{name},outcome:"done",...fields};
    calls.push({callId:record.call_id,record});
    return record;
  }
  const root=node("runUserGoal",null,{inputs:{goal:ref(world.goal)}});
  const skill=node("reconcilePanelLaunchState",root,{inputs:{goal:ref(world.goal)},output:ref(outcome)});
  function effectNode(name,service,method,args,value,parent=skill){
    const row={service,method,args:ref(args),result:ref(value)};
    if(name)node(name,parent,{effects:[row]});
    else parent.effects=[row];
    return row;
  }
  effectNode("listLaunchSlots","launchStateRead","enumerate",[],index);
  node("planLaunchState",skill,{inputs:{goal:ref(world.goal),index:ref(index)},output:ref(plan)});
  const reads=proof.frames.map(frame=>effectNode("readLaunchSlot","launchStateRead","read",[plan.panelId],frame));
  node("decideLaunchChange",skill,{inputs:{goal:ref(world.goal),plan:ref(plan),opening:ref(opening),current:ref(current)},output:ref(decision)});
  let authorityEffect,patch;
  if(attempt){
    effectNode("bindLaunchAuthority","launchStateRead","bind",[plan.panelId,current.digest,plan.patch],request);
    const authority=node("reviewLaunchAuthority",skill,{inputs:{request:ref(request)},output:ref(review)});
    const installed=node("reviewAuthority",authority,{inputs:{request:ref(request)},output:ref(review)});
    const operation=node("reviewOperation",installed);
    authorityEffect=effectNode(null,"assignedAuthorityRead","preflight",["exact"],witness,operation);
    patch=effectNode("applyLaunchPatch","launchStateWrite","patch",[plan.panelId,current.digest,plan.patch],effect);
  }
  const seal=effectNode("readbackLaunchSlot","launchStateRead","seal",[plan.panelId],readback);
  node("concludeLaunchState",skill,{inputs:{plan:ref(plan),opening:ref(opening),current:ref(current),decision:ref(decision),
    effect:ref(effect),readback:ref(readback)},output:ref(result)});
  const written=note?effectNode("writeLaunchNote","launchStateWrite","stage",[{...outcome,handoff:null}],handoff):null;
  return {proof,reads,authorityEffect,patch,seal,written,validate(){
    return openTemplateGoalEvidence({diagnostics:{openGoalVerification:proof},provenance:{contextId}},
      {report,calls,rootCallIds:[root.call_id]},world.id,{assignment:world});
  }};
}

test("launch-state export requires the exact scoped authority, native patch and independent persisted state",()=>{
  for(const status of ["confirmed","held","applied","rejected"])
    for(const note of [true,false])assert.doesNotThrow(fixture(status,note).validate);
  for(const change of [
    x=>{x.reads[1].result=x.reads[0].result;},
    x=>{x.authorityEffect.result=x.proof.witness;},
    x=>{x.patch.args=ref(["active","stale",{count:7}]);},
    x=>{x.seal.result=x.patch.result;},
    x=>{x.written.result.complete=false;},
    x=>{x.proof.artifact+=" ";},
  ]){
    const example=fixture("applied",true);
    change(example);
    assert.throws(example.validate,/Expected exact scoped panel launch state/u);
  }
});
