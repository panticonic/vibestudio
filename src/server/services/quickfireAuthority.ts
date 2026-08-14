/**
 * Quickfire authority — the reviewed closure and the per-conversation grants
 * (quickfire-overlay-spec §6).
 *
 * Two halves, deliberately separate:
 *
 *  1. **The closure** (§6.1) is the standing, reviewable document: which harness
 *     build may run as `mission:quickfire@<digest>`, what host surface that
 *     mission may reach, and the one context-independent grant it holds
 *     (`panel.inspect`). It is activated once at boot against the blessed
 *     conduit build, so its digest — and therefore the mission subject — moves
 *     whenever the harness or this document moves.
 *
 *  2. **The binding grants** (§6.2) are minted when a user opens quickfire over
 *     a panel, because the thing that must be named — the panel's context id —
 *     is a runtime value no static document can hold. They carry the same
 *     mission subject and die on lifecycle events: clear, slot close, or the
 *     slot moving to a different context. Nothing here reads a clock to decide
 *     whether authority is still good.
 */

import { createHash } from "node:crypto";
import type { AuthorityGrant, AuthorityGrantSubject, ResourceScope } from "@vibestudio/rpc";
import {
  reviewedExecutionClosureDigest,
  type CompiledExecutionExposure,
  type ReviewedExecutionClosureBody,
} from "@vibestudio/shared/authority/reviewedExecutionClosure";
import { HOST_AUTHORITY_METHODS } from "@vibestudio/shared/authority/hostAuthorityCatalog.generated";
import { panelAccessSeverityForTarget } from "@vibestudio/shared/panelAccessPolicy";
import { isAboutSource } from "@vibestudio/workspace-contracts/aboutNamespace";
import { contextBoundaryResourceKey } from "./contextBoundary.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";

/** The mission family quickfire conversations run as. */
export const QUICKFIRE_SUBJECT_PREFIX = "mission:quickfire";

/**
 * Where a quickfire binding decision was made, recorded on every minted grant.
 * `CLEARANCE_DECISION_SURFACE` is keyed by `UnitAdmissionOrigin` and describes
 * *install* decisions, so this is a sibling constant in the same family rather
 * than a new key in a map that would not typecheck.
 */
export const QUICKFIRE_DECISION_SURFACE = "quickfire-bind";

/** Issuer, publisher and session binder of the product closure — all the host. */
export const QUICKFIRE_CLOSURE_ISSUER = "host:vibestudio";

/** Grant subject for the `panel.inspect` primary capability (a literal resource). */
export const QUICKFIRE_PANEL_INSPECT_RESOURCE: ResourceScope = {
  kind: "exact",
  key: "panel.inspect",
};

/**
 * Lineage the quickfire grants are consented under.
 *
 * Quickfire's entire job is looking at page content, so a conversation that has
 * done its job always carries an external latch. Consenting to every lineage
 * class is therefore the honest reading of the user's gesture — "yes, look at
 * this panel" — rather than a loophole: the ingestion record itself is never
 * skipped (§6.4), it simply does not re-prompt for the access the user just
 * asked for.
 */
export const QUICKFIRE_LINEAGE_CLASSES = [
  "channel-external",
  "email",
  "external",
  "none",
  "web",
] as const;

/**
 * Host surface a quickfire conversation may reach (§5.3 plus the plumbing the
 * standard harness needs to hold a conversation at all).
 *
 * Exact entries are the tool-backing methods. Prefix entries are expanded
 * against the generated host authority catalog at compile time, so the compiled
 * list — and the closure digest — is a pure function of checked-in files.
 *
 * Deliberately absent: `eval.*`, `runtime.*`, `panelTree.*`, `extensions.*`.
 * Quickfire looks and makes small edits; it does not launch things.
 */
export const QUICKFIRE_EXPOSURE_PATTERNS = [
  // §5.3 debug tools.
  "panelCdp.getCdpEndpoint",
  "panelCdp.screenshot",
  "panelCdp.consoleHistory",
  "panelCdp.evaluate",
  "panelContext.*",
  // Source read/edit, scoped by the host's own per-context sandbox.
  "fs.*",
  "vcs.*",
  "blobstore.*",
  "provenance.*",
  // Conversation plumbing: workspace-service resolution, the latch, probes.
  "workers.resolveService",
  "workers.resolveDurableObject",
  "workers.listServices",
  "contextIntegrity.*",
  "probe.*",
] as const;

/** The document this closure is a compilation of. */
const QUICKFIRE_SOURCE_DOCUMENT = {
  kind: "spec",
  id: "docs/quickfire-overlay-spec.md#6",
  revision: 1,
} as const;

export interface QuickfireHarnessIdentity {
  /** Userland unit path, e.g. `workers/quickfire-agent`. */
  unit: string;
  /** Exact blessed effective version from the first-run conduit snapshot. */
  ev: string;
}

