import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createVerifiedCaller,
  type AuthorityChallengePresentation,
} from "@vibestudio/shared/serviceDispatcher";
import { CapabilityGrantStore, capabilityGrantId } from "./capabilityGrantStore.js";
import { authorizeVerifiedCaller } from "./authorityRuntime.js";
import {
  EvalInvocationCoordinator,
  type RootAuthorityResolver,
} from "./evalInvocationCoordinator.js";

const DIGEST = "a".repeat(64);
const OBJECT_KEY = "eval-object";
const READ = "service:fs.readFile";
const WRITE = "service:fs.writeFile";
const APPROVAL = "external-browser-open";
const CONTEXT_BOUNDARY = "context.boundary";
const SUBSCRIBE_CHANNEL = "rpc:subscribeChannel";

function caller(capabilities = [READ, WRITE, APPROVAL], repoPath = "workers/agent-worker") {
  return createVerifiedCaller(
    `do:${repoPath}:Agent:one`,
    "do",
    {
      callerId: `do:${repoPath}:Agent:one`,
      callerKind: "do",
      repoPath,
      executionDigest: DIGEST,
      requested: [{ capability: "service:eval.start", resource: { kind: "prefix", prefix: "" } }],
      delegations: [
        {
          audience: "eval",
          purpose: "agentic-code-execution",
          capabilities: capabilities.map((capability) => ({
            capability,
            resource: { kind: "prefix" as const, prefix: "" },
          })),
        },
      ],
    },
    null,
    { userId: "user-1", handle: "user-1" }
  );
}

function interactiveCaller() {
  return createVerifiedCaller("shell:interactive", "shell", null, null, {
    userId: "user-1",
    handle: "user-1",
  });
}

function evalTransportCaller() {
  return createVerifiedCaller(
    `do:product/eval:EvalDO:${OBJECT_KEY}`,
    "do",
    {
      callerId: `do:product/eval:EvalDO:${OBJECT_KEY}`,
      callerKind: "do",
      repoPath: "product/eval",
      executionDigest: "c".repeat(64),
      requested: [],
      delegations: [],
    },
    null,
    { userId: "user-1", handle: "user-1" }
  );
}

function harness(
  input: {
    decision?: "once" | "run" | "session" | "version" | "deny" | "dismiss";
    requestCapability?: (request: unknown) => Promise<never>;
    now?: () => number;
    onChallenge?: ConstructorParameters<typeof EvalInvocationCoordinator>[0]["onChallenge"];
  } = {}
) {
  const grantStore = new CapabilityGrantStore({
    statePath: mkdtempSync(join(tmpdir(), "eval-authority-")),
  });
  const requestCapability = vi.fn(
    input.requestCapability ?? (async (_request: unknown) => input.decision ?? "run")
  );
  const approvalQueue = { requestCapability } as never;
  const coordinator = new EvalInvocationCoordinator({
    approvalQueue,
    grantStore,
    ...(input.now ? { now: input.now } : {}),
    ...(input.onChallenge ? { onChallenge: input.onChallenge } : {}),
  });
  return { coordinator, grantStore, requestCapability };
}

function start(
  coordinator: EvalInvocationCoordinator,
  input: {
    initiator?: ReturnType<typeof caller>;
    authority?: {
      mode?: "adaptive" | "strict";
      effects?: "read-only" | "mutable";
      approvals?: "prompt" | "pregranted-only";
      requests?: Array<{ capability: string; resource: { kind: "prefix"; prefix: string } }>;
    };
    maxEndsAt?: number | null;
  } = {}
) {
  coordinator.issuePreparation({
    runId: "run-1",
    startIntentDigest: "b".repeat(64),
    objectKey: OBJECT_KEY,
    contextId: "ctx-eval",
    executor: `code:product/eval@${"c".repeat(64)}`,
    initiator: input.initiator ?? caller(),
    authority: input.authority,
    maxEndsAt: input.maxEndsAt ?? null,
  });
  return coordinator.finalize({
    runId: "run-1",
    startIntentDigest: "b".repeat(64),
    sourceDigest: "d".repeat(64),
    executionProvenanceDigest: "e".repeat(64),
    scopeInputRevision: "scope-1",
  });
}

