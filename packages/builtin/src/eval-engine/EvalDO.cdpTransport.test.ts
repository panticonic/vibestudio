import { afterEach,expect,it,vi } from "vitest";
import { createContext,runInContext } from "node:vm";
import path from "node:path";
import { build } from "esbuild";
import { WebSocketServer } from "ws";
import { createTestDO } from "@vibestudio/durable/test-utils";
import { mainRpcMethods } from "@vibestudio/service-schemas/mainRpc";
import { createDurableObjectServiceClient } from "@vibestudio/service-schemas/clients/durableObjectServiceClient";
import { createLazyTypedRpcServiceClient } from "@vibestudio/shared/typedRpcServiceClient";
import * as workspaceService from "@vibestudio/shared/workspaceServiceRpc";
import { requireDevelopmentTemplateCheckout } from "../../../../src/dev/developmentTemplateConfig.js";
import { EvalDO } from "./EvalDO.js";
import { ExecutionJournal } from "./executionJournal.js";
afterEach(()=>vi.unstubAllGlobals());

async function privateFactories() {
  const base=process.env["VIBESTUDIO_TEST_BASE_CHECKOUT"] ?? requireDevelopmentTemplateCheckout(process.cwd(),"base");
  const modules:Record<string,unknown>={"@vibestudio/service-schemas/mainRpc":{mainRpcMethods},
    "@vibestudio/service-schemas/clients/durableObjectServiceClient":{createDurableObjectServiceClient},
    "@vibestudio/shared/typedRpcServiceClient":{createLazyTypedRpcServiceClient},
    "@vibestudio/shared/workspaceServiceRpc":workspaceService};
  const artifact=await build({stdin:{contents:`export {createWorkerdClient} from './packages/runtime/src/shared/workerd.ts'; export {createCdpAutomation} from './packages/runtime/src/panel/cdpAutomation.ts'; export {BrowserImpl,CdpConnection} from './packages/cdp-client/src/worker.ts';`,resolveDir:base},
    bundle:true,write:false,format:"cjs",platform:"neutral",plugins:[{name:"private-support",setup(builder){
      builder.onResolve({filter:/^@vibestudio\/rpc\/protocol\/cdpSocket$/},()=>({path:path.resolve("packages/rpc/src/protocol/cdpSocket.ts")}));
      builder.onResolve({filter:/^@vibestudio\//},({path:specifier})=>({path:specifier,external:true}));
    }}]});
  // These non-network SDK helpers are existing explicit native endowments.
  modules["@vibestudio/rpc"] = await import("@vibestudio/rpc");
  modules["@vibestudio/shared/rpcMethods"] = await import("@vibestudio/shared/rpcMethods");
  modules["@vibestudio/shared/panel/observation"] = await import("@vibestudio/shared/panel/observation");
  modules["@vibestudio/service-schemas/eval"] = await import("@vibestudio/service-schemas/eval");
  const module={exports:{} as any};
  const realm=createContext({module,exports:module.exports,require:(name:string)=>{if(!(name in modules))throw new Error("Missing explicit SDK "+name);return modules[name];},
    URL,AbortSignal,AbortController,TextEncoder,TextDecoder,setTimeout,clearTimeout,queueMicrotask,console,btoa,atob});
  runInContext(artifact.outputFiles[0]!.text,realm);
  expect(runInContext("typeof fetch + ':' + typeof WebSocket",realm)).toBe("undefined:undefined");
  return module.exports;
}

it("injects real kernel capabilities into privately evaluated inspector and panel factories",async()=>{
  const server=new WebSocketServer({host:"127.0.0.1",port:0});
  await new Promise<void>(resolve=>server.once("listening",resolve));
  const address=server.address();if(!address||typeof address==="string")throw new Error("Missing socket");
  const endpoint={wsEndpoint:`ws://127.0.0.1:${address.port}/workerd-inspector/owned`,token:"owned-grant"};
  const received:string[]=[];
  server.on("connection",socket=>socket.on("message",raw=>{const message=JSON.parse(String(raw));received.push(message.method);if(message.method!=="Pending.command")socket.send(JSON.stringify({id:message.id,result:{ok:true,result:{value:"about:blank"}}}));}));
  const {instance}=await createTestDO(EvalDO);
  const kernel=instance as any;
  const controller=new AbortController();
  const execution={contextId:"owned",runId:"run",signal:controller.signal,residentSessionCleanups:new Set<()=>Promise<void>>(),
    operationJournal:new ExecutionJournal(),rpc:{call:vi.fn(async()=>endpoint),stream:vi.fn(),streamReadable:vi.fn()}};
  const run=<T>(work:()=>Promise<T>):Promise<T>=>kernel.activeEvalExecution.run(execution,work);
  const NativeWebSocket=globalThis.WebSocket;
  const nativeSockets:WebSocket[]=[];
  vi.stubGlobal("WebSocketPair",function WorkerPair(){});
  vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL)=>{
    const url=new URL(String(input));url.protocol="ws:";const native=new NativeWebSocket(url);nativeSockets.push(native);
    await new Promise<void>((resolve,reject)=>{native.addEventListener("open",()=>resolve(),{once:true});native.addEventListener("error",reject,{once:true});});
    return {status:101,webSocket:native} as unknown as Response;
  }));
  try {
    const guest=await privateFactories();
    let panelOptions:any;
    const support={createWorkerdClient:guest.createWorkerdClient,createPanelRuntime:(options:any)=>{panelOptions=options;return {getPanelHandle:()=>({})};},
      createHostedRuntime:(host:any)=>host,createRuntimeSelfHandle:()=>({}),createGatewayFetch:()=>()=>{},createRpcFs:()=>({}),createRuntimeParentHandle:()=>null};
    const runtime=kernel.createRunHostedRuntime(support,execution,"gateway",null,{});
    await run(async()=>{
      // Reproduce v5: the support factory itself has no ambient transport.
      const unbound=await guest.createWorkerdClient(runtime.rpc).inspectorSocket("/owned");
      await expect(guest.CdpConnection.connect(unbound.wsEndpoint,unbound.token,false,{openSocket:unbound.openSocket})).rejects.toThrow("neither WebSocket nor fetch");
      const bound=await runtime.workers.inspectorSocket("/owned");
      const connection=await guest.CdpConnection.connect(bound.wsEndpoint,bound.token,false,{openSocket:bound.openSocket});
      expect(await connection.send("Profiler.enable")).toMatchObject({ok:true});
      expect(Object.getPrototypeOf((connection as any).ws)).toBeNull();
      expect(Object.isFrozen((connection as any).ws)).toBe(true);
      const events:any[]=[];
      (connection as any).ws.addEventListener("message",(event:any)=>events.push(event));
      await connection.send("Runtime.enable");
      expect(Object.getPrototypeOf(events[0])).toBeNull();
      expect(events[0].target).toBe((connection as any).ws);
      expect(events[0].currentTarget).toBe((connection as any).ws);
      expect(events[0].target.constructor).toBeUndefined();
      const eventCount=events.length;
      // Native workerd socket events need not preserve caller async context.
      kernel.activeEvalExecution.exit(()=>nativeSockets[0]!.dispatchEvent(new MessageEvent("message",{
        data:JSON.stringify({method:"Runtime.consoleAPICalled",params:{type:"log"}})})));
      expect(events).toHaveLength(eventCount+1);
      expect(()=>kernel.activeEvalExecution.exit(()=>panelOptions.bindCdpSocket(endpoint))).toThrow("active");
      await expect(bound.openSocket(bound.wsEndpoint,bound.token)).rejects.toThrow("already been used");
      expect(()=>panelOptions.bindCdpSocket({...endpoint,token:"foreign"})).toThrow("issued endpoint grant");
      expect(()=>panelOptions.bindCdpSocket({...endpoint,wsEndpoint:endpoint.wsEndpoint+"/foreign"})).toThrow("issued endpoint grant");
      const observation={panelId:"panel:owned",kind:"workspace",source:"panels/owned",phase:"ready",
        attemptId:"attempt",runtimeEntityId:"runtime",buildKey:"build"};
      const panel=guest.createCdpAutomation(panelOptions.rpc,"panel:owned",{
        bindCdpSocket:panelOptions.bindCdpSocket,loadModule:async()=>({BrowserImpl:guest.BrowserImpl}),
        observe:async()=>observation,ensureReady:async()=>observation});
      const session=await panel.session();
      expect(session.page.isClosed()).toBe(false);
      const pending=connection.send("Pending.command");
      const rejected=expect(pending).rejects.toThrow();
      controller.abort(new Error("owner cancelled"));
      await rejected;
      expect(connection.isClosed()).toBe(true);
      kernel.closedInspectionExecutions.add(execution);
      await kernel.settleResidentSessions(execution);
      expect(execution.residentSessionCleanups.size).toBe(0);
      expect(connection.isClosed()).toBe(true);
      await expect(connection.send("Profiler.start")).rejects.toThrow();
      expect(()=>panelOptions.bindCdpSocket(endpoint)).toThrow("active execution");
    });
    expect(received).toContain("Profiler.enable");
    expect(received).toContain("Page.getFrameTree");
  } finally {
    for(const socket of server.clients)socket.terminate();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