function expandExposure(patterns: readonly string[]): CompiledExecutionExposure {
  const known = Object.keys(HOST_AUTHORITY_METHODS);
  const methods = new Set<string>();
  for (const pattern of patterns) {
    if (!pattern.endsWith(".*")) {
      methods.add(pattern);
      continue;
    }
    const prefix = pattern.slice(0, -1);
    for (const method of known) {
      if (method.startsWith(prefix)) methods.add(method);
    }
  }
  return {
    serviceMethods: [...methods].sort(),
    // Channel and model access are workspace services declared by the running
    // workspace, not host methods; quickfire resolves them live like every
    // other conversation-holding agent.
    userlandServices: { discovery: "live-declarations", bindings: [] },
    // Quickfire reads the panel in front of it. It has no business fetching.
    network: { mode: "none" },
  };
}

/**
 * Compile the product quickfire closure for one blessed harness build.
 *
 * §6.1 lists `context.boundary` beside `panel.inspect` here, at prefix
 * `context/<boundCtx>/requester/`. That grant is deliberately NOT a standing
 * closure grant: `<boundCtx>` is a runtime value, and the only static scope a
 * document could name — `context/` — would hand every quickfire conversation
 * the boundary for every context in the workspace, which is exactly what §6.2
 * exists to prevent. The boundary grant is therefore minted per binding, on the
 * same subject, by {@link mintQuickfireBindingGrants}.
 */
export function buildQuickfireClosureBody(
  harness: QuickfireHarnessIdentity
): ReviewedExecutionClosureBody {
  const exposure = expandExposure(QUICKFIRE_EXPOSURE_PATTERNS);
  return {
    subjectPrefix: QUICKFIRE_SUBJECT_PREFIX,
    exposure,
    harness: { unit: harness.unit, ev: harness.ev },
    grants: [
      {
        effect: "allow",
        capability: "panel.inspect",
        resource: QUICKFIRE_PANEL_INSPECT_RESOURCE,
        tier: "gated",
      },
    ],
    grantDependencies: [],
    lineageClasses: [...QUICKFIRE_LINEAGE_CLASSES],
    owner: QUICKFIRE_CLOSURE_ISSUER,
    issuer: QUICKFIRE_CLOSURE_ISSUER,
    sourceDocument: {
      ...QUICKFIRE_SOURCE_DOCUMENT,
      // The document's identity is its compiled meaning: the exact harness
      // build plus the exact surface it may reach.
      digest: createHash("sha256")
        .update("quickfire-closure-source-v1\0", "utf8")
        .update(`${harness.unit}@${harness.ev}\0`, "utf8")
        .update(exposure.serviceMethods.join("\n"), "utf8")
        .digest("hex"),
    },
  };
}

export function quickfireClosureSubject(closureDigest: string): AuthorityGrantSubject {
  return `${QUICKFIRE_SUBJECT_PREFIX}@${closureDigest}` as AuthorityGrantSubject;
}

export function quickfireClosureDigest(harness: QuickfireHarnessIdentity): string {
  return reviewedExecutionClosureDigest(buildQuickfireClosureBody(harness));
}

/** Resource scope of the boundary grant for one bound panel context (§6.2). */
export function quickfireBoundaryResource(targetContextId: string): ResourceScope {
  // The requester half of the key is the conversation's vessel entity, which is
  // re-minted per conversation; the target context is the interesting half, so
  // the scope stops at the requester boundary.
  return { kind: "prefix", prefix: contextBoundaryResourceKey(targetContextId, "") };
}

export interface MintQuickfireBindingInput {
  grantStore: CapabilityGrantStore;
  /** `mission:quickfire@<closureDigest>` — the subject the conversation runs as. */
  subject: AuthorityGrantSubject;
  /** Conversation channel id; also the authority session id for this vessel. */
  channelId: string;
  /** The bound panel's current context. */
  targetContextId: string;
  /** The user whose gesture opened the overlay. */
  decidedBy: `user:${string}`;
  now?: number;
}

/**
 * Mint the concrete pair for one conversation over one panel context.
 *
 * Scope is passed explicitly: the store would otherwise infer `"mission"` from
 * the `mission:` subject, and these grants are emphatically not standing
 * mission authority — they belong to this conversation and die with it.
 */
export function mintQuickfireBindingGrants(input: MintQuickfireBindingInput): AuthorityGrant[] {
  const now = input.now ?? Date.now();
  const constraints = {
    sessionId: input.channelId,
    reviewedClosureSubject: input.subject as `mission:${string}`,
    lineageAtConsent: [...QUICKFIRE_LINEAGE_CLASSES],
  };
  const shared = {
    effect: "allow" as const,
    subject: input.subject,
    scope: "session" as const,
    constraints,
    issuedBy: QUICKFIRE_CLOSURE_ISSUER,
    provenance: "acquisition" as const,
    decidedBy: input.decidedBy,
    decisionSurface: QUICKFIRE_DECISION_SURFACE,
    createdAt: now,
  };
  return input.grantStore.transaction(() => [
    input.grantStore.issue({
      ...shared,
      capability: "panel.inspect",
      resource: QUICKFIRE_PANEL_INSPECT_RESOURCE,
    }),
    input.grantStore.issue({
      ...shared,
      capability: "context.boundary",
      resource: quickfireBoundaryResource(input.targetContextId),
    }),
  ]);
}

