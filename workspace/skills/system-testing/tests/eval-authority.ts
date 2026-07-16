import type { TestCase } from "../types.js";
import {
  finalMessageHasAll,
  getToolCalls,
  noIncompleteInvocations,
  settledToolNames,
} from "./_helpers.js";

function verified(marker: string, requireEval = true): TestCase["validate"] {
  return (result) => {
    const final = finalMessageHasAll(result, [marker]);
    if (!final.passed) return final;
    if (requireEval && !settledToolNames(result).has("eval")) {
      return { passed: false, reason: "The case completed without exercising the eval tool" };
    }
    const unexpected = (result.toolFailures ?? []).filter((failure) => failure.expected !== true);
    if (unexpected.length > 0) {
      return {
        passed: false,
        reason: `Unexpected tool failures: ${unexpected.map((failure) => `${failure.name}:${failure.error ?? failure.status ?? "failed"}`).join(", ")}`,
      };
    }
    return noIncompleteInvocations(result);
  };
}

function verifiedPreauthorization(result: Parameters<TestCase["validate"]>[0]) {
  const base = verified("AGENT_EVAL_PREAUTHORIZATION_OK")(result);
  if (!base.passed) return base;
  const successful = getToolCalls(result).find(
    (call) =>
      call.name === "eval" &&
      call.execution?.status === "complete" &&
      call.execution.isError !== true &&
      Array.isArray(
        (call.arguments?.["authority"] as { preauthorize?: unknown } | undefined)?.preauthorize
      )
  );
  if (!successful) {
    return { passed: false, reason: "No successful eval carried a preauthorization manifest" };
  }
  const details = (
    successful.execution?.result as { details?: Record<string, unknown> } | undefined
  )?.details;
  const authority = details?.["authority"] as
    | { approvalsRequested?: unknown; approvalsDenied?: unknown }
    | undefined;
  const returnValue = details?.["returnValue"] as
    | { decision?: unknown; allowed?: unknown }
    | undefined;
  if (authority?.approvalsRequested !== 1 || authority.approvalsDenied !== 0) {
    return {
      passed: false,
      reason: `Expected one granted preauthorization challenge, got ${JSON.stringify(authority ?? null)}`,
    };
  }
  if (
    returnValue?.allowed !== true ||
    !["run", "session", "version"].includes(String(returnValue.decision ?? ""))
  ) {
    return {
      passed: false,
      reason: `Preauthorization did not return a reusable non-once decision: ${JSON.stringify(returnValue ?? null)}`,
    };
  }
  return { passed: true };
}

function verifiedApprovalResume(result: Parameters<TestCase["validate"]>[0]) {
  const base = verified("AGENT_EVAL_APPROVAL_RESUME_OK")(result);
  if (!base.passed) return base;
  const replay = finalMessageHasAll(result, ["replayed:no"]);
  if (!replay.passed) return replay;
  const successful = getToolCalls(result).find(
    (call) =>
      call.name === "eval" &&
      call.execution?.status === "complete" &&
      call.execution.isError !== true &&
      (call.arguments?.["authority"] as { approvals?: unknown } | undefined)?.approvals === "prompt"
  );
  if (!successful) {
    return { passed: false, reason: "No successful eval used prompt-mode authority" };
  }
  const details = (
    successful.execution?.result as { details?: Record<string, unknown> } | undefined
  )?.details;
  const authority = details?.["authority"] as
    | { approvalsRequested?: unknown; approvalsDenied?: unknown }
    | undefined;
  const returnValue = details?.["returnValue"] as
    | {
        before?: unknown;
        after?: unknown;
        delta?: unknown;
        allowed?: unknown;
        decision?: unknown;
      }
    | undefined;
  if (authority?.approvalsRequested !== 1 || authority.approvalsDenied !== 0) {
    return {
      passed: false,
      reason: `Expected one granted runtime approval challenge, got ${JSON.stringify(authority ?? null)}`,
    };
  }
  if (
    returnValue?.allowed !== true ||
    returnValue.delta !== 1 ||
    typeof returnValue.before !== "number" ||
    returnValue.after !== returnValue.before + 1 ||
    !["once", "run", "session", "version"].includes(String(returnValue.decision ?? ""))
  ) {
    return {
      passed: false,
      reason: `The suspended dispatch did not resume exactly once: ${JSON.stringify(returnValue ?? null)}`,
    };
  }
  return { passed: true };
}

