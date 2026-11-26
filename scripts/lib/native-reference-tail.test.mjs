import test from 'node:test';
import {collectionInterruption} from './live-teacher-interruption.mjs';
import assert from 'node:assert/strict';
import{mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync}from'node:fs';
import{gzipSync}from'node:zlib';
import{tmpdir}from'node:os';
import path from'node:path';
import{selectNativeReferences,inspectNativeReference,runNativeReferenceTail,runNativeReferenceBatches}from'./native-reference-tail.mjs';
const scenario='open-goal-checked-note',name='open-goal-oracle-checked-note',goal='Retain the checked note';
const world={workspace:'examples',assignment:{goal},interaction:'open-user-goal'};
const group={workspace:'examples',instance:'TEST-owned-collector',devices:[]};
const catalog=new Map([[name,{name,nativeReference:true,installed:true,orchestrated:true}]]);
const workflows=new Map([[scenario,world]]);
const selected={scenario,name,goal};
const packet=()=>({test:{name},result:{passed:true},execution:{provenance:{contextId:'TEST-context'},trajectoryReview:{modelCallCount:0},diagnostics:{natlangTeacher:null,openGoalVerification:{caseId:'checked-note',contextId:'TEST-context',goal,passed:true,checks:{nativeReadback:true}}}}});
test('native admission requires source declaration, installed units and exact placement',()=>{
 const options={group,workflows,catalog,limit:1};
 assert.deepEqual(selectNativeReferences(options),[selected]);
 for(const changed of [new Map([[name,{...catalog.get(name),nativeReference:undefined}]]),new Map([[name,{...catalog.get(name),installed:false}]])])assert.deepEqual(selectNativeReferences({...options,catalog:changed}),[]);
 for(const changed of [{...group,workspace:'system'},{...group,workspaceBaseline:'foreign'},{...group,devices:['android']}])assert.deepEqual(selectNativeReferences({...options,group:changed}),[]);
 assert.deepEqual(selectNativeReferences({...options,completed:{[name]:{status:'failed'}}}),[]);
 assert.deepEqual(selectNativeReferences({...options,limit:0}),[]);
 assert.deepEqual(selectNativeReferences({...options,workflows:new Map([[scenario,{...world,requiresAndroidEmulator:true}]])}),[]);
 const required=new Map([[scenario,{...world,requiresDeploymentPackage:true}]]);
 assert.deepEqual(selectNativeReferences({...options,workflows:required}),[]);
 assert.deepEqual(selectNativeReferences({...options,workflows:required,deploymentPackageAvailable:true}),[selected]);
});
test('native outcomes reject teacher/model evidence and forged context/goal/identity',()=>{
 assert.equal(inspectNativeReference(packet(),selected).status,'passed');
 const withoutTelemetry=packet();delete withoutTelemetry.execution.trajectoryReview;assert.equal(inspectNativeReference(withoutTelemetry,selected).status,'passed');assert.equal(inspectNativeReference(withoutTelemetry,selected).modelCallCount,null);
 for(const mutate of [p=>p.execution.diagnostics.natlangTeacher={},p=>p.execution.trajectoryReview.modelCallCount=1,p=>p.test.name='foreign',p=>p.execution.diagnostics.openGoalVerification.goal='foreign',p=>p.execution.diagnostics.openGoalVerification.contextId='foreign',p=>p.execution.diagnostics.openGoalVerification.caseId='foreign',p=>p.execution.diagnostics.openGoalVerification.checks={},p=>{delete p.execution.provenance;delete p.execution.diagnostics.openGoalVerification.contextId;},p=>p.execution.diagnostics.openGoalVerification.checks=[true]]){const p=packet();mutate(p);assert.throws(()=>inspectNativeReference(p,selected));}
 for(const mutate of [p=>p.result.passed=false,p=>p.execution.diagnostics.openGoalVerification.checks.nativeReadback=false,p=>p.execution.cleanupErrors=['failed join'],p=>p.execution.toolFailures=[{expected:false}]]){const p=packet();mutate(p);assert.equal(inspectNativeReference(p,selected).status,'failed');}
});
test('owned tail awaits the canonical run then retains separate source-bound raw without teacher admission',async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'TEST-native-reference-tail-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const out=path.join(root,'capture');mkdirSync(out);const stateRoot=path.join(root,'state'),runId='st_'+'a'.repeat(32),calls=[];
 const systemTest=async(args,_stdout,signal)=>{
  assert.equal(signal.aborted,false);assert.ok(!args.includes('--model'));calls.push(args);
  const directory=args[args.indexOf('--out-dir')+1];mkdirSync(path.join(directory,runId),{recursive:true});
  if(args[0]==='run'){assert.deepEqual(args.slice(0,2),['run',name]);await Promise.resolve();}
  else{assert.deepEqual(args.slice(0,3),['trajectory',runId,name]);writeFileSync(path.join(directory,runId,`trajectory-${name}-full.json.gz`),gzipSync(JSON.stringify(packet())));}
  return 0;
 };
 const options={group,workflows,catalog,pinned:{repositories:{TEST:{git_commit:'a'.repeat(40),dirty:false}}},out,stateRoot,limit:1,systemTest,signal:new AbortController().signal};
 const rows=await runNativeReferenceTail(options);assert.equal(rows.length,1);assert.equal(rows[0].status,'passed');assert.equal(calls.length,2);
 const evidence=JSON.parse(readFileSync(path.join(path.dirname(path.dirname(rows[0].artifact)),'reference-results.json')));
 assert.equal(evidence.teacherRegistryWrites,false);assert.ok(rows[0].artifact.includes('native-reference-only'));
 assert.deepEqual(await runNativeReferenceTail(options),[]);assert.equal(calls.length,2);
});

