import {test} from 'node:test';
import assert from 'node:assert/strict';
import {observedContentFields,observedContentNeedsReview,observedContentReviewInput} from './observed-content-admission.mjs';
function sample(){
 const world={kind:'desktopReadiness',goal:'Find whether the schedule is parked or gone and explain how to continue without rebuilding.'};
 const proof={semanticReviewRequired:true,outcomeContract:{returnedValue:{required:true}},desk:{id:'owned'},window:{status:'restored',current:{width:840,resident:['right'],parkedLeft:['left'],focused:'records'}},updates:{portCalls:0},exactAdmission:{source:'actual'},journal:[{method:'readWindow',args:['owned']}],actualResult:{reason:'The schedule remains parked in the retained left column at this narrow viewport.'}};
 const fields=observedContentFields[world.kind];assert.ok(fields);
 proof.semanticReviewInput={actual:{goal:world.goal,observations:Object.fromEntries(fields[0].map(k=>[k,proof[k]])),artifacts:{},requestedReturn:proof.actualResult},expected:{goal:world.goal,requestedReturnRequired:true},rubric:'Judge the requested findings against actual native facts without a fixed action taxonomy'};
 return{world,proof};
}
test('binds the actual required explanation and native layout without a private action label',()=>{const {world,proof}=sample();assert.equal(observedContentNeedsReview(world),true);assert.equal(observedContentReviewInput(proof,world),proof.semanticReviewInput);assert.equal(proof.actualResult.action,undefined);});
for(const [name,change] of [['missing review',p=>p.semanticReviewRequired=false],['different returned explanation',p=>p.actualResult={reason:'Different claim'}],['different reviewed window',p=>p.semanticReviewInput.actual.observations.window={status:'invalid'}],['missing required answer',p=>{delete p.actualResult;}],['optionalized requested query',p=>p.outcomeContract.returnedValue.required=false]])test('rejects '+name,()=>{const {world,proof}=sample();change(proof);assert.throws(()=>observedContentReviewInput(proof,world));});
