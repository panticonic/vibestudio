import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {stagePackageDependencies} from './build-server-npm-package.mjs';
const root=path.resolve(import.meta.dirname,'..'),require=createRequire(path.join(root,'package.json'));
const nativeName='@number0/iroh-linux-x64-gnu';
test('an optional fixed-source root package cannot replace the owned installed native dependency closure', {skip:process.platform!=='linux'||process.arch!=='x64'},()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'native-optional-closure-'));
 try{
  const nativeManifest=require.resolve(nativeName+'/package.json'),nativeSource=path.dirname(nativeManifest);
  const source=path.join(directory,'source'),destination=path.join(directory,'independent','package');
  fs.mkdirSync(source,{recursive:true});fs.mkdirSync(path.join(directory,'node_modules','@number0'),{recursive:true});
  fs.symlinkSync(nativeSource,path.join(directory,'node_modules',nativeName),'dir');
  const manifest={name:'TEST-only-native-owner',version:'1.0.0',optionalDependencies:{[nativeName]:'1.1.0'}};
  fs.writeFileSync(path.join(source,'package.json'),JSON.stringify(manifest));
  stagePackageDependencies(source,destination);
  const target=path.join(destination,'node_modules',nativeName);
  assert.ok(fs.existsSync(path.join(target,'package.json')),'active installed native optional dependency must travel with its runtime owner');
  assert.notEqual(fs.realpathSync(target),fs.realpathSync(nativeSource));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target,'package.json'))),JSON.parse(fs.readFileSync(nativeManifest)),'preserve actual published alias/name/version, never rewrite its identity');
  const entry=JSON.parse(fs.readFileSync(nativeManifest)).main;
  const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(hash(path.join(target,entry)),hash(path.join(nativeSource,entry)));
  const independent=createRequire(path.join(destination,'index.cjs'));
  assert.equal(independent.resolve(nativeName),path.join(target,entry));
  assert.equal(typeof independent(nativeName).Endpoint,'function','actual native addon loads from the independent staged closure');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
