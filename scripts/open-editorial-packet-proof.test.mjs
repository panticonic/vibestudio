import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const hash=text=>createHash("sha256").update(text).digest("hex");
function ref(value) {
  const text=JSON.stringify(value);
  return {complete:true,hash:hash(text),bytes:Buffer.byteLength(text)};
}
function example(branch, allowOcr = false) {
  const retry=branch==="retry", missing=branch==="hold", editRequested=branch!=="review";
  const world={id:"editorial-proof",kind:"editorial-packet",goal:"Correct the opening window.",end:missing?"held":editRequested?"ready":"reviewed"};
  const mission={id:"mission",title:"Exact mission",revision:1};
  const listed=[mission,{id:"older"}];
  const candidate={path:"candidate.md",version:"old",text:"Old line"};
  const opening={mission,candidate};
  const current=retry?{mission,candidate:{...candidate,version:"coedit",text:"Old line with additions"}}:opening;
  const snapshots=retry?[opening,current]:[opening];
  const plan={missionId:mission.id,operation:editRequested?"revise":"review",fields:["Hours"],note:"diagnostic"};
  const selection={attachment:"proof.pdf",pages:[1],query:"Hours"};
  const request={...selection,document:selection.attachment,allowOcr};
  const pdf={digest:"pdf",readPages:[1],citations:[{page:1,line:0,quote:"Hours: New line"}]};
  const evidence={status:"grounded",source:"proof.pdf",document:{path:"proof.pdf",version:"pdf",text:"Hours: New line"},citations:pdf.citations};
  const source=missing?{selection:null,request:null,pdf:null,evidence:null}:{selection,request,pdf,evidence};
  const sources=retry?[source,source]:[source];
  const proposed=editRequested&&!missing?{...candidate,text:"New line"}:null;
  const revised=retry?"New line with additions":null;
  const stored=proposed?{...proposed,version:"new",text:revised??proposed.text}:candidate;
  const result={status:"written",version:stored.version};
  const attempts=retry?[{proposal:proposed,result:{status:"changed",version:null}},
    {proposal:{...current.candidate,text:revised},result}]:proposed?[{proposal:proposed,result}]:[];
  const edit={proposed,revised,attempts:attempts.map(item=>item.result),stored};
  const decision={status:world.end,write:branch!=="review",explanation:"Verified original source and scoped result."};
  const artifact=decision.write?JSON.stringify({scope:"private-local",candidate:stored,sources:sources.map(source=>source.evidence)}):null;
  const note=artifact?{path:"/.tmp/local/handoff.json",digest:hash(artifact),candidateVersion:stored.version,missionRevision:mission.revision}:null;
  const checks=Object.fromEntries(["exactOwnedEditorialMission","exactEditorialFrontiers","exactApprovedPdfEvidence","minimalEditorialProposal",
    "preservedCoeditorBoundary","verifiedEditorialReadback","groundedEditorialDisposition","verifiedPrivateEditorialNote",
    "protectedEditorialSources","rejectedEditorialRetarget"].map(key=>[key,true]));
  const proof={contextId:"ctx",caseId:world.id,goal:world.goal,checks,passed:true,listed,snapshots,plan,sources,attempts,stored,edit,decision,note,artifact};
  const outcome={plan,opening,current,sources,edit,decision,note};
  const report={status:"workspace-skill-reviewed",skill:"editorialPacket",outcome};
  const calls=[];
  const node=(name,parent,fields={})=>{
    const record={call_id:String(calls.length),parent_call_id:parent?.call_id,definition:{name},outcome:"done",...fields};
    calls.push({callId:record.call_id,record});
    return record;
  };
  const root=node("runUserGoal",null,{inputs:{goal:ref(world.goal)}});
  const skill=node("workOnEditorialPacket",root,{inputs:{goal:ref(world.goal)}});
  const effect=(name,parent,service,method,args,result)=>{
    const row={service,method,args:ref(args),result:ref(result)};
    node(name,parent,{effects:[row]});
    return row;
  };
  effect("listPacketMissions",skill,"editorialMission","list",[],listed);
  node("chooseEditorialMission",skill,{inputs:{goal:ref(world.goal),missions:ref(listed)},output:ref(plan)});
  const reads=snapshots.map(snapshot=>effect("readPacketSnapshot",skill,"editorialWorkspace","read",[plan.missionId],snapshot));
  const readsPdf=sources.map((source,i)=>{
    const snapshot=snapshots[i];
    const wrapper=node("reviewPacketSource",skill,{inputs:{goal:ref(world.goal),snapshot:ref(snapshot),plan:ref(plan)},output:ref(source)});
    node("chooseAttachmentPages",wrapper,{output:ref(source.selection)});
    if(!source.request)return null;
    const bind=effect("bindPacketPdf",wrapper,"editorialPdf","bind",[snapshot,plan,selection],request);
    const extract=node("extractPdfEvidence",wrapper,{inputs:{request:ref(request)},output:ref(pdf)});
    node("probeDocument",extract);
    node("readBatch",extract);
    const attested=effect("attestPacketPdf",wrapper,"editorialPdf","attest",[pdf],evidence);
    return {bind,extract,attested};
  });
  if(proposed){
    const proposer=node("proposeEditorialRevision",skill,{inputs:{goal:ref(world.goal),snapshot:ref(opening),source:ref(source)},output:ref(proposed)});
    node("chooseRevision",proposer,{inputs:{documents:ref([opening.candidate,evidence.document])},output:ref(proposed)});
  }
  const writes=attempts.map(item=>effect("applyPacketRevision",skill,"editorialRevision","apply",[plan.missionId,item.proposal],item.result));
  let reconciliation;
  if(retry){
    const wrapper=node("reconcileEditorialRevision",skill,{inputs:{opening:ref(opening),current:ref(current),proposal:ref(proposed),
      earlier:ref(source),refreshed:ref(source)},output:ref(revised)});
    reconciliation=node("reconcileRevision",wrapper,{inputs:{refreshedEvidence:ref([evidence.document])}});
  }
  effect("readStoredPacket",skill,"editorialRevision","read",[plan.missionId],stored);
  node("decideEditorialHandoff",skill,{inputs:{goal:ref(world.goal),plan:ref(plan),opening:ref(opening),current:ref(current),sources:ref(sources),
    edit:ref(edit)},output:ref(decision)});
  const staged=note?effect("writePacketHandoff",skill,"editorialHandoff","stage",[{...outcome,note:null}],note):null;
  return {reads,readsPdf,writes,reconciliation,staged,proof,validate(){
    skill.output=ref(outcome);
    return openTemplateGoalEvidence({diagnostics:{openGoalVerification:proof},provenance:{contextId:"ctx"}},
      {report,calls,rootCallIds:[root.call_id]},world.id,{assignment:world});
  }};
}

test("editorial packet export binds exact sources, stale semantic receipts, installed policy calls and private handoff",()=>{
  for(const branch of ["ready","review","hold","retry"])assert.doesNotThrow(example(branch).validate);
  assert.throws(example("ready",true).validate,/Expected exact editorial mission/u);
  for(const fault of [
    x=>{x.reads[1].result=x.reads[0].result;},
    x=>{x.readsPdf[0].bind.result.complete=false;},
    x=>{x.readsPdf[1].extract.output=ref({digest:"another PDF"});},
    x=>{x.readsPdf[1].attested.args=ref([{digest:"different"}]);},
    x=>{x.writes[0].result=x.writes[1].result;},
    x=>{x.reconciliation.inputs.refreshedEvidence=ref([]);},
    x=>{x.staged.result.hash=hash("altered note");},
    x=>{x.proof.artifact+=" ";},
  ]){
    const x=example("retry");
    fault(x);
    assert.throws(x.validate,/Expected exact editorial mission/u);
  }
});
