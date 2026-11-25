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
 assert.equal(Object.keys(observedContentFields).length,56);
 for(const mutation of [p=>p.semanticReviewInput.actual.requestedReturn={reason:"Invented"},p=>p.semanticReviewInput.actual.observations.reads=[],p=>p.semanticReviewInput.actual.artifacts.artifact="Invented",p=>p.semanticReviewInput.actual.goal="Different goal",p=>p.semanticReviewRequired=false]){
  const clone=structuredClone(proof);mutation(clone);assert.throws(()=>observedContentReviewInput(clone,world));
 }
});
test("excludes wrong optional returns while preserving exact retained artifact review",()=>{
 const {world,proof}=example(false);proof.actualResult={reason:"Wrong incidental claim"};
 assert.equal(observedContentReviewInput(proof,world).actual.requestedReturn,null);
 proof.semanticReviewInput.actual.artifacts.artifact="Replacement";assert.throws(()=>observedContentReviewInput(proof,world));
});
test("native-only goal meaning review excludes incidental prose without waiving requested answers",()=>{
 const world={kind:"owned-task",goal:"Mark this card done",expected:{update:"done"}};
 const fields=observedContentFields[world.kind],proof={outcomeContract:{returnedValue:{required:false}},semanticReviewRequired:true};
 const pick=keys=>Object.fromEntries(keys.map(key=>[key,null]));
 proof.semanticReviewInput={actual:{goal:world.goal,observations:pick(fields[0]),artifacts:{},requestedReturn:null},expected:{goal:world.goal,requestedReturnRequired:false},rubric:"Native effect is authoritative"};
 assert.equal(observedContentNeedsReview(world),true);
 assert.equal(observedContentReviewInput(proof,world),proof.semanticReviewInput);
 assert.equal(proof.semanticReviewInput.actual.requestedReturn,null);
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

test("binds actual owned-task output bytes and reference independently of receipt labels",()=>{
 const world={kind:"owned-task",goal:"Find the accepted measurements",expected:{update:null,handoff:null}};
 const proof={outcomeContract:{returnedValue:{required:true}},semanticReviewRequired:true,effects:[],current:{task:{id:"actual"}},original:{content:"accepted filename"},delivery:null,nativeDeliveryError:null,raceInjected:false,
 resultArtifacts:[{record:{taskId:"actual",owner:"current",attempt:"run",artifact:"measurements.csv"},artifact:{name:"measurements.csv",reference:{digest:"actual-content-hash",mediaType:"text/csv"},content:"zone,litres\nNorth,1148\n"}}],actualResult:{result:{content:"zone,litres\nNorth,1148\n"}}};
 const pick=keys=>Object.fromEntries(keys.map(key=>[key,proof[key]??null]));const [observations,artifacts]=observedContentFields[world.kind];
 proof.semanticReviewInput={actual:{goal:world.goal,observations:pick(observations),artifacts:pick(artifacts),requestedReturn:structuredClone(proof.actualResult)},expected:{goal:world.goal,requestedReturnRequired:true},rubric:"Judge actual requested findings against retained output"};
 assert.equal(observedContentReviewInput(proof,world),proof.semanticReviewInput);
 for(const alter of [p=>p.semanticReviewInput.actual.observations.resultArtifacts[0].artifact.content="Invented",p=>p.semanticReviewInput.actual.observations.resultArtifacts[0].artifact.reference.digest="foreign",p=>p.semanticReviewInput.actual.observations.resultArtifacts[0].record.owner="foreign"]){const changed=JSON.parse(JSON.stringify(proof));alter(changed);assert.throws(()=>observedContentReviewInput(changed,world));}
});
test("migration meaning binds actual native sources and requested answer without a gold disposition",()=>{
 const world={kind:"templateMigration",goal:"Does this other group's receipt prove our adoption? Keep it read-only."};
 const proof={outcomeContract:{returnedValue:{required:true}},semanticReviewRequired:true,
  journal:[{method:"read",owner:"ours",receiptOwner:"other"}],observations:[{revision:2,owner:"ours",receipt:null}],
  readIds:["owned-dossier"],nativePrepared:null,protectedMain:"main-current",handoff:null,receiptText:null,
  actualResult:{status:"draft-only",candidateId:"owned-local",answer:"No. The receipt belongs to the other group and our adoption remains unproven."}};
 const [observations,artifacts]=observedContentFields.templateMigration;
 const pick=keys=>Object.fromEntries(keys.map(key=>[key,proof[key]??null]));
 proof.semanticReviewInput={actual:{goal:world.goal,observations:pick(observations),artifacts:pick(artifacts),requestedReturn:structuredClone(proof.actualResult)},
  expected:{goal:world.goal,requestedReturnRequired:true},rubric:"Judge the requested answer from actual native evidence, not an incidental status or candidate label."};
 assert.equal(observedContentNeedsReview(world),true);
 assert.equal(observedContentReviewInput(proof,world),proof.semanticReviewInput);
 for(const alter of [p=>p.semanticReviewInput.actual.observations.journal=[],p=>p.semanticReviewInput.actual.observations.nativePrepared={operationId:"invented"},
  p=>p.semanticReviewInput.actual.requestedReturn.answer="Yes, adopted",p=>p.semanticReviewRequired=false,p=>p.semanticReviewInput.actual.artifacts.receiptText="Invented receipt"]){
  const changed=structuredClone(proof);alter(changed);assert.throws(()=>observedContentReviewInput(changed,world));
 }
});
test("migration effect review remains mandatory without making incidental returns required",()=>{
 const world={kind:"templateMigration",goal:"Prepare this owned candidate for review without adopting it."};
 const proof={outcomeContract:{returnedValue:{required:false}},semanticReviewRequired:true,nativePrepared:{operationId:"native-owned",mainEventId:"main-current"},actualResult:null};
 const [observations,artifacts]=observedContentFields.templateMigration;
 const pick=keys=>Object.fromEntries(keys.map(key=>[key,proof[key]??null]));
 proof.semanticReviewInput={actual:{goal:world.goal,observations:pick(observations),artifacts:pick(artifacts),requestedReturn:null},
  expected:{goal:world.goal,requestedReturnRequired:false},rubric:"Judge the requested native preparation from the actual owned evidence."};
 assert.equal(observedContentReviewInput(proof,world),proof.semanticReviewInput);
 proof.semanticReviewRequired=false;assert.throws(()=>observedContentReviewInput(proof,world));
});
test("every newly admitted open domain binds native goal effects independently of optional receipts",()=>{
 const kinds=["agent-capability","bridge-delivery","deployed-interface","extension-dossier","installed-package","intent-discovery","launch-state","panel-source-migration","retained-memory","route-authority","system-release","testkit-closeout","webhook-admission","workspace-claims","workspace-config","workspace-share","gadDurableQuestion","examplesAdoption","system-diagnostics","news","spectrolite","gmail","calendar","google-handoff","unit-handoff"];
 for(const kind of kinds){
  const world={kind,goal:"Perform only the requested owned operation; do not invent a report requirement."};
  const [observations,artifacts]=observedContentFields[kind];
  const proof={outcomeContract:{returnedValue:{required:false}},semanticReviewRequired:true,actualResult:{unrequested:"incidental"}};
  for(const field of observations)proof[field]={source:"actual-owned-native",field};
  for(const field of artifacts)proof[field]="Actual native retained bytes";
  const pick=keys=>Object.fromEntries(keys.map(key=>[key,proof[key]??null]));
  proof.semanticReviewInput={actual:{goal:world.goal,observations:pick(observations),artifacts:pick(artifacts),requestedReturn:null},expected:{goal:world.goal,requestedReturnRequired:false},rubric:"Judge actual requested effects and retained bytes; do not require an unrequested return."};
  assert.equal(observedContentNeedsReview(world),true,kind);
  assert.equal(observedContentReviewInput(proof,world),proof.semanticReviewInput,kind);
  assert.equal(proof.semanticReviewInput.actual.requestedReturn,null,kind);
  const changed=JSON.parse(JSON.stringify(proof));changed.semanticReviewInput.actual.observations[observations[0]]={source:"foreign"};
  assert.throws(()=>observedContentReviewInput(changed,world),undefined,kind);
  const missing=structuredClone(proof);missing.semanticReviewRequired=false;assert.throws(()=>observedContentReviewInput(missing,world),undefined,kind);
 }
 assert.equal(observedContentNeedsReview({kind:"unregistered-function-contract"}),false);
});

test("readonly vault review cannot replace the retained writable-source scope proof",()=>{
 const world={kind:"spectrolite",goal:"Repair only the authorized section",writablePath:"owned.mdx"};
 assert.throws(()=>observedContentReviewInput({},world),/retained edit-scope/);
});

test("Personal requested findings and native effects require exact independently bound review",()=>{
 for(const kind of ["personal-automation","personal-artifacts","personal-history"]){
  for(const required of [true,false]){
   const world={kind,goal:"Use actual owned sources and perform only the requested work"};
   const [observations,artifacts]=observedContentFields[kind];
   const proof={outcomeContract:{returnedValue:{required}},semanticReviewRequired:true,actualResult:{native:"requested-finding"}};
   for(const field of observations)proof[field]={id:field,revision:"native-owned"};
   const pick=keys=>Object.fromEntries(keys.map(key=>[key,proof[key]??null]));
   proof.semanticReviewInput={actual:{goal:world.goal,observations:pick(observations),artifacts:pick(artifacts),requestedReturn:required?proof.actualResult:null},expected:{goal:world.goal,requestedReturnRequired:required},rubric:"Judge requested meaning against the actual owned evidence"};
   assert.equal(observedContentNeedsReview(world),true);
   assert.equal(observedContentReviewInput(proof,world),proof.semanticReviewInput);
   for(const alter of [p=>p.semanticReviewRequired=false,p=>p.semanticReviewInput.actual.observations[observations[0]]={revision:"invented"},p=>p.semanticReviewInput.actual.goal="Different goal",p=>p.semanticReviewInput.actual.requestedReturn={fabricated:true}]){
    const changed=structuredClone(proof);alter(changed);assert.throws(()=>observedContentReviewInput(changed,world));
   }
  }
 }
});

test("launch review binds assignment-owned companion observations and protected state",()=>{
 const world={kind:"launch-state",goal:"Inspect both assigned panels; change only the active panel"};
 const proof={semanticReviewRequired:true,outcomeContract:{returnedValue:{required:false}},companionReadbacks:[{panelId:"owned-companion",revision:"read-native"}],protectedCompanion:{initial:{revision:"original"},current:{revision:"original"}}};
 const [observations,artifacts]=observedContentFields[world.kind],pick=keys=>Object.fromEntries(keys.map(key=>[key,proof[key]??null]));
 proof.semanticReviewInput={actual:{goal:world.goal,observations:pick(observations),artifacts:pick(artifacts),requestedReturn:null},expected:{goal:world.goal,requestedReturnRequired:false},rubric:"Judge actual observations and scope"};
 assert.equal(observedContentReviewInput(proof,world),proof.semanticReviewInput);
 for(const field of ["companionReadbacks","protectedCompanion"]){const changed=structuredClone(proof);changed.semanticReviewInput.actual.observations[field]=null;assert.throws(()=>observedContentReviewInput(changed,world));}
});
