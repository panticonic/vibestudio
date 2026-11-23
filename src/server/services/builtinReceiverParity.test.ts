import {expect,it} from "vitest";
import {PRODUCT_BUILTINS} from "@vibestudio/service-schemas/productBuiltinServices";
import {resolveReceiverAuthority} from "@vibestudio/shared/receiverAuthorityDeclaration";
import {directRpcDenial} from "@vibestudio/shared/directRpcEnforcement";
import {createHostCaller} from "@vibestudio/shared/serviceDispatcher";
import {attestDirectRpc} from "./authorityRuntime.js";

it("attests every typed builtin method with exactly its live receiver policy",()=>{
 for(const builtin of PRODUCT_BUILTINS){
  for(const [method,schema] of Object.entries(builtin.directMethods)){
   const attestation=attestDirectRpc({caller:createHostCaller("main"),source:builtin.source,
    className:builtin.className,objectKey:"native-owner",method,workspaceId:"workspace",
    workspaceMember:true,sessionId:"native-archive",now:100});
   const declaration=resolveReceiverAuthority(builtin.className,method,schema,null);
   const denied=directRpcDenial({kind:"call",method,caller:null,attestation,
    audience:attestation.audience,resourceKey:attestation.resourceKey,capability:attestation.capability,
    declaration,now:100});
   expect(denied,`${builtin.className}.${method}`).toBeNull();
  }
 }
});
