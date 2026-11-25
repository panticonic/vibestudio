import {expect,it} from "vitest";
import {readFileSync} from "node:fs";
import {blobstoreMethods} from "@vibestudio/service-schemas/blobstore";
import {serializeMethod} from "./serialize.js";
import {createDocsService} from "../docsService.js";
import type {ServiceDefinition} from "@vibestudio/shared/serviceDefinition";
it("publishes actual blob handler argument names through the canonical role-filtered catalog",async()=>{
 const definition={name:"blobstore",authority:{principals:["code","host","user"]},methods:blobstoreMethods,handler:async()=>undefined} as ServiceDefinition;
 const docs=createDocsService({dispatcher:{getServiceDefinitions:()=>[definition]} as never,runtimeSurfaces:{} as never});
 const context={caller:{runtime:{kind:"worker"}},initiator:{kind:"code"}} as never;
 expect(await docs.handler(context,"describe",["service:blobstore.putText"])).toMatchObject({argumentNames:["text"]});
 expect(await docs.handler(context,"describe",["service:blobstore.getText"])).toMatchObject({argumentNames:["hash"]});
});
it("keeps every blob wire tuple's names in exact native handler order, including optional arguments",()=>{
 // Source of truth is the actual positional native handler contract, not guessed
 // names for JSON schema positions. No storage or network operation is executed.
 const source=readFileSync(new URL("../blobstoreService.ts",import.meta.url),"utf8");
 for(const [name,method] of Object.entries(blobstoreMethods)){
  const match=source.match(new RegExp("\\b"+name+": (?:async )?\\([^,]+, \\[([^\\]]*)\\]\\) =>"));
  expect(match,`native handler ${name}`).not.toBeNull();
  const actual=match![1]!.split(",").map(part=>part.trim()).filter(Boolean);
  expect(serializeMethod(method).argumentNames,name).toEqual(actual);
 }
});