function root(grantStore: CapabilityGrantStore) {
  return (input: {
    caller: ReturnType<typeof caller>;
    capability: string;
    resourceKey: string;
    audience: string;
    sessionId: string;
  }) =>
    authorizeVerifiedCaller(input.caller, {
      workspaceId: "workspace-1",
      workspaceMember: true,
      sessionId: input.sessionId,
      audience: input.audience,
      capability: input.capability,
      resourceKey: input.resourceKey,
      grantStore,
    });
}

async function resolve(
  coordinator: EvalInvocationCoordinator,
  grantStore: CapabilityGrantStore,
  lease: ReturnType<typeof start>,
  input: {
    capability?: string;
    sensitivity?: "read" | "write" | "admin" | "destructive";
    acquisition?:
      | { kind: "baseline" }
      | {
          kind: "approval";
          title: string;
          description: string;
          operation: { kind: string; verb: string };
          grantScopes: readonly ("run" | "session" | "version")[];
        };
    preauthorization?: boolean;
    challenge?: AuthorityChallengePresentation;
    resourceKey?: string;
    root?: RootAuthorityResolver;
  } = {}
) {
  const capability = input.capability ?? READ;
  return coordinator.resolve({
    runId: lease.runId,
    credential: lease.credential,
    objectKey: OBJECT_KEY,
    capability,
    resourceKey: input.resourceKey ?? "workspace-1/path",
    sensitivity: input.sensitivity ?? "read",
    acquisition: input.acquisition ?? { kind: "baseline" },
    ...(input.challenge ? { challenge: input.challenge } : {}),
    audience: "service:test",
    root: input.root ?? root(grantStore),
    ...(!input.preauthorization ? { transportCaller: evalTransportCaller() } : {}),
    ...(input.preauthorization ? { preauthorization: true } : {}),
  });
}

const approvalAcquisition = {
  kind: "approval" as const,
  title: "Open external browser",
  description: "Allow this exact external open.",
  operation: { kind: "browser", verb: "Open external browser" },
  grantScopes: ["run", "session", "version"] as const,
};