test('completion decisions are source-bound, wait for the same live owner and reject forged approval',async t=>{
 const {waitForNativeContinuation}=await import('./native-reference-tail.mjs');
 const {createHash}=await import('node:crypto');
 const root=mkdtempSync(path.join(tmpdir(),'TEST-native-continuation-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const out=path.join(root,'capture');mkdirSync(out);writeFileSync(path.join(out,'source.json'),JSON.stringify({repositories:{TEST:{git_commit:'a'.repeat(40)}}}));
 const pinned={repositories:{TEST:{git_commit:'a'.repeat(40)}}},signal=new AbortController().signal;
 const control=path.join(root,'continuation');
 let observed;
 const decision=await waitForNativeContinuation({control,out,pinned,signal,ownerIdentity:'TEST-owner',ownerAlive:identity=>{
  assert.equal(identity,'TEST-owner');const bytes=readFileSync(control+'.ready.json');observed=JSON.parse(bytes);
  writeFileSync(control+'.decision.json',JSON.stringify({schema:observed.schema,requestSha256:createHash('sha256').update(bytes).digest('hex'),decision:'drain-native'}));return true;
 }});
 assert.equal(decision,true);assert.equal(observed.capture,out);
 const forged=path.join(root,'forged');
 await assert.rejects(waitForNativeContinuation({control:forged,out,pinned,signal,ownerIdentity:null,ownerAlive:()=>{
  writeFileSync(forged+'.decision.json',JSON.stringify({schema:observed.schema,requestSha256:'0'.repeat(64),decision:'drain-native'}));return true;
 }}));
 assert.equal(await waitForNativeContinuation({control:path.join(root,'dead-owner'),out,pinned,signal,ownerIdentity:null,ownerAlive:()=>false}),false);
});

test('native errors retain their actual failure without inventing a proof or zero model telemetry',()=>{
 const value={test:{name},result:{passed:false},execution:{error:'TEST actual finite native evaluation deadline',diagnostics:{}}};
 assert.deepEqual(inspectNativeReference(value,selected),{status:'errored',reason:value.execution.error,nativeProofValidated:false,modelCallCount:null});
 value.execution.trajectoryReview={modelCallCount:1};assert.throws(()=>inspectNativeReference(value,selected));
});

test('cancelled aggregate preserves a completed raw prefix and keeps missing cases unchecked',async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'TEST-native-cancel-prefix-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const out=path.join(root,'capture');mkdirSync(out);const stateRoot=path.join(root,'state'),runId='st_'+'b'.repeat(32),abort=new AbortController();
 const pinned={repositories:{TEST:{git_commit:'b'.repeat(40),dirty:false}}};
 const extra='open-goal-still-queued',extraName='open-goal-oracle-still-queued';
 const allWorkflows=new Map([...workflows,[extra,{...world,assignment:{goal:'TEST-only queued'}}]]);
 const allCatalog=new Map([...catalog,[extraName,{name:extraName,nativeReference:true,installed:true,orchestrated:true}]]);
 const calls=[];
 await assert.rejects(runNativeReferenceTail({group,workflows:allWorkflows,catalog:allCatalog,pinned,out,stateRoot,limit:2,signal:abort.signal,systemTest:async args=>{
  calls.push(args);assert.equal(args[0],'run');
  const directory=args[args.indexOf('--out-dir')+1],retained=path.join(directory,runId,'failure-evidence');mkdirSync(retained,{recursive:true});
  writeFileSync(path.join(retained,`trajectory-${name}-full.json.gz`),gzipSync(JSON.stringify(packet())));
  abort.abort(new Error('TEST-only canonical cancellation'));return 1;
 }}),/verified prefix was preserved/);
 assert.equal(calls.length,1,'Never issue new retrieval after cancellation');
 const {summarizeNativeReferences}=await import('./native-reference-tail.mjs');
 const coverage=summarizeNativeReferences({workflows:allWorkflows,pinned,stateRoot});
 assert.equal(coverage.attempted,1);assert.equal(coverage.passed,1);assert.equal(coverage.unchecked,1);assert.equal(coverage.sweepCompleted,false);
 assert.deepEqual(coverage.uncheckedNames,[extraName]);
});

test('native failure retains canonical bounded inspect and honest CLI phase timestamps',async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'TEST-native-failure-inspect-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const out=path.join(root,'capture');mkdirSync(out);const stateRoot=path.join(root,'state'),runId='st_'+'c'.repeat(32),calls=[];
 const rows=await runNativeReferenceTail({group,workflows,catalog,pinned:{repositories:{TEST:{git_commit:'c'.repeat(40)}}},out,stateRoot,limit:1,signal:new AbortController().signal,systemTest:async args=>{
  calls.push(args);const directory=args[args.indexOf('--out-dir')+1],run=path.join(directory,runId);mkdirSync(run,{recursive:true});
  if(args[0]==='trajectory')writeFileSync(path.join(run,`trajectory-${name}-full.json.gz`),gzipSync(JSON.stringify({test:{name},result:{passed:false},execution:{error:'TEST finite native eval deadline',diagnostics:{}}})));
  if(args[0]==='inspect'){assert.deepEqual(args.slice(0,4),['inspect',runId,'--test',name]);writeFileSync(path.join(run,`inspect-${name}.json`),JSON.stringify({failure:{phase:'orchestration',error:{message:'TEST finite native eval deadline'}}}));}
  return args[0]==='run'?1:0;
 }});
 assert.equal(rows[0].status,'errored');assert.equal(rows[0].nativeProofValidated,false);assert.equal(rows[0].modelCallCount,null);
 assert.ok(rows[0].failureDiagnostic.sha256);assert.equal(calls.length,3);
 const diagnostic=JSON.parse(readFileSync(path.join(path.dirname(path.dirname(rows[0].artifact)),'run-diagnostic.json')));
 assert.equal(diagnostic.commandExit,1);assert.equal(diagnostic.phaseTimingAvailable,false);
});

