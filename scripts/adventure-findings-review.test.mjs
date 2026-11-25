import {test} from "node:test";
import assert from "node:assert/strict";
import {adventureJourneyReviewInput} from "./lib/source-claim-admission.mjs";
function sample(){
 const world={kind:"adventure-journey",goal:"Compare Front Steps and Counter; leave both alone.",saves:[{label:"Counter"},{label:"Front Steps"}],expected:{save:1,compared:[0]}};
 const assigned=[{id:"opaque-counter",label:"Counter"},{id:"opaque-front",label:"Front Steps"}];
 const before=[{save:assigned[0],observation:"native-counter",place:{id:"customs"},tick:0,scene:{signature:"counter",artwork:"missing"}},{save:assigned[1],observation:"native-front",place:{id:"landing"},tick:0,scene:{signature:"front",artwork:"missing"}}];
 const final=structuredClone(before),readbacks=structuredClone(before),actions=[];
 const observations={assigned,before,final,readbacks,actions,selected:assigned[1].id,comparison:[assigned[0].id]};
 const report={evidence:[{topic:"same-scene",subject:"Front Steps and Counter",verdict:"refuted"},{topic:"same-time",subject:"both bookmarks",verdict:"confirmed"}]};
 const proof={semanticReviewRequired:true,assigned,initial:before,nativeReadback:final,readbacks,actions,selected:assigned[1].id,final:final[1],journeyObservations:observations};
 proof.semanticReviewInput={actual:{goal:world.goal,observations,requestedReturn:report},expected:{goal:world.goal,requestedReturnRequired:true},rubric:"Judge the actual requested findings against these native player snapshots."};
 return{world,report,proof};
}
test("binds human-labelled captured Adventure findings without returned receipt echoes",()=>{const s=sample();assert.equal(adventureJourneyReviewInput(s.proof,s.world,s.report),s.proof.semanticReviewInput);});
test("binds additional claims as actual bytes rather than imposing a golden evidence count",()=>{const s=sample();s.report.evidence.push({topic:"scene",subject:"Front Steps illustration",verdict:"refuted"});assert.equal(adventureJourneyReviewInput(s.proof,s.world,s.report).actual.requestedReturn,s.report);});
for(const field of ["requestedReturn","goal","expected","readbacks","actions","selected","comparison","nativeFinal","nativeBefore"]){
 test(`refuses substituted Adventure ${field} before semantic review`,()=>{const s=sample();s.proof.semanticReviewInput=structuredClone(s.proof.semanticReviewInput);const input=s.proof.semanticReviewInput;
  if(field==="requestedReturn")input.actual.requestedReturn.evidence[0].verdict="confirmed";
  else if(field==="goal")input.actual.goal="A different instruction";
  else if(field==="expected")input.expected.requestedReturnRequired=false;
  else if(field==="nativeFinal")s.proof.nativeReadback=[];
  else if(field==="nativeBefore")s.proof.initial=[];
  else if(field==="selected")input.actual.observations.selected="foreign-save";
  else if(field==="comparison")input.actual.observations.comparison=[];
  else input.actual.observations[field]=["fabricated"];
  assert.throws(()=>adventureJourneyReviewInput(s.proof,s.world,s.report),/Adventure findings review differs/);
 });
}
test("required findings cannot be replaced by a blocked report or omitted return",()=>{for(const value of [undefined,{disposition:"blocked",reason:"No need to answer"},{evidence:[]}]){const s=sample();assert.throws(()=>adventureJourneyReviewInput(s.proof,s.world,value),/Adventure findings review differs/);}});
test("a different declared comparison cannot reuse this review",()=>{const s=sample();s.world.expected.compared=[];assert.throws(()=>adventureJourneyReviewInput(s.proof,s.world,s.report),/Adventure findings review differs/);});
test("all claimed falsehoods remain visible to independent review",()=>{const s=sample();s.report.evidence[0].verdict="confirmed";const input=adventureJourneyReviewInput(s.proof,s.world,s.report);assert.equal(input.actual.requestedReturn.evidence[0].verdict,"confirmed");assert.notEqual(input.actual.observations.final[0].scene.signature,input.actual.observations.final[1].scene.signature);});
test("the real authored registry declares independent review and the actual Findings type",async()=>{
 const {default:config}=await import("../src/dev/developmentTemplateConfig.cjs");
 const {loadLiveTeacherCases}=await import("./export-live-workflow-teacher.mjs");
 const {checkouts}=config.requireDevelopmentTemplateCheckouts(new URL("..",import.meta.url).pathname);
 const worlds=[...(await loadLiveTeacherCases(checkouts)).values()].filter(row=>row.assignment?.kind==="adventure-journey");
 assert.equal(worlds.length,16);for(const world of worlds){assert.equal(world.requiresReview,true);assert.equal(world.entry.resultType,"JourneyFindings");}
});

test("self-consistent missing native projections cannot obtain review",()=>{const s=sample();for(const key of ["assigned","initial","nativeReadback","readbacks","actions","selected","final"])delete s.proof[key];s.proof.journeyObservations={comparison:[]};s.world.expected.compared=[];s.proof.semanticReviewInput.actual.observations=s.proof.journeyObservations;assert.throws(()=>adventureJourneyReviewInput(s.proof,s.world,s.report),/Adventure findings review differs/);});
