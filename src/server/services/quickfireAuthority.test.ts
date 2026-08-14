/**
 * Adversarial coverage for the quickfire authority design (spec §6, P4 exit).
 *
 * The interesting claims are all about *scope*: a grant minted for one panel
 * context must not reach another; it must keep working when the requester
 * entity is re-minted; and it must stop working the moment the conversation
 * ends or the user revokes it in Permissions. Each of those is asserted against
 * the real grant store and the real authorization evaluator rather than a mock,
 * because the failure mode being guarded is "the evaluator disagrees with what
 * we thought we minted".
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateAuthority,
  requirementForPrincipals,
  type AuthorizationContext,
} from "@vibestudio/shared/authorization";
import type { AuthorityGrantSubject } from "@vibestudio/rpc";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { CONTEXT_BOUNDARY_CAPABILITY, contextBoundaryResourceKey } from "./contextBoundary.js";
import {
  QUICKFIRE_DECISION_SURFACE,
  buildQuickfireClosureBody,
  createQuickfireAuthorityBinder,
  mintQuickfireBindingGrants,
  quickfireBindingSeverity,
  quickfireBoundaryResource,
  quickfireClosureSubject,
  revokeQuickfireBindingGrants,
} from "./quickfireAuthority.js";

const CLOSURE_DIGEST = "d".repeat(64);
const SUBJECT = quickfireClosureSubject(CLOSURE_DIGEST);
const CHANNEL = "quickfire-abc123";
const BOUND_CONTEXT = "ctx-sales-dashboard";

function store(label: string): CapabilityGrantStore {
  return new CapabilityGrantStore({
    statePath: mkdtempSync(join(tmpdir(), `quickfire-authority-${label}-`)),
  });
}

/**
 * The authorization context a bound quickfire vessel presents.
 *
 * The origin is a *session*: an agent vessel carries an execution session, and
 * `subjectsForOrigin` only unions the reviewed-closure subject in for a session
 * origin. That is precisely what puts `mission:quickfire@<digest>` in front of
 * the evaluator, and it is why an unbound session (no closure fact) sees
 * nothing at all.
 */
function boundContext(
  overrides: {
    sessionId?: string;
    subject?: AuthorityGrantSubject | null;
    contextIntegrity?: AuthorizationContext["contextIntegrity"];
  } = {}
): AuthorizationContext {
  const sessionId = overrides.sessionId ?? CHANNEL;
  const subject = overrides.subject === undefined ? SUBJECT : overrides.subject;
  return {
    authorizingOrigin: { kind: "session", principal: `session:${sessionId}` },
    executingCode: {
      principal: "code:workers/agent-worker@ev-1",
      requested: [
        { capability: "context.boundary", resource: { kind: "prefix", prefix: "context" } },
      ],
      sourceLineage: { class: "unknown", externalKeys: [] },
    },
    actingUser: "user:alice",
    workspace: { workspaceId: "ws-1", member: true, role: null, revision: "live" },
    session: {
      id: sessionId,
      audience: "service:panelCdp",
      version: "1.0.0",
      expiresAt: Number.MAX_SAFE_INTEGER,
      ...(subject ? { reviewedClosure: { subject, closureDigest: CLOSURE_DIGEST } } : {}),
    },
    contextIntegrity: overrides.contextIntegrity ?? {
      class: "not-applicable",
      latchEpoch: 0,
      externalKeys: [],
    },
  } as unknown as AuthorizationContext;
}

function boundaryAllows(
  grants: CapabilityGrantStore,
  context: AuthorizationContext,
  targetContextId: string,
  requesterEntityId: string
): boolean {
  const resourceKey = contextBoundaryResourceKey(targetContextId, requesterEntityId);
  return evaluateAuthority({
    context,
    // The exact requirement `panelCdp`'s prepared boundary leaf uses.
    requirement: requirementForPrincipals(["code", "user", "host"], CONTEXT_BOUNDARY_CAPABILITY),
    resourceKey,
    grants: grants.grantsForSubjects([SUBJECT], CONTEXT_BOUNDARY_CAPABILITY),
  }).allowed;
}

