import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {recordExportRejection} from './live-export-diagnostics.mjs';
test('retains repeated ordinary and interrupted exporter errors bound to the exact original packet and source',async()=>{
 const directory=mkdtempSync(path.join(tmpdir(),'vibe-export-diagnostic-'));try{
 const trajectory=path.join(directory,'trajectory-case-full.json.gz'),pins=path.join(directory,'source.json');writeFileSync(trajectory,'actual compressed packet');writeFileSync(pins,'{"source":"actual"}');
 const args={directory,scenario:'open-goal-case',runId:'st_owned',pins,trajectory};
 await recordExportRejection({...args,error:new Error('Independent content review did not pass')});
 await recordExportRejection({...args,error:Object.assign(new Error('Native capture does not bind'),{code:'ECAPTURE'}),interrupted:true});
 const rows=readFileSync(path.join(directory,'st_owned/export-rejections.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(rows.length,2);assert.equal(rows[0].interrupted,false);assert.equal(rows[1].interrupted,true);assert.equal(rows[1].error.code,'ECAPTURE');assert.equal(rows[0].error.message,'Error: Independent content review did not pass');assert.equal(rows[0].trajectory.sha256,createHash('sha256').update('actual compressed packet').digest('hex'));assert.equal(rows[0].pinsSha256,createHash('sha256').update('{"source":"actual"}').digest('hex'));
 }finally{rmSync(directory,{recursive:true,force:true})}
});
test('records retrieval errors without claiming a missing packet exists',async()=>{
 const directory=mkdtempSync(path.join(tmpdir(),'vibe-export-diagnostic-'));try{const row=await recordExportRejection({directory,scenario:'case',runId:'st_missing',pins:path.join(directory,'source.json'),trajectory:path.join(directory,'absent.gz'),error:'Unable to retrieve durable trajectory'});assert.equal(row.trajectory,null);assert.equal(row.pinsSha256,null);assert.equal(row.error.message,'Unable to retrieve durable trajectory');}finally{rmSync(directory,{recursive:true,force:true})}
});

test('an auxiliary diagnostic I/O failure never replaces the original exporter failure',async()=>{
 const directory=mkdtempSync(path.join(tmpdir(),'vibe-export-diagnostic-'));const log=console.error;let message='';try{writeFileSync(path.join(directory,'st_owned'),'not a directory');console.error=value=>{message=String(value)};const row=await recordExportRejection({directory,scenario:'case',runId:'st_owned',pins:path.join(directory,'source.json'),trajectory:path.join(directory,'absent.gz'),error:new Error('original admission failure')});assert.equal(row,null);assert.match(message,/original admission failure/);assert.match(message,/ENOTDIR|EEXIST/);}finally{console.error=log;rmSync(directory,{recursive:true,force:true})}
});
