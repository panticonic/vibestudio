import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { openGoalEvidence } from "./export-live-workflow-teacher.mjs";

function ref(value) {
  const json = JSON.stringify(value);
  return { complete: true, hash: createHash("sha256").update(json).digest("hex"), bytes: Buffer.byteLength(json) };
}
const rejected = /Expected the attested public search provider/;

function fixture(provider = "brave") {
  const assignment = { kind: "research", id: "domain", goal: "Which domains are reserved for examples?",
    required: [{ host: "iana.org", phrase: "not available for registration or transfer" }] };
  const url = "https://www.iana.org/help/example-domains";
  const query = "site:iana.org reserved example domains";
  const body = "These domains are not available for registration or transfer.";
  const digest = createHash("sha256").update(body).digest("hex");
  const page = { url, title: "Example domains", digest, size: Buffer.byteLength(body), head: body,
    headBytes: Buffer.byteLength(body), session: "public", truncated: false, servedFromCache: false, elapsedMs: 1 };
  const quote = { url, quote: body, retrieved: "2026-11-21" };
  const result = { provider, elapsedMs: 1, results: [{ query, text: "Public authority", sources: [{ url }] }] };
  const credentialChecks = provider === "brave" ? [{ provider: "tavily", matched: false }, { provider: "brave", matched: true }]
    : ["tavily", "brave", "exa"].map(provider => ({ provider, matched: false }));
  const discovered = { provider, result, queries: [query], urls: [url], credentialChecks };
  const input = { url };
  const fetched = { input, page, requested: url, url, digest, provider, searchIndex: 0 };
  const contextId = "owned-context";
  const proof = {
    passed: true, caseId: assignment.id, contextId, goal: assignment.goal,
    searches: [discovered], fetched: [fetched], citationSources: [{ ...quote, digest, provider, searchIndex: 0 }],
    checks: Object.fromEntries(["discoveredSources", "attestedSearchProvider", "exactPageReadback", "answeredGoal",
      "groundedCitations", "requiredEvidence", "supportedConclusion"].map(name => [name, true])),
  };
  const search = { service: "goalDiscovery", method: "search", args: ref([[query]]), result: ref(result.results) };
  const fetch = { service: "web", method: "fetch", args: ref([input]), result: ref(page) };
  const report = { status: "answered", research: { status: "answered", question: assignment.goal,
    statements: [{ text: body, cites: [quote] }] } };
  const calls = [{ callId: "root", record: { call_id: "root", definition: { name: "runUserGoal" },
    inputs: { goal: ref(assignment.goal) }, effects: [search, fetch] } }];
  const execution = { diagnostics: { openGoalVerification: proof }, provenance: { contextId } };
  const exercise = { rootCallIds: ["root"], report, calls };
  return { proof, result, search, fetch, validate: () => openGoalEvidence(execution, exercise, assignment.id, { assignment }) };
}

test("accepts exact public search and citation bindings for a keyed or credential-free provider", () => {
  for (const provider of ["brave", "duckduckgo"])
    assert.equal(fixture(provider).validate().checks.attestedSearchProvider, true);
});

test("rejects missing, mismatched, or fabricated credential/provider attestation", () => {
  const missing = fixture();
  delete missing.proof.searches[0].credentialChecks;
  assert.throws(() => missing.validate(), rejected);
  const mismatched = fixture();
  mismatched.proof.searches[0].provider = "exa";
  assert.throws(() => mismatched.validate(), rejected);
  const wrongAudience = fixture();
  wrongAudience.proof.searches[0].credentialChecks[1].provider = "exa";
  assert.throws(() => wrongAudience.validate(), rejected);
  const dropped = fixture("duckduckgo");
  dropped.proof.searches[0].credentialChecks[1].matched = true;
  assert.throws(() => dropped.validate(), rejected);
});

test("rejects forged discovery, page readback or citation provider lineage", () => {
  const different = fixture();
  different.search.result = ref([{ query: different.result.results[0].query, sources: [] }]);
  assert.throws(() => different.validate(), rejected);
  const replaced = fixture();
  replaced.fetch.result = ref({ url: replaced.proof.fetched[0].url, digest: "0".repeat(64) });
  assert.throws(() => replaced.validate(), rejected);
  const unbound = fixture();
  unbound.proof.citationSources[0].provider = "exa";
  assert.throws(() => unbound.validate(), rejected);
});
