# Natlang teacher coverage

The collection inventory is [`scripts/natlang-teacher-suites.json`](../scripts/natlang-teacher-suites.json).
It names the existing executable skill suites, not a claim that every Vibestudio application has been converted.
The source inputs are the configured template checkouts; collection must pin their commits together with the
Vibestudio and natlang commits. Run all build and test tools from the Vibestudio host projection, never from a
template checkout.

Check collection preparation for the entire inventory from the host checkout:

```sh
pnpm natlang:teacher -- --all --out DIR --preflight
```

Preflight checks fixture and compilation readiness without asserting teacher quality or admitting training data.

## Covered source mechanisms

| Component                     | Inventory and role                                                                                                                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Base skill programs           | 12 suites: automations, alert routing, defect classification, provenance orientation, claim checking, documentation lookup/recovery, interaction surface selection, template interpretation, VCS summaries/commit proposals, visualization selection/props, research briefs, and icon selection. |
| Personal skill programs       | Two suites: GitHub access/troubleshooting and memory recall summaries.                                                                                                                                                                                                                           |
| System skill programs         | Three suites: local-model readiness, remote-access diagnosis, and server-log briefing.                                                                                                                                                                                                           |
| System-testing skill programs | One suite: failure triage.                                                                                                                                                                                                                                                                       |
| Program execution             | All 18 suites use natlang's existing evaluation fixtures and runtime. Hosted teachers execute the actual `.nl` calls, including callable children; exact service fixtures remain outside model-owned code.                                                                                       |
| Integrated acceptance         | System-testing's `natlang-skills-wave0.ts`, `natlang-skills-wave1.ts`, `natlang-skills-wave2.ts`, and `natlang-skills-agent-help.ts` exercise discovery and use of results by the outer agent. These are acceptance evidence, not executor trajectories by themselves.                           |
| Model transport and capture   | The existing natlang model driver and evaluation workers carry the executor requests and replies. Collection must distinguish executor calls from any independent judge calls and preserve their actual histories.                                                                               |
| Training                      | Verified executor calls enter the ordinary per-call SFT path. No teacher-policy sampling probabilities are required for teacher SFT.                                                                                                                                                             |

The nine fixtures for claim checking, documentation lookup, VCS summaries, GitHub troubleshooting, local-model
readiness, log briefing, test triage, research, and memory recall call their `.nl` roots. They formerly called crisp children directly,
which omitted root orchestration from both measurement and training. Documentation recovery and semantic commit
proposals retain their intentionally distinct callable-child entry points. Each case's traces establish which
functions actually executed; source presence alone does not establish execution coverage.

Research and memory capture the invocation time once at the host wrapper; the `.nl` root and crisp helper receive
that snapshot as a typed argument. Their cases store explicit Unix-millisecond timestamps. Citation read dates and
the 180-day stale-memory caveat therefore remain stable when a saved case is replayed on another day.

## Fixtures and verification strength

The suites are structurally self-contained: imports are natlang's evaluation/model APIs, local program types,
and Node filesystem/path/URL utilities. Documentation lookup reads the composed workspace's Markdown and a
recorded capability catalog; its entire composed source is therefore part of the pinned fixture. Research,
memory, model-readiness, and log-briefing fixtures replay recorded or authored service responses. None needs a
live production account to supply those fixture services.

Evaluation emits suite modules into a separate build location. Documentation and icon fixtures read their source
assets from the evaluation context's `programRoot`, not from the emitted module's URL. Documentation lookup derives
the composed workspace root from that authored source folder; icon lookup reads the adjacent shipped catalog.

Read-only fixture services return snapshots so model writes cannot change later service responses or the oracle's
source input. The complete service-return inventory is:

| Suite service | Snapshot mechanism |
| --- | --- |
| Documentation `fs.grep`/`fs.readText` | Fresh records/arrays containing strings and numbers; reads are confined to the Markdown inventory. |
| Documentation `docs.search`/`docs.describe` | Search projects fresh records; describe deep-clones its catalog entry before returning it. Source authentication retains the original description. |
| Research `web.search`/`web.fetch`/`web.read` | Every method constructs new objects/arrays from primitive page fields. No page object escapes the recorded map. |
| Memory `memory.recall` | Returns a new array and new records; every field in its `Result` contract is a string or null. |
| Icons `catalog.readdir` | Each filesystem listing returns a fresh array of names. |
| Readiness `localModels.listModels` | Deep-clones the rows, including nested fit and download fields. |
| Logs `serverLog.tail`/`serverLog.query` | Deep-clones the selected records. Statistics construct fresh aggregate objects/arrays. |

The other twelve suites bind no fixture services. Their model inputs are program arguments, rather than a mutable
backing store exposed through service responses. Adversarial fixture tests mutate returned catalog descriptions,
nested model fit fields, and log records, then confirm later reads and independent source inputs remain intact.

`verification` in the inventory describes what each existing scorer checks. It is provenance, not a stronger
admission label. Most expected classifications were authored from skill instructions; they are independently
supplied labels, not mechanically derived truth. Remote-access includes captured CLI messages and authored
routing scenarios. Model-readiness uses recorded-shaped model rows. Log cases combine real benign boot windows
with authored injected incidents. Test triage uses authored-shaped packets rather than retained failed runs.