test('native continuation finishes its active batch before the actual non-aborting owner drain',async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'native-boundary-')),drain=path.join(root,'drain.json');
 const owner=collectionInterruption({out:root,cases:[]});let finish,entered;
 const started=new Promise(resolve=>{entered=resolve;}),settled=new Promise(resolve=>{finish=resolve;});let calls=0;const preserved=[];
 try {
  const running=runNativeReferenceBatches({draining:true,signal:owner.signal,drainAtBoundary:()=>owner.drainAtBoundary(drain),runBatch:async()=>{calls++;entered();await settled;return[{name:'native-original',status:'passed'}];},afterBatch:records=>preserved.push(...records)});
  await started;writeFileSync(drain,'{}');assert.equal(owner.signal.aborted,false);assert.equal(calls,1);assert.equal(preserved.length,0);
  finish();assert.deepEqual(await running,{batches:1,observed:1});assert.equal(owner.signal.aborted,false);assert.equal(owner.requested,true);assert.equal(calls,1);assert.deepEqual(preserved,[{name:'native-original',status:'passed'}]);
 } finally {owner.dispose();rmSync(root,{recursive:true,force:true});}
});
test('native full scope continues across bounded batches until exhausted and tail mode runs only one',async()=>{
 for(const draining of [false,true]){let calls=0;const returned=await runNativeReferenceBatches({draining,signal:new AbortController().signal,runBatch:async()=>++calls<=2?[{name:'actual-'+calls}]:[]});assert.equal(calls,draining?3:1);assert.deepEqual(returned,{batches:calls,observed:draining?2:1});}
});
test('a prior drain or cancellation admits no new native batch',async()=>{
 for(const cancelled of [false,true]){const controller=new AbortController();if(cancelled)controller.abort();let calls=0;assert.deepEqual(await runNativeReferenceBatches({draining:true,signal:controller.signal,drainAtBoundary:()=>true,runBatch:async()=>{calls++;return[];}}),{batches:0,observed:0});assert.equal(calls,0);}
});

