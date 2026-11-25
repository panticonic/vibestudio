import test from 'node:test';
import assert from 'node:assert/strict';
import {natlangRunExportCode} from './lib/natlang-live-export.mjs';
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
const details={r:{record:{call_id:'r',parent_call_id:null,model_turns:[]},summary:{run_id:'actual-run',owner_key:'owned',owner_kind:'eval'}},c:{record:{call_id:'c',parent_call_id:'r'},summary:{run_id:'actual-run',owner_key:'owned',owner_kind:'eval'}}};
function api(overrides={}) {return {calls:async query=>{assert.equal(query.run,'actual-run');return query.after?[]:[{callId:'r',parentCallId:null},{callId:'c',parentCallId:'r'}];},trace:async id=>structuredClone(details[id]),...overrides};}
test('export uses exact original run, paginates and retains raw durable call evidence',async()=>{
 const value=await new AsyncFunction('natlang',natlangRunExportCode({runId:'actual-run',rootCallIds:['r']}))(api());
 assert.deepEqual(value.calls,[details.r,details.c]);assert.deepEqual(value.rootCallIds,['r']);
});
test('export refuses missing completion, changed owner/run and wrong roots',async()=>{
 for(const change of [d=>d.summary.run_id='other',d=>d.record=null,d=>d.summary.owner_key='other',d=>d.summary.owner_kind='other']){
 const service=api({trace:async id=>{const d=structuredClone(details[id]);if(id==='c')change(d);return d;}});
 await assert.rejects(new AsyncFunction('natlang',natlangRunExportCode({runId:'actual-run',rootCallIds:['r']}))(service));
 }
 await assert.rejects(new AsyncFunction('natlang',natlangRunExportCode({runId:'actual-run',rootCallIds:['unrelated']}))(api()));
});
test('retains true nested task calls with separate program scopes without rewriting records',async()=>{
 const records={
  application:{record:{call_id:'application',parent_call_id:null,task_id:'application-task',program_root:'skills/owner',definition:{name:'work',source:'work.ts'},effects:[{service:'programExecution',method:'run'}]},summary:{run_id:'actual-run',owner_key:'owned',owner_kind:'eval'}},
  loaded:{record:{call_id:'loaded',parent_call_id:'application',task_id:'loaded-task',program_root:'/.tmp/owned-program/source',definition:{name:'check',source:'main.ts'},output:{complete:true,hash:'native-output'}},summary:{run_id:'actual-run',owner_key:'owned',owner_kind:'eval'}},
 };
 const service={calls:async query=>query.after?[]:Object.entries(records).map(([callId,detail])=>({callId,parentCallId:detail.record.parent_call_id})),trace:async id=>structuredClone(records[id])};
 const before=structuredClone(records),value=await new AsyncFunction('natlang',natlangRunExportCode({runId:'actual-run',rootCallIds:['application']}))(service);
 assert.deepEqual(value.calls,Object.values(before));assert.deepEqual(records,before);assert.notEqual(value.calls[0].record.task_id,value.calls[1].record.task_id);
});
test('does not invent ancestry for disjoint tasks sharing an owner and eval run',async()=>{
 const service=api({calls:async query=>query.after?[]:[{callId:'r',parentCallId:null},{callId:'c',parentCallId:null}],trace:async id=>{const d=structuredClone(details[id]);d.record.parent_call_id=null;return d;}});
 await assert.rejects(new AsyncFunction('natlang',natlangRunExportCode({runId:'actual-run',rootCallIds:['r']}))(service),/root lineage/);
});
test('rejects row/detail ancestry mismatch and repeated pagination records',async()=>{
 await assert.rejects(new AsyncFunction('natlang',natlangRunExportCode({runId:'actual-run',rootCallIds:['r']}))(api({trace:async id=>{const d=structuredClone(details[id]);if(id==='c')d.record.parent_call_id=null;return d;}})),/mismatched run lineage/);
 await assert.rejects(new AsyncFunction('natlang',natlangRunExportCode({runId:'actual-run',rootCallIds:['r']}))(api({calls:async()=>[{callId:'r',parentCallId:null}]})),/duplicate call/);
});
test('rejects an unrooted cycle even when all parent IDs exist',async()=>{
 const cyclic={...structuredClone(details),d:{record:{call_id:'d',parent_call_id:'c'},summary:{run_id:'actual-run',owner_key:'owned',owner_kind:'eval'}}};cyclic.c.record.parent_call_id='d';
 const service={calls:async query=>query.after?[]:Object.entries(cyclic).map(([callId,d])=>({callId,parentCallId:d.record.parent_call_id})),trace:async id=>structuredClone(cyclic[id])};
 await assert.rejects(new AsyncFunction('natlang',natlangRunExportCode({runId:'actual-run',rootCallIds:['r']}))(service),/cyclic call lineage/);
});
