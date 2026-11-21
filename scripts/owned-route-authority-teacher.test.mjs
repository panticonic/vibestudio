import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import test from "node:test";
import {openTemplateGoalEvidence} from "./export-live-workflow-teacher.mjs";

const hash=text=>createHash("sha256").update(text).digest("hex");
function ref(value){
  const text=JSON.stringify(value);
  return {complete:true,hash:hash(text),bytes:Buffer.byteLength(text)};
}
function fixture(basis,stage){
  const world={id:"owned-route",kind:"route-authority",goal:"Resolve my exact owned evidence.",route:basis,note:stage};
  const contextId="owned-context";
  const operations=[{id:"native",label:"Local evidence"},{id:"external",label:"Link preflight"}];
  const ceiling=[];
  const routes=[{id:"current",basis:"comparison",operationIds:["native"]},
    {id:"link",basis:"external",operationIds:["external"],origin:"https://review.example.invalid"}];
  const choice={routeId:basis==="external"?"link":"current",execute:basis!=="external",retain:stage,reason:"Exact scoped source."};
  const offer={title:"Owned register",routes,request:{goal:world.goal,operations,ceiling}};
  const protectedLeaves=[{capability:"external.open",resourceKey:"https://review.example.invalid"}];
  const snapshots=[{operationId:"native",decision:"allowed",leaves:[]},
    {operationId:"external",decision:"acquirable",leaves:[{...protectedLeaves[0],tier:"gated",status:"acquirable"}]}];
  const reviews=[{observation:snapshots[0],outside:[],disposition:"eligible"},
    {observation:snapshots[1],outside:protectedLeaves,disposition:"outside-ceiling"}];
  const summary={status:"held",protectedLeaves,held:["external"]};
  const authority={...summary,reviews};
  const readback=choice.execute?{routeId:choice.routeId,records:[{basis:"working",value:"new"},null]}:null;
  const outcome={status:readback?"missing":"outside-limit",summary:"Only the selected scope was observed."};
  const artifact=stage?JSON.stringify({visibility:"private-local",routeId:choice.routeId,outcome,readback,
    reviewedOperations:snapshots.map(row=>row.operationId)}):null;
  const handoff=artifact?{path:"/.tmp/private/owned",digest:hash(artifact)}:null;
  const checks=Object.fromEntries(["exactRouteDiscovery","exactOrderedRoutePreflight","exactCanonicalOriginCeiling","selectedExactLocalAuthority",
    "nativeRouteReadback","preservedExactProtectedBasis","exactRouteConclusion","exactPrivateRouteNote","rejectedRouteRetarget"].map(key=>[key,true]));
  const proof={caseId:world.id,goal:world.goal,contextId,checks,passed:true,offer,snapshots,authority,choice,readback,outcome,handoff,artifact};
  const result={offer,authority,choice,readback,outcome,handoff};
  const report={status:"workspace-skill-reviewed",skill:"ownedRouteAuthority",outcome:result};
  const calls=[];
  function node(name,parent,fields={}){
    const record={call_id:String(calls.length),parent_call_id:parent?.call_id,definition:{name},outcome:"done",...fields};
    calls.push({callId:record.call_id,record});return record;
  }
  const root=node("runUserGoal",null,{inputs:{goal:ref(world.goal)}});
  const skill=node("chooseAuthorizedEvidenceRoute",root,{inputs:{goal:ref(world.goal)},output:ref(result)});
  function effectNode(name,service,method,args,value){
    const row={service,method,args:ref(args),result:ref(value)};
    node(name,skill,{effects:[row]});return row;
  }
  effectNode("discoverEvidenceRoutes","routeEvidenceRead","discover",[],offer);
  const authorityNode=node("inspectExactRouteAuthority",skill,{inputs:{request:ref(offer.request)},output:ref(authority)});
  const installed=node("reviewAuthority",authorityNode,{inputs:{request:ref(offer.request)},output:ref(authority)});
  const preflights=[],stages=[];
  for(const [i,operation] of operations.entries()){
    const review=reviews[i],observed=snapshots[i];
    const stage=node("reviewOperation",installed,{inputs:{operationId:ref(operation.id),ceiling:ref(ceiling)},output:ref(review)});
    stages.push(stage);
    preflights.push(node("preflight",stage,{inputs:{operationId:ref(operation.id)},output:ref(observed),effects:[
      {service:"assignedAuthorityRead",method:"preflight",args:ref([operation.id]),result:ref(observed)},
    ]}));
    node("findOutside",stage,{inputs:{leaves:ref(observed.leaves),ceiling:ref(ceiling)},output:ref(review.outside)});
    node("decideDisposition",stage,{inputs:{decision:ref(observed.decision),outside:ref(review.outside)},output:ref(review.disposition)});
  }
  const combined=node("combineCeiling",installed,{inputs:{reviews:ref(reviews)},output:ref(summary)});
  node("collectProtected",combined,{inputs:{reviews:ref(reviews)},output:ref(protectedLeaves)});
  node("selectEvidenceRoute",skill,{inputs:{goal:ref(world.goal),offer:ref(offer),authority:ref(authority)},output:ref(choice)});
  const read=readback?effectNode("readSelectedEvidenceRoute","routeEvidenceRead","inspect",[choice.routeId],readback):null;
  node("concludeEvidenceRoute",skill,{inputs:{goal:ref(world.goal),offer:ref(offer),authority:ref(authority),choice:ref(choice),
    readback:ref(readback)},output:ref(outcome)});
  const written=handoff?effectNode("stageRouteReview","routeEvidenceHandoff","stage",[{...result,handoff:null}],handoff):null;
  return {proof,preflights,stages,read,written,validate(){
    return openTemplateGoalEvidence({diagnostics:{openGoalVerification:proof},provenance:{contextId}},
      {report,calls,rootCallIds:[root.call_id]},world.id,{assignment:world});
  }};
}

test("route authority export binds installed preflights, complete operation sets and the exact selected local effect",()=>{
  for(const basis of ["comparison","external"])
    for(const note of [true,false])assert.doesNotThrow(fixture(basis,note).validate);
  for(const change of [
    x=>{x.preflights[0].parent_call_id=x.stages[1].call_id;},
    x=>{x.preflights[1].effects[0].result=x.proof.snapshots[1];},
    x=>{x.stages[1].inputs.operationId=x.stages[0].inputs.operationId;},
    x=>{x.read.args=ref(["outside"]);},
    x=>{x.written.result.complete=false;},
    x=>{x.proof.artifact+=" ";},
  ]){
    const value=fixture("comparison",true);
    change(value);
    assert.throws(value.validate,/Expected exact route authority, selected local evidence and independent scope/u);
  }
});
