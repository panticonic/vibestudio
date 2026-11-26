import { URL as NodeURL } from "node:url";
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

export function editorialReviewInput(proof,world,applicationResult){
  const input=proof.semanticReviewInput;
  const approved=proof.sources?.flatMap(source=>source.pdf?[{document:source.request?.document,digest:source.pdf.digest,citations:source.pdf.citations}]:[]);
  const handoff=proof.artifact?JSON.parse(proof.artifact):null;
  const note=world.note??"none",needsHandoff=note==="diagnostic"||note==="ready-only"&&["ready","already-current"].includes(world.end);
  requireFact(world.kind==="editorial-packet"&&proof.semanticReviewRequired===true&&input?.actual?.goal===world.goal&&
    input.expected?.goal===world.goal&&input.expected.literalApprovedWording===(world.literalApprovedWording??false)&&
    input.expected.operation===proof.plan?.operation&&input.expected.returnedDecisionRequired===world.requestedReturnRequired&&
    typeof world.requestedReturnRequired==="boolean"&&
    equal(input.actual.decision,world.requestedReturnRequired?applicationResult?.decision??null:null)&&
    input.expected.retainedHandoffRequired===needsHandoff&&equal(input.actual.retainedHandoff,handoff)&&
    equal(input.expected.fields,world.fields.map(field=>field.label))&&equal(input.actual.retainedDocument,proof.stored)&&
    equal(input.actual.originalDocument,proof.snapshots?.[0]?.candidate)&&equal(input.actual.approvedTextSources,approved)&&
    equal(input.actual.currentObservation,proof.snapshots?.at(-1)?.candidate)&&equal(input.actual.currentMission,proof.snapshots?.at(-1)?.mission)&&
    typeof input.rubric==="string"&&input.rubric.trim(),"Editorial review differs from actual stored copy or approved original evidence");
  return input;
}

export function coordinatedRevisionReviewInput(proof,world){
  const input=proof.semanticReviewInput;
  const applied=proof.attempts?.some(attempt=>attempt.receipt?.status==="applied");
  const original=proof.snapshots?.[0]?.scope?.files??[];
  const observed=proof.reviewScope;
  requireFact(world.kind==="coordinated-revision"&&proof.semanticReviewRequired===true&&input?.actual?.goal===world.goal&&
    input.expected?.goal===world.goal&&input.expected.returnedDecisionRequired===!applied&&
    equal(input.expected.editablePaths,world.changes.map(change=>change.path))&&equal(input.actual.documents,proof.documents)&&
    equal(input.actual.originalDocuments,original)&&equal(input.actual.currentObservedDocuments,observed)&&proof.snapshots?.some(snapshot=>equal(snapshot.scope.files,observed))&&
    equal(input.actual.returnedDecision,applied?null:proof.report)&&equal(proof.nativeReadback?.files,proof.documents)&&
    typeof input.rubric==="string"&&input.rubric.trim(),"Coordinated revision review differs from the exact native batch and signed authority");
  return input;
}

export function outcomeWorkspaceReviewInput(proof,world){
  const input=proof.semanticReviewInput;
  requireFact(world.kind==="outcome-workspace"&&proof.semanticReviewRequired===true&&input?.actual?.goal===world.goal&&
    input.expected?.goal===world.goal&&input.expected.target===world.target&&input.expected.authority===world.authority&&
    input.expected.returnedAnswerRequired===(world.target===null)&&equal(input.actual.documents,proof.contents)&&
    equal(input.actual.originalDocuments,world.files)&&equal(input.actual.actualAnswer,world.target===null?proof.actualResult:null)&&
    typeof input.rubric==="string"&&input.rubric.trim(),"Workspace outcome review differs from actual retained content and authority");
  return input;
}

/** Bind client query meaning to captured output and actual native observations, never gold enums. */
export function clientDiagnosticsReviewInput(proof,world,applicationResult){
  const input=proof.semanticReviewInput,observations=proof.clientObservations;
  const required=!world.handoff,answer=required?applicationResult?.decision?.answer:null;
  const handoff=proof.handoff?{audience:proof.handoff.audience,answer:proof.handoff.decision?.answer}:null;
  requireFact(world.kind==="clientDiagnostics"&&proof.semanticReviewRequired===true&&
    proof.requestedAnswerRequired===required&&(!required||typeof answer==="string"&&answer.trim())&&
    (!world.handoff||handoff?.audience===world.handoff&&typeof handoff.answer==="string"&&handoff.answer.trim())&&
    observations&&Array.isArray(observations.views)&&
    Array.isArray(observations.trace)&&Array.isArray(observations.journal)&&
    equal(observations.catalog,proof.catalog)&&equal(observations.trace,proof.trace)&&
    equal(observations.journal,proof.journal)&&equal(observations.final,proof.final)&&
    equal(observations.channel?.durable,proof.durable)&&equal(observations.handoff,handoff)&&
    equal(input?.actual,{goal:world.goal,observations,requestedAnswer:answer})&&
    equal(input?.expected,{goal:world.goal,requestedAnswerRequired:required})&&typeof input.rubric==="string"&&input.rubric.trim(),
    "Client meaning review differs from the captured answer, native observations or actual retained handoff");
  return input;
}

