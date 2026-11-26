import {test} from 'node:test';
import assert from 'node:assert/strict';
import {observedContentFields,observedContentNeedsReview,observedContentReviewInput} from './observed-content-admission.mjs';
function sample(){
 const world={kind:'provenance-question',goal:'Find the actual limiting outcome and original local scope.'};
 const proof={semanticReviewRequired:true,outcomeContract:{returnedValue:{required:true}},assignment:{id:'owned'},candidates:[{ref:'proposal',rationale:'Original purpose'}],evidence:{cohort:{paths:[{path:'dock/layout.md',count:1}]},withdrawn:[{counteractionRef:'later-attempt',reason:'The trailer could not turn'}]},native:{head:'current',walks:[{node:'actual-work'}]},effects:[{method:'rejections'}],actualResult:{answer:'The trailer could not turn'},answer:{privateExpected:'This must never prime independent review'}};
 const fields=observedContentFields[world.kind];assert.ok(fields);
 proof.semanticReviewInput={actual:{goal:world.goal,observations:Object.fromEntries(fields[0].map(k=>[k,proof[k]])),artifacts:{},requestedReturn:proof.actualResult},expected:{goal:world.goal,requestedReturnRequired:true},rubric:'Judge the actual requested findings against native recorded evidence.'};return{world,proof};
}
test('requires source-grounded meaning review of the exact actual answer without a private gold report',()=>{const {world,proof}=sample();assert.equal(observedContentNeedsReview(world),true);assert.equal(observedContentReviewInput(proof,world),proof.semanticReviewInput);assert.equal(Object.hasOwn(proof.semanticReviewInput.actual.observations,'answer'),false);});
for(const [name,change] of [['missing review',p=>p.semanticReviewRequired=false],['different actual answer',p=>p.actualResult={answer:'A different unsupported answer'}],['different native record',p=>p.semanticReviewInput.actual.observations.native={head:'foreign'}],['missing requested answer',p=>delete p.actualResult],['optionalized requested answer',p=>p.outcomeContract.returnedValue.required=false]])test('rejects '+name,()=>{const {world,proof}=sample();change(proof);assert.throws(()=>observedContentReviewInput(proof,world));});