describe("quickfire binding grants", () => {
  it("mints a session-scoped pair on the mission subject", () => {
    const grants = store("mint");
    const minted = mintQuickfireBindingGrants({
      grantStore: grants,
      subject: SUBJECT,
      channelId: CHANNEL,
      targetContextId: BOUND_CONTEXT,
      decidedBy: "user:alice",
    });

    expect(minted.map((grant) => grant.capability).sort()).toEqual([
      "context.boundary",
      "panel.inspect",
    ]);
    for (const grant of minted) {
      expect(grant.subject).toBe(SUBJECT);
      // The store would otherwise infer "mission" from the subject. These are
      // not standing mission authority — they belong to one conversation.
      expect(grant.scope).toBe("session");
      expect(grant.decisionSurface).toBe(QUICKFIRE_DECISION_SURFACE);
      expect(grant.constraints?.sessionId).toBe(CHANNEL);
      expect(grant.expiresAt).toBeUndefined();
    }
    grants.close();
  });

  it("allows the bound context and denies a different one", () => {
    const grants = store("scope");
    mintQuickfireBindingGrants({
      grantStore: grants,
      subject: SUBJECT,
      channelId: CHANNEL,
      targetContextId: BOUND_CONTEXT,
      decidedBy: "user:alice",
    });
    const context = boundContext();

    expect(boundaryAllows(grants, context, BOUND_CONTEXT, "do:quickfire:v1")).toBe(true);
    // The whole point of naming the target context: another panel's branch is
    // not covered, however the requester is named.
    expect(boundaryAllows(grants, context, "ctx-permissions", "do:quickfire:v1")).toBe(false);
    grants.close();
  });

  it("keeps covering a re-minted requester entity (prefix scope)", () => {
    const grants = store("requester");
    mintQuickfireBindingGrants({
      grantStore: grants,
      subject: SUBJECT,
      channelId: CHANNEL,
      targetContextId: BOUND_CONTEXT,
      decidedBy: "user:alice",
    });
    const context = boundContext();

    // Clearing and re-asking on the same slot builds a brand new vessel. The
    // requester half of the key is therefore volatile; the target half is not.
    for (const requester of [
      "do:workers/agent-worker:QuickfireAgentWorker:quickfire-slot-a-1111",
      "do:workers/agent-worker:QuickfireAgentWorker:quickfire-slot-a-2222",
      "do:workers/agent-worker:QuickfireAgentWorker:quickfire-slot-a-3333",
    ]) {
      expect(boundaryAllows(grants, context, BOUND_CONTEXT, requester)).toBe(true);
    }
    grants.close();
  });

  it("does not leak across contexts through a prefix collision", () => {
    const grants = store("collision");
    mintQuickfireBindingGrants({
      grantStore: grants,
      subject: SUBJECT,
      channelId: CHANNEL,
      targetContextId: "ctx-a",
      decidedBy: "user:alice",
    });
    const context = boundContext();

    // `ctx-a` must not cover `ctx-abc`: the resource key encodes the context and
    // the scope stops at the requester separator.
    expect(boundaryAllows(grants, context, "ctx-a", "do:v1")).toBe(true);
    expect(boundaryAllows(grants, context, "ctx-abc", "do:v1")).toBe(false);
    expect(quickfireBoundaryResource("ctx-a")).toEqual({
      kind: "prefix",
      prefix: "context/ctx-a/requester/",
    });
    grants.close();
  });

  it("stops working for another conversation's session", () => {
    const grants = store("session");
    mintQuickfireBindingGrants({
      grantStore: grants,
      subject: SUBJECT,
      channelId: CHANNEL,
      targetContextId: BOUND_CONTEXT,
      decidedBy: "user:alice",
    });

    // Same mission subject, different conversation. The session constraint is
    // what keeps one panel's conversation from borrowing another's reach.
    const other = boundContext({ sessionId: "quickfire-other" });
    expect(boundaryAllows(grants, other, BOUND_CONTEXT, "do:v1")).toBe(false);
    grants.close();
  });

  it("is invisible to a session with no reviewed-closure fact", () => {
    const grants = store("unbound");
    mintQuickfireBindingGrants({
      grantStore: grants,
      subject: SUBJECT,
      channelId: CHANNEL,
      targetContextId: BOUND_CONTEXT,
      decidedBy: "user:alice",
    });

    expect(boundaryAllows(grants, boundContext({ subject: null }), BOUND_CONTEXT, "do:v1")).toBe(
      false
    );
    grants.close();
  });

  it("survives the external latch a quickfire conversation always carries", () => {
    const grants = store("lineage");
    mintQuickfireBindingGrants({
      grantStore: grants,
      subject: SUBJECT,
      channelId: CHANNEL,
      targetContextId: BOUND_CONTEXT,
      decidedBy: "user:alice",
    });

    // Looking at page content is the job, so a conversation that has done its
    // job is always externally latched. The ingestion is still recorded (§6.4);
    // it simply does not re-prompt for the access the user just asked for.
    const latched = boundContext({
      contextIntegrity: {
        class: "external",
        latchEpoch: 1,
        externalKeys: ["web:example.com", "log:panel:target", "channel:c1"],
      },
    });
    expect(boundaryAllows(grants, latched, BOUND_CONTEXT, "do:v1")).toBe(true);
    grants.close();
  });
});

