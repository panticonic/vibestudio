import {writeFileAtomicSync} from "../atomicFile.js";
import {createHash,randomUUID} from "node:crypto";
import {mkdir,open,rename,unlink} from "node:fs/promises";
import path from "node:path";
import type {EntityRecord} from "@vibestudio/shared/runtime/entitySpec";
import {INTERNAL_DO_SOURCE} from "./internalDOs/internalDoLoader.js";
type Page={rows:Array<{key:string;value:string}>;after:string|null};
type ReadPage=(input:{after?:string})=>Promise<Page>;

/** Preserve original native custody before every logical Eval retirement. */
export async function retainEvalCaptureEvidence(record:EntityRecord,directory:string,read:ReadPage):Promise<void>{
 if(record.kind!=="do" || record.source.repoPath!==INTERNAL_DO_SOURCE || record.className!=="EvalDO")return;
 const root=path.join(directory,createHash("sha256").update(record.id).digest("hex"));
 let active:any,handle:Awaited<ReturnType<typeof open>>|undefined,temp:string|undefined,index=0,bytes=0,chars=0;
 let hash=createHash("sha256");
 const finish=async()=>{
  if(!active)return;
  if(index!==active.manifest.chunks || hash.digest("hex")!==active.manifest.sha256 || bytes!==active.manifest.bytes || chars!==active.manifest.chars)
   throw new Error("Native paid-exchange archive failed its exact content checks");
  await handle!.sync();await handle!.close();handle=undefined;
  await rename(temp!,path.join(root,active.manifest.sha256+".json"));temp=undefined;
  const manifestPath=path.join(root,active.manifest.sha256+".manifest.json");
  writeFileAtomicSync(manifestPath,JSON.stringify({runtime:record,native:active.manifest},null,2)+"\n",{mode:0o600});
  active=undefined;
 };
 let after:string|undefined;
 try{
  for(;;){
   const page=await read(after===undefined?{}:{after});
   for(const row of page.rows){
    let parsed:any;
    try{parsed=JSON.parse(row.value)}catch{}
    if(parsed?.schema==="eval.retained-provider-evidence/1"){
     await finish();
     if(!/^[a-f0-9]{64}$/u.test(parsed.sha256) || parsed.owner?.objectKey!==record.key || parsed.contextId!==record.contextId ||
        typeof parsed.runId!=="string" || row.key!==`natlang_pending_capture:${parsed.runId}:${parsed.sha256}` ||
        !Number.isSafeInteger(parsed.chunks) || parsed.chunks<1 || !Number.isSafeInteger(parsed.bytes) || !Number.isSafeInteger(parsed.chars))
      throw new Error("Native paid-exchange archive belongs to another execution or has malformed metadata");
     await mkdir(root,{recursive:true,mode:0o700});
     active={key:row.key,manifest:parsed};index=0;bytes=0;chars=0;hash=createHash("sha256");
     temp=path.join(root,parsed.sha256+"."+randomUUID()+".tmp");handle=await open(temp,"wx",0o600);
    }else{
     if(!active || row.key!==`${active.key}:${String(index).padStart(8,"0")}`)
      throw new Error("Native paid-exchange chunks are missing, reordered or unowned");
     const data=Buffer.from(row.value,"utf8");hash.update(data);bytes+=data.byteLength;chars+=row.value.length;
     await handle!.writeFile(data);index+=1;
    }
   }
   if(page.after===null)break;
   if(page.after===after || page.rows.length===0 || page.after!==page.rows.at(-1)!.key)
    throw new Error("Native paid-exchange page made no progress");
   after=page.after;
  }
  await finish();
 }finally{
  await handle?.close();if(temp)await unlink(temp).catch(error=>{if(error.code!=="ENOENT")throw error;});
 }
}
