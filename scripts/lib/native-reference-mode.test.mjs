import test from 'node:test';
import assert from 'node:assert/strict';
import {readNativeReferenceOnly} from './native-reference-mode.mjs';
test('native process ceiling is explicitly parsed and malformed settings fail closed',()=>{
 assert.equal(readNativeReferenceOnly({}),false);
 assert.equal(readNativeReferenceOnly({VIBESTUDIO_NATIVE_REFERENCE_ONLY:'0'}),false);
 assert.equal(readNativeReferenceOnly({VIBESTUDIO_NATIVE_REFERENCE_ONLY:'1'}),true);
 for(const value of ['', 'true', 'yes', '2'])assert.throws(()=>readNativeReferenceOnly({VIBESTUDIO_NATIVE_REFERENCE_ONLY:value}));
});
