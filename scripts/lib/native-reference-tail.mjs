import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync,renameSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import path from 'node:path';

const hash=value=>createHash('sha256').update(value).digest('hex');
const placement=world=>JSON.stringify([world.workspace??'system',world.workspaceBaseline??null,[...new Set(world.devices??[])].sort()]);
/** Select qualification work without weakening the full coverage obligation or its evidence index. */
export function selectNativeReferenceWorkflows({workflows,names=[],nativeOnly=false}) {
 assert.ok(Array.isArray(names),'Native reference selection must be a list');
 assert.ok(!names.length||nativeOnly,'Native reference cases require native-only mode');
 assert.equal(new Set(names).size,names.length,'Duplicate native reference case');
 for(const name of names)assert.ok(typeof name==='string'&&name.startsWith('open-goal-')&&workflows.get(name)?.interaction==='open-user-goal',`Unknown native reference case: ${name}`);
 const selected=new Set(names);
 return new Map([...workflows].filter(([name])=>!selected.size||selected.has(name)));
}
export function selectNativeReferences({group,workflows,catalog,completed={},limit,deploymentPackageAvailable}) {
 assert.ok(Number.isSafeInteger(limit)&&limit>=0);
 const selected=[];
 for(const [scenario,world] of workflows) {
  if(selected.length===limit)break;
  if(!scenario.startsWith('open-goal-')||world.interaction!=='open-user-goal'||placement(world)!==placement(group))continue;
  if(world.requiresDeploymentPackage&&!deploymentPackageAvailable)continue;
  if(world.requiresAndroidEmulator&&!(group.devices??[]).includes("android"))continue;
  const name='open-goal-oracle-'+scenario.slice('open-goal-'.length),entry=catalog.get(name);
  if(entry?.nativeReference!==true||entry.installed!==true||completed[name])continue;
  assert.equal(entry.orchestrated,true,'Native reference needs canonical harness orchestration');
  assert.ok(typeof world.assignment?.goal==='string'&&world.assignment.goal.trim(),'Native reference needs its literal goal');
  selected.push({name,goal:world.assignment.goal,scenario});
 }
 return selected;
}
export function inspectNativeReference(packet,selected) {
 assert.equal(packet.test?.name,selected.name);
 const execution=packet.execution,diagnostics=execution?.diagnostics,proof=diagnostics?.openGoalVerification;
 assert.ok(execution,'Reference has no execution evidence');
 assert.ok(diagnostics?.natlangTeacher==null,'Reference returned teacher evidence');
 const modelCallCount=execution.trajectoryReview?.modelCallCount??null;
 if(modelCallCount!==null)assert.equal(modelCallCount,0,'Reference executed a model');
 if(execution.error) return {status:'errored',reason:execution.error,nativeProofValidated:false,
   modelCallCount};
 assert.equal(diagnostics?.natlangTeacher,null,'Reference lacks its native completion witness');
 // Harness-validated native executions intentionally omit agent trajectory review.
 // The canonical owner enforces no-inference BEFORE running the fixture; missing
 // optional agent telemetry is unknown, never an invented observed zero.
 assert.ok(!(diagnostics.openGoalVerificationErrors??[]).length,'Reference native verification produced errors');
 assert.equal(proof?.goal,selected.goal,'Reference goal changed');
 assert.ok(typeof proof?.contextId==='string'&&proof.contextId.length,'Reference context witness is missing');
 assert.equal(proof.contextId,execution.provenance?.contextId,'Reference context changed');
 assert.equal(proof?.caseId,selected.scenario.slice('open-goal-'.length),'Reference case changed');
 assert.ok(proof.checks&&typeof proof.checks==='object'&&!Array.isArray(proof.checks)&&Object.keys(proof.checks).length&&Object.values(proof.checks).every(value=>typeof value==='boolean'));
 const unexpected=(execution.toolFailures??[]).filter(failure=>failure.expected!==true);
 const passed=!execution.error&&!(execution.cleanupErrors??[]).length&&!unexpected.length&&packet.result?.passed===true&&proof.passed===true&&Object.values(proof.checks).every(Boolean);
 return {status:passed?'passed':execution.error?'errored':'failed',checks:proof.checks,contextId:proof.contextId,modelCallCount};
}
/** Recover only independently passed native packets from this source's own
 * pre-launch journal. A killed CLI owner may retain packets before its join
 * finishes; aggregate cancellation is never a completion witness. */