/** Bind a requested vault answer to captured output and actor-visible native facts. */
export function vaultKnowledgeReviewInput(proof,world,applicationResult){
  const input=proof.semanticReviewInput,observations=proof.actorObservations;
  const required=world.requestedReturnRequired!==false;
  const answer=required?applicationResult?.answer??null:null;
  requireFact(world.kind==="vaultWork"&&!world.expected.steps.some(step=>step.kind==="write")&&
    proof.requestedAnswerRequired===required&&proof.semanticReviewRequired===true&&input?.actual?.goal===world.goal&&
    equal(input.expected,{goal:world.goal,requestedAnswerRequired:required})&&
    (!required||typeof answer==="string"&&answer.trim())&&
    observations&&Array.isArray(observations.views)&&Array.isArray(observations.receipts)&&
    equal(input.actual,{goal:world.goal,observations:{views:observations.views,receipts:observations.receipts,events:proof.events,journal:proof.journal,
      final:proof.final,handoff:proof.handoff},requestedAnswer:answer})&&
    typeof input.rubric==="string"&&input.rubric.trim(),
    "Vault answer review differs from the captured requested answer or actor-visible native observations");
  return input;
}

/** Bind Adventure findings to captured claims and independently observed player state. */
export function adventureJourneyReviewInput(proof, world, applicationResult) {
  const input = proof.semanticReviewInput, observations = proof.journeyObservations;
  requireFact(world.kind === "adventure-journey" && proof.semanticReviewRequired === true &&
    Array.isArray(applicationResult?.evidence) && applicationResult.evidence.length > 0 &&
    observations && Array.isArray(proof.assigned) && proof.assigned.length === world.saves.length &&
    proof.assigned.every(save => typeof save?.id === "string" && save.id) &&
    Array.isArray(observations.before) && Array.isArray(observations.final) &&
    observations.before.length === proof.assigned.length && observations.final.length === proof.assigned.length &&
    [observations.before,observations.final].every(views => views.every((view,index) =>
      view?.save?.id === proof.assigned[index].id && typeof view.observation === "string" && view.observation)) &&
    Array.isArray(observations.readbacks) && Array.isArray(observations.actions) &&
    equal(observations.assigned, proof.assigned) &&
    equal(observations.before, proof.initial) && equal(observations.final, proof.nativeReadback) &&
    equal(observations.readbacks, proof.readbacks) && equal(observations.actions, proof.actions) &&
    observations.selected === proof.selected && observations.selected === proof.assigned?.[world.expected.save]?.id &&
    equal(observations.final?.[world.expected.save], proof.final) &&
    equal(observations.comparison, (world.expected.compared ?? []).map(index => proof.assigned?.[index]?.id)) &&
    equal(input?.actual, { goal: world.goal, observations, requestedReturn: applicationResult }) &&
    equal(input.expected, { goal: world.goal, requestedReturnRequired: true }) &&
    typeof input.rubric === "string" && input.rubric.trim(),
    "Adventure findings review differs from the actual return, native player snapshots or assigned save scope");
  return input;
}

export function sourceContentReviewInput(proof,world,applicationResult){
  const nested=world.kind==="pdfVault"?proof.proof?.vault:proof;
  const input=nested?.semanticReviewInput,evidence=nested?.sourceContentEvidence;
  const paths=world.kind==="vaultWork"?world.expected.steps.filter(step=>step.kind==="write").map(step=>step.path):
    world.kind==="pdfVault"?[world.vault.writablePath]:[world.writablePath];
  requireFact(nested?.semanticReviewRequired===true&&input?.actual?.goal===world.goal&&input.expected?.goal===world.goal&&
    paths.length>0&&paths.every(path=>typeof path==="string"&&path)&&equal(input.expected.editablePaths,paths)&&
    evidence&&equal(input.actual,{goal:world.goal,...evidence})&&typeof input.rubric==="string"&&input.rubric.trim(),
    "Source content review differs from actual native documents, current readback or authorized paths");
  if(world.kind==="vaultWork"){
    const required=world.requestedReturnRequired!==false;
    const answer=required?applicationResult?.answer??null:null;
    requireFact(equal(evidence.events,proof.events)&&equal(evidence.journal,proof.journal)&&
      equal(evidence.navigationHops,proof.hops)&&equal(evidence.handoff,proof.handoff),
      "Vault source review differs from actual actor navigation, chronology or handoff");
    requireFact(proof.requestedAnswerRequired===required&&input.expected.requestedAnswerRequired===required&&
      evidence.requestedAnswer===answer&&(!required||typeof answer==="string"&&answer.trim()),
      "Vault source review differs from the captured requested answer obligation or value");
  }
  if(world.kind!=="pdfVault")return input;
  requireFact(proof.proof?.handoff?.status==="bound"&&proof.proof.handoff.source,
    "PDF-backed source review requires its exact independently verified PDF handoff");
  return {...input,actual:{...input.actual,goal:world.goal,pdfHandoff:proof.proof.handoff},expected:{...input.expected,goal:world.goal},
    rubric:input.rubric+" The requested source correction must be supported by the supplied independently verified PDF handoff and its exact page/quote evidence. Judge the actual retained vault source against those facts; do not infer a different PDF authority from a filename or an optional returned receipt."};
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
    readFile(new NodeURL("../reviews/assessPublicClaims.nl", import.meta.url), "utf8"),
    readFile(new NodeURL("../reviews/types.ts", import.meta.url), "utf8"),
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
