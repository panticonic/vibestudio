import{test}from'node:test';
import assert from'node:assert/strict';
import{coordinatedRevisionReviewInput as bind}from'./source-claim-admission.mjs';
function fixture(required=true){
 const world={kind:'coordinated-revision',goal:'Inspect the current signed instruction and the owned documents.',requestedReturnRequired:required,changes:[{path:'guide.md'}]};
 const original=[{path:'guide.md',fileId:'owned',version:'before',text:'Use south.'}],documents=[{path:'guide.md',fileId:'owned',version:'after',text:'Use north.'}];
 const result={answer:required?'The current signed instruction and retained guide both use north.':null,documents:[]};
 const proof={requestedAnswerRequired:required,semanticReviewRequired:true,report:structuredClone(result),documents,snapshots:[{scope:{files:original}}],reviewScope:original,nativeReadback:{files:documents},nativeRaceState:null,nativeRaceReadback:null};
 proof.semanticReviewInput={actual:{goal:world.goal,documents,originalDocuments:original,currentObservedDocuments:original,requestedAnswer:required?result.answer:null},expected:{goal:world.goal,editablePaths:['guide.md'],requestedAnswerRequired:required},rubric:'Judge actual signed authority and native retained documents.'};
 return{world,result,proof};
}
test('binds the actual requested answer and native documents without an all-document report echo',()=>{const s=fixture();assert.equal(bind(s.proof,s.world,s.result),s.proof.semanticReviewInput);});
test('keeps effect-only review mandatory when no root result was produced',()=>{const s=fixture(false);s.proof.report=null;assert.equal(bind(s.proof,s.world,undefined).actual.requestedAnswer,null);});
test('accepts independently read native race evidence without inventing an actor discovery',()=>{const s=fixture(false);s.proof.reviewScope=[{path:'guide.md',text:'Unrelated coedit.'}];s.proof.nativeRaceReadback=s.proof.reviewScope;s.proof.nativeRaceState={kind:'event',eventId:'race'};s.proof.semanticReviewInput.actual.currentObservedDocuments=s.proof.reviewScope;assert.equal(bind(s.proof,s.world,s.result),s.proof.semanticReviewInput);});
for(const[label,change]of[
 ['swapped actual answer',s=>{s.result.answer='Different actual answer';}],
 ['missing actual requested result',s=>{s.result=undefined;}],
 ['missing requested answer',s=>{s.result.answer=null;s.proof.report=s.result;s.proof.semanticReviewInput.actual.requestedAnswer=null;}],
 ['self-asserted proof report',s=>{s.proof.report.answer='Forged answer';s.proof.semanticReviewInput.actual.requestedAnswer='Forged answer';}],
 ['changed native current document',s=>{s.proof.semanticReviewInput.actual.documents=[{text:'Forged'}];}],
 ['unbound current scope',s=>{s.proof.reviewScope=[{text:'Forged'}];s.proof.semanticReviewInput.actual.currentObservedDocuments=s.proof.reviewScope;}],
 ['missing native race identity',s=>{s.proof.reviewScope=[{text:'Race'}];s.proof.nativeRaceReadback=s.proof.reviewScope;s.proof.semanticReviewInput.actual.currentObservedDocuments=s.proof.reviewScope;}],
 ['missing literal return annotation',s=>{delete s.world.requestedReturnRequired;}],
 ['changed return obligation',s=>{s.proof.requestedAnswerRequired=false;}],
 ['missing meaning review',s=>{s.proof.semanticReviewRequired=false;}],
])test('refuses '+label,()=>{const s=fixture();change(s);assert.throws(()=>bind(s.proof,s.world,s.result));});

import{createHash}from'node:crypto';
import{openOutcomeGoalEvidence,applicationEntryBinding}from'../export-live-workflow-teacher.mjs';
const reference=value=>({complete:true,bytes:Buffer.byteLength(JSON.stringify(value)),hash:createHash('sha256').update(JSON.stringify(value)).digest('hex')});
test('the real exporter caller binds reviewed answer to original captured applicationResult',()=>{
 const s=fixture(),entry={program:'skills/open-user-goal/reviseCoordinatedDocuments.nl',callable:'reviseCoordinatedDocuments',arguments:{goal:s.world.goal},resultType:'CoordinatedRevisionFindings'};
 Object.assign(s.world,{id:'coordinated-case'});Object.assign(s.proof,{entry:applicationEntryBinding(entry),caseId:s.world.id,contextId:'owned',goal:s.world.goal,passed:true,checks:{native:true},actualResult:s.result,outcomeContract:{returnedValue:{required:true}},outcomeDimensions:{returnedValue:{required:true}}});
 const exercise={applicationResult:s.result,entry:applicationEntryBinding(entry),rootCallIds:['root'],calls:[{callId:'root',record:{call_id:'root',outcome:'done',executor:{kind:'agent'},definition:{name:entry.callable,source:entry.program,returns:entry.resultType},inputs:{goal:reference(s.world.goal)},output:reference(s.result)}}]};
 const execution={provenance:{contextId:'owned'},diagnostics:{openGoalVerification:s.proof}},workflow={entry,assignment:s.world,requiresReview:true};
 assert.equal(openOutcomeGoalEvidence(execution,exercise,null,workflow).reviewInput,s.proof.semanticReviewInput);
 const swapped={...exercise,applicationResult:{...s.result,answer:'Another answer'}};assert.throws(()=>openOutcomeGoalEvidence(execution,swapped,null,workflow));
 const missing={...exercise};delete missing.applicationResult;assert.throws(()=>openOutcomeGoalEvidence(execution,missing,null,workflow));
});
