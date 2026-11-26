import {test} from 'node:test';
import assert from 'node:assert/strict';
import {editorialReviewInput} from './lib/source-claim-admission.mjs';
function fixture(required,written){
 const world={kind:'editorial-packet',goal:'Review the current approved correction',requestedReturnRequired:required,literalApprovedWording:false,note:'none',end:'reviewed',fields:[{label:'Hours'}]};
 const decision={status:'reviewed',write:false,explanation:'Actual approved hours agree with the stored draft'};
 const document={path:'candidate.md',version:'native',text:'Hours: 9 to 3'};
 const mission={id:'owned',revision:1};
 const root={document:{path:document.path,version:document.version},decision,note:null};
 const proof={semanticReviewRequired:true,actualResult:root,artifact:null,plan:{operation:'review'},attempts:written?[{result:{status:'written'}}]:[],stored:document,snapshots:[{candidate:document,mission}],sources:[]};
 const input={actual:{goal:world.goal,retainedDocument:document,originalDocument:document,currentObservation:document,currentMission:mission,approvedTextSources:[],decision:required?decision:null,retainedHandoff:null},expected:{goal:world.goal,fields:['Hours'],literalApprovedWording:false,operation:'review',returnedDecisionRequired:required,retainedHandoffRequired:false},rubric:'Judge requested meaning against native evidence'};
 proof.semanticReviewInput=input;return{world,root,proof,input};
}
test('editorial requested answer is bound after a successful mutation as well as a read-only review',()=>{
 for(const written of [true,false]){const s=fixture(true,written);assert.equal(editorialReviewInput(s.proof,s.world,s.root),s.input);}
});
test('effect-only editorial completion excludes optional returned bookkeeping',()=>{
 const s=fixture(false,true);assert.equal(editorialReviewInput(s.proof,s.world,undefined),s.input);
 s.input.actual.decision={status:'held',explanation:'Unrequested'};assert.throws(()=>editorialReviewInput(s.proof,s.world,s.root),/Editorial review differs/);
});
test('a swapped editorial answer and sidecar cannot replace the actual captured answer',()=>{
 const s=fixture(true,true);s.proof.actualResult={...s.root,decision:{...s.root.decision,explanation:'Forged'}};s.input.actual.decision=s.proof.actualResult.decision;
 assert.throws(()=>editorialReviewInput(s.proof,s.world,s.root),/Editorial review differs/);
});
test('missing requested answer or changing its authored obligation cannot use a valid stored effect',()=>{
 const s=fixture(true,true);assert.throws(()=>editorialReviewInput(s.proof,s.world,null),/Editorial review differs/);
 s.input.expected.returnedDecisionRequired=false;s.input.actual.decision=null;assert.throws(()=>editorialReviewInput(s.proof,s.world,s.root),/Editorial review differs/);
});