/**
 * Decide whether binding to this panel needs the standard approval card (§6.3).
 *
 * The server-side panel target that `panelCdp` builds never carries
 * `privileged` (it is a shell/`PanelManager` fact), so the flag is derived here
 * from the slot's source — the same rule `PanelManager` applies for `about/*`
 * panels — and then run through the canonical severity function rather than
 * being compared by hand.
 */
export function quickfireBindingSeverity(source: string | null): "standard" | "severe" {
  return panelAccessSeverityForTarget({
    id: "quickfire-binding",
    ...(source !== null && isAboutSource(source) ? { privileged: true } : {}),
  });
}

/**
 * Revoke everything minted for one conversation. Called on the lifecycle events
 * that end or re-target a conversation — clear, slot-close drain, context
 * change — and never on a timer.
 */
export function revokeQuickfireBindingGrants(input: {
  grantStore: CapabilityGrantStore;
  channelId: string;
  now?: number;
}): number {
  const now = input.now ?? Date.now();
  return input.grantStore.transaction(() => {
    let revoked = 0;
    for (const grant of input.grantStore.listActiveAuthorityGrants(now)) {
      if (grant.decisionSurface !== QUICKFIRE_DECISION_SURFACE) continue;
      if (grant.constraints?.sessionId !== input.channelId) continue;
      if (grant.id && input.grantStore.revoke(grant.id, now)) revoked += 1;
    }
    return revoked;
  });
}

/**
 * The lifecycle seam the quickfire service drives. One conversation is bound
 * once (or re-bound when its slot changes context) and released exactly when
 * the conversation ends.
 */
export interface QuickfireAuthorityBinder {
  /**
   * Bind one conversation to the reviewed closure and mint its grants. Returns
   * false when a severe binding was refused at the approval card; the caller
   * keeps the conversation (talking is always allowed) but the debug tools stay
   * shut until the user says yes on a later open.
   */
  bind(input: {
    slotId: string;
    channelId: string;
    targetContextId: string;
    decidedBy: `user:${string}`;
  }): Promise<boolean>;
  /** Revoke a conversation's grants and finish its closure session binding. */
  release(input: { channelId: string }): Promise<void>;
}

export interface QuickfireAuthorityBinderDeps {
  grantStore: CapabilityGrantStore;
  /** `mission:quickfire@<digest>` and the digest, resolved once at boot. */
  closure: { subject: AuthorityGrantSubject; digest: string } | null;
  bindClosureSession(input: {
    subject: AuthorityGrantSubject;
    closureDigest: string;
    sessionId: string;
    taskRef: string;
  }): void;
  finishClosureSession(sessionId: string): void;
  /** The bound slot's current panel source, for the severity gate. */
  resolveSlotSource(slotId: string): Promise<string | null>;
  /**
   * Show the standard approval card once for a severe binding. Resolves true
   * only on an explicit allow.
   */
  confirmSevereBinding(input: {
    slotId: string;
    source: string | null;
    targetContextId: string;
    decidedBy: `user:${string}`;
  }): Promise<boolean>;
  log?(message: string, detail?: Record<string, unknown>): void;
}

export function createQuickfireAuthorityBinder(
  deps: QuickfireAuthorityBinderDeps
): QuickfireAuthorityBinder {
  return {
    async bind(input) {
      const closure = deps.closure;
      if (!closure) {
        // No blessed harness build means no mission subject to bind to. The
        // conversation still works; it simply holds no pre-granted authority.
        deps.log?.("Quickfire closure is unavailable; binding no authority", {
          slotId: input.slotId,
        });
        return false;
      }
      const source = await deps.resolveSlotSource(input.slotId).catch(() => null);
      if (quickfireBindingSeverity(source) === "severe") {
        const approved = await deps.confirmSevereBinding({
          slotId: input.slotId,
          source,
          targetContextId: input.targetContextId,
          decidedBy: input.decidedBy,
        });
        if (!approved) return false;
      }
      deps.bindClosureSession({
        subject: closure.subject,
        closureDigest: closure.digest,
        sessionId: input.channelId,
        taskRef: `quickfire:${input.slotId}`,
      });
      mintQuickfireBindingGrants({
        grantStore: deps.grantStore,
        subject: closure.subject,
        channelId: input.channelId,
        targetContextId: input.targetContextId,
        decidedBy: input.decidedBy,
      });
      return true;
    },

    async release(input) {
      revokeQuickfireBindingGrants({
        grantStore: deps.grantStore,
        channelId: input.channelId,
      });
      // Finishing is best-effort: a conversation whose binding was refused (or
      // already finished) still has to release cleanly.
      try {
        deps.finishClosureSession(input.channelId);
      } catch {
        /* not bound */
      }
    },
  };
}
