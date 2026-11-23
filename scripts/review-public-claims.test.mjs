import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {validatePublicClaimAssessment,assessPublicClaims} from './review-live-workflow-teacher.mjs';
const text='These example domains are not available for registration or transfer.';
const input={kind:'public-claims',actual:{goal:'May I register an example domain?',answer:'No.',sourceScope:null,
 citations:[{url:'https://www.iana.org/help/example-domains',quote:text}],
 sources:[{url:'https://www.iana.org/help/example-domains',title:'Example domains',text,sha256:createHash('sha256').update(text).digest('hex')} ]}};
test('crisp review binds source bytes, exact quotation, and explicit user scope',()=>{
 assert.equal(validatePublicClaimAssessment(input),input.actual);
 const forged=structuredClone(input);forged.actual.sources[0].text+=' altered';
 assert.throws(()=>validatePublicClaimAssessment(forged),/captured bytes/);
 const quote=structuredClone(input);quote.actual.citations[0].quote='Sales are now open';
 assert.throws(()=>validatePublicClaimAssessment(quote),/not a span/);
 const scope=structuredClone(input);scope.actual.sourceScope=['https://example.com/'];
 assert.throws(()=>validatePublicClaimAssessment(scope),/explicit scope/);
});
test('actual pure typed Natlang assessor runs independently and retains program/input identity',async()=>{
 const repo=process.env.NATLANG_REPO??'/home/werg/natlang';
 const loader=relative=>import(pathToFileURL(repo+'/ts-host/dist/'+relative));
 const result=await assessPublicClaims(input,async()=>({calls:[['eval',{code:'return {supported: true, fulfillsGoal: true, needsReview: false, rationale: "The cited authority explicitly rules out registration."};',finish:true}]]}),loader);
 assert.equal(result.verdict.accepted,true);
 assert.equal(result.semanticResult.supported,true);
 assert.match(result.program.source,/There is no gold answer/);
 assert.equal(result.inputSha256,createHash('sha256').update(JSON.stringify(input)).digest('hex'));
 const rejected=await assessPublicClaims(input,async()=>({calls:[['eval',{code:'return {supported: false, fulfillsGoal: true, needsReview: false, rationale: "The conclusion contradicts the quotation."};',finish:true}]]}),loader);
 assert.equal(rejected.verdict.accepted,false);
});