describe("quickfire grant revocation", () => {
  it("revokes exactly one conversation's grants", () => {
    const grants = store("revoke");
    mintQuickfireBindingGrants({
      grantStore: grants,
      subject: SUBJECT,
      channelId: CHANNEL,
      targetContextId: BOUND_CONTEXT,
      decidedBy: "user:alice",
    });
    mintQuickfireBindingGrants({
      grantStore: grants,
      subject: SUBJECT,
      channelId: "quickfire-second",
      targetContextId: "ctx-other",
      decidedBy: "user:alice",
    });

    expect(revokeQuickfireBindingGrants({ grantStore: grants, channelId: CHANNEL })).toBe(2);
    expect(boundaryAllows(grants, boundContext(), BOUND_CONTEXT, "do:v1")).toBe(false);
    // The other conversation is untouched.
    expect(
      boundaryAllows(grants, boundContext({ sessionId: "quickfire-second" }), "ctx-other", "do:v1")
    ).toBe(true);
    grants.close();
  });

  it("leaves nothing behind when a cleared conversation is revoked twice", () => {
    const grants = store("idempotent");
    mintQuickfireBindingGrants({
      grantStore: grants,
      subject: SUBJECT,
      channelId: CHANNEL,
      targetContextId: BOUND_CONTEXT,
      decidedBy: "user:alice",
    });
    expect(revokeQuickfireBindingGrants({ grantStore: grants, channelId: CHANNEL })).toBe(2);
    expect(revokeQuickfireBindingGrants({ grantStore: grants, channelId: CHANNEL })).toBe(0);
    grants.close();
  });

  it("cuts a tool off when the user revokes the row from Permissions", () => {
    const grants = store("permissions");
    const minted = mintQuickfireBindingGrants({
      grantStore: grants,
      subject: SUBJECT,
      channelId: CHANNEL,
      targetContextId: BOUND_CONTEXT,
      decidedBy: "user:alice",
    });
    const boundary = minted.find((grant) => grant.capability === CONTEXT_BOUNDARY_CAPABILITY);

    expect(boundaryAllows(grants, boundContext(), BOUND_CONTEXT, "do:v1")).toBe(true);
    // `permissions.revoke` is exactly this call on exactly this id.
    expect(grants.revoke(boundary!.id!)).toBe(true);
    expect(boundaryAllows(grants, boundContext(), BOUND_CONTEXT, "do:v1")).toBe(false);
    grants.close();
  });
});

