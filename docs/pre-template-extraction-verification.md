# Pre-template-extraction functional verification

Status: active, revised 2026-08-09.

No optional templates are deployed. The three planned outcomes below still
ship in `workspace/` and must be proven before promotion and source removal.
The authoritative ownership boundary remains
[official-template-repositories-plan.md](official-template-repositories-plan.md#repository-inventory).

## Candidate and release rule

Private or explicitly experimental immutable candidate repositories may be
extracted first, because composed validation needs exact Git coordinates. A
candidate is not a release and must not appear in the verified registry.

Do not promote, advertise, or remove the in-tree source for an outcome until:

1. its ordinary user journey works both in the monolithic baseline and in the
   exact composed candidate;
2. focused unit/integration coverage passes;
3. its smallest meaningful live or system test passes where external hardware,
   credentials, or processes are part of the outcome;
4. base smoke coverage still passes; and
5. `inspectAuthoring` proves a closed base plus optional ownership split with
   no duplicated repository and no unclaimed required dependency.

A skipped live test is not a pass. Record the concrete credential, hardware,
or infrastructure blocker instead. Candidate publication and registry
promotion remain separate operations; a failed candidate is superseded by a
new immutable tag, never rewritten or promoted.

## Inventory and evidence checklist

| Planned outcome | Current in-base ownership                                                           | Fundamental journey                                                                                                   | Existing evidence                                                       | Gate still required                                   |
| --------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------- |
| Examples        | `panels/hello-vanilla`, `panels/hello-svelte`, `workers/hello`, `workers/sample-do` | Open both framework and framework-free panels; exercise the Worker runtime probe and the SQLite-backed Durable Object | Focused panel, worker, and Durable Object tests pass                    | Run the interactive panels and live worker/DO proof   |
| News            | `panels/news`, `workers/news-agent`, `packages/feeds`                               | Configure feeds/topics, fetch and persist items, produce a briefing, exercise schedule                                | Feed, worker, operations, and panel suites pass                         | Integrated panel + worker + model + scheduler journey |
| Spectrolite     | `panels/spectrolite`, `packages/mdx-editor-core`                                    | Open/edit/render MDX and preserve content through panel lifecycle                                                     | Package/panel suites pass; `tests/e2e/flows/spectrolite.spec.ts` exists | Run the Electron flow                                 |

Google Workspace, GitHub, local models, and mobile remain complete base
capabilities; their packages, workers, extensions, apps, skills, providers, and
manifest declarations are not part of this extraction. Shared ownership also
stays in base: `packages/channel-fork` (News) and all browser, terminal, shell,
runtime, template, and system-test infrastructure.

## Execution order

- [x] Correct onboarding: current in-base owners are not template offers.
- [x] Conventional baseline: userland typecheck, onboarding/system-test
      contracts, authority checks, and conventional smoke validators.
- [x] Examples: add and pass the missing focused compile/contract test.
- [ ] Examples: run the existing interactive Electron proof.
- [x] News and Spectrolite: pass their complete focused conventional suites.
- [ ] News and Spectrolite: close integrated desktop journeys.
- [ ] Authoring dry run: inspect exact base and each optional closure without
      publishing.
- [ ] Run the smallest base category and smoke coverage justified by any
      extraction-related repair and its plausible blast radius.

## Evidence log

Record commands, dates, run IDs, and concrete failures here as the checklist is
worked. Headless results require a deliberately started source instance and
must follow `AGENTS.md`; a stale ready file is never evidence of a live server.

- 2026-08-04: onboarding and Examples focused tests passed (24 tests). The new
  Examples test compiles the shipped Svelte 5 panel and checks its runtime-store
  and reactive-counter contract.
- 2026-08-04: userland typecheck and `check:unit-authority` passed. System-test
  harness, template composer/management, and Templates presentation suites
  passed (43 files, 384 tests).
- 2026-08-04: News + Spectrolite focused suites passed (33 files, 185 tests).
- 2026-08-04: Google Workspace + GitHub focused suites, including the shared
  integrations package, passed (21 files, 181 tests). These capabilities now
  remain in base and this result is baseline evidence, not an extraction gate.
- 2026-08-04: Local Models and mobile extension/skill focused Vitest suites
  passed (10 files, 73 tests); both real-model suites were correctly skipped
  because `RUN_LOCAL_MODELS_E2E=1` was not enabled. Local models remain in base,
  so those live suites are not an extraction gate.
- 2026-08-04: the complete mobile app Jest suite passed (26 suites, 189 tests).
  Mobile remains in base, so device-backed validation is not an extraction gate.
- 2026-08-04: the first full userland pass exposed two stale base test
  contracts: panel-handle mocks did not implement the now-required
  `panelRuntime.ensureSlot` response, and the new Examples test dependency was
  undeclared. Both contracts were corrected; the exact regressions passed (23
  tests), followed by the full userland suite (413 files and 3,600 tests passed;
  only the two real-model tests skipped).
- 2026-08-04: no source server was running by design, so no Electron, headless,
  provider-live, real-model, device-backed, or live `inspectAuthoring` result is
  claimed.
- 2026-08-09: repository history showed that `panels/hello-vanilla`,
  `workers/hello`, and `workers/sample-do` had been deleted as dead examples
  instead of being preserved for extraction. They were restored as the modern
  Examples boundary; the older NatStack-era `workers/rpc-example` remains
  retired because its concepts are already covered by the current Worker
  example. Focused restored-unit tests pass (5 tests).
- 2026-08-09: the first live base authoring inspection correctly refused the
  planned split because the base-owned system-testing skill directly imported
  Spectrolite's feature-owned deterministic suite. The suite remains with the
  Spectrolite panel for feature CI; the base catalog now contains only
  base-owned suites, and its generic state-args probe uses the base-owned Help
  panel. Re-run the authoring inspection after this ownership correction.