Research, memory, VCS prose, and visualization-prop scorers use keyword or field coverage with exact shape or
citation-membership checks. A real quote can still fail to support a generated statement. Documentation lookup
authenticates every quote against Markdown or catalog text actually returned by its fixture services and requires
every answering entry to come from an expected source. Its observation exposes these verified source passages to
the separate semantic reviewer, which checks whether they answer the question.
Claim checking compares authored verdicts and verifies quote membership; quote membership alone does not prove
that the quote supports the verdict. These limitations must remain visible in exported evidence. Collecting
their demonstrations requires independent semantic judgment in addition to the suite's checks.

Admission requires a scored successful outcome, quality exactly 1, all supplied gates passing, at least one
captured executor turn, and accepted independent verification. `gatesPassed` alone is insufficient: several
suites' only gate is that the call completed, while correctness lives in `quality`. Zero-turn helper-only
successes may be retained as fixture evidence but are not model demonstrations. A failed child call recovered
by its parent is not automatically a correct local target merely because the root succeeded.

## Splits and breadth

The initial inventory has 38 `.nl` files and 450 cases: 186 train, 128 validation, and 136 test. All 450 exact
inputs are distinct, and no declared group crosses partitions within a suite. This does not establish that
authored scenarios are independent source worlds. Namespace groups by template and suite and preserve their
source-family relationships when adding variants. Validation and test cases must never become training rows.
Some existing test cases were inspected during earlier prompt development, so those sets are regression tests;
fresh grouped scenarios are needed for an unseen transfer claim.

News, Google Workspace, Spectrolite, and Examples currently contain no `.nl` programs. Broad application
conversion, open-ended code repair, conflict resolution, publication, and full workspace-development workflows
are outside this initial executable inventory. They need their own decomposition, fixture services, programs,
and outcome validators before they can supply executor demonstrations. Existing skill helpers are useful
training coverage, but they do not stand in for these whole applications.

Expand training scenarios by changing the underlying task and service state: multi-source evidence,
contradictions, missing data, partial failures, recovery, and stateful operations. Merely paraphrasing the
same wrapper or repeating the 186 training inputs does not expand capability coverage. Measure trained-call
repetition and held-world exclusions before admitting each expansion.

## Collection and training commands

The existing executor quality gates do not block teacher collection. The teacher executes the same typed programs,
and independent outcome checks determine which demonstrations become SFT targets.

From a clean host and template source snapshot:

```sh
pnpm natlang:teacher -- --all --preflight --out /path/to/fixture-check
pnpm natlang:teacher -- --all --out /path/to/teacher-campaign
```

The default teacher and separate verifier are `openai-codex:gpt-6-luna` at low effort, using natlang's existing
provider credentials on the collection host. Provider credentials are never copied into the dataset. A focused
pilot can select `--template personal --suite skills/github/natlang/suite.ts --case CASE_ID`; `--limit N` bounds the
number of training roots. `--natlang-commit SHA` pins the staged runtime. Every suite directory has its own closed
split inventory, immutable source/teacher binding, per-case records and `episodes.jsonl` manifest. Reusing its
output directory resumes the same campaign; changed sources, teacher or `--replicate` require a new directory.
Collection uses a kernel advisory lock (`flock`, on the project's Linux collection hosts). It releases when the owner exits, including SIGKILL, without expiring live work. Interrupted attempts retain their exact model request/reply journal for diagnosis; completed episodes replace those drafts.

Collection selects only training cases. Failed outcomes and rejected semantic reviews stay in the records.
The initial admission conservatively excludes episodes with failed child calls or tool actions; it does not train
failed actions merely because a parent recovered. Hosted teachers generate ordinary tool-loop answers, including
for declared finite decision functions; collection does not manufacture native sampling probabilities or scoring
receipts. A separate verifier receives the reference requirements and fixture observations, not the teacher's
conversation or reasoning. It can reject or mark an answer uncertain. This is independent model review, not an
exact oracle for free-form prose.

On the training host, use the existing converter to build one corpus from completed suite directories:

```sh
python scripts/neuralese_data/vibestudio_sft.py \
  --collection /path/to/teacher-campaign/personal/skills_github_natlang \
  --collection /path/to/another/completed-suite \
  --tokenizer /path/to/lfm3-tokenizer --held-manifest /path/to/held-v3/manifest.json \
  --out /path/to/new-immutable-build
```

`chains.pkl` is the ordinary `exp0_sft.py train --chains` input. `build.json` reports admission, exclusions,
renderer identity and file hashes; source collection files are snapshotted alongside it. Publish through
`vibestudio_sft.py register --out BUILD --register-id ID --register-owner dgx` only after the artifact is present
on that actual owner. The shared corpus publisher records immutable manifests. Collection, admission, rendering
and actual learner exposure remain separate; a successful build does not claim the data has been trained on.


A campaign resolves its natlang commit once and shares one staged runtime module across suites. Repeated bundle
imports previously retained one native-server exit hook per copy, producing an exit-listener warning in a long
campaign even though no native server was started. Sharing the immutable bundle avoids duplicate modules and
keeps suite workers isolated without copying a runtime for every suite.