export function recoverRetainedNativeReferencePackets({state,workflows,catalog}) {
 const recovered=[];
 for(const pending of state.pendingBatches??[]) {
  const sourceBytes=readFileSync(path.join(pending.output,'source.json'));
  assert.equal(hash(sourceBytes),pending.sourceSha256,'Pending native batch source changed');
  const source=JSON.parse(sourceBytes);
  assert.deepEqual(source.repositories,state.repositories);
  assert.equal(source.collectionRole,'native-reference-only');
  assert.deepEqual(source.names,pending.selected.map(row=>row.name));
  const runs=readdirSync(pending.output).filter(name=>/^st_[a-f0-9]{32}$/u.test(name));
  assert.ok(runs.length<=1,'Pending reference has multiple owned runs');
  if(!runs.length)continue;
  for(const row of pending.selected) {
   const world=workflows.get(row.scenario),entry=catalog.get(row.name);
   assert.equal(row.name,'open-goal-oracle-'+row.scenario.slice('open-goal-'.length));
   assert.equal(world?.interaction,'open-user-goal');assert.equal(world.assignment?.goal,row.goal);
   assert.equal(placement(world),source.placement?JSON.stringify(source.placement):pending.placement);
   assert.equal(entry?.nativeReference,true);assert.equal(entry.installed,true);assert.equal(entry.orchestrated,true);
   const filename=`trajectory-${row.name.replace(/[^A-Za-z0-9_.-]+/gu,'_').slice(0,100)}-full.json.gz`,root=path.join(pending.output,runs[0]);
   const file=[path.join(root,filename),path.join(root,'failure-evidence',filename)].find(existsSync);
   if(!file)continue;
   const raw=readFileSync(file),observed=inspectNativeReference(JSON.parse(gunzipSync(raw)),row);
   // Interrupted errors/partial runs remain unchecked. Only the exact positive
   // native completion proof can survive a lost CLI join automatically.
   if(observed.status!=='passed'||state.results[row.name])continue;
   const record={...row,...observed,artifact:file,sha256:hash(raw),runId:runs[0],
    ...(source.deploymentPackage?{deploymentPackage:source.deploymentPackage}:{}),
    retainedPrefixRecovery:{sourceSha256:pending.sourceSha256}};
   state.results[row.name]=record;recovered.push(record);
  }
 }
 delete state.pendingBatches;
 return recovered;
}

/** Called only by the collector owning this exact instance, after its paid suite
 * and exporter have joined. The ordinary CLI still owns all fixture/resource cleanup.
 * Reference output is never passed to the teacher exporter or its registry.
 */