describe("EvalInvocationCoordinator", () => {
  it("activates an adaptive baseline leaf inside the verified delegation", async () => {
    const h = harness();
    const lease = start(h.coordinator);
    const resolved = await resolve(h.coordinator, h.grantStore, lease);
    expect(resolved.contextId).toBe("ctx-eval");
    expect(resolved.context.authorizingOrigin).toEqual({
      kind: "code",
      principal: lease.invocationPrincipal,
    });
    expect(resolved.context.codeAuthority.initiator?.principal).toBe(
      `code:workers/agent-worker@${DIGEST}`
    );
    expect(resolved.grants).toEqual(
      expect.arrayContaining([expect.objectContaining({ capability: READ, effect: "allow" })])
    );
    expect(h.requestCapability).not.toHaveBeenCalled();
  });

  it("applies the reviewed baseline policy to an authenticated interactive eval sponsor", async () => {
    const h = harness();
    const lease = start(h.coordinator, { initiator: interactiveCaller() });
    await resolve(h.coordinator, h.grantStore, lease, {
      capability: SUBSCRIBE_CHANNEL,
      sensitivity: "write",
    });
    expect(h.requestCapability).not.toHaveBeenCalled();
    expect(h.coordinator.authoritySummary(lease.runId)?.activated).toContainEqual(
      expect.objectContaining({ capability: SUBSCRIBE_CHANNEL })
    );
  });

  it("honors a target-specific refusal to sponsor evaluated code", async () => {
    const h = harness();
    const lease = start(h.coordinator, { initiator: interactiveCaller() });
    const ordinaryRoot = root(h.grantStore);

    await expect(
      resolve(h.coordinator, h.grantStore, lease, {
        root: (input) => ({
          ...ordinaryRoot(input),
          evalSponsorshipAllowed: false,
        }),
      })
    ).rejects.toMatchObject({ code: "EVAL_CAPABILITY_CLOSED" });
    expect(h.requestCapability).not.toHaveBeenCalled();
  });

  it("reuses an interactive sponsor's persisted approval on the next dispatch", async () => {
    const h = harness({ decision: "session" });
    const lease = start(h.coordinator, { initiator: interactiveCaller() });
    await resolve(h.coordinator, h.grantStore, lease, {
      capability: APPROVAL,
      acquisition: approvalAcquisition,
    });
    await resolve(h.coordinator, h.grantStore, lease, {
      capability: APPROVAL,
      acquisition: approvalAcquisition,
    });
    expect(h.requestCapability).toHaveBeenCalledTimes(1);
  });

  it("fails a strict manifest miss without prompting or expanding", async () => {
    const h = harness();
    const lease = start(h.coordinator, {
      authority: {
        mode: "strict",
        requests: [{ capability: READ, resource: { kind: "prefix", prefix: "" } }],
      },
    });
    await expect(
      resolve(h.coordinator, h.grantStore, lease, {
        capability: WRITE,
        sensitivity: "write",
      })
    ).rejects.toMatchObject({ code: "EVAL_AUTHORITY_CONSTRAINT" });
    expect(h.requestCapability).not.toHaveBeenCalled();
  });

  it("keeps strict run requests separate from preparation activations", async () => {
    const h = harness();
    const preparation = h.coordinator.issuePreparation({
      runId: "run-1",
      startIntentDigest: "b".repeat(64),
      objectKey: OBJECT_KEY,
      contextId: "ctx-eval",
      executor: `code:product/eval@${"c".repeat(64)}`,
      initiator: caller(),
      authority: { mode: "strict", requests: [] },
      maxEndsAt: null,
    });
    const prepared = await h.coordinator.resolve({
      runId: preparation.runId,
      credential: preparation.credential,
      objectKey: OBJECT_KEY,
      capability: READ,
      resourceKey: "workspace-1/source.ts",
      sensitivity: "read",
      acquisition: { kind: "baseline" },
      audience: "service:fs",
      root: root(h.grantStore),
      transportCaller: evalTransportCaller(),
    });
    expect(prepared.context.codeAuthority.execution).toMatchObject({
      phase: "preparation",
      requested: [{ capability: READ, resource: { kind: "exact", key: "workspace-1/source.ts" } }],
    });

    const run = h.coordinator.finalize({
      runId: "run-1",
      startIntentDigest: "b".repeat(64),
      sourceDigest: "d".repeat(64),
      executionProvenanceDigest: "e".repeat(64),
      scopeInputRevision: "scope-1",
    });
    expect(h.coordinator.authoritySummary(run.runId)?.activated).toEqual([]);
    await expect(resolve(h.coordinator, h.grantStore, run)).rejects.toMatchObject({
      code: "EVAL_AUTHORITY_CONSTRAINT",
    });
  });

  it("does not turn a baseline delegation request into a grant", async () => {
    const h = harness();
    const lease = start(h.coordinator, {
      initiator: caller([READ], "workers/unseeded-agent"),
    });
    await expect(resolve(h.coordinator, h.grantStore, lease)).rejects.toMatchObject({
      code: "EVAL_APPROVAL_REQUIRED",
    });
    expect(h.requestCapability).not.toHaveBeenCalled();
  });

  it("blocks a write in read-only mode before approval", async () => {
    const h = harness();
    const lease = start(h.coordinator, { authority: { effects: "read-only" } });
    await expect(
      resolve(h.coordinator, h.grantStore, lease, {
        capability: WRITE,
        sensitivity: "write",
      })
    ).rejects.toMatchObject({ code: "EVAL_READ_ONLY" });
    expect(h.requestCapability).not.toHaveBeenCalled();
  });

  it("preauthorizes a run permit without offering an exact-dispatch once choice", async () => {
    const h = harness({ decision: "run" });
    const lease = start(h.coordinator);
    const preauthorized = await resolve(h.coordinator, h.grantStore, lease, {
      capability: APPROVAL,
      acquisition: approvalAcquisition,
      preauthorization: true,
    });
    expect(preauthorized.decision).toBe("run");
    expect(h.requestCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedDecisions: ["run", "session", "version", "deny", "dismiss"],
      })
    );
    const dispatched = await resolve(h.coordinator, h.grantStore, lease, {
      capability: APPROVAL,
      acquisition: approvalAcquisition,
    });
    expect(dispatched.decision).toBe("run");
    expect(h.requestCapability).toHaveBeenCalledTimes(1);
  });

  it("uses distinct approval operation groups for distinct exact resources", async () => {
    const h = harness({ decision: "once" });
    const lease = start(h.coordinator);
    await resolve(h.coordinator, h.grantStore, lease, {
      capability: APPROVAL,
      acquisition: approvalAcquisition,
      resourceKey: "https://safe.example",
    });
    await resolve(h.coordinator, h.grantStore, lease, {
      capability: APPROVAL,
      acquisition: approvalAcquisition,
      resourceKey: "https://other.example",
    });

    const requests = h.requestCapability.mock.calls.map(
      ([request]) => request as { operation?: { groupKey?: string } }
    );
    const firstGroup = requests[0]?.operation?.groupKey;
    const secondGroup = requests[1]?.operation?.groupKey;
    expect(firstGroup).toBeTruthy();
    expect(secondGroup).toBeTruthy();
    expect(firstGroup).not.toBe(secondGroup);
  });

  it("reuses a session grant across distinct dispatches in the same initiator session", async () => {
    const h = harness({ decision: "session" });
    const lease = start(h.coordinator);
    await resolve(h.coordinator, h.grantStore, lease, {
      capability: APPROVAL,
      acquisition: approvalAcquisition,
    });
    await resolve(h.coordinator, h.grantStore, lease, {
      capability: APPROVAL,
      acquisition: approvalAcquisition,
    });
    expect(h.requestCapability).toHaveBeenCalledTimes(1);
    expect(h.coordinator.authoritySummary(lease.runId)?.approvalsReused).toBe(1);
  });

  it("observes grant revocation on the next dispatch without silently re-prompting", async () => {
    const h = harness({ decision: "session" });
    const lease = start(h.coordinator);
    await resolve(h.coordinator, h.grantStore, lease, {
      capability: APPROVAL,
      acquisition: approvalAcquisition,
    });
    const grant = h.grantStore.listSession()[0]!;
    expect(h.grantStore.revokeSession(capabilityGrantId(grant))).toBe(true);

    await expect(
      resolve(h.coordinator, h.grantStore, lease, {
        capability: APPROVAL,
        acquisition: approvalAcquisition,
      })
    ).rejects.toMatchObject({ code: "EVAL_GRANT_REVOKED" });
    expect(h.requestCapability).toHaveBeenCalledTimes(1);
  });

  it("records denial for the run but lets dismissal be challenged again", async () => {
    const denied = harness({ decision: "deny" });
    const deniedLease = start(denied.coordinator);
    await expect(
      resolve(denied.coordinator, denied.grantStore, deniedLease, {
        capability: APPROVAL,
        acquisition: approvalAcquisition,
      })
    ).rejects.toMatchObject({ code: "EVAL_APPROVAL_DENIED" });
    await expect(
      resolve(denied.coordinator, denied.grantStore, deniedLease, {
        capability: APPROVAL,
        acquisition: approvalAcquisition,
      })
    ).rejects.toMatchObject({ code: "EVAL_APPROVAL_DENIED" });
    expect(denied.requestCapability).toHaveBeenCalledTimes(1);

    const dismissed = harness({ decision: "dismiss" });
    const dismissedLease = start(dismissed.coordinator);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        resolve(dismissed.coordinator, dismissed.grantStore, dismissedLease, {
          capability: APPROVAL,
          acquisition: approvalAcquisition,
        })
      ).rejects.toMatchObject({ code: "EVAL_APPROVAL_REQUIRED" });
    }
    expect(dismissed.requestCapability).toHaveBeenCalledTimes(2);
  });

  it("reports an expired challenge without installing a run-local denial", async () => {
    const expired = Object.assign(new Error("Approval deadline expired"), {
      code: "APPROVAL_EXPIRED",
    });
    const h = harness({
      requestCapability: async () => {
        throw expired;
      },
    });
    const lease = start(h.coordinator);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        resolve(h.coordinator, h.grantStore, lease, {
          capability: APPROVAL,
          acquisition: approvalAcquisition,
        })
      ).rejects.toMatchObject({ code: "EVAL_CHALLENGE_EXPIRED" });
    }
    expect(h.requestCapability).toHaveBeenCalledTimes(2);
  });

  it("publishes and clears the exact live challenge boundary around the suspended dispatch", async () => {
    const onChallenge = vi.fn(
      async (
        _event: Parameters<
          NonNullable<ConstructorParameters<typeof EvalInvocationCoordinator>[0]["onChallenge"]>
        >[0]
      ) => undefined
    );
    const h = harness({ decision: "once", onChallenge });
    const lease = start(h.coordinator);
    await resolve(h.coordinator, h.grantStore, lease, {
      capability: APPROVAL,
      acquisition: approvalAcquisition,
    });
    expect(onChallenge.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({
        runId: "run-1",
        objectKey: OBJECT_KEY,
        waiting: true,
        phase: "run",
      }),
      expect.objectContaining({
        runId: "run-1",
        objectKey: OBJECT_KEY,
        waiting: false,
        phase: "run",
      }),
    ]);
  });

  it("activates a dynamically prepared capability with exact review copy and initiator authority", async () => {
    const h = harness({ decision: "once" });
    const lease = start(h.coordinator, {
      initiator: caller([READ, WRITE, APPROVAL, CONTEXT_BOUNDARY]),
    });
    const resolved = await resolve(h.coordinator, h.grantStore, lease, {
      capability: CONTEXT_BOUNDARY,
      sensitivity: "write",
      acquisition: {
        kind: "approval",
        title: "Use another runtime context",
        description: "Review cross-context access.",
        operation: { kind: "runtime", verb: "Use existing context" },
        grantScopes: ["run", "session", "version"],
      },
      challenge: {
        title: "Open panel with different file access",
        description: "The exact destination belongs to another panel.",
        deniedReason: "Cross-context open denied",
        dedupKey: "context-boundary:panel:one:ctx-foreign",
        resource: { type: "context", label: "File context", value: "ctx-foreign" },
        operation: {
          kind: "panel",
          verb: "Open panel in",
          object: { type: "context", label: "File context", value: "ctx-foreign" },
        },
        details: [{ label: "File context", value: "ctx-foreign" }],
      },
    });

    expect(resolved.decision).toBe("once");
    expect(resolved.authorizingCaller.runtime.id).toBe("do:workers/agent-worker:Agent:one");
    expect(resolved.effectiveCaller).toMatchObject({
      runtime: { id: `do:product/eval:EvalDO:${OBJECT_KEY}`, kind: "do" },
      code: {
        repoPath: "eval/run-1",
        executionDigest: lease.runDigest,
      },
      subject: { userId: "user-1" },
    });
    expect(h.requestCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: CONTEXT_BOUNDARY,
        title: "Open panel with different file access",
        resource: expect.objectContaining({ value: "ctx-foreign" }),
        dedupKey: "run-1:context-boundary:panel:one:ctx-foreign",
        operation: expect.objectContaining({ verb: "Open panel in" }),
        details: [{ label: "File context", value: "ctx-foreign" }],
        allowedDecisions: ["once", "run", "session", "version", "deny", "dismiss"],
      })
    );
    expect(
      (h.requestCapability.mock.calls[0]?.[0] as { operation: { groupKey: string } }).operation
        .groupKey
    ).toMatch(/^run-1:/u);
  });

  it("honors one-shot policy for a destructive prepared operation", async () => {
    const h = harness({ decision: "once" });
    const lease = start(h.coordinator, {
      initiator: caller([READ, WRITE, APPROVAL, CONTEXT_BOUNDARY]),
    });
    await resolve(h.coordinator, h.grantStore, lease, {
      capability: CONTEXT_BOUNDARY,
      sensitivity: "write",
      acquisition: {
        kind: "approval",
        title: "Use another runtime context",
        description: "Review destructive cross-context access.",
        operation: { kind: "runtime", verb: "Destroy context" },
        grantScopes: ["run", "session", "version"],
      },
      challenge: {
        title: "Destroy existing context",
        deniedReason: "Context destruction denied",
        severity: "severe",
        resource: { type: "context", label: "File context", value: "ctx-foreign" },
        operation: {
          kind: "runtime",
          verb: "Destroy context",
          object: { type: "context", label: "File context", value: "ctx-foreign" },
        },
        allowedDecisions: ["once", "deny", "dismiss"],
      },
    });

    expect(h.requestCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "severe",
        allowedDecisions: ["once", "deny", "dismiss"],
      })
    );
  });

  it("rejects wrong-object, expired, and invalidated credentials and renews a live lease", () => {
    let now = 1_000;
    const h = harness({ now: () => now });
    const lease = start(h.coordinator, { maxEndsAt: 40_000 });
    expect(() =>
      h.coordinator.renew({ runId: lease.runId, credential: lease.credential, objectKey: "wrong" })
    ).toThrow(expect.objectContaining({ code: "EVAL_INVOCATION_INVALID" }));
    expect(
      h.coordinator.renew({
        runId: lease.runId,
        credential: lease.credential,
        objectKey: OBJECT_KEY,
      })
    ).toEqual({ expiresAt: 31_000 });
    now = 31_000;
    expect(() =>
      h.coordinator.renew({
        runId: lease.runId,
        credential: lease.credential,
        objectKey: OBJECT_KEY,
      })
    ).toThrow(expect.objectContaining({ code: "EVAL_INVOCATION_EXPIRED" }));
    h.coordinator.invalidate(lease.runId, OBJECT_KEY);
    expect(() =>
      h.coordinator.renew({
        runId: lease.runId,
        credential: lease.credential,
        objectKey: OBJECT_KEY,
      })
    ).toThrow(expect.objectContaining({ code: "EVAL_INVOCATION_INVALID" }));
  });

  it("does not invalidate a lease when a different owner presents its run id", () => {
    const h = harness();
    const lease = start(h.coordinator);

    h.coordinator.invalidate(lease.runId, "different-eval-object");
    expect(
      h.coordinator.renew({
        runId: lease.runId,
        credential: lease.credential,
        objectKey: OBJECT_KEY,
      })
    ).toEqual(expect.objectContaining({ expiresAt: expect.any(Number) }));

    h.coordinator.invalidate(lease.runId, OBJECT_KEY);
    expect(() =>
      h.coordinator.renew({
        runId: lease.runId,
        credential: lease.credential,
        objectKey: OBJECT_KEY,
      })
    ).toThrow(expect.objectContaining({ code: "EVAL_INVOCATION_INVALID" }));
  });

  it("rotates an elapsed run into bounded cleanup without permitting new approval prompts", async () => {
    let now = 1_000;
    const h = harness({ now: () => now });
    const lease = start(h.coordinator, { maxEndsAt: 2_000 });
    now = 2_001;

    expect(
      h.coordinator.beginCleanup({
        runId: lease.runId,
        credential: lease.credential,
        objectKey: OBJECT_KEY,
      })
    ).toEqual({ expiresAt: 32_001 });
    await expect(resolve(h.coordinator, h.grantStore, lease)).resolves.toMatchObject({
      contextId: "ctx-eval",
    });
    await expect(
      resolve(h.coordinator, h.grantStore, lease, {
        capability: APPROVAL,
        acquisition: approvalAcquisition,
      })
    ).rejects.toMatchObject({ code: "EVAL_APPROVAL_REQUIRED" });
    expect(h.requestCapability).not.toHaveBeenCalled();

    now = 32_001;
    expect(() =>
      h.coordinator.renew({
        runId: lease.runId,
        credential: lease.credential,
        objectKey: OBJECT_KEY,
      })
    ).toThrow(expect.objectContaining({ code: "EVAL_INVOCATION_EXPIRED" }));
  });

  it("bounds authority resource identity before activation or challenge allocation", async () => {
    const h = harness();
    const lease = start(h.coordinator);
    await expect(
      h.coordinator.resolve({
        runId: lease.runId,
        credential: lease.credential,
        objectKey: OBJECT_KEY,
        capability: READ,
        resourceKey: "x".repeat(16 * 1024 + 1),
        sensitivity: "read",
        acquisition: { kind: "baseline" },
        audience: "service:test",
        root: root(h.grantStore),
        transportCaller: evalTransportCaller(),
      })
    ).rejects.toMatchObject({ code: "EVAL_RESOURCE_LIMIT" });
    expect(h.coordinator.authoritySummary(lease.runId)?.activated).toEqual([]);
  });
});
