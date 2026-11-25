import {test} from 'node:test';
import assert from 'node:assert/strict';
import {preparedProjectReviewInput} from './prepared-project-admission.mjs';
function sample(profile='draft'){
 const world={kind:'preparedContentProject',id:'owned',sourceGroup:'project-group',goal:'Create a private draft only with current approval',profile};
 const before={committed:{eventId:'baseline'},workingHead:{kind:'event',eventId:'baseline'},clean:true,mainEventId:'main'};
 const actual=profile==='draft'?{committed:before.committed,workingHead:{kind:'application',applicationId:'local'},clean:false,mainEventId:'main'}:structuredClone(before);
 const project={contextId:'ctx',caseId:world.id,sourceGroup:world.sourceGroup,repoPath:'projects/owned',sourcesPath:'sources/owned',before,actual,sourceReadback:{records:[{localApproval:profile==='draft'?'draft':'pending'}]},sourceNow:[{localApproval:profile==='draft'?'draft':'pending'}],journal:[],artifact:null,expectedOutcome:profile==='draft'?'draft':'held'};
 if(profile==='draft')project.artifact={passed:true,reasons:[],semanticReviewRequired:true,semanticReviewInput:{actual:{contextId:'ctx',state:actual.workingHead,lifecycle:{requestedDisposition:'draft',baseline:{committedEvent:before.committed,workingHead:before.workingHead,clean:before.clean,protectedMainEventId:'main'},current:{committedEvent:actual.committed,workingHead:actual.workingHead,clean:actual.clean,protectedMainEventId:'main'},delta:{committedEventChanged:false,workingHeadChanged:true,protectedMainChanged:false}},documents:[{path:'README.md',text:'Actual retained procedure'}]},rubric:'Judge actual retained content against the original request'}};
 const {expectedOutcome,...native}=project;
 const proof={contextId:'ctx',preparedContentProject:project,nativeProjectEvidence:structuredClone(native),outcomeContract:{returnedValue:{required:false}},semanticReviewRequired:true};
 proof.semanticReviewInput={actual:{goal:world.goal,observations:{nativeProjectEvidence:structuredClone(native)},artifacts:{},requestedReturn:null},expected:{goal:world.goal,requestedReturnRequired:false},rubric:'Judge original goal against actual native source and retained content; no report required'};
 return {world,proof};
}
test('keeps native artifact content and lifecycle bindings with an optional absent result',()=>{const {world,proof}=sample();assert.equal(preparedProjectReviewInput(proof,world),proof.semanticReviewInput);assert.equal(proof.semanticReviewInput.actual.requestedReturn,null);});
test('reviews actual conditional hold evidence without requiring a project or report',()=>{const {world,proof}=sample('pending');assert.equal(preparedProjectReviewInput(proof,world),proof.semanticReviewInput);assert.equal(proof.preparedContentProject.artifact,null);});
for(const [name,change] of [
 ['different native observations',p=>p.nativeProjectEvidence.sourceNow=[]],
 ['different reviewed observations',p=>p.semanticReviewInput.actual.observations.nativeProjectEvidence.sourceNow=[]],
 ['missing required review',p=>p.semanticReviewRequired=false],
 ['fabricated generic report requirement',p=>p.semanticReviewInput.expected.requestedReturnRequired=true],
 ['different artifact state',p=>p.preparedContentProject.artifact.semanticReviewInput.actual.state={kind:'event',eventId:'foreign'}],
 ['different baseline',p=>p.preparedContentProject.artifact.semanticReviewInput.actual.lifecycle.baseline.committedEvent={eventId:'foreign'}],
 ['different current lifecycle',p=>p.preparedContentProject.artifact.semanticReviewInput.actual.lifecycle.current.clean=true],
 ['different lifecycle delta',p=>p.preparedContentProject.artifact.semanticReviewInput.actual.lifecycle.delta.protectedMainChanged=true],
 ['missing retained documents',p=>p.preparedContentProject.artifact.semanticReviewInput.actual.documents=[]],
 ['wrong publication context',p=>p.preparedContentProject.contextId='foreign'],
 ['wrong case owner',p=>p.preparedContentProject.caseId='foreign'],
 ['artifact failure',p=>p.preparedContentProject.artifact.passed=false],
])test('rejects '+name,()=>{const {world,proof}=sample();change(proof);if(['different artifact state','different baseline','different current lifecycle','different lifecycle delta','missing retained documents','artifact failure'].includes(name)){const {expectedOutcome,...native}=proof.preparedContentProject;proof.nativeProjectEvidence=structuredClone(native);proof.semanticReviewInput.actual.observations.nativeProjectEvidence=structuredClone(native);}assert.throws(()=>preparedProjectReviewInput(proof,world));});

test("excludes a wrong optional project pointer from meaning review without losing native evidence",()=>{const {world,proof}=sample();proof.actualResult={outcome:"wrong",project:{repoPath:"foreign"}};const input=preparedProjectReviewInput(proof,world);assert.equal(input.actual.requestedReturn,null);assert.ok(input.actual.observations.nativeProjectEvidence.artifact);});

test("refuses an undeclared project authority profile",()=>{const {world,proof}=sample();world.profile="unknown";assert.throws(()=>preparedProjectReviewInput(proof,world));});