describe("quickfire binding severity", () => {
  it("treats an about panel as severe and an ordinary panel as standard", () => {
    expect(quickfireBindingSeverity("about/permissions")).toBe("severe");
    expect(quickfireBindingSeverity("panels/sales-dash")).toBe("standard");
    expect(quickfireBindingSeverity("browser:https://example.com")).toBe("standard");
    // An unknown source is not assumed privileged; the panel gate still runs.
    expect(quickfireBindingSeverity(null)).toBe("standard");
  });
});

describe("quickfire reviewed closure", () => {
  const harness = { unit: "workers/agent-worker", ev: "a".repeat(64) };

  it("declares only gated standing grants, as the registry requires", () => {
    for (const grant of buildQuickfireClosureBody(harness).grants) {
      expect(grant.tier).toBe("gated");
      expect(grant.effect).toBe("allow");
    }
  });

  it("holds no standing context.boundary — that is minted per binding", () => {
    // A static document cannot name a runtime context, and the only static
    // scope it could name (`context/`) would hand every conversation the
    // boundary for every branch in the workspace.
    const capabilities = buildQuickfireClosureBody(harness).grants.map((g) => g.capability);
    expect(capabilities).toEqual(["panel.inspect"]);
  });

  it("exposes the §5.3 tool surface and nothing that launches things", () => {
    const { serviceMethods } = buildQuickfireClosureBody(harness).exposure;
    for (const method of [
      "panelCdp.screenshot",
      "panelCdp.consoleHistory",
      "panelCdp.evaluate",
      "panelCdp.getCdpEndpoint",
      "panelContext.describe",
      "credentials.resolveCredential",
      "credentials.connect",
    ]) {
      expect(serviceMethods).toContain(method);
    }
    expect(serviceMethods).not.toContain("panelCdp.hostProvider.open");
    expect(serviceMethods.some((method) => method.startsWith("eval."))).toBe(false);
    // The vessel's own plumbing is exposed by exact name — a vessel that cannot
    // title itself or set its alarms never activates — but nothing else in
    // `runtime.*` is: quickfire still cannot launch, retire, or reserve.
    expect(serviceMethods).toContain("runtime.setTitle");
    expect(serviceMethods.filter((method) => method.startsWith("runtime."))).toEqual([
      "runtime.setTitle",
    ]);
    expect(serviceMethods).toContain("workspace-state.alarmSet");
    expect(serviceMethods.filter((method) => method.startsWith("workspace-state."))).toEqual([
      "workspace-state.alarmClear",
      "workspace-state.alarmSet",
      "workspace-state.lifecycleLeaseClear",
      "workspace-state.lifecycleLeaseUpsert",
    ]);
    // Sorted and deduped, so the digest is a pure function of checked-in files.
    expect([...serviceMethods].sort()).toEqual(serviceMethods);
  });

  it("moves its subject when the harness build moves", () => {
    const a = quickfireClosureSubject(CLOSURE_DIGEST);
    expect(a.startsWith("mission:quickfire@")).toBe(true);
    const body = buildQuickfireClosureBody(harness);
    const other = buildQuickfireClosureBody({ ...harness, ev: "b".repeat(64) });
    expect(body.sourceDocument.digest).not.toBe(other.sourceDocument.digest);
  });
});

