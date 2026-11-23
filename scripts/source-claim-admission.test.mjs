import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {sourceClaimKinds,sourceClaimReviewInput,sourceClaimProgramIdentity,sourceClaimReviewMatches,sourceClaimReviewPath} from "./lib/source-claim-admission.mjs";
const hash=text=>createHash("sha256").update(text).digest("hex");
function sample(kind="research") {
 const text="These domains may be used in examples and cannot be registered.";
 const url="https://www.iana.org/help/example-domains";
 const cite={url,quote:text,title:"Examples",retrieved:"2026-11-23",published:null};
 const result={status:"answered",question:"May I use the examples?",statements:[{text:"Yes, without registration.",cites:[cite]}],notRead:[],rejected:0};
 const world={kind,goal:result.question,sources:[url]};
 const value=kind==="assigned-public-brief"?{decision:"supported",brief:result}:kind.endsWith("-and-edit")?{research:result,revision:{status:"edited",path:"note",version:"v2"}}:result;
 const subject=kind.endsWith("-and-edit")?value.research:value;
 const input={kind:"public-claims",actual:{goal:world.goal,answer:JSON.stringify(subject),citations:[{url,quote:text}],sourceScope:kind==="assigned-public-brief"?[url]:null,
 sources:[{url,title:"Examples",sha256:hash(text),text,...(kind==="assigned-public-brief"?{requested:url}:{})}]}};
 const proof={semanticReviewRequired:true,semanticReviewInput:input,actualResult:value,fetched:[{url,digest:hash(text),page:{url,digest:hash(text),title:"Examples"}}]};
 if(kind==="assigned-public-brief")proof.assignedPublicBrief={shared:{cache:[{digest:hash(text),requested:url,visible:text}],reads:[{page:proof.fetched[0].page}]}};
 return{world,proof,input};
}
test("bind actual multi-domain and assigned application results without a generic report",()=>{
 for(const kind of ["research","research-and-edit","assigned-public-brief"]){const s=sample(kind);assert.equal(sourceClaimReviewInput(s.proof,s.world),s.input);}
 assert.equal(sourceClaimKinds.size,5);
});
test("do not let a different answer or citation obtain review for the original trace",()=>{
 for(const field of ["answer","citations"]){const s=sample();s.input.actual[field]=field==="answer"?JSON.stringify({status:"answered",statements:[]}):[];assert.throws(()=>sourceClaimReviewInput(s.proof,s.world),/actual application result/);}
});
test("self-consistent fabricated source bytes cannot replace the independently read page",()=>{
 const s=sample();s.input.actual.sources[0].text="Some unrelated source text";s.input.actual.sources[0].sha256=hash(s.input.actual.sources[0].text);s.input.actual.citations=[];s.proof.actualResult.statements=[];s.input.actual.answer=JSON.stringify(s.proof.actualResult);
 assert.throws(()=>sourceClaimReviewInput(s.proof,s.world),/independently observed page/);
});
test("assigned-source scope is exact but a grounded held result needs no fake citations",()=>{
 const s=sample("assigned-public-brief");s.proof.actualResult={decision:"held",brief:{status:"insufficient",statements:[]}};s.input.actual.answer=JSON.stringify(s.proof.actualResult);s.input.actual.citations=[];
 assert.equal(sourceClaimReviewInput(s.proof,s.world),s.input);
 s.input.actual.sourceScope.push("https://unassigned.example/");assert.throws(()=>sourceClaimReviewInput(s.proof,s.world),/assigned source scope/);
});
test("bound public review requires the actual goal and declared semantic assessment",()=>{
 const s=sample();s.input.actual.goal="Another request";assert.throws(()=>sourceClaimReviewInput(s.proof,s.world),/actual application result/);
 s.input.actual.goal=s.world.goal;s.proof.semanticReviewRequired=false;assert.throws(()=>sourceClaimReviewInput(s.proof,s.world),/configured semantic review/);
});
test("review reuse binds assessor bytes, model, teacher, input and all original provider replies",async()=>{
 const{input}=sample();const program=await sourceClaimProgramIdentity();const model="openai-codex:reviewer",teacher="openai-codex:luna";
 const exchange={request:{messages:[]},reply:{raw_response:{provider:"openai-codex",model:"reviewer"}}};
 const record={schema:"natlang.live-workflow-review/1",model,teacher,input,inputSha256:hash(JSON.stringify(input)),program,exchange,exchanges:[exchange],semanticResult:{supported:true,fulfillsGoal:true,needsReview:false,rationale:"Supported"},verdict:{accepted:true,verdict:"Supported"}};
 const valid=r=>sourceClaimReviewMatches(r,input,model,teacher,program);
 assert.equal(valid(record),true);
 for(const alter of [r=>r.teacher="someoneelse",r=>r.program.source+="x",r=>r.inputSha256="0".repeat(64),r=>r.exchanges[0].reply.raw_response.model="different",r=>r.verdict.accepted=false,r=>r.semanticResult.needsReview=true]){const changed=structuredClone(record);alter(changed);assert.equal(valid(changed),false);}
 assert.notEqual(sourceClaimReviewPath("out",input,model,teacher,program),sourceClaimReviewPath("out",input,model,teacher,{...program,sha256:"0".repeat(64)}));
 assert.notEqual(sourceClaimReviewPath("out",input,model,teacher,program),sourceClaimReviewPath("out",input,model,"newteacher",program));
});
