import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync,renameSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import path from 'node:path';

const hash=value=>createHash('sha256').update(value).digest('hex');
const placement=world=>JSON.stringify([world.workspace??'system',world.workspaceBaseline??null,[...new Set(world.devices??[])].sort()]);
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
  selected.push({name,goal:world.assignment.goal,scenario});
 }
 return selected;
}
export function inspectNativeReference(packet,selected) {
 assert.equal(packet.test?.name,selected.name);
 const execution=packet.execution,diagnostics=execution?.diagnostics,proof=diagnostics?.openGoalVerification;
 assert.ok(execution,'Reference has no execution evidence');
 assert.ok(diagnostics?.natlangTeacher==null,'Reference returned teacher evidence');
 assert.equal(execution.trajectoryReview?.modelCallCount??0,0,'Reference executed a model');
 if(execution.error) return {status:'errored',reason:execution.error,nativeProofValidated:false,
   modelCallCount:execution.trajectoryReview?.modelCallCount??null};
 assert.equal(diagnostics?.natlangTeacher,null,'Reference lacks its native completion witness');
 assert.equal(execution.trajectoryReview?.modelCallCount,0,'Reference lacks explicit zero-model telemetry');
 assert.ok(!(diagnostics.openGoalVerificationErrors??[]).length,'Reference native verification produced errors');
 assert.equal(proof?.goal,selected.goal,'Reference goal changed');
 assert.equal(proof?.contextId,execution.provenance?.contextId,'Reference context changed');
 assert.equal(proof?.caseId,selected.scenario.slice('open-goal-'.length),'Reference case changed');
 assert.ok(proof.checks&&Object.keys(proof.checks).length&&Object.values(proof.checks).every(value=>typeof value==='boolean'));
 const unexpected=(execution.toolFailures??[]).filter(failure=>failure.expected!==true);
 const passed=!execution.error&&!(execution.cleanupErrors??[]).length&&!unexpected.length&&packet.result?.passed===true&&proof.passed===true&&Object.values(proof.checks).every(Boolean);
 return {status:passed?'passed':execution.error?'errored':'failed',checks:proof.checks,contextId:proof.contextId,modelCallCount:0};
}
/** Called only by the collector owning this exact instance, after its paid suite
 * and exporter have joined. The ordinary CLI still owns all fixture/resource cleanup.
 * Reference output is never passed to the teacher exporter or its registry.
 */
export async function runNativeReferenceTail({group,workflows,catalog,pinned,out,stateRoot,limit,systemTest,signal,deploymentPackageAvailable,assertPins=()=>{}}) {
 if(!limit||signal.aborted)return [];
 const identity=hash(JSON.stringify(pinned.repositories)),stateDir=path.join(stateRoot,identity);
 mkdirSync(stateDir,{recursive:true,mode:0o700});
 const index=path.join(stateDir,'state.json');
 const original=existsSync(index)?readFileSync(index):null;
 const state=original?JSON.parse(original):{schema:'vibestudio.native-reference-tail/1',repositories:pinned.repositories,results:{}};
 assert.deepEqual(state.repositories,pinned.repositories);
 const selected=selectNativeReferences({group,workflows,catalog,completed:state.results,limit,deploymentPackageAvailable});
 if(!selected.length)return [];
 const output=path.join(out,'native-reference-only',randomUUID());mkdirSync(output,{recursive:true,mode:0o700});
 writeFileSync(path.join(output,'source.json'),JSON.stringify({repositories:pinned.repositories,instance:group.instance,placement:JSON.parse(placement(group)),collectionRole:'native-reference-only',names:selected.map(row=>row.name)},null,2),{flag:'wx',mode:0o600});
 assertPins();
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
  const filename=`trajectory-${row.name.replace(/[^A-Za-z0-9_.-]/gu,'_').slice(0,100)}-full.json.gz`;
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
   const record={...row,...observed,artifact:file,sha256:hash(raw),runId:runs[0]};
   if(observed.status!=='passed') {
    const diagnosticFile=path.join(root,`inspect-${row.name.replace(/[^A-Za-z0-9_.-]/gu,'_').slice(0,100)}.json`);
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
 const temporary=index+'.'+randomUUID()+'.tmp';writeFileSync(temporary,JSON.stringify(state,null,2)+'\n',{flag:'wx',mode:0o600});renameSync(temporary,index);
 writeFileSync(path.join(output,'reference-results.json'),JSON.stringify({schema:state.schema,repositories:state.repositories,results:records,unvalidated,teacherRegistryWrites:false},null,2)+'\n',{flag:'wx',mode:0o600});
 if(unvalidated.length)throw new AggregateError(unvalidated.map(row=>new Error(`${row.name}: ${row.reason}`)),
  'Reference batch retained unchecked evidence; verified prefix was preserved');
 if(commandError&&!records.length)throw commandError;
 return records;
}

export const nativeReferenceCapabilities=Object.freeze({schema:'vibestudio.native-reference-capabilities/1',completionControl:1,nativeOnly:true});
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
