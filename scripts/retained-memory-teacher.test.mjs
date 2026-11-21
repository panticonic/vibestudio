import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const hash=text=>createHash("sha256").update(text).digest("hex");
function ref(value){
  const text=JSON.stringify(value);
  return {complete:true,hash:hash(text),bytes:Buffer.byteLength(text)};
}
function fixture(stage){
  const world={id:"owned-memory",kind:"retained-memory",goal:"Find the kept Lantern decision.",private:stage};
  const contextId="owned";
  const brief={subject:"Lantern",channelId:"channel-lantern",repository:"projects/lantern"};
  const plan={query:"Lantern",kinds:["message","commit"],readTranscript:true,readWorking:true};
  const message={channelId:brief.channelId,envelopeId:"envelope",messageId:"message",sender:"author",
    sequence:1,text:"The original Lantern date is Tuesday."};
  const original={eventId:"record-event",fileId:"record",path:"projects/lantern/decision.txt",
    digest:"record-bytes",text:"Approved Lantern date Tuesday."};
  const working={...original,eventId:"working-event",digest:"working-bytes",text:"Draft Lantern date Friday."};
  const leads=[{kind:"commit",snippet:"Lantern decision",eventId:original.eventId,logId:null,head:null,path:null,digest:null}];
  const evidence={leads,messages:[message],committed:[original],working};
  const outcome={disposition:"confirmed",summary:"Tuesday was approved. Friday appears in a draft only.",citations:[
    {layer:"message",ref:message.envelopeId,coordinate:message.messageId,quote:message.text},
    {layer:"commit",ref:original.eventId,coordinate:original.fileId,quote:original.text},
    {layer:"working",ref:working.eventId,coordinate:working.fileId,quote:working.text},
  ]};
  const artifact=stage?JSON.stringify({visibility:"private-local",brief,plan,evidence,outcome}):null;
  const handoff=artifact?{path:"/.tmp/receipt/handoff.json",digest:hash(artifact)}:null;
  const checks=Object.fromEntries(["exactRetainedMemoryScope","exactBoundedNativeRecall","independentlyReadMemorySources",
    "exactMemoryCitations","protectedMemoryScope","exactPrivateMemoryHandoff"].map(key=>[key,true]));
  const proof={caseId:world.id,goal:world.goal,contextId,checks,passed:true,brief,plan,evidence,outcome,handoff,artifact};
  const result={brief,plan,evidence,outcome,handoff};
  const report={status:"workspace-skill-reviewed",skill:"retainedMemory",outcome:result};
  const calls=[];
  function node(name,parent,fields={}){
    const record={call_id:String(calls.length),parent_call_id:parent?.call_id,definition:{name},outcome:"done",...fields};
    calls.push({callId:record.call_id,record});
    return record;
  }
  function effect(name,parent,service,method,args,value){
    const row={service,method,args:ref(args),result:ref(value)};
    node(name,parent,{effects:[row]});
    return row;
  }
  const root=node("runUserGoal",null,{inputs:{goal:ref(world.goal)}});
  const skill=node("reviewRetainedMemory",root,{inputs:{goal:ref(world.goal)},output:ref(result)});
  effect("identifyMemoryScope",skill,"nativeRetainedMemory","brief",[],brief);
  const selected=node("chooseMemorySearch",skill,{inputs:{goal:ref(world.goal),brief:ref(brief)},output:ref(plan)});
  const oriented=node("provenanceMechanism",selected,{inputs:{question:ref(world.goal)},output:ref("memory-recall")});
  const resolve=node("resolveMemoryEvidence",skill,{inputs:{brief:ref(brief),plan:ref(plan)},output:ref(evidence)});
  const recall=effect("recallMemoryLeads",resolve,"nativeRetainedMemory","recall",[plan.query,plan.kinds],leads);
  const transcript=effect("readMemoryMessages",resolve,"nativeRetainedMemory","transcript",[brief.channelId],evidence.messages);
  const archive=effect("readMemoryArchive",resolve,"nativeRetainedMemory","archivedFile",[original.eventId],original);
  const draft=effect("readMemoryDraft",resolve,"nativeRetainedMemory","workingFile",[],working);
  const judgement=node("judgeMemoryClaim",skill,{inputs:{goal:ref(world.goal),plan:ref(plan),evidence:ref(evidence)},output:ref(outcome)});
  const saved=handoff?effect("stageMemoryHandoff",skill,"nativeMemoryHandoff","stage",[brief,plan,evidence,outcome],handoff):null;
  return {proof,oriented,recall,transcript,archive,draft,judgement,saved,validate(){
    return openTemplateGoalEvidence({diagnostics:{openGoalVerification:proof},provenance:{contextId}},
      {report,calls,rootCallIds:[root.call_id]},world.id,{assignment:world});
  }};
}

test("memory export binds native recall, original replay, immutable bytes, working scope and private result",()=>{
  for(const stage of [true,false])assert.doesNotThrow(fixture(stage).validate);
  for(const mutate of [
    f=>{f.oriented.inputs.question=ref("A different remembered claim");},
    f=>{f.recall.result=ref([]);},
    f=>{f.transcript.args=ref(["foreign-channel"]);},
    f=>{f.archive.result=ref(f.proof.evidence.working);},
    f=>{f.draft.result=f.proof.evidence.working;},
    f=>{f.judgement.output.complete=false;},
    f=>{f.saved.args=ref([f.proof.brief,f.proof.plan,f.proof.evidence]);},
  ]){
    const entry=fixture(true);
    mutate(entry);
    assert.throws(entry.validate,/Expected bounded native memory recall with exact original and immutable evidence/u);
  }
});
