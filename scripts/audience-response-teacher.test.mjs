import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import test from "node:test";
import {openTemplateGoalEvidence} from "./export-live-workflow-teacher.mjs";

function ref(value){
  const json=JSON.stringify(value);
  return {complete:true,hash:createHash("sha256").update(json).digest("hex"),bytes:Buffer.byteLength(json)};
}
function fixture(mode){
  const world={id:"audience-cost",kind:"audience-response",mode,goal:"Help our reader understand the current estimate."};
  const contextId="owned";
  const id="cost",revision="basis";
  const model=mode==="calculator"?{id,title:"Cost",inputLabel:"Quantity",outputLabel:"Cost",
    baseCents:250,unitCents:150,divisor:1,min:1,max:5,initial:2}:null;
  const sections=mode==="plain"?[]:[{id,required:true,ask:"Estimate",data:"Known limits"}];
  const facts=[{id:"initial estimate",value:"$5.50"}];
  const record={id:"owned-record",revision,title:"Cost estimate",source:"Signed sheet",facts,sections,model};
  const choice={mode,reason:"Use the representation that answers the reader's request."};
  const answer={facts,text:"The current estimate is $5.50."};
  const presentation={views:[mode==="calculator"?{id,status:"deferred",component:"Calculator"}:{id,status:"plain"}],omitted:[]};
  const prepared=mode==="plain"?null:{presentation,modelId:model?.id??null};
  const interaction=model?{inputLabel:"Quantity",beforeInput:2,afterInput:4,beforeResult:"$5.50",afterResult:"$8.50"}:null;
  const receipt=mode==="plain"?null:{revision,ids:[id],mdxDigests:["exact-mounted-body"],interaction};
  const observed={mdxDigests:receipt?.mdxDigests??[],rendered:{revision:receipt?.revision??null,ids:receipt?.ids??[]}};
  const checks=Object.fromEntries(["exactAudienceRecord","appropriateAudienceFormat","boundedGroundedAudienceAnswer",
    "verifiedNativeAudienceRendering","verifiedAudienceInteraction","preservedAudienceState"].map(key=>[key,true]));
  const outcome={record,choice,answer,prepared,receipt};
  const proof={caseId:world.id,goal:world.goal,contextId,checks,passed:true,report:outcome,observed};
  const report={status:"workspace-skill-reviewed",skill:"audienceResponse",outcome};
  const calls=[];
  const node=(name,parent,fields={})=>{
    const record={call_id:String(calls.length),parent_call_id:parent?.call_id,definition:{name},outcome:"done",...fields};
    calls.push({callId:record.call_id,record});
    return record;
  };
  const root=node("runUserGoal",null,{inputs:{goal:ref(world.goal)}});
  const skill=node("chooseAudienceResponse",root,{inputs:{goal:ref(world.goal)},output:ref(outcome)});
  function effect(name,method,args,value){
    const row={service:"nativeAudienceResponse",method,args:ref(args),result:ref(value)};
    node(name,skill,{effects:[row]});
    return row;
  }
  effect("readAudienceRecord","readRecord",[],record);
  const decision=node("decideAudienceFormat",skill,{inputs:{goal:ref(world.goal),record:ref(record)},output:ref(choice)});
  const text=node("answerFromRecord",skill,{inputs:{goal:ref(world.goal),record:ref(record),choice:ref(choice)},output:ref(answer)});
  let installed,written;
  if(prepared){
    const selected=node("prepareAudienceVisual",skill,{inputs:{goal:ref(world.goal),record:ref(record),choice:ref(choice)},output:ref(prepared)});
    installed=node("preparePresentation",selected,{inputs:{request:ref({goal:world.goal,sections})},output:ref(presentation)});
    written=effect("renderAudienceVisual","render",[record.id,revision,prepared],receipt);
  }
  return {proof,decision,text,installed,written,addUnrequestedRender(){
    effect("renderAudienceVisual","render",[record.id,"old",null],null);
  },validate(){
    return openTemplateGoalEvidence({diagnostics:{openGoalVerification:proof},provenance:{contextId}},
      {report,calls,rootCallIds:[root.call_id]},world.id,{assignment:world});
  }};
}

test("audience proof requires exact grounded answer, installed planner, and bounded renderer effects",()=>{
  for(const mode of ["plain","catalog","calculator"])assert.doesNotThrow(fixture(mode).validate);
  const plain=fixture("plain");
  plain.addUnrequestedRender();
  assert.throws(plain.validate,/Expected an appropriate grounded audience answer/u);
  for(const mutate of [
    row=>{row.decision.inputs.record=ref({id:"other"});},
    row=>{row.text.output.complete=false;},
    row=>{row.installed.output=ref(null);},
    row=>{row.written.args=ref(["old","other",null]);},
    row=>{row.proof.observed.rendered.ids=["unowned"];},
  ]){
    const row=fixture("calculator");
    mutate(row);
    assert.throws(row.validate,/Expected an appropriate grounded audience answer/u);
  }
});
