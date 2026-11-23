import {expect,it} from "vitest";
import {spawn} from "node:child_process";
import {createServer as netServer} from "node:net";
import {createServer} from "node:http";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {once} from "node:events";
import {createRequire} from "node:module";
import {WebSocketServer} from "ws";
const WebSocket=globalThis.WebSocket;
import {build} from "esbuild";
import {createContext,runInContext} from "node:vm";
import {WorkerdInspectorBridge} from "./workerdInspectorBridge.js";
async function freePort(){const server=netServer();await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const port=(server.address() as {port:number}).port;await new Promise<void>(r=>server.close(()=>r()));return port;}
it("runs strict CDP profiling against the actual workerd inspector dialect through its bridge",async()=>{
 const root=await mkdtemp("/home/werg/data/vibestudio-inspector-wire-");
 const req=createRequire(import.meta.url), inspectorPort=await freePort(),httpPort=await freePort();
 const server=createServer(),wss=new WebSocketServer({noServer:true});
 let bridge:WorkerdInspectorBridge|undefined,child:ReturnType<typeof spawn>|undefined,connection:any;
 let diagnostics="";
 try{
  await writeFile(root+"/worker.js",'export default {fetch(){let value=0;for(let i=0;i<2000000;i++)value+=i;return new Response(String(value))}}');
  await writeFile(root+"/config.capnp",`using Workerd = import "/workerd/workerd.capnp"; const config :Workerd.Config = (services=[(name="probe",worker=(modules=[(name="worker",esModule=embed "worker.js")],compatibilityDate="2026-01-01"))],sockets=[(name="http",address="127.0.0.1:${httpPort}",http=(),service="probe")]);`);
  child=spawn(req.resolve("@cloudflare/workerd-linux-64/bin/workerd"),["serve","--experimental",`--inspector-addr=127.0.0.1:${inspectorPort}`,root+"/config.capnp"]);
  child.stderr?.on("data",value=>{diagnostics+=String(value)});
  // Bounded test readiness only; this does not install a production deadline.
  for(let attempt=0;;attempt++){
   try{await fetch(`http://127.0.0.1:${inspectorPort}/json/list`);break;}catch(error){if(attempt>=100)throw new Error(diagnostics,{cause:error});await new Promise(r=>setTimeout(r,20));}
  }
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  bridge=new WorkerdInspectorBridge({port:(server.address() as {port:number}).port,getInspectorUrl:()=>`http://127.0.0.1:${inspectorPort}`});
  server.on("upgrade",(request,socket,head)=>bridge!.handleUpgrade(request,socket,head,wss));
  const endpoint=bridge.getEndpoint("probe","test-owner")!;
  const base=process.env.VIBESTUDIO_TEST_BASE_CHECKOUT!;
  const output=await build({stdin:{contents:"export {CdpConnection} from './packages/cdp-client/src/worker.ts'",resolveDir:base},bundle:true,write:false,format:"cjs",platform:"neutral",plugins:[{name:"sdk-socket",setup(b){b.onResolve({filter:/^@vibestudio\/rpc\/protocol\/cdpSocket$/},()=>({path:process.cwd()+"/packages/rpc/src/protocol/cdpSocket.ts"}));}}]});
  const module={exports:{} as any};runInContext(output.outputFiles[0]!.text,createContext({module,exports:module.exports,WebSocket,URL,AbortSignal,AbortController,TextEncoder,TextDecoder,setTimeout,clearTimeout,queueMicrotask,btoa,atob}));
  connection=await module.exports.CdpConnection.connect(endpoint.wsEndpoint,endpoint.token);
  expect(await connection.send("Profiler.enable")).toEqual({});
  expect(await connection.send("Profiler.setSamplingInterval",{interval:1000})).toEqual({});
  expect(await connection.send("Profiler.start")).toEqual({});
  expect((await fetch(`http://127.0.0.1:${httpPort}`)).status).toBe(200);
  const stopped=await connection.send("Profiler.stop");
  expect(stopped.profile.nodes.length).toBeGreaterThan(0);
  expect(stopped.profile.samples.length).toBeGreaterThan(0);
 }finally{
  connection?.close();bridge?.stop();for(const socket of wss.clients)socket.terminate();wss.close();
  await new Promise<void>(r=>server.close(()=>r()));
  if(child&&child.exitCode===null){const exited=once(child,"exit");child.kill("SIGTERM");await exited;}
  await rm(root,{recursive:true,force:true});
 }
});
