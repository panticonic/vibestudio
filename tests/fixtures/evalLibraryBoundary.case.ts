import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it, vi } from "vitest";
import { createTestDO } from "@vibestudio/durable/test-utils";
import {mainRpcMethod} from "@vibestudio/service-schemas/mainRpc";
import { NATLANG_PROVIDER_HOST_CONTRACT_VERSION } from "@vibestudio/service-schemas/evalNatlang";
import {createEvalNodeCompat} from "../../packages/builtin/src/eval-engine/evalNodeCompat.js";
import { tameRealmCodegen } from "@vibestudio/shared/evalConfinement";
import { EvalDO } from "../../packages/builtin/src/eval-engine/EvalDO.js";
import { initBuildSystemV2 } from "../../src/server/buildV2/index.js";
import type { BuildSourceProvider } from "../../src/server/buildV2/buildSource.js";
import type { WorkspaceStateSource } from "../../src/server/buildV2/stateTrigger.js";
import { discoverPackageGraph } from "../../src/server/buildV2/packageGraph.js";
import { createBuildProcessOwner } from "../../src/server/buildV2/builder.js";
import { runIsolatedBuildJob } from "../../src/server/buildV2/nativeJobTestFixture.js";
import { composeDevelopmentTemplateCheckouts } from "../../src/dev/developmentTemplateComposition.js";
import { exactTemplateRoots } from "../exactUserlandRoot.js";

