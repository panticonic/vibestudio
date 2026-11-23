import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual as equal } from "node:util";
import { validatePublicClaimAssessment } from "../review-live-workflow-teacher.mjs";

export const sourceClaimKinds = new Set(["research", "research-and-edit", "owned-research", "owned-research-and-edit", "assigned-public-brief"]);
const sha = value => createHash("sha256").update(value).digest("hex");
const requireFact = (value, message) => { if (!value) throw new Error(message); };

/** Bind semantic policy inputs to actual returned values and independent readback. */
export function sourceClaimReviewInput(proof, world) {
  requireFact(sourceClaimKinds.has(world.kind) && proof.semanticReviewRequired === true,
    "Source claims require independently configured semantic review");
  const input = proof.semanticReviewInput;
  const actual = validatePublicClaimAssessment(input);
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
