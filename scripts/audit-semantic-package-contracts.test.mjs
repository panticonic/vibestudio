import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { auditSemanticPackageContracts } from './audit-semantic-package-contracts.mjs';
function fixture(run) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'semantic-package-contract-'));
  const write=(file,value)=>{const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,typeof value==='string'?value:JSON.stringify(value));};
  try{return run(root,write);}finally{fs.rmSync(root,{recursive:true,force:true});}
}
test('checks generated utility imports as well as ordinary package imports',()=>fixture((root,write)=>{
  const manifest={name:'@workspace/producer',exports:{'./live':'./live.ts'}};
  write('packages/producer/package.json',manifest);write('packages/producer/live.ts','export const value=1;');
  write('workers/consumer/package.json',{name:'@workspace-workers/consumer',dependencies:{'@workspace/producer':'workspace:*'}});
  write('workers/consumer/index.ts','import {value} from "@workspace/producer/live"; export const code=`import {later} from "@workspace/producer/later";`;');
  const report=auditSemanticPackageContracts({fixture:root});
  assert.deepEqual(report.findings.map(({issue,specifier,generated})=>({issue,specifier,generated})),[
    {issue:'missing-export',specifier:'@workspace/producer/later',generated:true}]);
  write('packages/producer/package.json',{...manifest,exports:{...manifest.exports,'./later':'./later.ts'}});
  write('packages/producer/later.ts','export const later=2;');
  assert.deepEqual(auditSemanticPackageContracts({fixture:root}).findings,[]);
}));
test('requires actual source manifests and runtime edges, without assigning emitted imports to the outer worker',()=>fixture((root,write)=>{
  write('skills/new-program/helper.ts','export const entry=1;');
  write('workers/consumer/package.json',{name:'@workspace-workers/consumer'});
  write('workers/consumer/index.ts','export const code=`import {entry} from "@workspace-skills/new-program/helper";`;');
  assert.equal(auditSemanticPackageContracts({fixture:root}).findings[0].issue,'missing-package');
  write('skills/new-program/package.json',{name:'@workspace-skills/new-program',exports:{'./helper':'./helper.ts'}});
  assert.deepEqual(auditSemanticPackageContracts({fixture:root}).findings,[]);
  write('workers/consumer/index.ts','import {entry} from "@workspace-skills/new-program/helper"; export {entry};');
  assert.equal(auditSemanticPackageContracts({fixture:root}).findings[0].issue,'undeclared-dependency');
}));
test('uses explicit Node and type contexts without exposing private test helpers to runtime consumers',()=>fixture((root,write)=>{
  write('packages/source/package.json',{name:'@workspace/source',exports:{'./private':{types:'./private.ts',node:'./private.ts',default:null}}});
  write('packages/source/private.ts','export const marker=1;');
  write('packages/support/package.json',{name:'@workspace/support'});
  write('packages/support/src/testing/helper.ts','import {marker} from "@workspace/source/private";');
  write('packages/support/ambient.d.ts','export * from "@workspace/source/private";');
  assert.deepEqual(auditSemanticPackageContracts({fixture:root}).findings,[]);
  write('packages/support/index.ts','import {marker} from "@workspace/source/private";');
  assert.ok(auditSemanticPackageContracts({fixture:root}).findings.some(row=>row.issue==='missing-export'&&row.context==='runtime'));
}));