// This exercises the actual bundle and EvalDO loader, not a provider substitute.
// The only emulated boundaries are Worker UnsafeEval and the Host artifact journal.
it("loads the selected natlang provider and system-test CLI through EvalDO's actual module boundary", async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "eval-library-boundary-"));
  const composition = await composeDevelopmentTemplateCheckouts(
    ["base", "system", "system-testing"].map(name => ({checkout: exactTemplateRoots[name]!, url: `fixture://${name}`})),
  );
  const state = `state:${"a".repeat(64)}`;
  const source: WorkspaceStateSource & BuildSourceProvider = {
    workspaceId: "workspace:eval-library-boundary",
    async ensureFresh() { return {stateHash: state}; },
    async unitHashes(_state, paths) { return Object.fromEntries(paths.map(p => [p, `h:${p}`])); },
    async resolveContextState() { return state; },
    async readFile() { return null; },
    executionStateForContent(hash) { return {kind: "event", eventId: `event:${hash}`}; },
    async discoverGraph() { return discoverPackageGraph(composition.root); },
    onProtectedPublication() { return () => {}; },
    async recordBuild() {},
    async materializeForBuild() { return {sourceRoot: composition.root}; },
  };
  const processOwner = createBuildProcessOwner({appRoot: process.env["VIBESTUDIO_APP_ROOT"] ?? path.resolve(__dirname, "../.."), appNodeModules: [path.resolve(__dirname, "../../node_modules")]});
  const build = await initBuildSystemV2(composition.root, source, {
    processOwner, stateRoot: path.join(scratch, "state"),
    storeRoots: {sharedArtifactPoolRoot: null, sharedBuildResultCacheRoot: null},
    releaseBuildRoot: null, runNativeJob: runIsolatedBuildJob,
    dependencyWorkspaceRoot: composition.root,
  });
  let compiler = Function;
  const {instance, db} = await createTestDO(EvalDO, {
    UNSAFE_EVAL: {newFunction: (body: string, _name: string, ...args: string[]) => new compiler(...args, body)},
  });
  const internal = instance as unknown as {
    rpc: {call: (...args: unknown[]) => Promise<unknown>};
    loadLibraryModule(specifier: string, execution: unknown, opts: {externals: string[]}): Promise<Record<string, unknown>>;
    isolateModuleMap: Record<string, unknown>;
    requireIsolateModule(id: string): unknown;
  };
  const retained: unknown[][] = [];
  const journal = vi.spyOn(internal.rpc, "call").mockImplementation(async (...args) => {
    retained.push(args);
    return {retained: true};
  });
  try {
    const allowed = Object.keys(internal.isolateModuleMap);
    expect(allowed.sort()).toEqual(["node:async_hooks", "node:util/types"]);
    const specifiers = ["@workspace/natlang", "@workspace/eval", "@workspace/runtime/hosted"];
    const compat = createEvalNodeCompat({}, () => {throw Error("unexpected native callback");}, () => true);
    const runExternals = [...Object.keys(compat), "@workspace/runtime", "@workspace/natlang"];
    const cliSpecifier = "@workspace-skills/system-testing/cli";
    const domainSpecifier = "@workspace-skills/system-testing/open-goal-owned-operations-managed";
    const artifacts = new Map();
    for (const specifier of specifiers) artifacts.set(specifier, await build.getBuild(specifier, undefined, {library: true, libraryTarget: "worker", externals: allowed}));
    for(const specifier of [cliSpecifier,domainSpecifier]) artifacts.set(specifier, await build.getBuild(specifier, undefined, {library:true,libraryTarget:"worker",externals:runExternals}));
    // Workerd blocks ordinary code generation. Tame the isolated test worker
    // likewise, preserving only the UnsafeEval compiler captured by its kernel.
    compiler = tameRealmCodegen();
    const execution = {build: {async getBuild(specifier: string, state: unknown, options: unknown) {
      expect(state).toBeUndefined();
      expect(options).toEqual({library: true, libraryTarget: "worker", externals: allowed});
      expect(artifacts.has(specifier)).toBe(true);
      return artifacts.get(specifier);
    }}, runId: "eval-library-boundary-run"};
    const provider = await internal.loadLibraryModule("@workspace/natlang", execution, {externals: allowed});
    expect(provider["NATLANG_PROVIDER_HOST_CONTRACT_VERSION"]).toBe(NATLANG_PROVIDER_HOST_CONTRACT_VERSION);
    expect(typeof provider["createEvalNatlang"]).toBe("function");
    const engine = await internal.loadLibraryModule("@workspace/eval",execution,{externals:allowed});
    const hosted = await internal.loadLibraryModule("@workspace/runtime/hosted",execution,{externals:allowed});
    const refuse = () => {throw Error("Import-only fixture cannot perform native operations");};
    const createRuntime = hosted["createHostedRuntime"] as (host:unknown)=>Record<string,unknown>;
    const runtime = createRuntime({id:"eval-library-boundary",contextId:"context:library-boundary",rpc:{call:refuse},fs:{},gatewayConfig:null,gatewayFetch:refuse,panelRuntime:{},workers:{},openExternal:refuse,resolveParent:()=>null});
    const moduleMap:Record<string,unknown> = {...compat,"@workspace/runtime":runtime,"@workspace/natlang":provider};
    const execute = engine["executeSandbox"] as (code:string,options:unknown)=>Promise<{success:boolean;returnValue:unknown;error:unknown}>;
    const result = await execute(`const cli=await import("${cliSpecifier}"); const domain=await import("${domainSpecifier}"); return {cli:typeof cli.inspectSystemTestRun,domain:typeof domain.prepareOpenOwnedOperations};`,{
      syntax:"javascript",moduleMap,bindings:{},
      require:(id:string)=>{if(moduleMap[id]!==undefined)return moduleMap[id];throw Error("Module not admitted: "+id);},
      compileFunction:(args:string[],body:string)=>new compiler(...args,body),
      confinement:"private-global",publishLazyLoaderToGlobal:false,
      loadImport:async(specifier:string)=>{expect([cliSpecifier,domainSpecifier]).toContain(specifier);return artifacts.get(specifier);},
    });
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.returnValue).toEqual({cli:"function",domain:"function"});
    // A previously leaking builtin remains unavailable after every real import.
    expect(() => internal.requireIsolateModule("node:util")).toThrow('not available in EvalDO');
    expect(retained).toHaveLength(3);
    for (const [index,args] of retained.entries()) {
      expect(args[0]).toBe("main");
      expect(args[1]).toBe(mainRpcMethod("evalExecutionRoots.retain"));
      expect(args[2]).toEqual(["eval-library-boundary-run",specifiers[index],artifacts.get(specifiers[index])?.execution]);
    }
  } finally {
    journal.mockRestore();
    await build.shutdown();
    await processOwner.shutdown();
    db.close();
    await composition.release();
    fs.rmSync(scratch, {recursive: true, force: true});
  }
}, 180_000);
