import test from 'node:test';
import assert from 'node:assert/strict';
import{mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync}from'node:fs';
import{gzipSync}from'node:zlib';
import{tmpdir}from'node:os';
import path from'node:path';
import{selectNativeReferences,inspectNativeReference,runNativeReferenceTail}from'./native-reference-tail.mjs';
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
 for(const mutate of [p=>p.execution.diagnostics.natlangTeacher={},p=>p.execution.trajectoryReview.modelCallCount=1,p=>p.test.name='foreign',p=>p.execution.diagnostics.openGoalVerification.goal='foreign',p=>p.execution.diagnostics.openGoalVerification.contextId='foreign',p=>p.execution.diagnostics.openGoalVerification.caseId='foreign',p=>p.execution.diagnostics.openGoalVerification.checks={}]){const p=packet();mutate(p);assert.throws(()=>inspectNativeReference(p,selected));}
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