export async function runNativeReferenceTail({group,workflows,catalog,pinned,out,stateRoot,limit,systemTest,signal,deploymentPackageAvailable,deploymentPackageIdentity=null,assertPins=()=>{}}) {
 if(!limit||signal.aborted)return [];
 const identity=hash(JSON.stringify(pinned.repositories)),stateDir=path.join(stateRoot,identity);
 mkdirSync(stateDir,{recursive:true,mode:0o700});
 const index=path.join(stateDir,'state.json');
 let original=existsSync(index)?readFileSync(index):null;
 const state=original?JSON.parse(original):{schema:'vibestudio.native-reference-tail/1',repositories:pinned.repositories,results:{}};
 assert.deepEqual(state.repositories,pinned.repositories);
 const persist=()=>{
  assert.equal(existsSync(index)?hash(readFileSync(index)):null,original?hash(original):null,'Native-reference state has another writer');
  assertPins();
  const bytes=JSON.stringify(state,null,2)+'\n',temporary=index+'.'+randomUUID()+'.tmp';
  writeFileSync(temporary,bytes,{flag:'wx',mode:0o600});renameSync(temporary,index);original=Buffer.from(bytes);
 };
 assertPins();
 const recovered=recoverRetainedNativeReferencePackets({state,workflows,catalog});
 if(recovered.length||original&&JSON.parse(original).pendingBatches)persist();
 const selected=selectNativeReferences({group,workflows,catalog,completed:state.results,limit,deploymentPackageAvailable});
 if(!selected.length)return recovered;
 const output=path.join(out,'native-reference-only',randomUUID());mkdirSync(output,{recursive:true,mode:0o700});
 writeFileSync(path.join(output,'source.json'),JSON.stringify({repositories:pinned.repositories,instance:group.instance,placement:JSON.parse(placement(group)),collectionRole:'native-reference-only',deploymentPackage:deploymentPackageIdentity,names:selected.map(row=>row.name)},null,2),{flag:'wx',mode:0o600});
 state.pendingBatches=[{output,sourceSha256:hash(readFileSync(path.join(output,'source.json'))),selected,placement:placement(group)}];
 persist();
 const startedAt=new Date().toISOString();
 let commandExit=null,commandError;
 try {
  commandExit=await systemTest(['run',...selected.map(row=>row.name),'--native-reference','--concurrency','1','--retain-trajectories','--out-dir',output,'--json'],undefined,signal);
 } catch(error) { commandError=error; }
 writeFileSync(path.join(output,'run-diagnostic.json'),JSON.stringify({startedAt,settledAt:new Date().toISOString(),commandExit,
  ...(commandError?{error:String(commandError)}:{}),aborted:signal.aborted,
  phaseTimingAvailable:false,reason:'These are CLI lifetime timestamps, not fixture Eval activation/CPU timings.'},null,2)+'\n',{flag:'wx',mode:0o600});
 assertPins();
 const runs=readdirSync(output).filter(name=>/^st_[a-f0-9]{32}$/u.test(name));
 assert.equal(runs.length,1,'Reference must produce one canonically owned system-test run; original command diagnostic retained');
 const records=[],unvalidated=[];
 for(const row of selected) {
  const filename=`trajectory-${row.name.replace(/[^A-Za-z0-9_.-]+/gu,'_').slice(0,100)}-full.json.gz`;
  const root=path.join(output,runs[0]);
  let file=[path.join(root,filename),path.join(root,'failure-evidence',filename)].find(existsSync);
  try {
   // Cancellation may already have preserved completed packets. Validate them
   // before considering retrieval; no aggregate progress-name gate is involved.
   if(!file&&!signal.aborted) {
    const result=await systemTest(['trajectory',runs[0],row.name,'--full','--json','--out-dir',output],'ignore',signal);
    assert.equal(result,0,'Reference full trajectory retention failed');
    file=[path.join(root,filename),path.join(root,'failure-evidence',filename)].find(existsSync);
   }
   assert.ok(file,'No full reference packet retained; case stays unchecked');
   const raw=readFileSync(file),packet=JSON.parse(gunzipSync(raw));
   const observed=inspectNativeReference(packet,row);
   const record={...row,...observed,artifact:file,sha256:hash(raw),runId:runs[0],...(deploymentPackageIdentity?{deploymentPackage:deploymentPackageIdentity}:{})};
   if(observed.status!=='passed') {
    const diagnosticFile=path.join(root,`inspect-${row.name.replace(/[^A-Za-z0-9_.-]+/gu,'_').slice(0,100)}.json`);
    if(!existsSync(diagnosticFile)&&!signal.aborted) {
     try { await systemTest(['inspect',runs[0],'--test',row.name,'--json','--out-dir',output],'ignore',signal); }
     catch(error) { record.diagnosticError=String(error); }
    }
    record.failureDiagnostic=existsSync(diagnosticFile)?{artifact:diagnosticFile,sha256:hash(readFileSync(diagnosticFile))}:
      {available:false,reason:signal.aborted?'Owner cancelled before diagnostic retrieval':'Canonical inspect did not retain a diagnostic'};
   }
   state.results[row.name]=record;records.push(record);
  } catch(error) {
   unvalidated.push({name:row.name,reason:String(error),...(file?{artifact:file,sha256:hash(readFileSync(file))}:{})});
  }
 }
 // The enclosing campaign already owns collection serially. Detect an
 // unexpected second index writer instead of overwriting another owner's work.
 assert.equal(existsSync(index)?hash(readFileSync(index)):null,original?hash(original):null,'Native-reference state has another writer');
 assertPins();
 delete state.pendingBatches;persist();
 writeFileSync(path.join(output,'reference-results.json'),JSON.stringify({schema:state.schema,repositories:state.repositories,results:records,unvalidated,teacherRegistryWrites:false},null,2)+'\n',{flag:'wx',mode:0o600});
 if(unvalidated.length)throw new AggregateError(unvalidated.map(row=>new Error(`${row.name}: ${row.reason}`)),
  'Reference batch retained unchecked evidence; verified prefix was preserved');
 if(commandError&&!records.length)throw commandError;
 return [...recovered,...records];
}