describe("quickfire authority binder", () => {
  function binderFixture(overrides: {
    source?: string;
    approve?: boolean;
    closure?: { subject: AuthorityGrantSubject; digest: string } | null;
  }) {
    const grantStore = store("binder");
    const bound: unknown[] = [];
    const finished: string[] = [];
    const prompts: unknown[] = [];
    const binder = createQuickfireAuthorityBinder({
      grantStore,
      closure:
        overrides.closure === undefined
          ? { subject: SUBJECT, digest: CLOSURE_DIGEST }
          : overrides.closure,
      bindClosureSession: (input) => void bound.push(input),
      finishClosureSession: (sessionId) => void finished.push(sessionId),
      resolveSlotSource: async () => overrides.source ?? "panels/sales-dash",
      confirmSevereBinding: async (input) => {
        prompts.push(input);
        return overrides.approve ?? false;
      },
    });
    return { binder, grantStore, bound, finished, prompts };
  }

  it("binds an ordinary panel with zero prompts", async () => {
    const f = binderFixture({});
    await expect(
      f.binder.bind({
        slotId: "panel:tree/1",
        channelId: CHANNEL,
        targetContextId: BOUND_CONTEXT,
        decidedBy: "user:alice",
      })
    ).resolves.toBe(true);
    expect(f.prompts).toHaveLength(0);
    expect(f.bound).toEqual([
      {
        subject: SUBJECT,
        closureDigest: CLOSURE_DIGEST,
        sessionId: CHANNEL,
        taskRef: "quickfire:panel:tree/1",
      },
    ]);
    expect(boundaryAllows(f.grantStore, boundContext(), BOUND_CONTEXT, "do:v1")).toBe(true);
    f.grantStore.close();
  });

  it("prompts once for a privileged panel and then works", async () => {
    const f = binderFixture({ source: "about/permissions", approve: true });
    await expect(
      f.binder.bind({
        slotId: "panel:tree/2",
        channelId: CHANNEL,
        targetContextId: BOUND_CONTEXT,
        decidedBy: "user:alice",
      })
    ).resolves.toBe(true);
    expect(f.prompts).toHaveLength(1);
    // The grants persist for the conversation: the prompt is per binding, not
    // per tool call.
    expect(boundaryAllows(f.grantStore, boundContext(), BOUND_CONTEXT, "do:v1")).toBe(true);
    f.grantStore.close();
  });

  it("mints nothing when a privileged binding is refused", async () => {
    const f = binderFixture({ source: "about/permissions", approve: false });
    await expect(
      f.binder.bind({
        slotId: "panel:tree/3",
        channelId: CHANNEL,
        targetContextId: BOUND_CONTEXT,
        decidedBy: "user:alice",
      })
    ).resolves.toBe(false);
    expect(f.prompts).toHaveLength(1);
    expect(f.bound).toHaveLength(0);
    expect(boundaryAllows(f.grantStore, boundContext(), BOUND_CONTEXT, "do:v1")).toBe(false);
    f.grantStore.close();
  });

  it("mints nothing when no closure is active", async () => {
    const f = binderFixture({ closure: null });
    await expect(
      f.binder.bind({
        slotId: "panel:tree/4",
        channelId: CHANNEL,
        targetContextId: BOUND_CONTEXT,
        decidedBy: "user:alice",
      })
    ).resolves.toBe(false);
    expect(f.bound).toHaveLength(0);
    f.grantStore.close();
  });

  it("releases grants and finishes the closure session", async () => {
    const f = binderFixture({});
    await f.binder.bind({
      slotId: "panel:tree/5",
      channelId: CHANNEL,
      targetContextId: BOUND_CONTEXT,
      decidedBy: "user:alice",
    });
    await f.binder.release({ channelId: CHANNEL });
    expect(f.finished).toEqual([CHANNEL]);
    expect(boundaryAllows(f.grantStore, boundContext(), BOUND_CONTEXT, "do:v1")).toBe(false);
    f.grantStore.close();
  });

  it("still revokes grants when finishing the closure session throws", async () => {
    const grantStore = store("release-throws");
    const binder = createQuickfireAuthorityBinder({
      grantStore,
      closure: { subject: SUBJECT, digest: CLOSURE_DIGEST },
      bindClosureSession: () => undefined,
      finishClosureSession: () => {
        throw new Error("Reviewed closure session is not active");
      },
      resolveSlotSource: async () => "panels/sales-dash",
      confirmSevereBinding: async () => false,
    });
    await binder.bind({
      slotId: "panel:tree/6",
      channelId: CHANNEL,
      targetContextId: BOUND_CONTEXT,
      decidedBy: "user:alice",
    });
    await expect(binder.release({ channelId: CHANNEL })).resolves.toBeUndefined();
    expect(boundaryAllows(grantStore, boundContext(), BOUND_CONTEXT, "do:v1")).toBe(false);
    grantStore.close();
  });
});
