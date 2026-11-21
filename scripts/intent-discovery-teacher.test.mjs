import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import test from "node:test";
import {openTemplateGoalEvidence} from "./export-live-workflow-teacher.mjs";

const hash=text=>createHash("sha256").update(text).digest("hex");
function ref(value){
  const text=JSON.stringify(value);
  return {complete:true,hash:hash(text),bytes:Buffer.byteLength(text)};
}
function fixture(stage){
  const world={id:"owned-intent",kind:"intent-discovery",goal:"Find what matters in the current handoff.",private:stage};
  const contextId="owned",methodId="service:fs.readBytes",scope="/.tmp/private/note.txt";
  const notice={title:"Owned handoff",contextId,notePath:scope,skillName:"workspace-dev",workerKey:"local"};
  const queries=["local retained bytes"];
  const found={id:methodId,name:"fs.readBytes",description:"Read a bounded byte range."};
  const search={queries,hits:[[found]],described:[{...found,digest:"catalog-exact"}]};
  const plan={actions:[{methodId,scope}],retain:stage};
  const evidence=[{methodId,scope,status:"observed",coordinate:scope,details:[""],digest:"exact-empty"}];
  const outcome={status:"observed",summary:"The selected local note exists and is empty."};
  const artifact=stage?JSON.stringify({visibility:"private-local",notice,plan,evidence,outcome}):null;
  const handoff=artifact?{path:"/.tmp/private/handoff.json",digest:hash(artifact)}:null;
  const checks=Object.fromEntries(["exactIntentNotice","installedIntentDiscovery","exactIntentActionSelection","independentlyScopedIntentResults",
    "exactIntentOutcome","exactPrivateIntentNote","preservedIntentWorkspace","rejectedIntentRetarget"].map(key=>[key,true]));
  const proof={caseId:world.id,goal:world.goal,contextId,checks,passed:true,notice,search,plan,evidence,outcome,handoff,artifact};
  const result={notice,search,plan,evidence,outcome,handoff};
  const report={status:"workspace-skill-reviewed",skill:"intentDiscovery",outcome:result};
  const calls=[];
  function node(name,parent,fields={}){
    const record={call_id:String(calls.length),parent_call_id:parent?.call_id,definition:{name},outcome:"done",...fields};
    calls.push({callId:record.call_id,record});return record;
  }
  const root=node("runUserGoal",null,{inputs:{goal:ref(world.goal)}});
  const skill=node("discoverScopedIntent",root,{inputs:{goal:ref(world.goal)},output:ref(result)});
  function effect(name,parent,service,method,args,value){
    const row={service,method,args:ref(args),result:ref(value)};
    node(name,parent,{effects:[row]});return row;
  }
  effect("readIntentNotice",skill,"nativeIntentDiscovery","notice",[],notice);
  const searched=node("searchRelevantIntent",skill,{inputs:{goal:ref(world.goal),notice:ref(notice)},output:ref(search)});
  const query=effect("searchIntentCatalog",searched,"nativeIntentDiscovery","search",[queries[0]],search.hits[0]);
  const described=effect("describeIntentCapability",searched,"nativeIntentDiscovery","describe",[methodId],search.described[0]);
  node("chooseIntentActions",skill,{inputs:{goal:ref(world.goal),notice:ref(notice),search:ref(search)},output:ref(plan)});
  const read=effect("inspectIntentEvidence",skill,"nativeIntentDiscovery","inspect",[methodId,scope],evidence[0]);
  node("concludeIntentReview",skill,{inputs:{goal:ref(world.goal),plan:ref(plan),evidence:ref(evidence)},output:ref(outcome)});
  const written=handoff?effect("stageIntentNote",skill,"nativeIntentHandoff","stage",[{...result,handoff:null}],handoff):null;
  return {proof,query,described,read,written,validate(){
    return openTemplateGoalEvidence({diagnostics:{openGoalVerification:proof},provenance:{contextId}},
      {report,calls,rootCallIds:[root.call_id]},world.id,{assignment:world});
  }};
}

test("intent discovery export authenticates actual catalog search, exact installed schema and scoped evidence",()=>{
  for(const stage of [true,false])assert.doesNotThrow(fixture(stage).validate);
  for(const mutate of [
    x=>{x.query.result=ref([]);},
    x=>{x.described.result=x.proof.search.described[0];},
    x=>{x.read.args=ref(["service:fs.readBytes","/.tmp/sibling/note.txt"]);},
    x=>{x.read.result=ref({...x.proof.evidence[0],status:"missing"});},
    x=>{x.written.result.complete=false;},
    x=>{x.proof.artifact+=" ";},
  ]){
    const entry=fixture(true);
    mutate(entry);
    assert.throws(entry.validate,/Expected installed intent discovery and independently scoped native evidence/u);
  }
});