/** Honor the same non-aborting owner boundary for native-only continuation.
 * A drain is observed only between fully settled, retained batches. */
export async function runNativeReferenceBatches({draining,signal,drainAtBoundary=()=>false,runBatch,afterBatch=()=>{}}) {
 let batches=0,observed=0;
 while(!signal.aborted&&!drainAtBoundary()) {
  const records=await runBatch();
  batches++;observed+=records.length;
  await afterBatch(records);
  if(!draining||!records.length)break;
 }
 return {batches,observed};
}

export const nativeReferenceCapabilities=Object.freeze({schema:'vibestudio.native-reference-capabilities/1',completionControl:1,nativeOnly:true,selection:1});
/** The existing parent collector owner decides from actual paid receipts. A
 * source/nonce-bound decision is never inferred from elapsed time or exit text.
 */
export async function waitForNativeContinuation({control,out,pinned,signal,ownerIdentity,ownerAlive}) {
 if(!control||signal.aborted)return false;
 const source=path.join(out,'source.json'),sourceBytes=readFileSync(source);
 const request={schema:'vibestudio.native-reference-continuation/1',nonce:randomUUID(),capture:out,sourceSha256:hash(sourceBytes),repositories:pinned.repositories};
 const bytes=JSON.stringify(request)+'\n',requestPath=control+'.ready.json';
 assert.ok(!existsSync(requestPath),'Native continuation request already belongs to an owner');
 const temporary=requestPath+'.'+randomUUID()+'.tmp';
 writeFileSync(temporary,bytes,{flag:'wx',mode:0o600});renameSync(temporary,requestPath);
 const requestSha256=hash(bytes);
 while(!signal.aborted) {
  if(!ownerAlive(ownerIdentity))return false;
  if(existsSync(control+'.decision.json')) {
   const response=JSON.parse(readFileSync(control+'.decision.json'));
   assert.equal(response.schema,request.schema);assert.equal(response.requestSha256,requestSha256);
   assert.ok(['continue-paid','drain-native'].includes(response.decision));
   return response.decision==='drain-native';
  }
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 return false;
}

export function summarizeNativeReferences({workflows,pinned,stateRoot}) {
 const identity=hash(JSON.stringify(pinned.repositories)),index=path.join(stateRoot,identity,'state.json');
 const state=existsSync(index)?JSON.parse(readFileSync(index)):{repositories:pinned.repositories,results:{}};
 assert.deepEqual(state.repositories,pinned.repositories);
 const names=[...workflows].filter(([name,world])=>name.startsWith('open-goal-')&&world.interaction==='open-user-goal').map(([name])=>'open-goal-oracle-'+name.slice('open-goal-'.length));
 const results=names.flatMap(name=>state.results[name]?[state.results[name]]:[]);
 const unchecked=names.filter(name=>!state.results[name]);
 return {schema:'vibestudio.native-reference-coverage/1',repositories:pinned.repositories,planned:names.length,attempted:results.length,
  passed:results.filter(row=>row.status==='passed').length,failed:results.filter(row=>row.status==='failed').length,errored:results.filter(row=>row.status==='errored').length,
  unchecked:unchecked.length,uncheckedNames:unchecked,sweepCompleted:names.length>0&&unchecked.length===0,allQualified:names.length>0&&results.length===names.length&&results.every(row=>row.status==='passed'),teacherRegistryWrites:false};
}
