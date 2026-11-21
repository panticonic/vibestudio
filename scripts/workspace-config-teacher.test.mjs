import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const hash=text=>createHash("sha256").update(text).digest("hex");
function ref(value) {
  const text=JSON.stringify(value);
  return {complete:true,hash:hash(text),bytes:Buffer.byteLength(text)};
}
function fixture({note="always",history=true,dependencies=true,drift=false}={}) {
  const world={id:"workspace-config-audit",kind:"workspace-config",goal:"Review what this workspace actually runs.",note};
  const contextId="owned";
  const facts=[{question:"panel-restore",declared:true,value:'"focused"'}];
  const brief={subject:"Return settings",noteHash:"retained",noteId:"owned",noteName:"Example",noteEpoch:drift?1:0,noteFacts:facts};
  const lens={questions:["panel-restore"],inspectManifest:history,inspectDependencies:dependencies};
  const row={ref:"main",fileId:"manifest",digest:"original",epoch:0,facts};
  const active={id:"owned",name:"Example",configId:"config",epoch:0,appVersion:"1.2.3",hubVersion:"1.2.4",
    projectionNamespace:"v6",projectionUsesCurrentNamespace:true,facts};
  const evidence={active,history:history?{contextId,clean:true,working:row,committed:row,main:row}:null,
    dependencies:dependencies?{mainEvent:"main",manifestDigest:"original",epoch:0,minimumAppVersion:null,sources:[]}:null};
  const outcome={noteStatus:drift?"different-epoch":"matches",sourceStatus:history?"aligned":"uninspected",
    dependencyStatus:dependencies?"no-declarations":"uninspected",affectedQuestions:[],workingDifferences:[],
    committedDifferences:[],summary:"The workspace declares focused-panel restoration."};
  const allowed=note==="always"||(note==="if-aligned"&&!drift);
  const artifact=allowed?JSON.stringify({visibility:"private-local",brief,lens,evidence,outcome}):null;
  const handoff=artifact?{path:"/.tmp/receipt/handoff.json",digest:hash(artifact)}:null;
  const checks=Object.fromEntries(["exactConfigBrief","scopedConfigLens","exactLiveWorkspaceConfig","exactProtectedConfigHistory",
    "exactProtectedTemplateDependencies","exactConfigDisposition","preservedProtectedConfig","constrainedConfigEvidence",
    "exactPrivateConfigNote"].map(key=>[key,true]));
  const proof={caseId:world.id,goal:world.goal,contextId,checks,passed:true,brief,lens,evidence,outcome,handoff,artifact};
  const result={brief,lens,evidence,outcome,handoff};
  const report={status:"workspace-skill-reviewed",skill:"workspaceConfig",outcome:result};
  const calls=[];
  function node(name,parent,fields={}) {
    const record={call_id:String(calls.length),parent_call_id:parent?.call_id,definition:{name},outcome:"done",...fields};
    calls.push({callId:record.call_id,record});
    return record;
  }
  function effect(name,parent,service,method,args,value) {
    const row={service,method,args:ref(args),result:ref(value)};
    node(name,parent,{effects:[row]});
    return row;
  }
  const root=node("runUserGoal",null,{inputs:{goal:ref(world.goal)}});
  const skill=node("reconcileWorkspaceConfig",root,{inputs:{goal:ref(world.goal)},output:ref(result)});
  effect("readConfigBrief",skill,"nativeWorkspaceConfig","readBrief",[],brief);
  node("selectConfigLens",skill,{inputs:{goal:ref(world.goal),brief:ref(brief)},output:ref(lens)});
  const collect=node("collectConfigEvidence",skill,{inputs:{lens:ref(lens)},output:ref(evidence)});
  const observed=effect("inspectActiveConfig",collect,"nativeWorkspaceConfig","inspectActive",[lens.questions],active);
  const manifests=history?effect("inspectConfigManifests",collect,"nativeWorkspaceConfig","inspectManifests",
    [lens.questions],evidence.history):null;
  const protectedDeps=dependencies?effect("inspectConfigDependencies",collect,"nativeWorkspaceConfig","inspectDependencies",
    ["main"],evidence.dependencies):null;
  const review=node("reviewConfigDisposition",skill,
    {inputs:{goal:ref(world.goal),brief:ref(brief),lens:ref(lens),evidence:ref(evidence)},output:ref(outcome)});
  const saved=handoff?effect("stageConfigDisposition",skill,"nativeConfigHandoff","stage",[brief,lens,evidence,outcome],handoff):null;
  return {proof,observed,manifests,protectedDeps,review,saved,validate(){
    return openTemplateGoalEvidence({diagnostics:{openGoalVerification:proof},provenance:{contextId}},
      {report,calls,rootCallIds:[root.call_id]},world.id,{assignment:world});
  }};
}

test("configuration export binds the active read, protected manifests and conditional private handoff",()=>{
  for (const options of [{},{note:"if-aligned",drift:true},{note:null,history:false,dependencies:false}])
    assert.doesNotThrow(fixture(options).validate);
  for (const mutate of [
    row=>{row.observed.result=ref({...row.proof.evidence.active,id:"foreign"});},
    row=>{row.manifests.result=row.proof.evidence.history;},
    row=>{row.protectedDeps.args=ref(["local-commit"]);},
    row=>{row.protectedDeps.result=ref({...row.proof.evidence.dependencies,manifestDigest:"another-file"});},
    row=>{row.review.output.complete=false;},
    row=>{row.saved.args=ref([row.proof.brief,row.proof.lens,row.proof.evidence]);},
    row=>{row.proof.artifact+=" ";},
  ]) {
    const row=fixture();
    mutate(row);
    assert.throws(row.validate,/Expected active workspace config and verified exact protected\/retained evidence/u);
  }
});
