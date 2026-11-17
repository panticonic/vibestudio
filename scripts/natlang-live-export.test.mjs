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
