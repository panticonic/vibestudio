import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const hash=value=>createHash("sha256").update(value).digest("hex");
function ref(value){
  const text=JSON.stringify(value);
  return {complete:true,hash:hash(text),bytes:Buffer.byteLength(text)};
}
function fixture(result,withNote) {
  const world={id:"owned-bridge",kind:"bridge-delivery",goal:"Review the exact retained release target.",
    condition:result==="hold"?"candidate-pending":"aligned",result};
  const contextId="owned-context",mainEventId="main-event",repository="projects/owned-packet";
  const index={scopes:[{id:"this",path:repository,purpose:"delivery"},{id:"other",path:repository+"-archive",purpose:"archive"}]};
  const plan={id:"this",intent:result==="commit"?"commit":"review",handoff:withNote};
  const scope={id:"this",repository,remote:"origin",branch:"release/print",specPath:"contract.txt",notePath:"note.txt",
    retained:{repository,remote:"origin",branch:"release/print",candidateEvent:result==="hold"?"candidate":"none"},
    retainedDigest:"original-source"};
  const basis={kind:"application",applicationId:"working-basis"};
  const bridgeRead={repository,upstream:{state:"local-only"},semantic:{contextId,mainEventId}};
  const local={view:bridgeRead,next:"configure-upstream"};
  const file=path=>({snapshot:{working:basis,file:{path,working:{hash:"hash:"+path}}},next:"verify-then-commit"});
  const spec=file(scope.specPath),note=file(scope.notePath);
  const branch={status:world.condition,explanation:"Exact retained observation."};
  const decision={status:result,explanation:"Compared the retained route and working file pair."};
  const commit=result==="commit"?{repository,eventId:"committed-local-event",protectedEventId:mainEventId,from:basis,
    files:[scope.specPath,scope.notePath]}:null;
  const artifact=withNote?JSON.stringify({visibility:"private-local",repository,branch:scope.branch,retained:scope.retained,
    retainedDigest:scope.retainedDigest,protectedEventId:mainEventId,commit,decision,spec:spec.snapshot.file,note:note.snapshot.file}):null;
  const handoff=artifact?{path:"/.tmp/owned/handoff.json",digest:hash(artifact)}:null;
  const operations=[["","op-git"],[scope.specPath,"op-contract"],[scope.notePath,"op-note"]];
  const fileReads=[[scope.specPath,spec.snapshot],[scope.notePath,note.snapshot]];
  const checks=Object.fromEntries(["exactBranchProject","exactLiveLocalBridge","exactSemanticFileChain","retainedBranchAuthority",
    "groundedBranchDecision","exactLocalBranchCommit","exactPrivateBranchHandoff","protectedBranchMain","rejectedBranchRetarget"].map(key=>[key,true]));
  const proof={caseId:world.id,goal:world.goal,contextId,checks,passed:true,index,plan,scope,operations,bridgeRead,fileReads,
    branch,decision,commit,handoff,artifact};
  const outcome={scope,plan,local,spec,note,branch,decision,commit,handoff};
  const report={status:"workspace-skill-reviewed",skill:"bridgeDelivery",outcome};
  const calls=[];
  function node(name,parent,fields={}){
    const record={call_id:String(calls.length),parent_call_id:parent?.call_id,definition:{name},outcome:"done",...fields};
    calls.push({callId:record.call_id,record});
    return record;
  }
  const root=node("runUserGoal",null,{inputs:{goal:ref(world.goal)}});
  const skill=node("workOnBridgeDelivery",root,{inputs:{goal:ref(world.goal)},output:ref(outcome)});
  function effect(name,parent,service,method,args,result){
    const row={service,method,args:ref(args),result:ref(result)};
    if(name) node(name,parent,{effects:[row]});
    else parent.effects=[row];
    return row;
  }
  effect("discover",skill,"branchDeliveryRead","discover",[],index);
  effect("inspect",skill,"branchDeliveryRead","inspect",[plan.id],scope);
  node("chooseBridgeScope",skill,{inputs:{goal:ref(world.goal),index:ref(index)},output:ref(plan)});
  const inspectBridge=node("inspectCurrentBridge",skill,{inputs:{goal:ref(world.goal),scope:ref(scope),operationId:ref("op-git")},output:ref(local)});
  effect("operation",skill,"branchDeliveryRead","operation",[plan.id,""],"op-git");
  const installedBridge=node("reviewGitBridge",inspectBridge,{inputs:{request:ref({operationId:"op-git",
    goal:world.goal,repository,direction:"diagnose"})},output:ref(local)});
  const bridgeEffect=effect(null,installedBridge,"gitBridgeReviewRead","observe",["op-git"],bridgeRead);
  const fileEffects=[spec,note].map((value,i)=>{
    const [path,operationId]=operations[i+1];
    const row=node("reviewDeliveryFile",skill,{inputs:{goal:ref(world.goal),scope:ref(scope),path:ref(path),operationId:ref(operationId)},output:ref(value)});
    effect("operation",skill,"branchDeliveryRead","operation",[plan.id,path],operationId);
    const installed=node("reviewVcsDelivery",row,{inputs:{request:ref({operationId,goal:world.goal,repository,path})},output:ref(value)});
    return effect(null,installed,"vcsDeliveryRead","observe",[operationId],value.snapshot);
  });
  const retained=node("assessRetainedBranch",skill,{inputs:{scope:ref(scope)},output:ref(branch)});
  node("decideLocalDelivery",skill,{inputs:{goal:ref(world.goal),scope:ref(scope),plan:ref(plan),local:ref(local),
    spec:ref(spec),note:ref(note),branch:ref(branch)},output:ref(decision)});
  const written=commit?effect("commit",skill,"branchDeliveryWrite","commit",[plan.id,basis],commit):null;
  const staged=handoff?effect("retain",skill,"branchDeliveryWrite","retain",[{...outcome,handoff:null}],handoff):null;
  return {proof,bridgeEffect,fileEffects,retained,written,staged,validate(){
    return openTemplateGoalEvidence({diagnostics:{openGoalVerification:proof},provenance:{contextId}},
      {report,calls,rootCallIds:[root.call_id]},world.id,{assignment:world});
  }};
}

test("branch delivery export binds both installed reviews, the historical receipt and the local effect",()=>{
  for(const branch of [["commit",true],["commit",false],["hold",true],["hold",false],["reviewed",true],["reviewed",false]])
    assert.doesNotThrow(fixture(...branch).validate);
  for(const change of [
    x=>{x.bridgeEffect.result=x.proof.bridgeRead;},
    x=>{x.fileEffects[1].result=x.fileEffects[0].result;},
    x=>{x.retained.inputs.scope=ref({...x.proof.scope,branch:"release/foreign"});},
    x=>{x.written.args=ref([x.proof.plan.id,{kind:"application",applicationId:"stale"}]);},
    x=>{x.staged.result.complete=false;},
    x=>{x.proof.artifact+=" ";},
  ]){
    const example=fixture("commit",true);
    change(example);
    assert.throws(example.validate,/Expected exact Git Bridge and semantic delivery evidence/u);
  }
});
