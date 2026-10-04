# Durable Pi behavior ledger and product contracts

Status: preservation contracts and historical baseline, 2026-10-02. The shipping
source now selects the native owner and the displaced engine is removed.
This ledger records behavior to preserve; it is **not a whole-product acceptance
verdict**. The [implementation audit](durable-pi-implementation-audit.md) and
[current checkpoint](durable-pi-migration-plan.md#17-current-implementation-outcome-and-cutover-scope)
record completed checks and the concrete remaining gates. The
[feasibility report](durable-pi-feasibility-report.md) is historical evidence.

Cutover starts with fresh pre-release state. Existing state requires no migration
or backward compatibility. Durability, recovery and cleanup obligations below
apply to work created by the new system.

## Baseline and scope

The source baseline is host `3be741c6b0825f8781d892fa06a51bd5814d54b7`, Base
`1b17159e7e5f60b80f3a10bfb5b769c1d77e9156`, and Pi
`0f8740bb65638180403a225ad7ec4d0cc1f8dedf`. The machine-readable
inventory (`inventory.json`, private verification evidence) records all eight configured
template revisions, file hashes, static imports, declarations and named tests.
The inventory script (`inventory.mjs`, private verification evidence) scans the host and
configured templates without running tools in template checkouts.

The scan records selected files, declarations and test/group titles through
execution-boundary directories and references, with current counts in the
inventory's `counts` field. Those counts include supporting
code and historical documentation. They do not establish a transitive dynamic
call graph or mean every selected declaration has been semantically reviewed.
Keep the inventory as the caller-audit worklist; a row cannot close solely because
its owning package appears in that list.

Paths in the ledger are relative to Base unless prefixed `host/`, `Pi/`, or another
template name. Test titles below are existing regression evidence or newly run
fixture checks. Component receipts close their stated boundaries; use the current
audit to distinguish completed checks from remaining product evidence. Historical
old-engine tests remain an invariant inventory, not tests to recreate verbatim.

## Product contracts

1. **Admission identifies logical work.** Input identity includes its execution
   owner, conversation and logical source envelope. Retry attaches to the same
   accepted work. Distinct inputs remain distinct. Reusing an identity for a
   different semantic request must surface a conflict; transient transport tokens
   may refresh without changing the admitted request. Acknowledgement follows
   committed acceptance, independently of eventual execution or delivery.
2. **Busy input has an explicit policy.** Steering applies at a safe committed
   boundary; follow-up queues retain order; rejection writes no work. Passive
   writes, user inputs and direct operation requests remain distinguishable.
   A reset creates a model-context boundary without silently cancelling or
   duplicating external operations. Feedback cannot start autonomous turns.
3. **Cancellation closes admission and records intent.** An admitted protected
   mutation may have committed before interrupt. Its receipt remains truthful.
   Cancellation stops further progress, requests domain-owner cancellation, and
   preserves cleanup obligations. Execution terminal, publication delivered,
   resource released and source incorporated are separate facts. Unsupported
   external uncertainty must remain inspectable.
4. **Retirement establishes exclusion.** Replacement must exclude old writable
   owners before new code resumes. Cooperative signals help cleanup but cannot
   establish exclusion by themselves. Native owner invalidation and domain-owned
   process/socket cleanup are both required. Rebuild is a compatible continuation
   only when persisted definitions and admitted request bindings permit it.
5. **Tool ordering preserves barriers.** Parallel-safe calls in a wave may run
   together. Sequential calls establish barriers before and after themselves.
   Results retain model call order. Independent conversations and child work must
   make progress while another provider/tool is blocked. Pi's policy of making
   an entire round sequential when one tool requests sequential execution does
   not by itself preserve this contract.
6. **Local task ownership and background collaboration are distinct.** Pi ordinary
   owned work drains before its task settles. Existing `spawn_subagent` returns
   after launch and supervises child assignments in the background; parent
   completion/interrupt does not implicitly join/cancel the collaborator. Explicit
   assignment cancellation and entity retirement preserve cleanup obligations.
   A report, child idleness, publication, source incorporation and retained
   collaborator identity remain separate facts. Suspension keeps the current
   submission waiting for eligible later input rather than completing it.
7. **Source and executable bindings are immutable facts of admitted work.** A
   child retains its own source frontier, implementation artifact, context,
   environment and authority. Same-named definitions in different source images
   must not replace each other implicitly. Resource/settings refresh happens at
   named request/admission boundaries; it cannot retarget an already admitted
   mutation. Protected ports reevaluate current authority when used.
8. **History forks create new work identities.** A fork inherits committed model
   knowledge at a concrete entry and the selected source boundary. It does not
   inherit runnable tasks, pending submissions, approval acquisitions, operation
   admissions, cancellation intents, subscriptions or background ownership.
   Conversation documents declare `asOf`, `current` or `initial` fork semantics
   as supported by their history policy. The parent retains its admitted work.
   Live execution transfer is a separate feature requiring its own design.
9. **Outside content cannot retain stale standing authority.** The authority
   reset must settle before that content becomes actionable by protected work.
   A failed reset is visible and blocks action; remembering an origin in heap
   memory is not evidence that reset succeeded. Read/delivery may still retain
   the content as pending input. This deliberately tightens current error handling.
10. **Operations have domain-owned receipts.** Pi persists intent, dependency and
    continuation; the domain owner admits, executes, cancels and retains the
    operation. Safe reattachment never means replaying a lost JavaScript stack.
    Wrong caller/scope/input cannot attach to an existing identity. Reclamation
    either retains a receipt or retires the admission namespace so an old identity
    can never become a fresh execution. Retention must be bounded by explicit
    ownership/acknowledgement, not a timer that erases execution truth.
11. **Waits are conditions, not live invocations.** Task, time and external-result
    waits commit their continuation and wake condition, release activation
    resources, and resume after replacement without user traffic. Multiple wake
    causes cannot consume each other. Preserve upstream wait/ownership checks and
    the existing self-inspection and queued-work/continuation regressions. General
    cycle detection is deferred. Investigation deadlines never manufacture
    product outcomes.
12. **Recurring goals have their own owner.** A mission revision and occurrence
    identify an admitted tick. Goal completion, tick execution terminal and
    delivery acknowledgement are different transitions. Duplicate occurrences,
    overlapping ticks, charter changes and late completion cannot revive a
    completed goal or acknowledge another revision's work.
13. **Committed product views are recoverable without a panel.** Canonical card
    state, attachment bytes/references, task outcomes, provenance, usage and
    diagnostics are directly inspectable after reconnect or code replacement.
    Streaming/progress may be bounded and coalesced, but transient state is not
    misrepresented as committed. Model self-repair cannot erase unexpected faults.
14. **Schema conversion is permitted and owned.** A dependency migration runner
    may initialize and upgrade its storage. Native bootstrap/probe/validation
    must have one lifecycle owner and validate the resulting shape before
    execution. A schema number alone is insufficient. Supported checkpoint/code
    compatibility is a separate contract. This cutover needs no migration of
    existing pre-release state. Preserve work and histories created by the new
    system; reset or delete only state owned by the authorized lifecycle.

## Preservation and deletion ledger

`Pi` below means the native task/session kernel within an execution owner whose
code and authority bindings are coherent. The shared-tree placement originally
proposed has failed its independent-definition test; D01 selects separate independently loaded agent entities with one local Pi
Session each. Background assignments retain their own entity identity. Domain owners are retained when they own effects,
delivery or resources rather than a competing agent scheduler.

### Inputs, channels and model context

| ID / invariant                                                                 | Existing evidence and caller boundary                                                                                                                                                                                                                                                                                         | New owner, deterministic acceptance and deletion                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L01 Envelope admission dedupes, while distinct observations survive            | `AgentLoopDriver` observation admission; driver tests “deduplicates a replayed structured observation by source envelope”, “admits different observation envelopes as different inputs”, “can retry the same observation after failure before prompt admission”; vessel `acceptChannelDelivery`, `routeConfiguredObservation` | Pi submission plus channel receipt. Interrupt before/after admission and replay both equal and distinct envelopes. Delete observation-to-old-fold execution admission after callers consume native identities.                                                                                                 |
| L02 Channel read acknowledgement does not await a provider                     | Driver test “dispatches a read-ack before the pending model call completes”; `ChannelClient`, subscription replay                                                                                                                                                                                                             | Channel delivery owner acknowledges durable admission. Hold provider indefinitely and deliver/read-ack another envelope. Retain channel outbox/receipt; delete dependency on loop pump/effect dispatch.                                                                                                        |
| L03 Steering and follow-up cannot be lost or overtake earlier input            | Driver observation/queued direct eval/repaired tool-cascade tests; vessel `dispatchApprovedInput`, `processChannelEvent`                                                                                                                                                                                                      | Pi inbox and boundary placement. Queue while tools settle, replace owner, then assert exact input identities/order. Delete legacy steering-event fold and recovery cascade.                                                                                                                                    |
| L04 Reset preserves operation truth and establishes a new context head         | Vessel `interruptChannel`, reset paths and `outsideContentReset`; Pi `Conversation.reset`, `InboxDoc`                                                                                                                                                                                                                         | Pi context head plus explicit cancellation policy. Reset during mutation/approval and assert no forgotten receipt or replay. Delete custom context-reset execution reconciliation.                                                                                                                             |
| L05 Respond policy, addressees and identity remain per channel                 | Vessel `shouldRespond`, `addresseeContext`, roster resolution, `getRespondPolicy`; driver supervisor final-response and channel-self-identity tests                                                                                                                                                                           | Product admission/prompt policy and publication owner. Test direct mentions, configured supervisor, unknown human target, allow-list and forks. Retain product addressing policy; remove execution decisions encoded in its old fold.                                                                          |
| L06 Source, prompt resources, skills and attachments hydrate as actual content | Vessel `preparePromptArtifacts`, `ensurePromptArtifacts`, blob cache, `loadPromptResources`; `say-attachments.test.ts`; driver prompt transport retry                                                                                                                                                                         | Per-request preparation with immutable admitted bindings; blob/resource owners retain bytes. Replace during hydration, reconnect and verify exact content/reference provenance. Delete prompt-loaded effect and bespoke replay; retain domain hydration/cache where justified.                                 |
| L07 Fork knowledge never re-expands inherited tool calls                       | Driver “does not re-expand inherited parent tool calls when waking a forked child turn”; vessel `postClone`, `initFromTrajectoryFork`; host `runtimeService.cloneContext`                                                                                                                                                     | Pi history fork plus source-context creation. Fork with live tools, approvals, child and compaction; verify new identities and no copied execution. Delete copied outbox normalization/fold cache and inherited-execution repair. Basic active-task history case passes the fixture; remaining cases are open. |
| L08 Passive observations, model-free evals and method requests remain distinct | Driver model-free automation eval and queued direct eval tests; vessel `onMethodCall`, `chatOp`, direct method cancellation                                                                                                                                                                                                   | Pi native operation tasks and product dispatch. Run without a model; replace while queued; assert one domain admission and correct visible invocation. Delete synthetic old-loop turn/effect dependence, not these APIs.                                                                                       |

### Providers and tool execution

| ID / invariant                                                              | Existing evidence and caller boundary                                                                                                                | New owner, deterministic acceptance and deletion                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L09 Blocked work does not pin other conversations                           | Driver “a long model_call on one channel does NOT pin the shared pump”; noncooperative executor tests                                                | Pi scheduler and correctly isolated execution owner. Hold provider A, complete B; repeat during cancellation and rebuild. Delete custom shared pump concurrency ownership.                                                                                                              |
| L10 Parallel waves obey sequential barriers                                 | Driver “dispatches local tools in durable ordered waves around sequential barriers”; `agent-loop/step.ts`, tool registrations                        | One Pi scheduling rule, not a wrapper queue. Use ordered gates to prove before/after barriers and result ordering. Delete legacy wave/effect expansion only after equivalent native behavior passes.                                                                                    |
| L11 Arguments and tool-schema errors are deterministic                      | `tool-arguments.test.ts`, `agent-worker-base.tools.test.ts`, `action-data.test.ts`; driver provider schema rejection test                            | Tool registration/validation before durable intent. Test repaired arguments, invalid schemas and rejected provider requests without unwanted retry. Delete duplicate preparation layers after preserving pure normalization.                                                            |
| L12 Safe and unsafe tool interruption are honest                            | `local-tool-execution.test.ts`; driver late-result/lifecycle tests; Pi `ToolTask` replay policy                                                      | Pi intent and domain receipt; native invocation fences. Interrupt at intent/admission/result/receipt publication. Safe reattach succeeds once; unsafe uncertainty blocks visibly. Delete outbox external-ID claim/settlement and local replay guesses.                                  |
| L13 Provider attempts and usage retain actual routing provenance            | Driver distinct attempts with reused message ID, routing/usage tests; `model-call.test.ts`, `model-spec.test.ts`                                     | Pi generation attempts and committed usage with host credential attribution. Script retry/fallback and verify unique attempts, actual model/provider and spend. Delete journal-derived duplicate execution routing; preserve provenance views.                                          |
| L14 Credential and authority waits cannot consume result wakes              | Driver credential-connect/reconnect/fallback tests and three authority/deferred-result race tests; vessel `onAuthorityChanged`, `resolveModelApiKey` | Explicit Pi external conditions with credential/approval domain owners. Deliver wake before/after park and replace both owners; result wait must not reexecute on authority refresh. Delete ad hoc deferred markers and credential-suspension scheduling.                               |
| L15 Usage-limit reset, transient failures and retry policy stay inspectable | Driver scheduled usage-limit resume, reset metadata, rate-limit, transient/persistent transport budget tests                                         | Pi durable timed phases and explicit product/provider failure policy. Test due-time resume, terminal quota classification and diagnostic retention. Delete old wake tables/retry fold after a coherent replacement; decide retry policy explicitly rather than copying all old budgets. |
| L16 Thinking, streaming, native prompt progress and final metadata survive  | `pi-raw-thinking-options.test.ts`, Codex transport tests, provider patch; renderer/model-call consumers                                              | Pi native model/view events and provider delta. Script signature-bearing thinking, prompt progress and metadata; late join recovers final truth, progress remains bounded. Delete old signal packet shapes only after consumer audit.                                                   |
| L17 Provider sockets and credential egress remain correctly owned           | `openai-codex-transport.test.ts`, `model-fetch-proxy.test.ts`, provider patch; host UniversalDO `EgressGateway`                                      | Bound provider transport and session resource owner. Prove fetch-upgrade attribution, abort/release and isolated session identities in real facets. Retain egress authority; delete old global hook plumbing only when equivalent native transport exists.                              |

### Effects, cancellation, waits and storage

| ID / invariant                                                        | Existing evidence and caller boundary                                                                                                                                      | New owner, deterministic acceptance and deletion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L18 Interrupt cannot describe a committed mutation as undone          | Driver “settles an admitted mutation before journaling a user interrupt”, admission fence test; host semantic mutation operation owners                                    | Pi intent plus mutation receipt. Gate interrupt before/after domain acceptance and caller acknowledgement, then reopen. Delete old-effect-derived mutation-completed inference.                                                                                                                                                                                                                                                                                                                                                                         |
| L19 Eval attaches by semantic identity and survives lost delivery     | Host `EvalDO.enqueueRun`, semantic argument comparison and routing credential refresh; driver lost eval terminal/duplicate push/transient store-load tests                 | Eval remains execution owner; Pi waits on its durable receipt. Test early/late/duplicate/forged results, reload and same identity with wrong semantic input. Delete parked-effect redrive/poll-backstop as agent execution authorities.                                                                                                                                                                                                                                                                                                                 |
| L20 Reclaimed results cannot admit the same operation again           | Host `EvalDO.dispose`, `executionJournal`, vessel deferred-start attempt logic                                                                                             | Canonical owner admission record retained after payload reclamation, or complete finite-incarnation retirement before record deletion. Reclaim/replay and prove no second execution; measure metadata/payload ownership. Ordered namespace/range optimization is deferred. Remove start-attempt workaround only after this law holds.                                                                                                                                                                                                                   |
| L21 Cancellation survives caller and executor loss                    | Vessel eval cancel intents/drain, direct method cancellation; host `EvalDO.cancel.test.ts`, process-adapter operation tests                                                | Domain cancellation receipt; Pi durable obligation. Kill each side after accepted cancel, then recover and verify resource completion separately. Delete vessel eval-cancel scheduling only after domain-owned reconciliation exists.                                                                                                                                                                                                                                                                                                                   |
| L22 Replacement excludes stale commits even from noncooperative code  | Driver lifecycle/late-result/cache-amnesia/crash-kill tests; host `workerdManager`, actual UniversalDO loader                                                              | Native activation fencing, Pi invocation gates and domain resource cleanup. Actual facet restart/image advance writer test passes; still test manager process death and lost domain cancellation. Delete old generation-specific effect executor ownership.                                                                                                                                                                                                                                                                                             |
| L23 Time/result waits release invocations and cannot lose quiet wakes | Vessel alarm sources, `nextAgentAlarmSchedule`, host `alarmDriver`; Pi generation/compaction `runtime.sleep`                                                               | Pi wait record; host alarm service as wake index/driver for current facets. Kill between Pi commit and host registration, suppress user traffic, restart host and prove completion. Delete heap sleeps in durable phases and legacy effect/wake queues. **Selected D03/D04 response:** typed dormant waits plus versioned existing host wakes. Intrinsic typed waits and native quiet timer/real EvalDO recovery pass, including loss of every publication. Custom runtime.sleep remains resident; shipping integration and resource proof remain open. |
| L24 Existing wait/serviceability safeguards survive                   | Pi scheduler self/ancestor validator; Base `chat-op.test.ts` self-inspection; `step.ts` queued direct invocation and `agent-loop.test.ts` future-turn artifact preparation | Retain Pi's existing wait/ownership checks and port the concrete self-inspection/queued-work/current-tool continuation behaviors. The synthetic sibling-cycle fixture exposes an upstream limitation, not a demonstrated preservation requirement. General local/distributed cycle detection is outside this migration.                                                                                                                                                                                                                                 |
| L25 Unknown/incompatible code blocks instead of guessing              | Pi definition versions/migrations; host source rebuild/image binding                                                                                                       | Pi checkpoint compatibility plus explicit artifact binding. Reopen missing/older/incompatible phases; show reason and preserve work. Missing-definition fixture passes; version/image matrix remains open. Delete custom generic activation redrive.                                                                                                                                                                                                                                                                                                    |
| L26 Atomic storage and uncertain acceptance are not conflated         | Pi `SqliteStorage`, `SessionImpl`, `StorageRejected`; upstream facade/migration/storage tests                                                                              | Existing async SQLite facade plus native serialized connection. Rollback rejects without effects; acknowledgement loss poisons Session and publishes nothing; reopen recomputes IDs. All 23 portable storage conformance cases and native uncertainty/rollback pass; exhaustive native crash/reopen/retention checks remain open. No synchronous SQL-core rewrite is required by current evidence.                                                                                                                                                      |
| L27 Migration and shape validation have one lifecycle owner           | Host `packages/durable/src/schema.ts`; Pi migration runner                                                                                                                 | Dependency bootstrap/migrations followed by native expected-shape validation inside one owned lifecycle. Fresh/upgrade/retry/newer rejection and index drift tests; no independently mutating installers. D06 selects one composed async lifecycle. Production base/extracted runner native rollback/reopen and complete-shape refusal pass; manager descriptor evidence is keyed by exact execution digest. Shipping Pi activation must require the descriptor on every route.                                                                         |

### Supervision, source and missions

| ID / invariant                                                               | Existing evidence and caller boundary                                                                                                                                                     | New owner, deterministic acceptance and deletion                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L28 Spawn/provisioning is recoverable with distinct child identities         | Vessel `runDeferredSpawn`, task seed publication, failed-spawn rollback; `subagent-runs.test.ts`; context/entity creation callers                                                         | Pi parent task owns provisioning intent; platform owns context/entity/source creation. Kill at every creation boundary, recover or retire exact child resources. Delete status mirrors acting as execution authority; retain provenance/adoption receipts.                                                                                                                                                                                                 |
| L29 Local task ownership does not turn subagent spawn into a foreground join | Pi ownership/completing tests; Base `chat-op.test.ts` immediate spawn handle, ordinary report, retained follow-up and active-child report tests; `interruptChannelAndCancelDeferredEvals` | Reuse Pi ordinary owned-task semantics for local work. Child assignments start under conversation-owned background supervision. Parent finish/interrupt leaves admitted collaborators supervised; explicit cancel/retirement owns their cleanup. Do not hold parent final-answer settlement until all child assignments finish.                                                                                                                            |
| L30 Background work has a durable supervisor and explicit retirement         | Vessel `guardBackgroundSuspension`, cancellation/activity/retirement methods; subagent skills                                                                                             | Pi background ownership and domain cleanup. Finish parent, replace owner, follow up and explicitly retire child; retained workspace stays usable. Delete anonymous supervisor wakes and status-derived cleanup guesses.                                                                                                                                                                                                                                    |
| L31 Child code/context/authority cannot be globally replaced                 | Custom worker overrides below; host loader source/class/context/image identity; Pi registry/task resolution                                                                               | Coherent physical owner and bound executable definitions. Two same-named implementations must each run their admitted code and call only their own protected ports. Initial shared-Session counterexample: cwd remains distinct, both results use code B. **Selected D01 response:** separate bound entities. Native same-name/code/fixture-egress isolation, replacement and A-only update pass; real authority and child-supervision proofs remain open. |
| L32 Send/read/inspect/follow-up preserve collaborator identity               | Vessel `sendToSubagent`, `readSubagent`, `inspectSubagent`, recovered run lookup; subagent tests/skills                                                                                   | Product collaborator API plus native committed views, with source/context identity retained. Cancel then follow up; recover by handle after reload; inspect without mounting UI. Delete folded execution summaries and mirror polling, not collaborator APIs.                                                                                                                                                                                              |
| L33 Source incorporation is separate from task execution                     | Vessel `mergeSubagent`, semantic integration projection/source receipts; host VCS/context adoption                                                                                        | VCS/source owner retains immutable integration provenance. Child success with merge conflict remains success plus unincorporated source; retries attach to exact source event. Delete task-status-implies-merge logic; retain VCS receipts.                                                                                                                                                                                                                |
| L34 Direct automation eval has exact invocation settlement                   | Driver automation eval and exact final-assistant tests; vessel automation launch/control/acknowledge methods                                                                              | Mission owner admits occurrence; Pi task executes it and records exact answer/failure set. Test another turn closing concurrently and model-free action reload. Delete loop-turn lookup as mission execution authority.                                                                                                                                                                                                                                    |
| L35 Goal completion, tick terminal and delivery ack remain separate          | Mission completion protocol, execution-image digest, vessel automation definitions; host mission service/contracts                                                                        | Mission owner retains one-active-run/overlap skip, missed-occurrence/no-catch-up, pause/grants and revision replacement policies; Pi owns admitted execution. Race completion versus new tick and old-revision late results; assert no resurrection. Delete duplicate executor status folds after caller cutover.                                                                                                                                          |
| L36 Source copy/export does not copy live ownership                          | Host `runtimeService.cloneContext`, workerd storage copy/delete paths; vessel `postClone`; Pi doc fork policies                                                                           | Source context copy plus explicit Pi history import/fork; fresh owner namespace. Copy/export while mutation, approval and child are active; verify rollback of provisioning and no parent subscription unregister. Delete blind agent execution database copy and normalization.                                                                                                                                                                           |

### Product views and customized workers

| ID / invariant                                                          | Existing evidence and caller boundary                                                                                                                                                           | New owner, deterministic acceptance and deletion                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L37 Cards validate, recover and obey one canonical state owner          | `custom-cards.test.ts`; vessel `chatOp`, message-type registration/indexing; Gmail/News cards                                                                                                   | Versioned canonical product document plus channel publication receipt. Replace between state commit and publication; recover directly; race writers and late join. Delete duplicate card execution history/projection only after canonical choice is proved.                                                        |
| L38 Human questions settle once with exact audience                     | Driver first `ask_user` answer test; `AgentWorkerBase.createAskUserTool`, channel call owner                                                                                                    | Channel/human answer receipt; Pi waits on condition. Competing answers across replacement yield one winner; unknown target rejects and never broadcasts; other forms cancel. Delete old-effect-specific answer settlement.                                                                                          |
| L39 Feedback is bounded and cannot be consumed before acceptance        | `FeedbackIngest.consume/ingest`, `feedback-ingest.test.ts`, chat feedback hooks                                                                                                                 | Product feedback document and Pi admission in one commit. Crash between read and admission, replay render failure and verify bounded notes without autonomous turns. Replace destructive pre-admission drain; keep diagnostic fault evidence beyond presentation dedupe.                                            |
| L40 Inspection and UI distinguish pending, committed and terminal facts | Vessel `readAgentInspection`, model evidence/debug APIs; `agentic-chat` hooks, channel reducers; agent inspection callers                                                                       | Pi committed views, domain receipts and provenance. Query headlessly during retry, uncertainty, cancellation and rebuild; late join gets exact current truth. Delete fold-cache/outbox-derived inspection and obsolete protocol packets.                                                                            |
| L41 Custom subclass policy remains real executable behavior             | `AiChatWorker` prompt/resources; `SilentAgentWorker` publish policy; Personal explorer prompts/tools/cards; System prompt overrides/memory recall; System-testing test-agent event interception | Native agent definition API plus product hooks; migrate each override explicitly. Exercise behavior with the class's own source and capability bindings. Delete old `getStepPolicies`/executor overrides only after mapping their actual meaning.                                                                   |
| L42 Specialized workers retain their independent lifecycles             | Google Gmail watch/push/reminder/triage/alarm/method/card state; News polling/briefing/deep-dive/fork/preferences/cards; examples adventure/grimoire/regency moment delivery/turn closure       | Domain workers retain canonical domain state and alarm sources; Pi owns admitted agent execution only. Share the single host alarm schedule fairly, recover subscriptions/cards, and preserve specialized turn closure/method behavior. Do not delete these classes as incidental vessel subclasses.                |
| L43 GAD remains source/channel provenance without a second agent engine | GAD workspace worker/readers; trajectory consumers; `agent-loop/state.ts`, `fold-cache.ts`, protocol reducers                                                                                   | Source/channel logs retained; native execution views replace agent trajectory fold authority. Audit every import/reader and artifact consumer; remove old execution event derivation, replay caches and effect expansion together.                                                                                  |
| L44 Delivery, progress and resource retention remain bounded            | Publication executors, subscription manager/channel client tests; provider session cleanup; host resource/process ownership                                                                     | Channel receipt/outbox, bounded native watches/progress and domain resource owner. Replace/reconnect/cancel repeatedly; verify no owned socket/process/observer/temp directory survives cleanup and measure retained history separately. Delete redundant execution queues; retain cross-owner delivery durability. |

## Focused preservation review and baseline verification

The preservation evidence (`preservation-evidence.json`, private verification evidence)
records the reviewed source hashes, explicit dispositions and the two focused
host-projection runs: **24 existing tests passed across three files**. These are
baseline tests of the current product, not tests of a Pi-integrated replacement.
The checkouts include concurrent uncommitted work; HEAD alone does not identify
the audited bytes. Source hashes and evidence scope are recorded separately.

| Boundary                | Existing meaning to preserve                                                                                                                           | Replacement acceptance                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Spawn                   | Returns after launch; effective parent model/approval/prompt settings are inherited with explicit child overrides.                                     | Admission task settles independently of child assignment; immutable request settings and exact retained child binding.           |
| Child report / activity | Reports wake the parent; an active child remains active after a progress report; a reported problem does not permanently fail the collaborator.        | Message admission, execution receipt/idleness and collaborator retirement are independent, with no fabricated task terminal.     |
| Follow-up / cancel      | Exact participant/channel targeting; completed/failed/cancelled assignments retain the collaborator; abandoned identity refuses execution.             | Fresh logical assignment in the same retained entity, correctly authorized and supervised.                                       |
| Suspension              | The open turn stays waiting; own suspension result/recovery hint cannot resume it; eligible queued reports can resume it immediately.                  | Native input cursor/continuation with early/late input races; no premature response-less terminal or all-children barrier.       |
| Mission schedule        | Five-second delivery opportunity window; missed occurrences advance with no catch-up; overlapping runs skip with one persistent issue.                 | Retain domain scheduling and exact occurrence identity; native execution change introduces no new backlog or concurrency policy. |
| Mission controls        | Pause keeps grants; revision replacement commits new eligibility before old execution/authority cleanup; transient remote failures remain nonterminal. | Exact revision result/cancellation/ack receipts and authoritative lifecycle propagation.                                         |

Required semantic changes are explicit: dormant work recovers without resident
invocations; wake publication cannot be lost; schema initialization has one
owner; feedback consumption becomes atomic with admission; failed outside-content
authority reset blocks actionable input. The latter two fix identified current
error-handling gaps. Ordered tool waves and custom worker policy preserve current
behavior. General cycle detection, live ownership transfer, catch-up scheduling
and range-compacted receipt namespaces are deferred enhancements, not cutover gates.

### Historical regression cases to port

These are source-backed review/acceptance obligations, not completed replacement
proofs. Paths are relative to Base unless marked host. Keep their product meaning
when old event/fold assertions are replaced with native state/receipt assertions.

| Behavior                                  | Existing evidence to audit                                                                            | New acceptance assertion                                                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Interrupt racing an admitted mutation     | `packages/agentic-do/src/agent-loop-driver.test.ts`: mutation settles before interrupt                | Actual mutation receipt survives; cancellation never describes a committed mutation as undone                                               |
| Non-cooperative work during retirement    | Same file: interrupt/lifecycle release/late-result tests; host `workerdManager.ts`                    | Replacement establishes exclusion without relying on cooperative completion; old callbacks cannot commit and cleanup remains honestly owned |
| Independent conversations                 | Same file: long model call does not pin pump; branch-isolated identities                              | Conversations/entities advance fairly and remain causally/authority isolated                                                                |
| Parallel tools around sequential barriers | Same file: durable ordered waves around sequential barriers                                           | Define product ordering, then prove it against Pi rather than assuming its modes are equivalent                                             |
| Human answers and approvals               | Same file: first `ask_user` answer cancels other forms; authority wake races deferred acknowledgement | One answer wins durably; credentials, approval and external-result conditions resolve independently                                         |
| Model-free automation/eval                | Same file: direct eval queued behind conversation and recovered after reload                          | Direct operations need no invented model turn; one eval admission and recoverable receipt                                                   |
| Observation/message admission             | Same file: envelope dedupe, distinct observations, active steering and retry before admission         | Logical inputs retain identity; distinct inputs survive; acknowledgements follow committed acceptance                                       |
| Provider routing, attempts and usage      | Same file, `effect-executors/*.test.ts`, `packages/pi-ai/patches/`                                    | Pinned request settings, visible attempts/uncertainty, preserved credential attribution and socket cleanup                                  |
| Inherited task history                    | Same file: child never re-expands parent tool calls; vessel fork methods; host `runtimeService.ts`    | Usable model history and exact source boundary without inherited runnable work or authority                                                 |
| Eval retention and scope                  | Host `EvalDO.ts`: semantic input comparison, transport refresh and `dispose()`                        | Same identity attaches; wrong scope/input rejects; reclaimed identity cannot execute anew; lost JS stack is not replayed                    |
| Feedback and outside content              | `feedback-ingest.ts`, `outside-content-reset.ts`, tests and admission callers                         | Feedback consumption commits with admission; failed authority reset blocks actionable content; duplicate delivery cannot bypass policy      |
| Cards, attachments and resources          | `custom-cards.test.ts`, `say-attachments.test.ts`, prompt/blob hydration callers                      | Canonical validated card state and actual content bytes survive reconnect/fork/rebuild                                                      |

## Provider patch assessment against the frozen Pi source

Base's `packages/pi-ai/patches/@earendil-works__pi-ai@0.99.1.patch` modifies five
published files. The following groups record the frozen upstream findings and
required preservation; they are not assertions that the maintained delta still
lacks those features. Explicit credential type, request identity/diagnostics,
owned WebSocket port/cleanup, prompt progress and fast-tier accounting now live
in coherent fork source, with 84 focused source tests and full fork checks.
Production attributed transport, pricing provenance and view consumers remain
acceptance gates before old patches disappear. The stream-idle watchdog is not
ported as an execution outcome policy.

| Patch behavior                                                                  | Pinned source finding                                                                                      | Decision / evidence required                                                                                                                                                                         |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit trusted-transport credential method for Anthropic OAuth                | Patch adds `authType` through request options and client creation; reviewed source lacks that field/branch | Preserve explicit credential-method attribution; test opaque injected OAuth without assuming token text identifies the credential.                                                                   |
| Codex distinct logical request ID versus transport session ID                   | Source SSE headers still set `x-client-request-id` from session ID                                         | Preserve per-attempt/request identity and stable session association; assert retries with reused transcript message IDs remain distinguishable.                                                      |
| Codex SSE retry diagnostics                                                     | Patch adds provider/transport/phase/attempt/delay/status diagnostics at both retry sites                   | Retain observable attempts and retry reasons; assess current diagnostics semantically and test both status and fetch failure routes.                                                                 |
| Separate renewable stream-idle lease from whole HTTP timeout                    | Patch adds `streamIdleTimeoutMs` and raw-chunk/frame lease behavior                                        | Reassess against the repository's no-invented-timeout law. Transport protocol failure detection must have an explicit justified contract; do not copy a watchdog to hide missing durable completion. |
| `fast` tier cost accounting                                                     | Patch handles `fast` alongside `priority`; that branch is absent in the pin                                | Verify exact routed tier/model accounting with primary provider data when implementing; retain spend attribution. No live pricing assumption is established here.                                    |
| Workers fetch WebSocket upgrade, attributed egress and platform socket shape    | Pin still resolves a WebSocket constructor; no patched fetch-upgrade helper                                | Source transport integration is required; test through actual UniversalDO bound egress, not an unbound browser/Node socket.                                                                          |
| Avoid inappropriate Workers socket reuse; release cached socket and debug state | Source resource cleanup registers socket close separately from debug reset                                 | Preserve owned cleanup and prove repeated interrupted sessions do not retain socket/debug maps. Replace global hooks with an explicit transport/resource contract when feasible.                     |
| Native local-provider prompt-processing progress                                | Patch adds monotonic `prompt_progress` parsing and event type; pin lacks it                                | Preserve meaningful local model progress, including progress-only chunks and stream end before generated content; update committed/transient view consumers deliberately.                            |

## Caller audit closure and next review

The inventory explicitly includes Base chat/silent workers, Personal explorer,
System agent, System-testing test agent, Gmail, News, and all three example agent
families. Their extension points include prompts, resource loading, tools,
participant/method policies, observation interception, turn-close callbacks,
fork hooks, domain state and additional alarm sources. Independent updates and
capability isolation are required behavior, not optional implementation detail.

Before claiming M0 complete for cutover, link each selected execution consumer
and custom override to its ledger row or an explicit out-of-scope disposition;
read the selected historical bug evidence; then close any missing capabilities.
The present first-pass ledger covers the identified boundary families, but does
not claim that this per-declaration audit is finished. Before claiming a
preservation pass, replace each required acceptance assertion with test evidence
and a concrete deleted symbol/table/import list. No production deletion is
authorized by a successful component test alone.

The [design record](durable-pi-design-decisions.md) now maps D01–D18 to these
preservation obligations, including concrete customized-worker hooks and
historical race cases. Placement, schema and bounded protocol specifications
have additional evidence in the [updated report](durable-pi-feasibility-report.md).
Those decisions close design questions; they do not close this ledger's
per-declaration audit or production acceptance. No old engine has been deleted.

A kick is a prompt to check progress/carry on, not a request that blocks until
another task finishes. Sending, inspecting and reading a child preserve this
independence. Sibling cycles remain a synthetic observation, not a migration
blocker or required enhancement. Preserve concrete existing regression safeguards;
revisit general detection only on evidence from a supported product path. No global naming wrapper, heap
polling fallback, second scheduler or timeout-induced outcome closes a gate.

## Implemented packet evidence and limits

The [affected-caller audit](durable-pi-implementation-audit.md) maps the new
schema, commit, wait, relay and real EvalDO slice to this ledger. Native evidence
proves quiet timer recovery, loss of every publication and admission-before-
continuation recovery with one actual SQL application. It does not close product
rows from those component tests. Canonical Eval receipt/exact acknowledgement,
finite retirement, host reset-incarnation journaling and Base owner/receipt
components are implemented. Production completion routing/redelivery, actual
resource/payload collection, full process/reset proofs, native provider transport
and custom worker replacement remain release obligations. See the affected-caller
audit for current evidence rather than treating this historical baseline as a
replacement pass.

Existing lazy conversation creation remains unchanged and is tested. Intrinsic
provider retries and deferred generation polls now park durably; after replacement,
provider loss at the due poll retains the admitted handle in a visible failure
wait. Exact incident repair resumes that operation; cancellation uses the same
handle. A failed observation cannot start a replacement generation. Tool
continuation failures likewise retain the admitted operation and placed input;
bounded output/details/diagnostics survive failure and replacement, and resumed
progress does not duplicate restored diagnostics. Exact repair or successful
cleanup precedes the tool result and owning generation's settlement. These source
proofs do not establish shipping operation admission or physical resource release.
Custom runtime.sleep still keeps a
resident invocation; audit and port such definitions before claiming their
dormancy. Background collaborators and mission policies retain the selected
current-product semantics and their separate baseline evidence.

L14's authority handover now has a tested live-observer contract: disconnected
waiters release their listener/callback, and the last departure before receiving
a decision restores the existing owner wake. Ordinary and target approvals share
this rule, including the committed-decision/disconnect race. Fourteen new tests
and the affected 71-test host cohort pass; see the
source evidence (`acquisition-handover-evidence.json`, private verification evidence).
The canonical grant owner now retains ordinary/source-delta acquisition requests
and decisions; the production coordinator uses them and has removed its expiring
completion buffer. Full install-review collections and source facts survive
recovery, and consent/decision writes settle atomically. Fourteen coordinator
recovery tests, fourteen storage tests and nine commit-effect tests pass in the
affected 566-test cohort. Rollback preserves live authority; withdrawal effects
observe the committed grant/decision state;
see coordinator evidence (`authority-acquisition-coordinator-evidence.json`, private verification evidence).
Grant schema v13 also repairs lost consent lineage and proves every authority
constraint survives reopen. The earlier
v12 storage evidence (`authority-acquisition-storage-evidence.json`, private verification evidence)
remains a historical checkpoint. Grant schema v14 now brings standing approvals
into the same owner, removes their separate connection and commits complete
task-rules answers with consent. Validated one-time read-only adoption preserves
historical decisions and retirement; fifteen new tests pass in the affected
581-test cohort. See standing approval evidence (`target-authority-ownership-evidence.json`, private verification evidence).
Grant schema v15 now admits standing invocation joins in the canonical acquisition
store and commits joined receipts with standing decisions and consent. Their
separate process-local join/wait paths are removed. Sixteen recovery regressions
and the affected 597-test, 24-file cohort pass, including actual Node process exit,
direct late receipt consumption, multi-page rollback and grouped-prompt ownership.
See join recovery evidence (`target-acquisition-recovery-evidence.json`, private verification evidence).
The subsequent host checkpoint adds authenticated canonical receipt reads,
bounded outstanding pages and exact acknowledgement. Runtime-only lookup is
removed; live and recovered waits verify both runtime and session. Thirteen
service regressions, two wait-isolation regressions and one composed mixed-owner
refusal regression pass in the affected 615-test, 26-file cohort; see authenticated receipt evidence (`authority-session-receipt-evidence.json`, private verification evidence).
Protected shipping Pi consumption, owner/incarnation reconciliation and
acknowledged production redelivery remain open. The host endpoints and wake hints
alone do not establish them.
These host source proofs do not close L14 or authorize deletion of the old
approval redrive path; the preceding `.3` native snapshot does not attest them.

The `.4` fork adds the invoking task's transaction capability to the protected
model port. Five new kernel regressions prove bound approval receipt replacement,
early outcomes, rollback/original failure, conflicting binding and queued
post-request refusal; the affected 306-test cohort passes. Base's installed owner
replacement and transport cohort passes 47 tests. Explicit generic execution
completion now closes canonical approvals after controller authentication and
before dropping retry authority; 30 registry/service tests prove closure failure,
foreign-controller refusal and preserved notebook-history semantics. See
transaction and completion evidence (`model-request-commit-evidence.json`, private verification evidence).
L14 remains open: shipping host receipt consumption, loss-safe approval wakes,
reconnect and owner/incarnation admission are still required. Neither a controlled
receipt nor a disposable notification authorizes deleting existing recovery.
