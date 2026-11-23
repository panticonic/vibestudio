# Eval startup / kernel lease ownership inventory

Observed: scheduled-recovery mission seeds persisted; no mission_runs, no
inference. EvalDO b865... created; its host residency hold remained active
300/600 seconds and ended during lifecycle cleanup at610 seconds. A residency
hold is not evidence that run admission occurred.

Mechanisms inspected before edits:
- evalService.ts:670-1036 prepareRun awaits lease touch at997; start:1042-1091
  subsequently dispatches startRun. No other await is between these operations.
- evalKernelLease.ts:49-137 serializes finite acquire/attach transitions per
  notebook and deliberately does not await the separate long residency promise.
  close:138-154 owns host cancellation and joins those promises.
- EvalDO.ts:1102-1216 acquire/attach serialize through a separate transition
  chain; hold awaits only lease settlement/cancellation, outside that chain.
  startRun:1388-1450 inserts before executing guest code. The observed utility
  does not supply reset, so forceReset is not on this admission path.
- doDispatch.ts:509,728-835 scopes each request's relay/authority admission;
  rpcServer.ts:1316-1330 does not globally join other authority parents.
- workerdRpcRelay.ts:314-333 uses an origin Pool with unlimited default
  connections and pipelining0; held requests do not consume a singleton lane.
- durable/index.ts:1538-1635 drains outbound causal RPCs of one inbound context;
  rpc/causal-operation-tracker.ts has per-context WeakMap ownership. Host lease
  dispatch is process-local DODispatch, not an outbound child of that DO tracker.
- service-schemas/evalEngine.ts declares the finite acquire/attach and held lease
  methods; service-schemas/eval.ts:createEvalExecutor calls eval.start then polls.
- SystemTesting workers/system-test-runner/index.ts:683-735 creates the finite
  utility scope; no reset flag is supplied. Other kernel holders use the same
  Host coordinator. No model engine/serving path implements this lease mechanism.

No cause for the observed missing scheduled run is established by this trace.
Concrete independent lifecycle defects found: failed attach left a no-hold lease
in the active map so close spun forever; replacing a stale holder or failing its
refresh dropped the only ownership record of an unsettled native request.
Fix: retain all in-flight holder records separately from the current lease map;
retire/abort superseded admissions immediately, join them on close, and remove
failed no-hold admissions. Keep residency asynchronous to run admission.

Validation:10 coordinator tests plus45 eval service tests pass in ledger
`vibe-kernel-lease-owned-holds-final-20261123` (383MiB peak). The first runner
attempt omitted the mandatory Host artifact generation environment; supplying
that canonical explicit generation made the existing eval service suite runnable.
The regression cases prove failed attach can close, a superseded holder is
aborted immediately but its terminal native response is still joined, and failed
refresh preserves the same cleanup ownership. Existing tests prove that ordinary
touch returns while residency remains held. No paid inference or runtime retry
was performed. Production v8 bundle matches the inspected asynchronous holder
implementation; missing scheduled run cause remains unproven.
