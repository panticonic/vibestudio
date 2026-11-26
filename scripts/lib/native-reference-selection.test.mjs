import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {selectNativeReferenceWorkflows,summarizeNativeReferences} from './native-reference-tail.mjs';
const a={interaction:'open-user-goal',workspace:'system',devices:['android']},b={interaction:'open-user-goal',workspace:'examples'},closed={interaction:'assignment'};
const workflows=new Map([['open-goal-a',a],['open-goal-b',b],['closed-fixture',closed]]);
test('native subset retains exact workflow placement/identity and leaves source map unchanged',()=>{
 const selected=selectNativeReferenceWorkflows({workflows,names:['open-goal-b'],nativeOnly:true});
 assert.deepEqual([...selected.keys()],['open-goal-b']);assert.equal(selected.get('open-goal-b'),b);assert.equal(workflows.size,3);
});
test('default native selection preserves every domain including owned Android prerequisites',()=>{
 const selected=selectNativeReferenceWorkflows({workflows,nativeOnly:true});assert.deepEqual(selected,workflows);assert.equal(selected.get('open-goal-a'),a);
});
for(const names of [['unknown'],['closed-fixture'],['open-goal-a','open-goal-a']])test(`refuses invalid native selection ${names}`,()=>{
 assert.throws(()=>selectNativeReferenceWorkflows({workflows,names,nativeOnly:true}));
});
test('teacher collection cannot apply native-only selection',()=>assert.throws(()=>selectNativeReferenceWorkflows({workflows,names:['open-goal-a']})));
test('selected subset does not manufacture completion or erase deferred full-scope obligations',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'TEST-native-selection-'));try{
  const selected=selectNativeReferenceWorkflows({workflows,names:['open-goal-b'],nativeOnly:true});assert.equal(selected.size,1);
  const summary=summarizeNativeReferences({workflows,pinned:{repositories:{host:{git_commit:'source',dirty:false}}},stateRoot:dir});
  assert.equal(summary.planned,2);assert.equal(summary.attempted,0);assert.equal(summary.unchecked,2);assert.equal(summary.sweepCompleted,false);assert.equal(summary.allQualified,false);assert.deepEqual(summary.uncheckedNames,['open-goal-oracle-a','open-goal-oracle-b']);
 }finally{rmSync(dir,{recursive:true});}
});
