import {expect,it} from "vitest";
import {mkdtemp,readdir,readFile,rm} from "node:fs/promises";
import {createHash} from "node:crypto";
import {retainEvalCaptureEvidence} from "./retainEvalCaptureEvidence.js";
import {INTERNAL_DO_SOURCE} from "./internalDOs/internalDoLoader.js";
import type {EntityRecord} from "@vibestudio/shared/runtime/entitySpec";
const record={id:"do:owned",kind:"do",source:{repoPath:INTERNAL_DO_SOURCE,effectiveVersion:"v1"},className:"EvalDO",key:"owner",contextId:"context",status:"retired",authoritySessionId:"lifetime",createdAt:1,cleanupComplete:false} as EntityRecord;
function rows(changed:Record<string,unknown>={}){
 const json=JSON.stringify({schema:"natlang.pending-model-exchanges/1",owner:{objectKey:"owner"},runId:"run",calls:[{model_turns:[{response:"😀".repeat(400)}]}]});
 // Native chunks never split UTF-16 pairs; this fixture uses JSON-escaped text.
 const text=JSON.stringify({original:json});const chunks=Array.from(text).reduce<string[]>((out,char)=>{if(!out.length||out.at(-1)!.length>=100)out.push("");out[out.length-1]+=char;return out;},[]);
 const sha=createHash("sha256").update(text).digest("hex"),base="natlang_pending_capture:run:"+sha;
 return {text,sha,rows:[{key:base,value:JSON.stringify({schema:"eval.retained-provider-evidence/1",source:"@workspace/natlang",sourceIdentity:{bundleSha256:"a".repeat(64)},owner:{objectKey:"owner"},runId:"run",contextId:"context",sha256:sha,chunks:chunks.length,bytes:Buffer.byteLength(text),chars:text.length,...changed})},...chunks.map((value,index)=>({key:base+":"+String(index).padStart(8,"0"),value}))]};
}
it("archives bounded native pages to exact standalone files before namespace disposal",async()=>{
 const root=await mkdtemp("/home/werg/data/eval-capture-archive-");
 try{
  const fixture=rows();let calls=0;
  await retainEvalCaptureEvidence(record,root,async({after})=>{calls++;const start=after?fixture.rows.findIndex(row=>row.key===after)+1:0;const page=fixture.rows.slice(start,start+8);return{rows:page,after:start+8<fixture.rows.length?page.at(-1)!.key:null};});
  expect(calls).toBeGreaterThan(1);
  const directory=root+"/"+createHash("sha256").update(record.id).digest("hex");
  expect(await readFile(directory+"/"+fixture.sha+".json","utf8")).toBe(fixture.text);
  const manifest=JSON.parse(await readFile(directory+"/"+fixture.sha+".manifest.json","utf8"));expect(manifest.runtime.id).toBe(record.id);
  expect(manifest.native.sha256).toBe(fixture.sha);
 }finally{await rm(root,{recursive:true,force:true});}
});
it("rejects foreign ownership and corrupt payloads without publishing partial evidence",async()=>{
 for(const change of [{owner:{objectKey:"foreign"}},{bytes:1}]){
  const root=await mkdtemp("/home/werg/data/eval-capture-archive-");
  try{
   const fixture=rows(change);
   await expect(retainEvalCaptureEvidence(record,root,async()=>({rows:fixture.rows,after:null}))).rejects.toThrow();
   const entries=await readdir(root,{recursive:true});expect(entries.some(name=>name.endsWith(".json")||name.endsWith(".tmp"))).toBe(false);
  }finally{await rm(root,{recursive:true,force:true});}
 }
});
it("never reads non-builtin lookalikes",async()=>{
 let called=false;await retainEvalCaptureEvidence({...record,source:{...record.source,repoPath:"workers/foreign"}},"/unreachable",async()=>{called=true;throw new Error("foreign")});expect(called).toBe(false);
});
