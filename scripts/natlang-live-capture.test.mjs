import test from 'node:test';
import assert from 'node:assert/strict';
import { captureExchange } from '../../vibestudio-templates/base/packages/natlang/src/modelTurnCapture.ts';

test('live capture snapshots actual input and reply before later mutations',async()=>{
 const events=[],request={invocation_id:'real-call',messages:[{role:'user',content:'actual context'}],tools:[]};
 const reply={text:'actual reply',calls:[]};
 const result=await captureExchange('generation',request,async()=>{request.messages[0].content='mutated by transport';return reply;},e=>events.push(e));
 assert.equal(result,reply);reply.text='later mutation';
 assert.equal(events[0].request.messages[0].content,'actual context');assert.equal(events[0].reply.text,'actual reply');
 assert.equal(events[0].kind,'generation');
});

test('actual failed requests have no fabricated reply and preserve original error',async()=>{
 const error=new Error('provider disconnected'),events=[];
 await assert.rejects(captureExchange('generation',{invocation_id:'failed'},async()=>{throw error;},e=>events.push(e)),e=>e===error);
 assert.equal(events[0].reply,undefined);assert.equal(events[0].error.message,error.message);
});

test('real scores retain their own type and values; uncaptured calls retain their ordinary behavior',async()=>{
 const events=[],scores={log_probs:[-0.1,-2]};
 assert.equal(await captureExchange('score',{options:['true','false']},async()=>scores,e=>events.push(e)),scores);
 assert.equal(events[0].kind,'score');assert.deepEqual(events[0].reply,scores);
 assert.equal(await captureExchange('generation',undefined,async()=>7),7);
});
