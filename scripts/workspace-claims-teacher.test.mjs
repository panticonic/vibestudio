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
  const world={id:"open-claim-fixture",kind:"workspace-claims",goal:"Check source and behavior for the owned candidate",note};
  const contextId="owned";
  const choice={id:"active",retain:note};
  const index={scopes:[{id:choice.id,purpose:"review"},{id:"archive",purpose:"archive"}]};
  const required=["Current source is saved","The live panel shows it"];
  const packet={id:choice.id,candidateEvent:"current",priorEvent:"earlier",protectedEvent:"main",packetHash:"packet",
    requirements:required.map((text,i)=>({id:String(i),text}))};
  const evidence={packetId:choice.id,candidateEvent:"current",priorEvent:"earlier",sourceHash:"packet",
    observations:["The source file reflects the local revision","Only a native TestKit check was executed"]};
  const supported=status==="confirmed"?required:status==="partial"?required.slice(0,1):[];
  const support={supported,missing:required.filter(text=>!supported.includes(text))};
  const disposition={status,summary:"Tested the exact scope."};
  const artifact=note?JSON.stringify({visibility:"private-local",packet,evidence,support,disposition}):null;
  const handoff=note?{path:"/.tmp/private/handoff.json",digest:hash(artifact)}:null;
  const checks=Object.fromEntries(["exactClaimScope","independentSemanticEvidence","exactTestkitClaimInput","exactAuthorityPreflight",
    "exactGroundedClaimPartition","independentlyPreservedClaimContext","exactPrivateClaimNote","rejectedClaimRetarget",
    "exactInstalledClaimGuide"].map(key=>[key,true]));
  const proof={caseId:world.id,goal:world.goal,contextId,checks,passed:true,index,packet,choice,evidence,required,
    support,disposition,handoff,artifact,guideRevision:"sk1_"+hash("guide").slice(0,32)};
  const outcome={choice,packet,evidence,support,disposition,handoff};
  const report={status:"workspace-skill-reviewed",skill:"workspaceClaims",outcome};
  const calls=[];
  function node(name,parent,fields={},events=[]){
    const record={call_id:String(calls.length),parent_call_id:parent?.call_id,definition:{name},outcome:"done",...fields};
    const detail={callId:record.call_id,record,events};
    calls.push(detail);
    return detail;
  }
  const root=node("runUserGoal",null,{inputs:{goal:ref(world.goal)}}).record;
  const skill=node("reviewWorkspaceClaims",root,{inputs:{goal:ref(world.goal)},output:ref(outcome)}).record;
  function effect(name,service,method,args,result){
    const row={service,method,args:ref(args),result:ref(result)};
    node(name,skill,{effects:[row]});
    return row;
  }
  effect("listClaimScopes","workspaceClaimRead","list",[],index);
  node("selectClaimPacket",skill,{inputs:{goal:ref(world.goal),index:ref(index)},output:ref(choice)});
  const read=effect("readClaimPacket","workspaceClaimRead","read",[choice.id],packet);
  const observed=effect("readClaimEvidence","workspaceClaimRead","observe",[choice.id],evidence);
  const review=node("verifyClaimSupport",skill,{inputs:{packet:ref(packet),evidence:ref(evidence)},output:ref(support)}).record;
  const checker=node("checkSupport",review,{inputs:{required:ref(required),observed:ref(evidence.observations)},output:ref(support)},[
    {kind:"skill_use",phase:"body_read",skill_name:"workspace-evidence",path:"SKILL.md",skill_revision:proof.guideRevision},
  ]);
  node("summarizeClaimReview",skill,{inputs:{goal:ref(world.goal),packet:ref(packet),evidence:ref(evidence),support:ref(support)},
    output:ref(disposition)});
  const written=note?effect("writeClaimNote","workspaceClaimHandoff","stage",[{...outcome,handoff:null}],handoff):null;
  return {proof,read,observed,checker,written,validate(){
    return openTemplateGoalEvidence({diagnostics:{openGoalVerification:proof},provenance:{contextId}},
      {report,calls,rootCallIds:[root.call_id]},world.id,{assignment:world});
  }};
}

test("claim audit export requires exact VCS and TestKit inputs and native workspace-evidence disclosure",()=>{
  for(const status of ["confirmed","partial","unconfirmed"])
    for(const note of [true,false])assert.doesNotThrow(fixture(status,note).validate);
  for(const change of [
    x=>{x.read.args=ref(["archive"]);},
    x=>{x.observed.result=x.proof.evidence;},
    x=>{x.checker.record.inputs.observed=ref(["Unverified substitute observation"]);},
    x=>{x.checker.events=[];},
    x=>{x.checker.events[0].phase="listed";},
    x=>{x.checker.events[0].skill_revision="sk1_"+hash("old").slice(0,32);},
    x=>{x.written.result.complete=false;},
    x=>{x.proof.artifact+=" ";},
  ]){
    const candidate=fixture("partial",true);
    change(candidate);
    assert.throws(candidate.validate,/Expected exact workspace claim evidence, native knowledge read and private review/u);
  }
});
