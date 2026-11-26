import {test} from 'node:test';
import assert from 'node:assert/strict';
import {authoredServiceScopeFile} from './authored-service-scopes.mjs';
test('accepts actual natural and TypeScript owners including child-call scopes',()=>{
 for(const [selector,file] of [['choose.nl','choose.nl'],['reviewTemplateMigration.ts','reviewTemplateMigration.ts'],['own/run.ts/**','own/run.ts'],['own/choose.nl/**','own/choose.nl']])assert.equal(authoredServiceScopeFile(selector),file);
});
test('refuses declarations, unsupported targets and noncanonical escaping paths',()=>{
 for(const value of ['types.d.ts','choose.d.nl.ts','a.tsx','a.js','../foreign.ts','/foreign.ts','a/../foreign.ts','a//b.ts','a\\b.ts','a.ts#default',null,7,{},''])assert.equal(authoredServiceScopeFile(value),null);
});