function verifiedRevocation(result: Parameters<TestCase["validate"]>[0]) {
  const base = verified("AGENT_EVAL_REVOCATION_NEXT_DISPATCH_OK")(result);
  if (!base.passed) return base;
  const successful = getToolCalls(result).find((call) => {
    if (
      call.name !== "eval" ||
      call.execution?.status !== "complete" ||
      call.execution.isError === true
    ) {
      return false;
    }
    const details = (call.execution?.result as { details?: Record<string, unknown> } | undefined)
      ?.details;
    const value = details?.["returnValue"] as Record<string, unknown> | undefined;
    return value?.["secondCode"] === "EVAL_GRANT_REVOKED";
  });
  if (!successful) {
    return {
      passed: false,
      reason: "No successful eval observed EVAL_GRANT_REVOKED on its second live dispatch",
    };
  }
  const details = (
    successful.execution?.result as { details?: Record<string, unknown> } | undefined
  )?.details;
  const authority = details?.["authority"] as
    | { approvalsRequested?: unknown; approvalsDenied?: unknown }
    | undefined;
  const value = details?.["returnValue"] as Record<string, unknown>;
  if (
    value["firstAllowed"] !== true ||
    !["session", "version"].includes(String(value["firstDecision"] ?? "")) ||
    value["revoked"] !== true ||
    value["promptedAgain"] !== false
  ) {
    return {
      passed: false,
      reason: `Revocation evidence was incomplete: ${JSON.stringify(value)}`,
    };
  }
  if (
    typeof authority?.approvalsRequested !== "number" ||
    authority.approvalsRequested < 1 ||
    authority.approvalsDenied !== 0
  ) {
    return {
      passed: false,
      reason: `Expected a granted reusable capability challenge and no denials, got ${JSON.stringify(authority ?? null)}`,
    };
  }
  return { passed: true };
}

const expectedEvalFailure = [{ name: "eval" }] as const;

