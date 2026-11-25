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
 assert.equal(diagnostics?.natlangTeacher,null,'Reference returned teacher evidence');
 assert.equal(execution.trajectoryReview?.modelCallCount??0,0,'Reference executed a model');
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
 await systemTest(['run',...selected.map(row=>row.name),'--concurrency','1','--retain-trajectories','--out-dir',output,'--json'],undefined,signal);
 assertPins();
 const runs=readdirSync(output).filter(name=>/^st_[a-f0-9]{32}$/u.test(name));
 assert.equal(runs.length,1,'Reference must produce one canonically owned system-test run');
 const records=[];
 for(const row of selected) {
  if(signal.aborted)break;
  const result=await systemTest(['trajectory',runs[0],row.name,'--full','--json','--out-dir',output],'ignore',signal);
  assert.equal(result,0,'Reference full trajectory retention failed');
  const file=path.join(output,runs[0],`trajectory-${row.name.replace(/[^A-Za-z0-9_.-]/gu,'_').slice(0,100)}-full.json.gz`);
  const raw=readFileSync(file),packet=JSON.parse(gunzipSync(raw));
  const observed=inspectNativeReference(packet,row);
  const record={...row,...observed,artifact:file,sha256:hash(raw),runId:runs[0]};
  state.results[row.name]=record;records.push(record);
 }
 // The enclosing campaign already owns collection serially. Detect an
 // unexpected second index writer instead of overwriting another owner's work.
 assert.equal(existsSync(index)?hash(readFileSync(index)):null,original?hash(original):null,'Native-reference state has another writer');
 assertPins();
 const temporary=index+'.'+randomUUID()+'.tmp';writeFileSync(temporary,JSON.stringify(state,null,2)+'\n',{flag:'wx',mode:0o600});renameSync(temporary,index);
 writeFileSync(path.join(output,'reference-results.json'),JSON.stringify({schema:state.schema,repositories:state.repositories,results:records,teacherRegistryWrites:false},null,2)+'\n',{flag:'wx',mode:0o600});
 return records;
}
