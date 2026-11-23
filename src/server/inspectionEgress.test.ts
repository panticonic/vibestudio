import { afterEach,expect,it } from "vitest";
import { CdpGrantService,CDP_INTERNAL_GRANT_HEADER } from "@vibestudio/shared/cdpGrants";
import { WorkerdInspectorBridge } from "./workerdInspectorBridge.js";
import { authorizeInspectionEgress } from "./inspectionEgress.js";
const stores: {stop():void}[]=[];
afterEach(()=>{for(const store of stores.splice(0))store.stop();});
it("admits the exact gated inspector grant without consuming it and keeps panel authority separate",()=>{
  const bridge=new WorkerdInspectorBridge({port:4100,getInspectorUrl:()=>"http://127.0.0.1:9229"});stores.push(bridge);
  const panels=new CdpGrantService();stores.push(panels);
  const inspector=bridge.getEndpoint("service/owned","user:owner")!;
  const url=new URL(inspector.wsEndpoint);url.protocol="http:";
  const policy={gatewayOrigin:url.origin,validatesPanel:(token:string,target:string)=>panels.validatesTarget(token,target),
    validatesWorkerd:(token:string,target:string)=>bridge.validatesTransportGrant(token,target)};
  const request={targetUrl:url,method:"GET",headers:{[CDP_INTERNAL_GRANT_HEADER]:inspector.token}};
  expect(authorizeInspectionEgress(request,policy)).toEqual({trustedForwardHeaders:request.headers});
  expect(bridge.validatesTransportGrant(inspector.token,"service/owned")).toBe(true);
  for(const targetUrl of [new URL("http://127.0.0.1:4101"+url.pathname),new URL(url.origin+"/workerd-inspector/foreign"),
    new URL(url.origin+"/cdp/service%2Fowned"),new URL(url.origin+"/workerd-inspector/%GG"),new URL(url.origin+"/arbitrary")])
    expect(authorizeInspectionEgress({...request,targetUrl},policy)).toBeNull();
  expect(authorizeInspectionEgress({...request,method:"POST"},policy)).toBeNull();
  expect(authorizeInspectionEgress({...request,headers:{[CDP_INTERNAL_GRANT_HEADER]:"foreign"}},policy)).toBeNull();
  expect(authorizeInspectionEgress({...request,headers:{[CDP_INTERNAL_GRANT_HEADER]:[inspector.token,inspector.token]}},policy)).toBeNull();
  const panel=panels.grant("user:owner","panel:owned");
  expect(authorizeInspectionEgress({...request,targetUrl:new URL(url.origin+"/cdp/panel%3Aowned"),headers:new Headers({[CDP_INTERNAL_GRANT_HEADER]:panel.token})},policy)).not.toBeNull();
  expect(authorizeInspectionEgress({...request,headers:{[CDP_INTERNAL_GRANT_HEADER]:panel.token}},policy)).toBeNull();
  bridge.stop();
  expect(authorizeInspectionEgress(request,policy)).toBeNull();
});
