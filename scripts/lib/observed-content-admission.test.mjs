import {test} from "node:test";
import assert from "node:assert/strict";
import {observedContentFields,observedContentNeedsReview,observedContentReviewInput} from "./observed-content-admission.mjs";
function example(required=true){
 const world={kind:"image-candidate",goal:"Explain whether the source is available"};
 const proof={outcomeContract:{returnedValue:{required}},semanticReviewRequired:true,index:{id:"owned"},snapshots:[{revision:2}],reads:[{status:"missing"}],artifact:required?null:"Actual retained prose",actualResult:{reason:"The original was removed"}};
 proof.semanticReviewInput={actual:{goal:world.goal,observations:{index:proof.index,snapshots:proof.snapshots,reads:proof.reads},artifacts:{artifact:proof.artifact},requestedReturn:required?proof.actualResult:null},expected:{goal:world.goal,requestedReturnRequired:required},rubric:"Judge supported meaning; accept paraphrases and reject contradictions"};
 return {world,proof};
}
test("binds each domain's actual proof independently of authored answer vocabulary",()=>{
 const {world,proof}=example();assert.equal(observedContentReviewInput(proof,world),proof.semanticReviewInput);
 assert.equal(Object.keys(observedContentFields).length,27);
 for(const mutation of [p=>p.semanticReviewInput.actual.requestedReturn={reason:"Invented"},p=>p.semanticReviewInput.actual.observations.reads=[],p=>p.semanticReviewInput.actual.artifacts.artifact="Invented",p=>p.semanticReviewInput.actual.goal="Different goal",p=>p.semanticReviewRequired=false]){
  const clone=structuredClone(proof);mutation(clone);assert.throws(()=>observedContentReviewInput(clone,world));
 }
});
test("excludes wrong optional returns while preserving exact retained artifact review",()=>{
 const {world,proof}=example(false);proof.actualResult={reason:"Wrong incidental claim"};
 assert.equal(observedContentReviewInput(proof,world).actual.requestedReturn,null);
 proof.semanticReviewInput.actual.artifacts.artifact="Replacement";assert.throws(()=>observedContentReviewInput(proof,world));
});
test("native-only effects exclude incidental prose without waiving a required domain answer",()=>{
 const world={kind:"owned-task",goal:"Mark this card done",expected:{update:"done"}};
 const fields=observedContentFields[world.kind],proof={outcomeContract:{returnedValue:{required:false}},semanticReviewRequired:false};
 const pick=keys=>Object.fromEntries(keys.map(key=>[key,null]));
 proof.semanticReviewInput={actual:{goal:world.goal,observations:pick(fields[0]),artifacts:{},requestedReturn:null},expected:{goal:world.goal,requestedReturnRequired:false},rubric:"Native effect is authoritative"};
 assert.equal(observedContentReviewInput(proof,world),null);
 proof.outcomeContract.returnedValue.required=true;assert.throws(()=>observedContentReviewInput(proof,world));
});

test("native displayed presentations require goal review even with no requested return",()=>{
 const world={kind:"localPresentation",goal:"Show two confirmed rooms here without reserving anything",expected:{holds:null}};
 const proof={outcomeContract:{returnedValue:{required:false}},semanticReviewRequired:true,
  current:{source:"Confirmed rooms Cedar; Willow"},journal:[],preview:{revision:"actual"},previewDisplay:{passed:true},
  report:{views:[{component:"Choices",props:{id:"actual-choices",question:"Which room?",options:["Cedar","Willow"],multiple:false}}]},
  display:{passed:true,rendered:{texts:["Which room? Cedar Willow"],controls:[[{role:"radio",disabled:false}]]}}};
 const pick=keys=>Object.fromEntries(keys.map(key=>[key,proof[key]??null]));
 const [observations,artifacts]=observedContentFields.localPresentation;
 proof.semanticReviewInput={actual:{goal:world.goal,observations:pick(observations),artifacts:pick(artifacts),requestedReturn:null},
  expected:{goal:world.goal,requestedReturnRequired:false},rubric:"Judge actual goal meaning and visible enabled controls"};
 assert.equal(observedContentNeedsReview(world),true);
 assert.equal(observedContentReviewInput(proof,world),proof.semanticReviewInput);
 for(const alter of [p=>p.semanticReviewRequired=false,p=>p.semanticReviewInput.actual.artifacts.display={passed:true},
  p=>p.semanticReviewInput.actual.artifacts.report={views:[]},p=>p.semanticReviewInput.actual.observations.previewDisplay=null]){
  const changed=structuredClone(proof);alter(changed);assert.throws(()=>observedContentReviewInput(changed,world));
 }
});
