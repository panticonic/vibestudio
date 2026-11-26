import test from 'node:test';import assert from 'node:assert/strict';
import {referenceReviewInput} from './review-evidence-roles.mjs';
import {observedContentReviewInput} from './observed-content-admission.mjs';
function fixture(){
 const world={kind:'build-incident',goal:'If approval was withdrawn preserve the setting and explain whether we can proceed'};
 const proof={semanticReviewRequired:true,outcomeContract:{returnedValue:{required:true}},actualResult:{reason:'Review withdrawn'},
  subject:{id:'owned'},current:{notice:'paper'},baseline:{notice:'paper'},metadata:{window:'closed'},handoffText:null,
  effects:[{service:'reconcile',method:'apply',args:['old',{notice:'shift-board'}],result:{status:'changed',head:'withdrawn'}}]};
 const legacy={actual:{goal:world.goal,observations:Object.fromEntries(['subject','current','baseline','metadata','effects'].map(k=>[k,proof[k]])),artifacts:{handoffText:null},requestedReturn:proof.actualResult},expected:{goal:world.goal,requestedReturnRequired:true},rubric:'Judge the requested explanation using native state'};
 proof.semanticReviewInput=referenceReviewInput(legacy);return {world,proof,legacy};
}
test('native state/results are reference; proposed edit remains only an attempted argument',()=>{
 const {world,proof,legacy}=fixture(),before=structuredClone(legacy);
 assert.equal(observedContentReviewInput(proof,world),proof.semanticReviewInput);
 assert.deepEqual(proof.semanticReviewInput.expected.observations.current,{notice:'paper'});
 assert.deepEqual(proof.semanticReviewInput.expected.observations.effects[0].result,{status:'changed',head:'withdrawn'});
 assert.equal(JSON.stringify(proof.semanticReviewInput.expected).includes('shift-board'),false);
 assert.deepEqual(proof.semanticReviewInput.actual.attemptedArguments[0].arguments,['old',{notice:'shift-board'}]);
 assert.deepEqual(legacy,before);
});
for(const[label,alter]of[
 ['invented reference state',p=>p.semanticReviewInput.expected.observations.current.notice='shift-board'],
 ['promoted attempted edit',p=>p.semanticReviewInput.expected.observations.effects[0].args=['old',{notice:'shift-board'}]],
 ['swapped result',p=>p.semanticReviewInput.expected.observations.effects[0].result.status='accepted'],
 ['changed attempted input',p=>p.semanticReviewInput.actual.attemptedArguments[0].arguments=[]],
 ['dropped attempted input',p=>p.semanticReviewInput.actual.attemptedArguments=[]],
 ['changed required answer',p=>p.semanticReviewInput.actual.requestedReturn={reason:'Proceed'}],
 ['changed retained content',p=>p.semanticReviewInput.actual.artifacts.handoffText='invented note'],
 ['role layout swap',p=>p.semanticReviewInput.expected.evidenceRoleLayout='other'],
])test(`strict binder refuses ${label}`,()=>{const{world,proof}=fixture();alter(proof);assert.throws(()=>observedContentReviewInput(proof,world));});
test('legacy captures and explicit layout opt-out remain exactly bound',()=>{const {world,proof,legacy}=fixture();assert.equal(referenceReviewInput(legacy,{legacyCandidateLayout:true}),legacy);proof.semanticReviewInput=structuredClone(legacy);assert.equal(observedContentReviewInput(proof,world),proof.semanticReviewInput);proof.semanticReviewInput.actual.observations.current.notice='different';assert.throws(()=>observedContentReviewInput(proof,world));});
test('private classification and actor copy are never promoted to authoritative reference',()=>{const input={actual:{goal:'Explain current state',observations:{state:{notice:'paper'},choice:{status:'integrated'}},artifacts:{},requestedReturn:'Held'},expected:{goal:'Explain current state',requestedReturnRequired:true},rubric:'Actual question'};const projected=referenceReviewInput(input,{nonAuthoritativeKeys:['choice']});assert.deepEqual(projected.expected.observations,{state:{notice:'paper'}});assert.equal(JSON.stringify(projected).includes('integrated'),false);assert.equal(input.actual.observations.choice.status,'integrated');assert.throws(()=>referenceReviewInput(input,{nonAuthoritativeKeys:['missing']}));});
test('nested operation paths are escaped and native non-operation args fields remain actual state',()=>{const input={actual:{observations:{'a/b':{'~item':[{method:'read',args:['scope'],result:null}]},schema:{args:['declared-parameter']}}},expected:{},rubric:'roles'};const r=referenceReviewInput(input);assert.equal(r.actual.attemptedArguments[0].path,'/a~1b/~0item/0/args');assert.deepEqual(r.expected.observations.schema,{args:['declared-parameter']});});
