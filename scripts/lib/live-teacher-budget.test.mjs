import test from 'node:test';
import assert from 'node:assert/strict';
import {teacherEpisodeTimeout} from './live-teacher-budget.mjs';
test('teacher collection gives each episode an hour while retaining explicit bounded overrides',()=>{
 assert.equal(teacherEpisodeTimeout(undefined),'3600000');
 assert.equal(teacherEpisodeTimeout('600000'),'600000');
 assert.equal(teacherEpisodeTimeout('7200000'),'7200000');
 for(const value of ['0','-1','Infinity','1.5','1e3',String(Number.MAX_SAFE_INTEGER+1)])
  assert.throws(()=>teacherEpisodeTimeout(value),/positive integer/);
});
