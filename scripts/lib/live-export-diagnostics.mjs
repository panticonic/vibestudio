import {appendFileSync,existsSync,mkdirSync,readFileSync} from 'node:fs';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
async function fileHash(file){const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest('hex');}
/** Diagnostic custody only: this never grants capture admission or changes a verdict. */
async function appendExportRejection({directory,scenario,runId,pins,trajectory,error,interrupted=false}){
 const folder=path.join(directory,runId);mkdirSync(folder,{recursive:true,mode:0o700});
 const receipt={schema:'vibestudio.teacher-export-rejection/1',scenario,runId,interrupted,
  trajectory:existsSync(trajectory)?{path:path.basename(trajectory),sha256:await fileHash(trajectory)}:null,
  pinsSha256:existsSync(pins)?createHash('sha256').update(readFileSync(pins)).digest('hex'):null,
  error:{name:error instanceof Error?error.name:'Error',message:String(error)},at:Date.now()};
 if(typeof error?.code==='string')receipt.error.code=error.code;
 appendFileSync(path.join(folder,'export-rejections.jsonl'),JSON.stringify(receipt)+'\n',{mode:0o600});
 return receipt;
}

export async function recordExportRejection(input){
 if(process.env.VIBESTUDIO_EXPORT_FAILURE_DIAGNOSTICS==='0')return null;
 try{return await appendExportRejection(input);}
 catch(error){console.error(`Unable to retain export diagnostic for ${input.scenario}; original exporter error: ${String(input.error)}; diagnostic error: ${String(error)}`);return null;}
}
