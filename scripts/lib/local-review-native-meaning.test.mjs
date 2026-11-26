import {test} from 'node:test';
import assert from 'node:assert/strict';
import {observedContentFields,observedContentNeedsReview,observedContentReviewInput} from './observed-content-admission.mjs';
for(const kind of ['systemCandidateTriage','scaffoldReview','grimoireScene']){
 function sample(required=true){
  const world={kind,goal:'Inspect the owned current evidence and provide only the requested findings or retained private artifact.'};
  const [keys,artifacts]=observedContentFields[kind];
  const proof={semanticReviewRequired:true,outcomeContract:{returnedValue:{required}},actualResult:required?{finding:'The actual native evidence supports this finding.'}:{incidental:'not requested'}};
  for(const key of keys)proof[key]=key==='journal'?[]:{native:key};
  for(const key of artifacts)proof[key]='Actual independently retained private bytes.';
  proof.semanticReviewInput={actual:{goal:world.goal,observations:Object.fromEntries(keys.map(k=>[k,structuredClone(proof[k])])),artifacts:Object.fromEntries(artifacts.map(k=>[k,proof[k]])),requestedReturn:required?proof.actualResult:null},expected:{goal:world.goal,requestedReturnRequired:required},rubric:'Judge requested meaning against the bound native observations and actual bytes.'};
  return{world,proof,keys,artifacts};
 }
 test(kind+' requires independently bound meaning review for requested findings',()=>{const {world,proof}=sample();assert.equal(observedContentNeedsReview(world),true);assert.equal(observedContentReviewInput(proof,world),proof.semanticReviewInput);});
 test(kind+' retains native goal review when a separate returned value is not requested',()=>{const {world,proof}=sample(false);assert.equal(observedContentReviewInput(proof,world).actual.requestedReturn,null);proof.actualResult={different:'incidental'};assert.equal(observedContentReviewInput(proof,world).actual.requestedReturn,null);});
 for(const problem of ['missing-review','changed-native-evidence','changed-answer','missing-answer'])test(kind+' rejects '+problem,()=>{const {world,proof,keys}=sample();if(problem==='missing-review')proof.semanticReviewRequired=false;else if(problem==='changed-native-evidence')proof.semanticReviewInput.actual.observations[keys[0]]={foreign:true};else if(problem==='changed-answer')proof.actualResult={finding:'A different claim'};else delete proof.actualResult;assert.throws(()=>observedContentReviewInput(proof,world));});
}