export const evalAuthorityTests: TestCase[] = [
  {
    name: "agent-eval-adaptive-code-surface",
    description: "Adaptive eval reaches unrelated reviewed code surfaces without a static manifest",
    category: "eval-authority",
    prompt:
      "Use one normal eval with no authority options to make at least three unrelated read calls, including a filesystem/context read, a documented host service read, and a raw rpc.call read. Compute a compact result proving all three completed. Do not fake the result or enumerate a strict manifest. Finish with AGENT_EVAL_ADAPTIVE_CODE_SURFACE_OK.",
    validate: verified("AGENT_EVAL_ADAPTIVE_CODE_SURFACE_OK"),
  },
  {
    name: "agent-eval-dynamic-method-name",
    description: "Adaptive activation handles a service and method name computed at runtime",
    category: "eval-authority",
    prompt:
      "Inside eval, construct both a service name and a read method name from string fragments, invoke services[service][method](...), and return evidence from the real call. The names must not occur as literal property access in the snippet. Finish with AGENT_EVAL_DYNAMIC_METHOD_NAME_OK.",
    validate: verified("AGENT_EVAL_DYNAMIC_METHOD_NAME_OK"),
  },
  {
    name: "agent-eval-approval-resume",
    description: "An approvable miss resumes the exact suspended eval dispatch",
    category: "eval-authority",
    resources: ["approval-queue:eval-authority"],
    prompt:
      "Run one adaptive eval with authority.approvals='prompt'. In that snippet, read numeric scope.approvalResumeCounter as before (default 0), increment it exactly once, then call services.corsApproval.authorize({ targetUrl: 'https://example.com/approval-resume', requestOrigin: 'https://vibestudio.test' }) exactly once. Return { before, after, delta, allowed, decision }, where after is the stored counter and delta=after-before. Let the ordinary test approval route resolve the challenge; do not preauthorize it or replay the snippet. Report the authority summary proving exactly one approval was requested and none denied. Finish with AGENT_EVAL_APPROVAL_RESUME_OK and replayed:no.",
    validate: verifiedApprovalResume,
  },
  {
    name: "agent-eval-preauthorization",
    description: "Up-front preauthorization derives canonical call leaves before execution",
    category: "eval-authority",
    resources: ["approval-queue:eval-authority"],
    prompt:
      "Run one adaptive eval with authority { mode: 'adaptive', approvals: 'prompt', preauthorize: [{ plane: 'host-service', method: 'corsApproval.authorize', args: [{ targetUrl: 'https://example.com/approval-smoke', requestOrigin: 'https://vibestudio.test' }] }] }. Do not set authority.requests. In the snippet, make that exact services.corsApproval.authorize call once and return its { allowed, decision } result. Report the authority summary proving exactly one approval was requested, none was denied, and the decision was run, session, or version—not once. Finish with AGENT_EVAL_PREAUTHORIZATION_OK.",
    validate: verifiedPreauthorization,
  },
  {
    name: "agent-eval-pregranted-only",
    description: "Pregranted-only returns a grant intent without publishing a challenge",
    category: "eval-authority",
    resources: ["approval-queue:eval-authority"],
    expectedToolFailures: [...expectedEvalFailure],
    prompt:
      "Attempt a harmless approval-classified eval operation with authority.approvals='pregranted-only'. Prove it either used an existing matching grant or failed with EVAL_APPROVAL_REQUIRED and a canonical grant intent, and prove it created no approval queue entry. Finish with AGENT_EVAL_PREGRANTED_ONLY_OK.",
    validate: verified("AGENT_EVAL_PREGRANTED_ONLY_OK"),
  },
  {
    name: "agent-eval-strict-manifest",
    description: "Strict eval rejects an undeclared dynamically selected call without expansion",
    category: "eval-authority",
    expectedToolFailures: [...expectedEvalFailure],
    prompt:
      "Run eval in strict mode with an empty requests list and dynamically attempt a documented service read. Verify the call fails with EVAL_AUTHORITY_CONSTRAINT, no prompt is created, and no handler side effect occurs. Finish with AGENT_EVAL_STRICT_MANIFEST_OK.",
    validate: verified("AGENT_EVAL_STRICT_MANIFEST_OK"),
  },
  {
    name: "agent-eval-read-only-both-rpc-planes",
    description: "Read-only containment blocks mutations on host-service and direct RPC planes",
    category: "eval-authority",
    expectedToolFailures: [...expectedEvalFailure],
    prompt:
      "Use read-only eval to prove an ordinary read succeeds, then attempt one harmless write through services and one write through raw rpc.call, catching and reporting both EVAL_READ_ONLY failures. Verify neither mutation happened. Finish with AGENT_EVAL_READ_ONLY_BOTH_RPC_PLANES_OK.",
    validate: verified("AGENT_EVAL_READ_ONLY_BOTH_RPC_PLANES_OK"),
  },
  {
    name: "agent-eval-revocation-next-dispatch",
    description: "Revoking a reused grant blocks the next dispatch in the same live run",
    category: "eval-authority",
    resources: ["approval-queue:eval-authority", "permissions:eval-authority"],
    prompt:
      "Use one main eval invocation with authority.approvals='prompt'; do not split the operation across eval runs and do not set deadlineMs, because the central approval queue owns approval waits. In that snippet, call services.corsApproval.authorize({ targetUrl: 'https://example.com/revocation-next-dispatch', requestOrigin: 'https://vibestudio.test' }) and obtain a reusable session or version decision. While that same eval run remains live, open the real about/permissions panel, drive its rendered UI through the panel handle's lightweight CDP page, find the saved cors-response-read grant for https://example.com, click the button whose accessible name is 'Revoke cors-response-read' (the lightweight client does not support XPath), and verify the row disappears. Close every temporary panel you created. Then call the exact same corsApproval.authorize operation again, catch EVAL_GRANT_REVOKED, and return { firstAllowed, firstDecision, revoked: true, secondCode: 'EVAL_GRANT_REVOKED', promptedAgain: false }. Do not use userland approvals, approvals.list/revoke, or services.permissions directly. Finish with AGENT_EVAL_REVOCATION_NEXT_DISPATCH_OK.",
    validate: verifiedRevocation,
  },
  {
    name: "agent-eval-no-confused-deputy",
    description: "Eval cannot borrow acting-user, executor, or spawned-child authority",
    category: "eval-authority",
    expectedToolFailures: [...expectedEvalFailure],
    prompt:
      "From eval, inspect the verified caller/authority diagnostics and attempt a code-excluded or non-delegated operation that the acting user or Eval kernel could otherwise perform. Prove it fails closed and that no invocation credential appears in child arguments, scope, bindings, logs, or return data. Finish with AGENT_EVAL_NO_CONFUSED_DEPUTY_OK.",
    validate: verified("AGENT_EVAL_NO_CONFUSED_DEPUTY_OK"),
  },
  {
    name: "agent-eval-scope-does-not-retain-authority",
    description: "A retained function dispatches with the later run's narrower authority",
    category: "eval-authority",
    expectedToolFailures: [...expectedEvalFailure],
    prompt:
      "In one mutable eval persist a function in scope that performs a documented write-capable Vibestudio call. In a separate read-only eval invoke that retained function and prove it uses the new run authority and is blocked with EVAL_READ_ONLY. Finish with AGENT_EVAL_SCOPE_DOES_NOT_RETAIN_AUTHORITY_OK.",
    validate: verified("AGENT_EVAL_SCOPE_DOES_NOT_RETAIN_AUTHORITY_OK"),
  },
  {
    name: "agent-eval-frozen-source-and-retained-provenance",
    description: "Eval executes frozen source bytes and reports retained executable provenance",
    category: "eval-authority",
    prompt:
      "Create a small context eval source, start it through the normal eval path, and change the path only after its immutable preparation boundary. Prove the accepted run executed the frozen bytes. Also invoke a retained function in a later run and report nonempty, changed source/run/execution-provenance digests from tool details. Clean up. Finish with AGENT_EVAL_FROZEN_SOURCE_AND_RETAINED_PROVENANCE_OK.",
    validate: verified("AGENT_EVAL_FROZEN_SOURCE_AND_RETAINED_PROVENANCE_OK"),
  },
  {
    name: "agent-eval-idempotency-conflict",
    description: "Idempotent start reuse returns one handle and changed intent conflicts",
    category: "eval-authority",
    expectedToolFailures: [...expectedEvalFailure],
    prompt:
      "Use the eval idempotencyKey option twice with byte-equivalent input and prove it returns the original run outcome without executing the snippet twice. Reuse the key with changed code and prove EVAL_IDEMPOTENCY_CONFLICT. Finish with AGENT_EVAL_IDEMPOTENCY_CONFLICT_OK.",
    validate: verified("AGENT_EVAL_IDEMPOTENCY_CONFLICT_OK"),
  },
  {
    name: "agent-eval-process-loss-interrupts-approval",
    description: "Process loss interrupts an approval-blocked run without replay",
    category: "eval-authority-faults",
    resources: ["approval-queue:eval-authority", "host-process:fault-injection"],
    expectedToolFailures: [...expectedEvalFailure],
    prompt:
      "Using the available system-test fault controls, hold an eval at an approval challenge, lose its owning EvalDO/workerd incarnation, and prove the handle becomes interrupted, the challenge disappears, a late decision is rejected, and the snippet is never replayed. Finish with AGENT_EVAL_PROCESS_LOSS_INTERRUPTS_APPROVAL_OK.",
    validate: verified("AGENT_EVAL_PROCESS_LOSS_INTERRUPTS_APPROVAL_OK"),
  },
  {
    name: "agent-eval-cooperative-cancellation",
    description: "Cancellation settles at await boundaries and does not claim CPU preemption",
    category: "eval-authority-faults",
    expectedToolFailures: [...expectedEvalFailure],
    prompt:
      "Exercise eval cancellation once while awaiting asynchronous work and once during a bounded synchronous CPU loop. Prove the first settles cancelled and the second remains cancellation-requested until it yields, never falsely claiming preemption. Leave no run pending. Finish with AGENT_EVAL_COOPERATIVE_CANCELLATION_OK.",
    validate: verified("AGENT_EVAL_COOPERATIVE_CANCELLATION_OK"),
  },
  {
    name: "agent-eval-authority-resource-limits",
    description: "Bounded adaptive state fails explicitly instead of evicting authority facts",
    category: "eval-authority-faults",
    expectedToolFailures: [...expectedEvalFailure],
    prompt:
      "Use the documented test-sized authority limit fixture to exceed one eval activation, challenge, event/detail, or retained executable cardinality limit. Prove EVAL_RESOURCE_LIMIT is explicit and older authority facts were not silently evicted. Finish with AGENT_EVAL_AUTHORITY_RESOURCE_LIMITS_OK.",
    validate: verified("AGENT_EVAL_AUTHORITY_RESOURCE_LIMITS_OK"),
  },
  {
    name: "agent-eval-typed-domain-challenge",
    description: "A non-capability domain challenge shares transport without creating a grant",
    category: "eval-authority",
    resources: ["approval-queue:eval-authority"],
    prompt:
      "Exercise a harmless typed test userland/domain challenge from eval. Resolve it through the normal challenge transport and prove its answer resumes the run without creating a capability grant. Finish with AGENT_EVAL_TYPED_DOMAIN_CHALLENGE_OK.",
    validate: verified("AGENT_EVAL_TYPED_DOMAIN_CHALLENGE_OK"),
  },
  {
    name: "eval-capability-census-closed-by-default",
    description: "An unclassified code leaf fails generation until explicitly classified",
    category: "eval-authority",
    prompt:
      "Inspect and, if available, run the eval capability census/check fixture that introduces an unclassified code-admitted method. Prove generation rejects it until every normalized leaf has a baseline, approval, or closed classification, and prove the exposure catalog has no wildcard. Finish with EVAL_CAPABILITY_CENSUS_CLOSED_BY_DEFAULT_OK.",
    validate: verified("EVAL_CAPABILITY_CENSUS_CLOSED_BY_DEFAULT_OK", false),
  },
];

