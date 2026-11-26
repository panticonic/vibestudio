import {it,expect} from 'vitest';
import {buildMethods} from '@vibestudio/service-schemas/build';
import {NativeCompilerProducts,compilerProductDriver} from './nativeCompilerProducts.js';

it('preserves pure linked type metadata through the Native compiler JSON cache and strict RPC result envelope',async()=>{
 const sourceTypes={schema:'natlang.source-types/1',root:'/project',sourceDigest:'source',compilerOptions:{target:'node',services:{declarations:{probe:'{read():Promise<string>}'},scopes:{probe:['root.nl']}}},compilerDigest:'options',modules:{'/project/types.ts':{Shared:'{value:string}'}},modulesDigest:'aliases'};
 const product={schema:'natlang.virtual-project-product/1',project:{root:'/project',files:{'types.ts':'export type Shared={value:string};'}},runtimeSpecifiers:['@natlang/node'],build:{ok:true,outputs:{},declarations:{},diagnostics:[]},sourceTypes};
 const request={bundle:'exact immutable compiler bytes',format:'cjs' as const,input:{project:product.project,options:sourceTypes.compilerOptions}};
 let launches=0;
 const cache=new NativeCompilerProducts(async actual=>{launches++;expect(actual).toEqual(request);return JSON.stringify(product);});
 const a=buildMethods.compileProduct.returns.parse({kind:'product',value:await cache.compile(request)}) as {kind:'product';value:typeof product};
 expect(a.value.sourceTypes).toEqual(sourceTypes);
 a.value.sourceTypes.modules['/project/types.ts']!.Shared='poison';
 const b=buildMethods.compileProduct.returns.parse(JSON.parse(JSON.stringify({kind:'product',value:await cache.compile(request)}))) as typeof a;
 expect(b.value.sourceTypes.modules['/project/types.ts']!.Shared).toBe('{value:string}');expect(launches).toBe(1);
 const driver=compilerProductDriver(request.input,'/owned/result.json',request.format);
 expect(driver).toContain('compileVirtualProjectProduct');
 expect(driver).toContain('JSON.stringify');
});