test('a later owner recovers the actual passed packet after a lost CLI join before admitting another run',async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'TEST-native-lost-join-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const out=path.join(root,'capture');mkdirSync(out);const stateRoot=path.join(root,'state'),runId='st_'+'d'.repeat(32);
 const pinned={repositories:{TEST:{git_commit:'d'.repeat(40),dirty:false}}};let checkpoints=0;
 const options={group,workflows,catalog,pinned,out,stateRoot,limit:1,signal:new AbortController().signal};
 await assert.rejects(runNativeReferenceTail({...options,assertPins:()=>{
  // Startup validation, then durable pre-launch registration, then lost join.
  if(++checkpoints===3)throw new Error('TEST process died after retained packet, before outcome checkpoint');
 },systemTest:async args=>{
  const directory=args[args.indexOf('--out-dir')+1],retained=path.join(directory,runId,'failure-evidence');mkdirSync(retained,{recursive:true});
  writeFileSync(path.join(retained,`trajectory-${name}-full.json.gz`),gzipSync(JSON.stringify(packet())));return 0;
 }}),/TEST process died/);
 const rows=await runNativeReferenceTail({...options,systemTest:()=>{throw new Error('Must not rerun independently passed reference');}});
 assert.equal(rows.length,1);assert.equal(rows[0].status,'passed');assert.ok(rows[0].retainedPrefixRecovery.sourceSha256);
 assert.deepEqual(await runNativeReferenceTail({...options,systemTest:()=>assert.fail('Already completed')}),[]);
});

test('pending prefix recovery rejects source substitution and forged packet provenance',async t=>{
 const {recoverRetainedNativeReferencePackets}=await import('./native-reference-tail.mjs');
 const {createHash}=await import('node:crypto');
 const hash=v=>createHash('sha256').update(v).digest('hex');
 for(const changed of ['source','goal','model','context']) {
  const root=mkdtempSync(path.join(tmpdir(),'TEST-native-prefix-custody-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const repositories={TEST:{git_commit:'e'.repeat(40),dirty:false}},source={repositories,collectionRole:'native-reference-only',placement:['examples',null,[]],names:[name]},bytes=JSON.stringify(source);
  writeFileSync(path.join(root,'source.json'),bytes);
  const state={repositories,results:{},pendingBatches:[{output:root,sourceSha256:hash(bytes),selected:[selected]}]};
  const runId='st_'+'e'.repeat(32);mkdirSync(path.join(root,runId));const p=packet();
  if(changed==='source')writeFileSync(path.join(root,'source.json'),JSON.stringify({...source,repositories:{foreign:true}}));
  if(changed==='goal')p.execution.diagnostics.openGoalVerification.goal='foreign';
  if(changed==='model')p.execution.trajectoryReview.modelCallCount=1;
  if(changed==='context')p.execution.provenance.contextId='foreign';
  writeFileSync(path.join(root,runId,`trajectory-${name}-full.json.gz`),gzipSync(JSON.stringify(p)));
  assert.throws(()=>recoverRetainedNativeReferencePackets({state,workflows,catalog}));assert.deepEqual(state.results,{});
 }
});

test('interrupted error and absent packets remain unchecked instead of becoming failed qualification or a pass',async t=>{
 const {recoverRetainedNativeReferencePackets}=await import('./native-reference-tail.mjs');
 const {createHash}=await import('node:crypto');
 const root=mkdtempSync(path.join(tmpdir(),'TEST-native-prefix-error-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const repositories={TEST:{git_commit:'f'.repeat(40)}},source={repositories,collectionRole:'native-reference-only',placement:['examples',null,[]],names:[name]},bytes=JSON.stringify(source);
 writeFileSync(path.join(root,'source.json'),bytes);const runId='st_'+'f'.repeat(32);mkdirSync(path.join(root,runId));
 writeFileSync(path.join(root,runId,`trajectory-${name}-full.json.gz`),gzipSync(JSON.stringify({test:{name},result:{passed:false},execution:{error:'TEST interrupted while disposing',diagnostics:{}}})));
 const state={repositories,results:{},pendingBatches:[{output:root,sourceSha256:createHash('sha256').update(bytes).digest('hex'),selected:[selected]}]};
 assert.deepEqual(recoverRetainedNativeReferencePackets({state,workflows,catalog}),[]);assert.deepEqual(state.results,{});assert.equal(state.pendingBatches,undefined);
});