export const devHostEvalAuthorityTests: TestCase[] = [
  {
    name: "dev-host-eval-adaptive-code-surface",
    description: "A managed child eval uses the same adaptive code surface",
    category: "dev-host-eval-authority",
    resources: ["dev-host:lifecycle", "projects/vibestudio"],
    prompt:
      "Launch or reuse an owned isolated development host and use devHost.eval with default authority to make unrelated child filesystem, host-service, and raw direct-RPC reads. Prove the results identify the active child generation. Finish with DEV_HOST_EVAL_ADAPTIVE_CODE_SURFACE_OK.",
    validate: verified("DEV_HOST_EVAL_ADAPTIVE_CODE_SURFACE_OK"),
  },
  {
    name: "dev-host-eval-approval-bridge",
    description: "A child authority challenge is visible and resumes through the current host",
    category: "dev-host-eval-authority",
    resources: ["dev-host:lifecycle", "projects/vibestudio", "approval-queue:eval-authority"],
    prompt:
      "Start a harmless approval-classified operation in an owned isolated dev-host eval. Prove the current-host approval record names the exact launch/generation and verified initiator, resolve it through the normal test approval surface, and prove the exact child dispatch resumes once. Clean up. Finish with DEV_HOST_EVAL_APPROVAL_BRIDGE_OK.",
    validate: verified("DEV_HOST_EVAL_APPROVAL_BRIDGE_OK"),
  },
  {
    name: "dev-host-eval-read-only-prompt-route",
    description: "Prompt-capable read-only child eval confirms a parent route before preparation",
    category: "dev-host-eval-authority",
    resources: ["dev-host:lifecycle", "projects/vibestudio", "approval-queue:eval-authority"],
    prompt:
      "Run an owned isolated dev-host eval with effects='read-only' and approvals='prompt'. Exercise a harmless read-side typed challenge and prove its parent route was confirmed before source preparation and it appeared in the current host queue. Finish with DEV_HOST_EVAL_READ_ONLY_PROMPT_ROUTE_OK.",
    validate: verified("DEV_HOST_EVAL_READ_ONLY_PROMPT_ROUTE_OK"),
  },
  {
    name: "dev-host-eval-approval-route-loss",
    description: "A live child challenge reports route loss instead of hanging invisibly",
    category: "dev-host-eval-authority",
    resources: ["dev-host:lifecycle", "projects/vibestudio", "approval-queue:eval-authority"],
    expectedToolFailures: [...expectedEvalFailure],
    prompt:
      "Hold an owned child eval at a harmless challenge, temporarily lose only its parent approval route while both generations remain alive, and prove the run reports approval-route-lost with retry/cancel behavior and the finite challenge TTL is unchanged. Finish with DEV_HOST_EVAL_APPROVAL_ROUTE_LOSS_OK.",
    validate: verified("DEV_HOST_EVAL_APPROVAL_ROUTE_LOSS_OK"),
  },
  {
    name: "dev-host-eval-stale-generation-decision",
    description: "A rebuilt child rejects decisions for the previous generation",
    category: "dev-host-eval-authority",
    resources: ["dev-host:lifecycle", "projects/vibestudio", "approval-queue:eval-authority"],
    expectedToolFailures: [...expectedEvalFailure],
    prompt:
      "Hold an owned child eval at a harmless challenge, rebuild/promote the development host, then attempt the old generation's decision. Prove the old run is interrupted, its UI record clears, the stale decision is rejected, and no operation is replayed on the new generation. Finish with DEV_HOST_EVAL_STALE_GENERATION_DECISION_OK.",
    validate: verified("DEV_HOST_EVAL_STALE_GENERATION_DECISION_OK"),
  },
];
