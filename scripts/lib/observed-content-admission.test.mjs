import {test} from "node:test";
import assert from "node:assert/strict";
import {observedContentFields,observedContentNeedsReview,observedContentReviewInput} from "./observed-content-admission.mjs";
function phoneFacts(journal=[]){const roles={assignment:["phoneFirstRun","inspect"],startup:["phoneFirstRun","phases"],provider:["phoneFirstRun","provider"],resume:["phoneSetupRead","readiness"]};return {actorObserved:Object.fromEntries(Object.entries(roles).map(([role,[service,method]])=>[role,journal.some(row=>row.service===service&&row.method===method)])),workspaceBefore:{mainEventId:"owned-main"},workspaceAfter:{mainEventId:"owned-main"},readProtocol:"A refused read is no installation or pairing effect.",evidenceProtocol:"Trusted verifier facts and actual actor observations are distinct."};}
function example(required=true){
 const world={kind:"image-candidate",goal:"Explain whether the source is available"};
 const proof={outcomeContract:{returnedValue:{required}},semanticReviewRequired:true,index:{id:"owned"},snapshots:[{revision:2}],reads:[{status:"missing"}],artifact:required?null:"Actual retained prose",actualResult:{reason:"The original was removed"}};
 proof.semanticReviewInput={actual:{goal:world.goal,observations:{index:proof.index,snapshots:proof.snapshots,reads:proof.reads},artifacts:{artifact:proof.artifact},requestedReturn:required?proof.actualResult:null},expected:{goal:world.goal,requestedReturnRequired:required},rubric:"Judge supported meaning; accept paraphrases and reject contradictions"};
 return {world,proof};
}
test("binds each domain's actual proof independently of authored answer vocabulary",()=>{
 const {world,proof}=example();assert.equal(observedContentReviewInput(proof,world),proof.semanticReviewInput);
 assert.deepEqual(observedContentFields.preparedContentProject, [["nativeProjectEvidence"], []]);
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
  for(const field of observations)proof[field]=kind==="phoneFirstRun"&&field==="refusedOperations"?[]:{source:"actual-owned-native",field};
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

test("owned operations review binds native custody and actual retained bytes without private expected decisions",()=>{
 const world={kind:"owned-operations",goal:"Tell us whether the current docket can proceed and keep any requested dossier private"};
 const proof={semanticReviewRequired:true,outcomeContract:{returnedValue:{required:true}},docket:{id:"current",revision:"owned"},effects:{reads:[{authority:"local-exercise",request:{kind:"release-continuation",after:[{id:"training",state:"approved"}]}}]},audit:{opened:[{handle:{id:"worker",contextId:"owned"}}],retiredIds:["worker"],remainingEntityIds:[]},dossierReadback:"Actual retained native checkpoint and handoff bytes",actualResult:{reason:"The current training gate is approved"}};
 const [observations,artifacts]=observedContentFields[world.kind],pick=keys=>Object.fromEntries(keys.map(key=>[key,proof[key]??null]));
 proof.semanticReviewInput={actual:{goal:world.goal,observations:pick(observations),artifacts:pick(artifacts),requestedReturn:proof.actualResult},expected:{goal:world.goal,requestedReturnRequired:true},rubric:"Judge the actual goal against current native facts"};
 assert.equal(observedContentNeedsReview(world),true);assert.equal(observedContentReviewInput(proof,world),proof.semanticReviewInput);
 for(const alter of [p=>p.semanticReviewRequired=false,p=>p.semanticReviewInput.actual.observations.audit={retiredIds:[]},p=>p.semanticReviewInput.actual.artifacts.dossierReadback="Invented",p=>p.semanticReviewInput.actual.requestedReturn={reason:"Invented"}]){const changed=structuredClone(proof);alter(changed);assert.throws(()=>observedContentReviewInput(changed,world));}
});

test("local inventory review binds actual native capabilities and requested findings, not the private expected answer",()=>{
 const world={kind:"live-local-inventory",goal:"Which retained local option can read the repository and retain the prior conversation?"};
 const proof={semanticReviewRequired:true,outcomeContract:{returnedValue:{required:true}},docket:{preferences:[{ref:"local:actual"}]},inventoryReadback:{request:{needsTools:true,requiresPriorConversation:true},rows:[{ref:"local:actual",row:{state:"ready",toolsCapable:true,contextWindow:64000}}],inspected:["local:actual"]},actualResult:{reason:"Actual supports file tools and a fork handoff"}};
 const [observations,artifacts]=observedContentFields[world.kind],pick=keys=>Object.fromEntries(keys.map(key=>[key,proof[key]??null]));
 proof.semanticReviewInput={actual:{goal:world.goal,observations:pick(observations),artifacts:pick(artifacts),requestedReturn:proof.actualResult},expected:{goal:world.goal,requestedReturnRequired:true},rubric:"Judge the requested finding against native capabilities and original goal"};
 assert.equal(observedContentNeedsReview(world),true);assert.equal(observedContentReviewInput(proof,world),proof.semanticReviewInput);
 for(const alter of [p=>p.semanticReviewRequired=false,p=>p.semanticReviewInput.actual.observations.inventoryReadback={...p.semanticReviewInput.actual.observations.inventoryReadback,rows:[]},p=>p.semanticReviewInput.actual.requestedReturn={reason:"Invented"}]){const changed=structuredClone(proof);alter(changed);assert.throws(()=>observedContentReviewInput(changed,world));}
});

test("terminal diagnostic review binds actual source/native assertions rather than a preferred hold label",()=>{
 const world={kind:"terminalAppRepair",goal:"Explain the observed count discrepancy without editing"};
 const proof={semanticReviewRequired:true,outcomeContract:{returnedValue:{required:true}},journal:[{service:"observe",result:{source:"return count+1",tests:{expected:3,actual:4},mayEdit:false}}],proof:{currentRevision:"native-current",protectedDigest:"unchanged"},actualResult:{outcome:"diagnosed",artifact:null,explanation:"The actual source increments the count"}};
 const [observations,artifacts]=observedContentFields[world.kind],pick=keys=>Object.fromEntries(keys.map(key=>[key,proof[key]??null]));
 proof.semanticReviewInput={actual:{goal:world.goal,observations:pick(observations),artifacts:pick(artifacts),requestedReturn:proof.actualResult},expected:{goal:world.goal,requestedReturnRequired:true},rubric:"Judge the requested diagnosis from actual source and native assertions"};
 assert.equal(observedContentNeedsReview(world),true);assert.equal(observedContentReviewInput(proof,world),proof.semanticReviewInput);
 for(const alter of [p=>p.semanticReviewRequired=false,p=>p.semanticReviewInput.actual.observations.journal=[],p=>p.semanticReviewInput.actual.observations.proof={currentRevision:"invented"},p=>p.semanticReviewInput.actual.requestedReturn={explanation:"Permission alone"}]){const changed=structuredClone(proof);alter(changed);assert.throws(()=>observedContentReviewInput(changed,world));}
});

test("program-run meaning review binds actual catalog, causal native attempts and signed bytes",()=>{
 const world={kind:"program-run",goal:"Run the permitted sample and preserve its actual output"};
 const proof={catalog:{initial:[],current:[]},inspections:[],attempts:[{id:"actual-native-attempt",output:null}],observations:[],signedText:null,actualResult:{status:"reviewed"},outcomeContract:{returnedValue:{required:true}},semanticReviewRequired:true};
 const [observations,artifacts]=observedContentFields[world.kind],pick=keys=>Object.fromEntries(keys.map(key=>[key,proof[key]??null]));
 proof.semanticReviewInput={actual:{goal:world.goal,observations:pick(observations),artifacts:pick(artifacts),requestedReturn:{status:"reviewed"}},expected:{goal:world.goal,requestedReturnRequired:true},rubric:"Judge requested native output and authorized run scope"};
 assert.equal(observedContentNeedsReview(world),true);
 assert.doesNotThrow(()=>observedContentReviewInput(proof,world));
 const altered={...proof,attempts:[{id:"actual-native-attempt",output:"invented"}]};
 assert.throws(()=>observedContentReviewInput(altered,world));
});

for(const [kind,native,artifacts,answer] of [
 ["phoneFirstRun",{card:{device:"paired-target"},assignment:{debugAllowed:false},phases:[{phase:"readback",desktopAvailable:true}],build:{id:"native-build"},journal:[{operation:"inspect"}],refusedOperations:[],nativeFacts:phoneFacts()},{},"The paired target has the native build, while the requested debug capability is absent"],
 ["mobileContinuity",{profile:{id:"owned-profile"},observations:[{buildId:"actual-build",cacheKey:"owned-cache",transport:"native"}],journal:[{operation:"observe",profileId:"owned-profile"}]},{},"The current owned profile retains its native build and transport"],
 ["source-attribution",{assignment:{unitId:"owned-unit"},files:[{path:"owned.ts",revision:"current-head",text:"actual source"}],evidence:[{path:"owned.ts",fact:"native declaration"}],effects:[{kind:"retained-note"}],native:{readback:{revision:"current-head"},protectedMain:"unchanged"}},{receipt:{path:"private/receipt.md",sha256:"native-retained-text-hash"},retainedText:"Actual source attribution"},{conclusion:"The actual source owns the native declaration",receipt:{path:"private/receipt.md"}}],
])test(`${kind} requires native-bound meaning review independent of optional status copies`,()=>{
 const world={kind,goal:kind==="mobileContinuity"?"Explain the current mobile continuity":"Attribute the current declaration and preserve its private note"};
 const proof={...native,...artifacts,actualResult:answer,semanticReviewRequired:true,outcomeContract:{returnedValue:{required:true}}};
 const fields=observedContentFields[kind],pick=keys=>Object.fromEntries(keys.map(key=>[key,proof[key]??null]));
 proof.semanticReviewInput={actual:{goal:world.goal,observations:pick(fields[0]),artifacts:pick(fields[1]),requestedReturn:answer},expected:{goal:world.goal,requestedReturnRequired:true},rubric:"Judge requested meaning from native current evidence and actual retained bytes"};
 assert.equal(observedContentNeedsReview(world),true);
 assert.equal(observedContentReviewInput(proof,world),proof.semanticReviewInput);
 for(const mutate of [p=>p.semanticReviewRequired=false,p=>p.semanticReviewInput.actual.observations[fields[0][0]]=null,p=>p.semanticReviewInput.actual.requestedReturn="Invented"]){const changed=structuredClone(proof);mutate(changed);assert.throws(()=>observedContentReviewInput(changed,world));}
 for(const artifact of fields[1]){const changed=structuredClone(proof);changed.semanticReviewInput.actual.artifacts[artifact]=null;assert.throws(()=>observedContentReviewInput(changed,world));}
 const optional=structuredClone(proof);optional.actualResult={status:"irrelevant"};optional.outcomeContract.returnedValue.required=false;optional.semanticReviewInput.actual.requestedReturn=null;optional.semanticReviewInput.expected.requestedReturnRequired=false;
 assert.equal(observedContentNeedsReview(world),true);assert.equal(observedContentReviewInput(optional,world),optional.semanticReviewInput);
});


test("notification answers and native lifecycle evidence are independently bound",()=>{
 const world={kind:"notificationState",goal:"Was the old read receipt removed? Keep the current note."};
 const proof={outcomeContract:{returnedValue:{required:true}},semanticReviewRequired:true,journal:[{method:"read",result:{id:"old"}}],assigned:{id:"ours"},initial:{retained:[{id:"old"}]},refresh:{producerReceipt:"removed"},current:{attention:[{id:"current"}],retained:[]},ack:null,final:{attention:[{id:"current"}],retained:[]},durable:{rows:[{id:"current"}]},actualResult:{finding:{state:"missing",id:"old",revision:1},explanation:"The old receipt was removed; the current note is retained.",acknowledgment:null}};
 const [keys,artifacts]=observedContentFields.notificationState;
 proof.semanticReviewInput={actual:{goal:world.goal,observations:Object.fromEntries(keys.map(key=>[key,proof[key]??null])),artifacts:{},requestedReturn:structuredClone(proof.actualResult)},expected:{goal:world.goal,requestedReturnRequired:true},rubric:"Judge supported notification meaning from native facts; internal IDs are not reference answer gates."};
 assert.deepEqual(artifacts,[]);assert.equal(observedContentNeedsReview(world),true);assert.equal(observedContentReviewInput(proof,world),proof.semanticReviewInput);
 for(const alter of [p=>p.semanticReviewInput.actual.observations.current=null,p=>p.semanticReviewInput.actual.requestedReturn.explanation="It is still present",p=>p.semanticReviewRequired=false]){const changed=structuredClone(proof);alter(changed);assert.throws(()=>observedContentReviewInput(changed,world));}
});

test("publication review binds actual selected target, native packages and actual requested return",()=>{
 const world={kind:"publication",goal:"Compare this preview with the retained review"};
 const actual={status:"reviewed",choice:{targetId:"owned",preflight:"prepare",compareRevision:true},preflight:null,revision:null};
 const proof={actualResult:actual,outcomeContract:{returnedValue:{required:true}},semanticReviewRequired:true,selected:actual.choice,observations:{preflight:null,revision:{candidate:{artifactDigest:"current"},reviewed:{artifactDigest:"prior"}}},artifact:{current:"current",prior:"prior"},renderer:{attemptId:"native"},journal:[],reads:{preflight:0,revision:1}};
 const pick=keys=>Object.fromEntries(keys.map(key=>[key,proof[key]??null]));
 proof.semanticReviewInput={actual:{goal:world.goal,observations:pick(observedContentFields.publication[0]),artifacts:{},requestedReturn:actual},expected:{goal:world.goal,requestedReturnRequired:true},rubric:"Judge requested meaning against actual native observations"};
 assert.equal(observedContentNeedsReview(world),true);
 assert.equal(observedContentReviewInput(proof,world),proof.semanticReviewInput);
 for(const mutate of [p=>p.semanticReviewInput.actual.observations.artifact.current="forged",p=>p.semanticReviewInput.actual.observations.selected.targetId="other",p=>p.actualResult={...actual,choice:{...actual.choice,targetId:"other"}},p=>p.semanticReviewRequired=false]){const p=JSON.parse(JSON.stringify(proof));mutate(p);assert.throws(()=>observedContentReviewInput(p,world));}
});

test("runbook query meaning is mandatory while writable runbooks retain their dedicated edit-scope binding",()=>{
 const world={kind:"google-runbook",action:"held",goal:"Does the current appointment authorize changing this runbook?"};
 const value={decision:{action:"held",path:null,approval:null,reason:"Current approval does not match the appointment."},write:null,attribution:null};
 const proof={actualResult:value,productReview:{calls:[],bases:[],calendar:{passed:true},documents:[]},outcomeContract:{returnedValue:{required:true}},semanticReviewRequired:true};
 proof.semanticReviewInput={actual:{goal:world.goal,observations:{productReview:proof.productReview},artifacts:{},requestedReturn:value},expected:{goal:world.goal,requestedReturnRequired:true},rubric:"Judge the requested answer from actual native evidence"};
 assert.equal(observedContentNeedsReview(world),true);assert.equal(observedContentReviewInput(proof,world),proof.semanticReviewInput);
 const changed=JSON.parse(JSON.stringify(proof));changed.semanticReviewInput.actual.observations.productReview.calendar.passed=false;assert.throws(()=>observedContentReviewInput(changed,world));
 assert.equal(observedContentNeedsReview({...world,action:"revise"}),false);assert.throws(()=>observedContentReviewInput(proof,{...world,action:"revise"}),/edit-scope/);
});

test("terminal ordering review binds the actual completed-operation chronology",()=>{
 const world={kind:"terminal-handoff",goal:"Only mark review after its Native check"};const value={answer:"The check completed before the review mark."};const proof={actualResult:value,outcomeContract:{returnedValue:{required:true}},semanticReviewRequired:true,events:[],journal:[{ordinal:0,operation:"suite.execute",resultSha256:"actual-check"},{ordinal:1,operation:"terminal.change",resultSha256:"actual-input"}]};
 const pick=keys=>Object.fromEntries(keys.map(key=>[key,proof[key]??null]));proof.semanticReviewInput={actual:{goal:world.goal,observations:pick(observedContentFields[world.kind][0]),artifacts:pick(observedContentFields[world.kind][1]),requestedReturn:value},expected:{goal:world.goal,requestedReturnRequired:true},rubric:"Judge requested ordering from actual completed Native operations"};
 assert.equal(observedContentReviewInput(proof,world),proof.semanticReviewInput);const forged=JSON.parse(JSON.stringify(proof));forged.semanticReviewInput.actual.observations.journal.reverse();assert.throws(()=>observedContentReviewInput(forged,world));
});

test("Regency and Grimoire Native fact roles bind to independent proof rather than a desired decision",()=>{
 for(const kind of ["regency-briefing","grimoireScene"]){const world={kind,goal:"Judge the requested current Native evidence"};const value={finding:"Actual observations"};const proof={actualResult:value,outcomeContract:{returnedValue:{required:true}},semanticReviewRequired:true,nativeFacts:{sourceCurrent:false,retainedArtifact:null}};const pick=keys=>Object.fromEntries(keys.map(key=>[key,proof[key]??null]));proof.semanticReviewInput={actual:{goal:world.goal,observations:pick(observedContentFields[kind][0]),artifacts:pick(observedContentFields[kind][1]),requestedReturn:value},expected:{goal:world.goal,requestedReturnRequired:true},rubric:"Judge requested meaning using independent Native facts"};assert.equal(observedContentReviewInput(proof,world),proof.semanticReviewInput);const swapped=JSON.parse(JSON.stringify(proof));swapped.semanticReviewInput.actual.observations.nativeFacts.sourceCurrent=true;assert.throws(()=>observedContentReviewInput(swapped,world));}
});

test("phone meaning review binds actual refused operations without inventing a successful effect",()=>{
 const world={kind:"phoneFirstRun",goal:"Explain readiness without reinstalling."},proof={outcomeContract:{returnedValue:{required:true}},semanticReviewRequired:true,card:{id:"phone"},assignment:{pairing:null},phases:[],build:null,journal:[],refusedOperations:[{service:"phoneSetupRead",method:"start",reason:"No owned pairing"}],nativeFacts:phoneFacts(),actualResult:{answer:"Only the shell marker is observed; no setup was started."}};
 const pick=keys=>Object.fromEntries(keys.map(key=>[key,proof[key]??null]));const [observations,artifacts]=observedContentFields.phoneFirstRun;
 proof.semanticReviewInput={actual:{goal:world.goal,observations:pick(observations),artifacts:pick(artifacts),requestedReturn:proof.actualResult},expected:{goal:world.goal,requestedReturnRequired:true},rubric:"Judge actual attempts and actual effects against the literal goal."};
 assert.equal(observedContentReviewInput(proof,world),proof.semanticReviewInput);
 for(const alter of [p=>p.semanticReviewInput.actual.observations.refusedOperations=[],p=>{delete p.refusedOperations;p.semanticReviewInput.actual.observations.refusedOperations=null;},p=>p.refusedOperations=[{...p.refusedOperations[0],method:"reinstall"}]]){const changed=structuredClone(proof);alter(changed);assert.throws(()=>observedContentReviewInput(changed,world));}
});

test("board migration binds the actual rendered source, authority history and retained target independently of a disposition label",()=>{
 const world={kind:"board-migration",goal:"Which checklist travelled?"};
 const proof={semanticReviewRequired:true,available:[{id:"native-board"}],rendered:{cards:[{id:"slipway",checklist:["Mark approach"]}]},basis:{target:"dock"},targetObservations:[],final:{target:"dock",cards:[{id:"slipway",checklist:["Mark approach"]}]},actualResult:{disposition:"held",receipt:null,reason:"The existing Slipway copy carries Mark approach."},outcomeContract:{returnedValue:{required:true}}};
 const fields=observedContentFields[world.kind];proof.semanticReviewInput={actual:{goal:world.goal,observations:Object.fromEntries(fields[0].map(key=>[key,proof[key]??null])),artifacts:{},requestedReturn:proof.actualResult},expected:{goal:world.goal,requestedReturnRequired:true},rubric:"Judge requested native facts and effects without imposing a private disposition."};
 assert.equal(observedContentNeedsReview(world),true);assert.equal(observedContentReviewInput(proof,world),proof.semanticReviewInput);
 for(const mutate of [p=>p.semanticReviewRequired=false,p=>p.semanticReviewInput.actual.observations.rendered={cards:[]},p=>p.semanticReviewInput.actual.requestedReturn={reason:"Different answer"},p=>p.final={target:"foreign"}]){const changed=structuredClone(proof);mutate(changed);assert.throws(()=>observedContentReviewInput(changed,world));}
});

test("authored literal answer obligations cannot be removed or invented by a self-consistent native proof",()=>{
 for(const field of ['requestedReturnRequired','requestedAnswerRequired']){
  const required=example(true);required.world[field]=true;assert.doesNotThrow(()=>observedContentReviewInput(required.proof,required.world));
  required.proof.outcomeContract.returnedValue.required=false;required.proof.semanticReviewInput.actual.requestedReturn=null;required.proof.semanticReviewInput.expected.requestedReturnRequired=false;assert.throws(()=>observedContentReviewInput(required.proof,required.world));
  const optional=example(false);optional.world[field]=false;assert.doesNotThrow(()=>observedContentReviewInput(optional.proof,optional.world));optional.world[field]=true;assert.throws(()=>observedContentReviewInput(optional.proof,optional.world));optional.world[field]='false';assert.throws(()=>observedContentReviewInput(optional.proof,optional.world));
 }
});

test("phone native facts bind actual inspected roles and workspace/protocol evidence instead of treating unread as unavailable",()=>{
 const world={kind:"phoneFirstRun",goal:"Inspect the actual startup marker only."};const journal=[{service:"phoneFirstRun",method:"inspect"},{service:"phoneFirstRun",method:"phases"}];const proof={outcomeContract:{returnedValue:{required:true}},semanticReviewRequired:true,journal,nativeFacts:phoneFacts(journal),refusedOperations:[],actualResult:{answer:"Only startup was inspected; provider readiness remains uninspected."}};const [fields,artifacts]=observedContentFields.phoneFirstRun;const pick=keys=>Object.fromEntries(keys.map(key=>[key,proof[key]??null]));proof.semanticReviewInput={actual:{goal:world.goal,observations:pick(fields),artifacts:pick(artifacts),requestedReturn:proof.actualResult},expected:{goal:world.goal,requestedReturnRequired:true},rubric:"Judge the actual goal from trusted facts without inventing unread observations."};assert.doesNotThrow(()=>observedContentReviewInput(proof,world));
 for(const alter of [p=>p.semanticReviewInput.actual.observations.nativeFacts={...p.nativeFacts,workspaceAfter:{mainEventId:"other"}},p=>{delete p.nativeFacts;p.semanticReviewInput.actual.observations.nativeFacts=null;},p=>{p.nativeFacts={...p.nativeFacts,actorObserved:{...p.nativeFacts.actorObserved,provider:true}};p.semanticReviewInput.actual.observations.nativeFacts=p.nativeFacts;},p=>{p.nativeFacts={...p.nativeFacts,readProtocol:""};p.semanticReviewInput.actual.observations.nativeFacts=p.nativeFacts;}]){const changed=structuredClone(proof);alter(changed);assert.throws(()=>observedContentReviewInput(changed,world));}
});
test("Smoke and Wake bind actual findings, native evidence and retained bytes independently of old enums",()=>{
 for(const kind of ["workspace-smoke","delivery-wake"]){
  for(const required of [true,false]){
   const world={kind,goal:"Explain the native result and retain only the requested authorized effect"};
   const [observations,artifacts]=observedContentFields[kind];
   const proof={outcomeContract:{returnedValue:{required}},semanticReviewRequired:true,actualResult:"A domain finding with no disposition or receipt echo"};
   for(const key of [...observations,...artifacts])proof[key]=key==="retainedText"?"Actual independently read bytes":{owned:key};
   const pick=keys=>Object.fromEntries(keys.map(key=>[key,structuredClone(proof[key])]));
   proof.semanticReviewInput={actual:{goal:world.goal,requestedReturn:required?proof.actualResult:null,observations:pick(observations),artifacts:pick(artifacts)},expected:{goal:world.goal,requestedReturnRequired:required},rubric:"Judge requested meaning against actual native effects"};
   assert.equal(observedContentNeedsReview(world),true);assert.equal(observedContentReviewInput(proof,world),proof.semanticReviewInput);
   for(const key of observations){const changed=structuredClone(proof);changed.semanticReviewInput.actual.observations[key]={forged:true};assert.throws(()=>observedContentReviewInput(changed,world));}
   for(const key of artifacts){const changed=structuredClone(proof);changed.semanticReviewInput.actual.artifacts[key]="Forged retained bytes";assert.throws(()=>observedContentReviewInput(changed,world));}
   const changed=structuredClone(proof);changed.semanticReviewRequired=false;assert.throws(()=>observedContentReviewInput(changed,world));
   if(required){const swapped=structuredClone(proof);swapped.semanticReviewInput.actual.requestedReturn="Another finding";assert.throws(()=>observedContentReviewInput(swapped,world));}
  }
 }
});

test("installed authority chronology and local release protocol remain bound to native observations and exact artifact bytes",()=>{
 for(const kind of ["installed-package","system-release"]){
  const world={kind,goal:kind==='installed-package'?"Restore the approved entry and identify its suite":"Leave a private local delivery diagnosis"};
  const proof={actualResult:{finding:{reason:"Actual native finding"}},outcomeContract:{returnedValue:{required:kind==='installed-package'}},semanticReviewRequired:true};
  const [observations,artifacts]=observedContentFields[kind];for(const key of [...observations,...artifacts])proof[key]=key==='authorization'?{before:{scopeMatches:true},action:{status:'restored'},after:{scopeMatches:false}}:key==='handoffProtocol'?{contextId:'owned',storage:'context-scoped-scratch',externalTransmission:false}:key==='handoffText'?'Actual JSON diagnostic bytes':{native:key};
  const pick=keys=>Object.fromEntries(keys.map(key=>[key,structuredClone(proof[key])]));
  proof.semanticReviewInput={actual:{goal:world.goal,observations:pick(observations),artifacts:pick(artifacts),requestedReturn:proof.outcomeContract.returnedValue.required?proof.actualResult:null},expected:{goal:world.goal,requestedReturnRequired:proof.outcomeContract.returnedValue.required},rubric:"Temporal authorization and format-neutral native evidence"};
  assert.equal(observedContentReviewInput(proof,world),proof.semanticReviewInput);
  for(const key of kind==='installed-package'?['authorization']:['handoffProtocol']){const bad=structuredClone(proof);bad.semanticReviewInput.actual.observations[key]={forged:true};assert.throws(()=>observedContentReviewInput(bad,world));}
  for(const key of artifacts){const bad=structuredClone(proof);bad.semanticReviewInput.actual.artifacts[key]='Forged artifact';assert.throws(()=>observedContentReviewInput(bad,world));}

 }
});
