import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual as equal } from "node:util";
import { validatePublicClaimAssessment,validateDocumentEdits } from "../review-live-workflow-teacher.mjs";

export const sourceClaimKinds = new Set(["research", "research-and-edit", "owned-research", "owned-research-and-edit", "assigned-public-brief"]);
const sha = value => createHash("sha256").update(value).digest("hex");
const requireFact = (value, message) => { if (!value) throw new Error(message); };

function bindWorkspaceEdit(proof,world,edits){
  validateDocumentEdits(edits);
  requireFact(edits.length===1,"Workspace review needs the assigned retained edit");
  const edit=edits[0];
  if(world.kind==="google-runbook"){
    const current=proof.productReview?.documents?.find(document=>document.path==="operations-runbook.md");
    requireFact(world.action==="revise"&&edit.path==="operations-runbook.md"&&edit.originalText===world.before&&
      edit.authority.path==="approved-instructions.md"&&edit.authority.text===world.approval&&edit.concurrentAddition===(world.coedit??"")&&
      current?.text===edit.retainedText&&current.version===edit.retainedSha256,"Runbook review differs from the actual retained document and approval");
    return;
  }
  const scope=world.edit??world,observed=proof.document??proof;
  requireFact(edit.path===scope.destination&&edit.originalText===scope.files?.[edit.path]&&
    edit.authority.path===scope.source&&edit.authority.text===scope.files?.[scope.source]&&
    edit.concurrentAddition===scope.concurrentAddition&&edit.retainedText===observed.contents?.[edit.path]&&
    observed.reads?.some(read=>read.path===edit.path&&read.version===edit.retainedSha256),
    "Workspace review differs from actual retained bytes or assigned authority");
}

export function workspaceEditReviewInput(proof,world){
  const input=proof.semanticReviewInput;
  requireFact((world.kind==="workspace-edit"||world.kind==="google-runbook"&&world.action==="revise")&&proof.semanticReviewRequired===true&&input?.actual?.goal===world.goal&&
    input?.expected?.goal===world.goal&&typeof input.rubric==="string"&&input.rubric.trim(),
    "Workspace edits require their independent goal-bound content review");
  bindWorkspaceEdit(proof,world,input.actual.documentEdits);
  const documents=world.kind==="google-runbook"?proof.productReview.documents.map(({path,text})=>({path,text})):Object.entries(proof.contents).map(([path,text])=>({path,text}));
  requireFact(equal(input.actual.documents,documents),"Workspace review changed the independently retained documents");
  return input;
}

/** Bind semantic policy inputs to actual returned values and independent readback. */
export function sourceClaimReviewInput(proof, world) {
  requireFact(sourceClaimKinds.has(world.kind) && proof.semanticReviewRequired === true,
    "Source claims require independently configured semantic review");
  const input = proof.semanticReviewInput;
  const actual = validatePublicClaimAssessment(input);
  if(world.kind.endsWith("-and-edit"))bindWorkspaceEdit(proof,world,actual.documentEdits);
  const subject = world.kind.endsWith("-and-edit") ? proof.actualResult?.research : proof.actualResult;
  let answer;
  try { answer = JSON.parse(actual.answer); } catch { throw new Error("Source claim answer must retain the actual typed value"); }
  requireFact(actual.goal === world.goal && equal(answer, subject), "Source claim review differs from the actual application result");
  const brief = world.kind === "assigned-public-brief" ? subject?.brief : subject;
  const citations = (brief?.statements ?? []).flatMap(statement => (statement.cites ?? []).map(({url, quote}) => ({url, quote})));
  requireFact(equal(actual.citations, citations), "Source claim citations differ from the actual application result");
  if (world.kind === "assigned-public-brief") {
    requireFact(equal(actual.sourceScope, world.sources), "Source claim review changed the assigned source scope");
  } else if (world.kind.startsWith("owned-")) {
    requireFact(Array.isArray(actual.sourceScope) && actual.sourceScope.length > 0 && actual.sourceScope.every(url => new URL(url).origin === proof.origin),
      "Owned claim review changed the assigned source origin");
  } else requireFact(actual.sourceScope === null, "Public claim review invented a source restriction");
  for (const source of actual.sources) {
    let observed;
    if (world.kind === "assigned-public-brief") {
      const shared = proof.assignedPublicBrief?.shared;
      const cached = shared?.cache?.find(page => page.digest === source.sha256 && page.requested === source.requested && page.visible === source.text);
      observed = cached && shared.reads?.find(read => read.page?.digest === source.sha256 && read.page.url === source.url)?.page;
    } else if (world.kind.startsWith("owned-")) {
      const cached = proof.readback?.find(page => page.url === source.url && page.digest === source.sha256 && page.text === source.text && page.exact === true);
      observed = cached && proof.fetched?.find(page => page.url === source.url && page.digest === source.sha256);
    } else {
      const fetched = proof.fetched?.find(page => page.url === source.url && page.digest === source.sha256);
      observed = fetched?.page;
    }
    requireFact(observed && observed.title === source.title &&
      (source.published == null || source.published === observed.published),
      "Source claim review differs from the independently observed page");
  }
  return input;
}

export async function sourceClaimProgramIdentity() {
  const [source, types] = await Promise.all([
    readFile(new URL("../reviews/assessPublicClaims.nl", import.meta.url), "utf8"),
    readFile(new URL("../reviews/types.ts", import.meta.url), "utf8"),
  ]);
  return { path: "reviews/assessPublicClaims.nl", source, types, sha256: sha(source + "\n" + types) };
}

/** A retained verdict is evidence only for exactly the invocation it assessed. */
export function sourceClaimReviewMatches(record, input, model, teacher, program) {
  const split = model?.indexOf(":") ?? -1;
  const exchanges = record?.exchanges;
  const result = record?.semanticResult;
  return split > 0 && model !== teacher && record?.schema === "natlang.live-workflow-review/1" &&
    record.model === model && record.teacher === teacher && equal(record.input, input) &&
    record.inputSha256 === sha(JSON.stringify(input)) && equal(record.program, program) &&
    Array.isArray(exchanges) && exchanges.length > 0 && equal(record.exchange, exchanges.at(-1)) &&
    exchanges.every(exchange => exchange.request && exchange.reply?.raw_response?.provider === model.slice(0, split) &&
      exchange.reply.raw_response.model === model.slice(split + 1)) &&
    typeof result?.supported === "boolean" && typeof result.fulfillsGoal === "boolean" && typeof result.needsReview === "boolean" &&
    typeof result.rationale === "string" && result.rationale.trim().length > 0 &&
    record.verdict?.accepted === (result.supported && result.fulfillsGoal && !result.needsReview) &&
    record.verdict.verdict === result.rationale && Boolean(record.verdict.needs_review) === result.needsReview;
}

/** Immutable per-input cache, including negative verdicts; never overwrites earlier review evidence. */
export function sourceClaimReviewPath(out, input, model, teacher, program) {
  return `${out}.review-${sha(JSON.stringify({input, model, teacher, program:program.sha256}))}.json`;
}
