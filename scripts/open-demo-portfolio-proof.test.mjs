import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openTemplateGoalEvidence } from "./export-live-workflow-teacher.mjs";

const hash = text => createHash("sha256").update(text).digest("hex");
function ref(value) {
  const text = JSON.stringify(value);
  return {complete:true,hash:hash(text),bytes:Buffer.byteLength(text)};
}
function sample(status,write,forecast) {
  const world={id:"portfolio-proof",kind:"demo-portfolio",goal:"Check the current portfolio card.",status};
  const index={id:"portfolio"};
  const card=text=>({text,digest:hash(text),title:"Acceptance"});
  const opening={portfolio:index.id,id:"opening",card:card("earlier"),garden:{id:"garden-opening"},realm:{id:"realm-opening",month:3}};
  const current={portfolio:index.id,id:"current",card:card("latest"),garden:{id:"garden-current"},realm:{id:"realm-current",month:4}};
  const projection=forecast?{portfolio:index.id,months:1,basis:current.id,accounts:{id:"realm-project",month:5}}:null;
  const gardenCriterion={kind:"habitat",check:{kind:"is-home",resident:"sol",home:"hollow"}};
  const realmCriterion={kind:"settlement",basis:forecast?"forecast":"saved",check:{kind:"region-grain-at-least",region:"harbor",amount:3}};
  const gardenRequest={kind:"habitat",check:gardenCriterion.check,current:current.garden};
  const realmRequest={kind:"settlement",check:realmCriterion.check,current:projection?.accounts??current.realm};
  const gardenResult={criterion:gardenCriterion,review:{decision:"supported",finding:"chosen-home",evidenceIds:[current.garden.id]}};
  const realmResult={criterion:realmCriterion,review:{decision:status==="ready"?"supported":status==="blocked"?"contradicted":"not-observed",
    finding:"regional-reserves",evidenceIds:[realmRequest.current.id]}};
  const garden=[gardenResult],realm=[realmResult];
  const plan={criteriaBasis:current.card.digest,garden:[gardenCriterion],realm:[realmCriterion],months:forecast?1:null,note:write?"decision":"none"};
  const decision={status,write,explanation:"Reviewed current evidence."};
  const artifact=write?JSON.stringify({scope:"private-local",portfolio:index.id,opening:opening.id,current:current.id,
    acceptedCard:current.card,readings:{garden,realm}}):null;
  const note=artifact?{path:"/.tmp/portfolio/handoff.json",portfolio:index.id,basis:current.id,digest:hash(artifact)}:null;
  const checks=Object.fromEntries(["exactOwnedPair","independentlyReadPortfolioCards","settledPortfolioGarden","settledPortfolioRealm",
    "exactCurrentPortfolioPlan","exactPortfolioForecast","exactInstalledGardenCriteria","exactInstalledRealmCriteria",
    "groundedPortfolioDecision","verifiedPrivatePortfolioHandoff","preservedPortfolioWorkspace","rejectedPortfolioRetarget"].map(key=>[key,true]));
  const proof={contextId:"ctx",passed:true,caseId:world.id,goal:world.goal,checks,index,frames:[opening,current],plan,projection,
    garden:[{request:gardenRequest,result:gardenResult}],realm:[{request:realmRequest,result:realmResult}],decision,note,artifact};
  const outcome={plan,opening,current,projection,garden,realm,decision,note};
  const report={status:"workspace-skill-reviewed",skill:"demoPortfolio",outcome};
  const calls=[];
  const node=(name,parent,fields={})=>{
    const row={call_id:String(calls.length),parent_call_id:parent?.call_id,definition:{name},outcome:"done",...fields};
    calls.push({record:row,callId:row.call_id});
    return row;
  };
  const root=node("runUserGoal",null,{inputs:{goal:ref(world.goal)}});
  const skill=node("workOnDemoPortfolio",root,{inputs:{goal:ref(world.goal)}});
  const effect=(name,service,method,args,result)=>{
    const row={service,method,args:ref(args),result:ref(result)};
    node(name,skill,{effects:[row]});
    return row;
  };
  effect("findPortfolio","demoPortfolioIndex","list",[],index);
  const frontiers=proof.frames.map(frame=>effect("readPortfolioFrame","demoPortfolioState","read",[index.id],frame));
  const planned=node("choosePortfolioCriteria",skill,{inputs:{goal:ref(world.goal),opening:ref(opening),current:ref(current)},output:ref(plan)});
  const preview=projection?effect("readPortfolioForecast","demoPortfolioForecast","preview",[index.id,current.id,1],projection):null;
  const g=node("reviewPortfolioGarden",skill,{inputs:{criteria:ref([gardenCriterion]),opening:ref(opening),current:ref(current)},output:ref(garden)});
  const r=node("reviewPortfolioRealm",skill,{inputs:{criteria:ref([realmCriterion]),opening:ref(opening),current:ref(current),projection:ref(projection)},output:ref(realm)});
  const gl=node("reviewGarden",g,{inputs:{review:ref(gardenRequest)},output:ref(gardenResult.review)});
  const rl=node("reviewRealm",r,{inputs:{review:ref(realmRequest)},output:ref(realmResult.review)});
  const leaf=node("inspectHabitat",gl);
  node("inspectSettlement",rl);
  const decided=node("decidePortfolioDelivery",skill,{inputs:{goal:ref(world.goal),current:ref(current),plan:ref(plan),garden:ref(garden),
    realm:ref(realm)},output:ref(decision)});
  const stage=write?effect("stagePortfolioHandoff","demoPortfolioHandoff","stage",[{...outcome,note:null}],note):null;
  return {frontiers,planned,preview,leaf,rl,decided,stage,proof,validate(){
    skill.output=ref(outcome);
    return openTemplateGoalEvidence({diagnostics:{openGoalVerification:proof},provenance:{contextId:"ctx"}},
      {report,calls,rootCallIds:[root.call_id]},world.id,{assignment:world});
  }};
}

test("paired demo export checks both installed skills, current card references and optional local handoff",()=>{
  assert.doesNotThrow(sample("ready",true,true).validate);
  assert.doesNotThrow(sample("blocked",true,false).validate);
  assert.doesNotThrow(sample("incomplete",false,false).validate);
  for (const fault of [
    value=>{value.frontiers[1].result=value.frontiers[0].result;},
    value=>{value.planned.inputs.current.complete=false;},
    value=>{value.preview.args=ref(["portfolio","opening",1]);},
    value=>{value.leaf.parent_call_id="foreign";},
    value=>{value.rl.inputs.review=ref({kind:"settlement",current:"claimed archive"});},
    value=>{value.decided.inputs.garden=ref([]);},
    value=>{value.stage.result.hash=hash("swapped");},
    value=>{value.proof.artifact+=" ";},
  ]) {
    const value=sample("ready",true,true);
    fault(value);
    assert.throws(value.validate,/Expected exact paired Grimoire and Regency evidence/u);
  }
});
