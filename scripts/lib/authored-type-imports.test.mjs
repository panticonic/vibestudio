import {test} from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {createAuthoredTypeResolver,renderAuthoredService} from './authored-natlang-services.mjs';
const root=fileURLToPath(new URL('./fixtures/authored-type-imports/',import.meta.url)),unit={name:'@workspace-skills/owned',path:root};
const mappings=[{find:'@workspace-skills/owned/types',replacement:path.join(root,'types.ts')}];
const service={name:'ownedReader',summary:'Read actual owned evidence',methods:[{name:'read',params:['id']}]};
test('uses canonical configured exports to render source types without executing the module',()=>{
 const resolveTypeImport=createAuthoredTypeResolver([unit],mappings);const text=renderAuthoredService(service,path.join(root,'service.d.ts'),{resolveTypeImport});assert.match(text,/type OwnedValue = \{id:string; actual:string\}/);assert.match(text,/read\(id:string\): Promise<OwnedValue>/);assert.doesNotMatch(text,/throw new Error|import\(/);
});
test('rejects unconfigured, unexported and traversal imports instead of guessing a source',()=>{
 const resolve=createAuthoredTypeResolver([unit],mappings);
 for(const name of ['@workspace-skills/foreign/types','@workspace-skills/owned/private','@workspace-skills/owned/../types','@workspace-skills/owned//types','@workspace-skills/owned\\types'])assert.equal(resolve('',name),null);
 assert.throws(()=>renderAuthoredService(service,path.join(root,'service.d.ts')),/type imports must be relative/);
});
test('does not allow a configured export target to escape its package owner',()=>{const resolve=createAuthoredTypeResolver([unit],[{find:unit.name+'/types',replacement:path.join(root,'../authored-service-scopes.mjs')}]);assert.equal(resolve('',unit.name+'/types'),null);});
test('refuses ambiguous referenced package owners while ignoring unrelated overlays',()=>{const resolve=createAuthoredTypeResolver([unit,{...unit,path:root+'other'}],mappings);assert.equal(resolve('', '@workspace-skills/unrelated/types'),null);assert.throws(()=>resolve('',unit.name+'/types'),/Ambiguous authored type package/);});
test('follows an actual source barrel instead of silently emitting an undeclared type',()=>{const text=renderAuthoredService(service,path.join(root,'barrel-service.d.ts'));assert.match(text,/type OwnedValue = \{id:string; actual:string\}/);assert.match(text,/Promise<OwnedValue>/);});
test('preserves the local name of an explicitly re-exported type alias',()=>{const text=renderAuthoredService(service,path.join(root,'named-service.d.ts'));assert.match(text,/type OwnedValue =/);assert.match(text,/type RenamedValue = OwnedValue/);assert.match(text,/Promise<RenamedValue>/);});
function virtualResolver(){return createAuthoredTypeResolver([],[],{workspaces:[{root:path.join(root,'virtual-project'),checkout:root,mounts:{'review/discovery':'skills/installed'}}],checkouts:[root]});}
test('reads a type through the actual declared workspace mount without manufacturing a physical module',()=>{const text=renderAuthoredService(service,path.join(root,'virtual-project/service.d.ts'),{resolveTypeImport:virtualResolver()});assert.match(text,/type MountedValue = \{current:string\}/);assert.match(text,/Promise<MountedValue>/);});
test('honors the mounted source include boundary for type declarations',()=>{assert.throws(()=>renderAuthoredService(service,path.join(root,'virtual-project/private-service.d.ts'),{resolveTypeImport:virtualResolver()}),/not included/);});
