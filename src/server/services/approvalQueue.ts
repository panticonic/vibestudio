/**
 * Sensitive action queue for shell-owned prompts.
 *
 * Despite the historical ApprovalQueue name, this queue handles more than
 * access approvals: one-shot actions, reusable permission grants, and
 * privileged setup prompts all share this user-decision rendezvous point.
 */

import { randomUUID } from "node:crypto";

import { canonicalKey } from "@vibestudio/shared/canonicalKey";
import type { EventService } from "@vibestudio/shared/eventsService";
import type {
  ApprovalDecision,
  ApprovalOperationDescriptor,
  ApprovalPrincipal,
  ApprovalRequesterCategory,
  ApprovalRequesterIdentity,
  DiffReviewEntry,
  PendingApproval,
  PendingCapabilityApproval,
  PendingCredentialApproval,
  PendingCredentialInputApproval,
  PendingSecretInputApproval,
  PendingClientConfigApproval,
  PendingDeviceCodeApproval,
  PendingExternalAgentApproval,
  PendingUnitBatchApproval,
  PendingUserlandApproval,
  ExternalAgentApprovalResult,
  UserlandApprovalChoice,
  UserlandApprovalOption,
  UserlandApprovalSubject,
} from "@vibestudio/shared/approvals";
import type {
  AccountIdentity,
  CredentialInjection,
  UrlAudience,
} from "@vibestudio/shared/credentials/types";
import type { UserSubject } from "@vibestudio/shared/users/types";
import type {
  ApprovalProvenanceKind,
  ApprovalRequestedBy,
  ApprovalResolvedBy,
  ApprovalResolvedEvent,
  ApprovalResource,
  GrantScopeStored,
  ResolvedVia,
} from "@vibestudio/shared/governance/types";

/** Terminal decision surfaced back to queue waiters (dismiss collapses to deny). */
export type GrantedDecision = "once" | "session" | "version" | "deny";

/**
 * The resolver's verified identity + surface (WP5 §4/§5), threaded from the
 * service handler (which holds `ctx.caller.subject`) into the queue's `settle`
 * coordinator. Identity is host-verified, never accepted from the wire (INV-3).
 * Absent → the resolution is a programmatic/system settle (no provenance record
 * and no live `resolved` surface — only the enumerated bootstrap principals or
 * cleanup paths, which have no human resolver).
 */
export interface ApprovalResolver {
  subject: UserSubject;
  via: ResolvedVia;
  deviceId?: string;
  deviceLabel?: string;
}

interface ApprovalQueueRequestBase {
  callerId: string;
  callerKind: "panel" | "app" | "worker" | "do" | "extension" | "system";
  repoPath: string;
  effectiveVersion: string;
  /**
   * The REQUESTING user's `subject.userId` (WP5 §5.1), stamped by the enqueuing
   * service so a resolution record can name both parties. Attribution only.
   */
  requestedByUserId?: string;
  requesterCategory?: ApprovalRequesterCategory;
  operation?: ApprovalOperationDescriptor;
  /**
   * Host-computed diff-review payload (narrow-host-vcs-plan §5.1), forwarded
   * verbatim onto the pending approval. Set by the main-advance gate for
   * capability (advance/delete/restore) and unit-batch (meta) prompts.
   */
  diffReview?: DiffReviewEntry[];
  signal?: AbortSignal;
}

export interface CredentialApprovalQueueRequest extends ApprovalQueueRequestBase {
  kind?: "credential";
  credentialId: string;
  credentialLabel: string;
  audience: UrlAudience[];
  injection: CredentialInjection;
  accountIdentity: AccountIdentity;
  scopes: string[];
  credentialUse?: PendingCredentialApproval["credentialUse"];
  bindingLabel?: PendingCredentialApproval["bindingLabel"];
  gitOperation?: PendingCredentialApproval["gitOperation"];
  grantResource?: PendingCredentialApproval["grantResource"];
  oauthAuthorizeOrigin?: string;
  oauthTokenOrigin?: string;
  oauthUserinfoOrigin?: string;
  oauthAudienceDomainMismatch?: boolean;
  replacementCredentialLabel?: string;
}

export interface CapabilityApprovalQueueRequest extends ApprovalQueueRequestBase {
  kind: "capability";
  capability: string;
  severity?: PendingCapabilityApproval["severity"];
  /**
   * Override pending-request deduplication for capability prompts. `null`
   * isolates this request so a one-shot approval cannot release unrelated
   * waiters for the same resource.
   */
  dedupKey?: string | null;
  title: string;
  description?: string;
  resource?: PendingCapabilityApproval["resource"];
  resourceScope?: PendingCapabilityApproval["resourceScope"];
  grantResourceKey?: string;
  details?: PendingCapabilityApproval["details"];
}

export interface UnitBatchApprovalQueueRequest extends ApprovalQueueRequestBase {
  kind: "unit-batch";
  dedupKey?: string | null;
  trigger: PendingUnitBatchApproval["trigger"];
  title: string;
  description: string;
  units: PendingUnitBatchApproval["units"];
  configWrite?: PendingUnitBatchApproval["configWrite"];
}

export interface ClientConfigApprovalQueueRequest extends ApprovalQueueRequestBase {
  kind: "client-config";
  configId: string;
  authorizeUrl: string;
  tokenUrl: string;
  title: string;
  description?: string;
  fields: PendingClientConfigApproval["fields"];
}

export interface CredentialInputApprovalQueueRequest extends ApprovalQueueRequestBase {
  kind: "credential-input";
  title: string;
  description?: string;
  credentialLabel: string;
  audience: UrlAudience[];
  injection: CredentialInjection;
  accountIdentity: AccountIdentity;
  scopes: string[];
  fields: PendingCredentialInputApproval["fields"];
}

export interface SecretInputApprovalQueueRequest extends ApprovalQueueRequestBase {
  kind: "secret-input";
  title: string;
  description?: string;
  warning?: string;
  details?: PendingSecretInputApproval["details"];
  fields: PendingSecretInputApproval["fields"];
}

export interface UserlandApprovalQueueRequest {
  principal: ApprovalPrincipal;
  /** The requesting user's `subject.userId` (WP5 §5.1); attribution only. */
  requestedByUserId?: string;
  /** Issuer of the request — defaults to principal when omitted. */
  issuer?: import("@vibestudio/shared/approvals").UserlandApprovalIssuer;
  subject: UserlandApprovalSubject;
  title: string;
  summary?: string;
  warning?: string;
  details?: PendingUserlandApproval["details"];
  positiveEvidence?: PendingUserlandApproval["positiveEvidence"];
  severity?: PendingUserlandApproval["severity"];
  defaultAction?: PendingUserlandApproval["defaultAction"];
  promptOptions: PendingUserlandApproval["promptOptions"];
  options: UserlandApprovalOption[];
  signal?: AbortSignal;
}

export interface ExternalAgentApprovalQueueRequest extends ApprovalQueueRequestBase {
  kind: "external-agent";
  entityId: string;
  channelId: string;
  capability: string;
  /** Tool/operation name (runtime-facing request field `operation`). */
  operationName: string;
  description?: string;
  preview?: string;
  requestId: string;
  resolveToken: string;
}

export interface DeviceCodeApprovalQueueRequest extends ApprovalQueueRequestBase {
  kind: "device-code";
  credentialLabel: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
  oauthTokenOrigin: string;
}

/**
 * Device-code approvals are passive informational entries — the server runs
 * the polling loop, the bar displays the user_code while it runs, and the
 * user can cancel. The handle surfaces a cancellation AbortSignal plus a
 * `dispose()` to clear the bar entry when polling completes.
 */
export interface DeviceCodeApprovalHandle {
  approvalId: string;
  cancelled: AbortSignal;
  dispose(): void;
}

export type ApprovalQueueRequest =
  | CredentialApprovalQueueRequest
  | CapabilityApprovalQueueRequest
  | UnitBatchApprovalQueueRequest
  | ClientConfigApprovalQueueRequest
  | CredentialInputApprovalQueueRequest
  | SecretInputApprovalQueueRequest
  | DeviceCodeApprovalQueueRequest;
export type DecisionApprovalQueueRequest =
  | CredentialApprovalQueueRequest
  | CapabilityApprovalQueueRequest
  | UnitBatchApprovalQueueRequest;

export type ClientConfigApprovalResult =
  | { decision: "submit"; values: Record<string, string> }
  | { decision: "deny" };
export type FieldInputApprovalResult = ClientConfigApprovalResult;
export type UserlandApprovalResult = UserlandApprovalChoice;

interface QueueWaiter {
  resolve: (decision: GrantedDecision) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface FieldInputQueueWaiter {
  resolve: (result: FieldInputApprovalResult) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface UserlandQueueWaiter {
  resolve: (result: UserlandApprovalResult) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface DeviceCodeQueueWaiter {
  cancel: () => void;
}

interface ExternalAgentQueueWaiter {
  resolve: (result: ExternalAgentApprovalResult) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface QueueEntry {
  approval: PendingApproval;
  dedupKey: string;
  /** The requesting user's `subject.userId`, captured at enqueue time (WP5 §5.1). */
  requestedByUserId?: string;
  waiters: Map<number, QueueWaiter>;
  fieldInputWaiters: Map<number, FieldInputQueueWaiter>;
  userlandWaiters: Map<number, UserlandQueueWaiter>;
  deviceCodeWaiters: Map<number, DeviceCodeQueueWaiter>;
  externalAgentWaiters: Map<number, ExternalAgentQueueWaiter>;
  nextWaiterId: number;
  /** The single in-flight human settlement; competing verdicts are rejected. */
  settlement?: Promise<void>;
}

export interface ApprovalQueue {
  request(req: DecisionApprovalQueueRequest): Promise<GrantedDecision>;
  requestClientConfig(req: ClientConfigApprovalQueueRequest): Promise<ClientConfigApprovalResult>;
  requestCredentialInput(
    req: CredentialInputApprovalQueueRequest
  ): Promise<FieldInputApprovalResult>;
  requestSecretInput(req: SecretInputApprovalQueueRequest): Promise<FieldInputApprovalResult>;
  requestUserland(req: UserlandApprovalQueueRequest): Promise<UserlandApprovalResult>;
  requestExternalAgent(
    req: ExternalAgentApprovalQueueRequest
  ): Promise<ExternalAgentApprovalResult>;
  presentDeviceCode(req: DeviceCodeApprovalQueueRequest): DeviceCodeApprovalHandle;
  onPendingChanged?(listener: (pending: PendingApproval[]) => void): () => void;
  resolve(
    approvalId: string,
    decision: ApprovalDecision,
    resolver?: ApprovalResolver
  ): Promise<void>;
  resolveUserland(approvalId: string, choice: string, resolver?: ApprovalResolver): Promise<void>;
  resolveExternalAgent(
    approvalId: string,
    behavior: "allow" | "deny",
    resolver?: ApprovalResolver
  ): Promise<void>;
  /**
   * Record a user verdict on the external-agent approval matched by
   * (channelId, requestId, resolveToken) — the inline conversation card
   * resolution path, which knows the runtime requestId and opaque token but not
   * the internal approvalId. Resolves the
   * pending request with the given `behavior` (a real verdict, NOT the quiet
   * settle-elsewhere path). Returns the number of approvals resolved.
   */
  resolveExternalAgentByRequest(
    channelId: string,
    requestId: string,
    resolveToken: string,
    behavior: "allow" | "deny",
    resolver?: ApprovalResolver
  ): Promise<number>;
  /**
   * Quiet-settle every external-agent approval matching `predicate` (answered at
   * the terminal / bridge detached): removes the card and resolves the pending
   * request as `deny` WITHOUT the UI recording a user deny. Returns the count.
   */
  settleExternalAgent(predicate: (approval: PendingExternalAgentApproval) => boolean): number;
  resolveMatching?(
    predicate: (approval: PendingApproval) => boolean,
    decision: GrantedDecision
  ): number;
  resolveMatchingUserland?(
    predicate: (approval: PendingApproval) => boolean,
    choice: string
  ): number;
  submitClientConfig(
    approvalId: string,
    values: Record<string, string>,
    resolver?: ApprovalResolver
  ): Promise<void>;
  submitCredentialInput(
    approvalId: string,
    values: Record<string, string>,
    resolver?: ApprovalResolver
  ): Promise<void>;
  submitSecretInput(
    approvalId: string,
    values: Record<string, string>,
    resolver?: ApprovalResolver
  ): Promise<void>;
  listPending(): PendingApproval[];
  /** Cleanup hook: cancel any pending approvals associated with a caller id. */
  cancelForCaller(callerId: string): void;
}

export interface ApprovalQueueWithListeners extends ApprovalQueue {
  onPendingChanged(listener: (pending: PendingApproval[]) => void): () => void;
  resolveMatching(
    predicate: (approval: PendingApproval) => boolean,
    decision: GrantedDecision
  ): number;
  resolveMatchingUserland(
    predicate: (approval: PendingApproval) => boolean,
    choice: string
  ): number;
}

export type SensitiveActionQueue = ApprovalQueue;

export interface ApprovalQueueAutoApproveOptions {
  decision?: GrantedDecision;
}

export function createApprovalQueue(deps: {
  eventService: EventService;
  /**
   * Optional resolver for server-controlled display titles. When set, every
   * pending approval includes `callerTitle` and userland-issuer `label`
   * populated from this lookup. Without it, both fall back to opaque ids in
   * the UI.
   */
  resolveTitle?: (entityId: string) => string | undefined;
  resolveRequester?: (input: {
    callerId: string;
    callerKind: "panel" | "app" | "worker" | "do" | "extension" | "system";
    repoPath: string;
    effectiveVersion: string;
    requesterCategory?: ApprovalRequesterCategory;
  }) => ApprovalRequesterIdentity;
  autoApprove?: ApprovalQueueAutoApproveOptions | boolean;
  /**
   * Host governance writer (WP5 §6 step 4). The single `settle` coordinator
   * hands it the same workspace-neutral snapshot it broadcasts on
   * `shell-approval:resolved`. The authenticated hub route stamps the
   * authoritative workspace id; child callers cannot supply or spoof it. A
   * human resolution does not settle until this write is acknowledged. Absent
   * → provenance is not persisted (the live surface still fires).
   */
  recordProvenance?: (record: ApprovalResolvedEvent) => void | Promise<void>;
}): ApprovalQueueWithListeners {
  const { eventService } = deps;
  const resolveTitle = deps.resolveTitle ?? (() => undefined);
  const autoApproveDecision =
    deps.autoApprove === true ? "once" : deps.autoApprove ? deps.autoApprove.decision : null;
  const entriesById = new Map<string, QueueEntry>();
  const entriesByDedupKey = new Map<string, QueueEntry>();
  const pendingListeners = new Set<(pending: PendingApproval[]) => void>();

  function emitPendingChanged(): void {
    const pending = Array.from(entriesById.values()).map((e) => e.approval);
    for (const listener of pendingListeners) {
      try {
        listener(pending);
      } catch (error) {
        console.warn("[ApprovalQueue] pending listener failed:", error);
      }
    }
    eventService.emit("shell-approval:pending-changed", { pending });
  }

  function removeEntry(entry: QueueEntry): void {
    entriesById.delete(entry.approval.approvalId);
    entriesByDedupKey.delete(entry.dedupKey);
  }

  /**
   * Broadcast the live resolved surface (WP5 §6). The `shell-approval:resolved`
   * event name is registered in `packages/shared/src/events.ts` at integration
   * (like `shell-approval:pending-changed`); it is typed here through a narrow
   * view so the queue compiles independently of that registration. Until the
   * name is registered `emit` simply finds no subscribers and returns — no crash.
   */
  function emitResolved(event: ApprovalResolvedEvent): void {
    (
      eventService as unknown as {
        emit(name: "shell-approval:resolved", data: ApprovalResolvedEvent): void;
      }
    ).emit("shell-approval:resolved", event);
  }

  function buildRequestedBy(entry: QueueEntry): ApprovalRequestedBy {
    const approval = entry.approval;
    return {
      callerId: approval.callerId,
      callerKind: approval.callerKind,
      ...(approval.repoPath ? { repoPath: approval.repoPath } : {}),
      ...(approval.effectiveVersion ? { effectiveVersion: approval.effectiveVersion } : {}),
      ...(entry.requestedByUserId ? { userId: entry.requestedByUserId } : {}),
    };
  }

  /** A compact, kind-agnostic descriptor of WHAT was approved (WP5 §5). */
  function deriveResource(approval: PendingApproval): ApprovalResource | undefined {
    switch (approval.kind) {
      case "capability":
        return {
          capability: approval.capability,
          ...(approval.resource?.value ? { value: approval.resource.value } : {}),
        };
      case "credential":
        return { credentialId: approval.credentialId, value: approval.credentialLabel };
      case "credential-input":
        return { value: approval.credentialLabel };
      case "client-config":
        return { value: approval.configId };
      case "device-code":
        return { value: approval.credentialLabel };
      case "userland":
        return { subjectId: approval.subject.id };
      case "external-agent":
        return { capability: approval.capability, value: approval.operationName };
      case "secret-input":
      case "unit-batch":
        return { value: approval.title };
      default:
        return undefined;
    }
  }

  /**
   * The SINGLE settlement coordinator (WP5 §6) every human resolve/submit path
   * funnels through — it fixes the delete-before-emit bug by snapshotting and
   * durably recording and broadcasting the resolution BEFORE removal:
   *   1. snapshot `{ approvalId, decision, granted, resolvedBy, requestedBy,
   *      resource, grantScopeStored, … }` from the still-present entry + resolver;
   *   2. await the governance writer's durable acknowledgement;
   *   3. emit `shell-approval:resolved` (the live `resolvedBy` surface);
   *   4. settle coalesced waiters + remove the entry (`settleWaiters`), then
   *      refresh `pending-changed` (now reflecting the removal).
   * The same snapshot feeds the durable and live surfaces. If persistence
   * fails, the entry stays pending and no resolution is broadcast.
   * A resolution with no `resolver` (programmatic/cleanup settle) skips the
   * snapshot/event/record and just settles waiters + refreshes pending.
   */
  async function settle(
    entry: QueueEntry,
    resolution: {
      decision: ApprovalResolvedEvent["decision"];
      granted: boolean;
      grantScopeStored?: GrantScopeStored;
      resolver?: ApprovalResolver;
      /** Overrides the resource derived from the pending approval (e.g. userland choice). */
      resource?: ApprovalResource;
    },
    settleWaiters: (entry: QueueEntry) => void
  ): Promise<void> {
    if (entry.settlement) {
      throw new Error(`Approval ${entry.approval.approvalId} is already being resolved`);
    }
    let acknowledgeSettlement!: () => void;
    let rejectSettlement!: (error: unknown) => void;
    const settlement = new Promise<void>((resolve, reject) => {
      acknowledgeSettlement = resolve;
      rejectSettlement = reject;
    });
    // Install the lock before invoking any provenance hook. The settlement
    // body still runs immediately so resolver-free cleanup keeps its historical
    // synchronous behavior.
    entry.settlement = settlement;
    const runSettlement = async () => {
      let event: ApprovalResolvedEvent | undefined;

      // (1) Snapshot from the STILL-PRESENT entry + the resolver's verified subject.
      if (resolution.resolver) {
        const resolvedBy: ApprovalResolvedBy = {
          userId: resolution.resolver.subject.userId,
          handle: resolution.resolver.subject.handle,
          ...(resolution.resolver.deviceId ? { deviceId: resolution.resolver.deviceId } : {}),
          ...(resolution.resolver.deviceLabel
            ? { deviceLabel: resolution.resolver.deviceLabel }
            : {}),
        };
        const resource = resolution.resource ?? deriveResource(entry.approval);
        event = {
          approvalId: entry.approval.approvalId,
          approvalKind: entry.approval.kind as ApprovalProvenanceKind,
          decision: resolution.decision,
          granted: resolution.granted,
          resolvedAt: Date.now(),
          resolvedBy,
          resolvedVia: resolution.resolver.via,
          requestedBy: buildRequestedBy(entry),
          ...(resource ? { resource } : {}),
          ...(resolution.grantScopeStored !== undefined
            ? { grantScopeStored: resolution.grantScopeStored }
            : {}),
        };
      }

      // (2) Acknowledge durable provenance before exposing or settling success.
      if (event) await deps.recordProvenance?.(event);

      // (3) Emit the live resolved surface BEFORE removal (the §6 fix).
      if (event) emitResolved(event);

      // (4) Remove the entry + settle coalesced waiters.
      settleWaiters(entry);

      // pending-changed now reflects removal.
      emitPendingChanged();
    };
    void runSettlement().then(acknowledgeSettlement, rejectSettlement);
    try {
      await settlement;
    } catch (error) {
      if (entry.settlement === settlement) delete entry.settlement;
      throw error;
    }
  }

  /** Grant scope the server persisted for a decision (null for once/deny/dismiss). */
  function grantScopeFor(decision: GrantedDecision): GrantScopeStored {
    return decision === "session" || decision === "version" ? decision : null;
  }

  function dedupKeyFor(req: ApprovalQueueRequest): string {
    if (req.operation?.groupKey) {
      return canonicalKey(["operation", req.callerId, req.operation.groupKey]);
    }
    if (req.kind === "capability") {
      if (req.dedupKey === null) {
        return canonicalKey(["capability-isolated", randomUUID()]);
      }
      if (req.dedupKey) {
        return canonicalKey(["capability-custom", req.callerId, req.dedupKey]);
      }
      return canonicalKey([
        "capability",
        req.callerId,
        req.repoPath,
        req.effectiveVersion,
        req.capability,
        req.resource?.value ?? "",
      ]);
    }
    if (req.kind === "unit-batch") {
      if (req.dedupKey === null) {
        return canonicalKey(["unit-batch-isolated", randomUUID()]);
      }
      if (req.dedupKey) {
        return canonicalKey(["unit-batch-custom", req.callerId, req.dedupKey]);
      }
      // Coalesce duplicate reconciles for the same trigger + set onto one
      // prompt. Include each unit's source repo/ref/ev and the config
      // write, so batches that differ only in those (same names) don't collapse
      // and surface stale consent details.
      return canonicalKey([
        "unit-batch",
        req.trigger,
        ...req.units
          .slice()
          .sort((a, b) =>
            `${a.unitKind}:${a.unitName}`.localeCompare(`${b.unitKind}:${b.unitName}`)
          )
          .flatMap((unit) => [
            unit.unitKind,
            unit.unitName,
            unit.target ?? null,
            unit.source.repo,
            unit.source.ref,
            unit.ev ?? null,
            unit.integrity ?? null,
            unit.provider?.name ?? null,
            unit.provider?.activeEv ?? null,
            unit.provider?.activeBuildKey ?? null,
            unit.provider?.contractVersion ?? null,
          ]),
        req.configWrite?.repoPath ?? null,
        req.configWrite?.summary ?? null,
      ]);
    }
    if (req.kind === "client-config") {
      return canonicalKey([
        "client-config",
        req.repoPath,
        req.effectiveVersion,
        req.configId,
        req.authorizeUrl,
        req.tokenUrl,
        req.fields.map((field) => field.name).join(","),
      ]);
    }
    if (req.kind === "credential-input") {
      // A submitted secret is a one-shot input, not a reusable approval. Keep
      // concurrent prompts isolated so one submission cannot release multiple
      // waiters and create duplicate credentials.
      return canonicalKey(["credential-input-isolated", randomUUID()]);
    }
    if (req.kind === "secret-input") {
      // A submitted secret is a one-shot input, not a reusable approval. Keep
      // concurrent prompts isolated so one submission cannot satisfy another
      // privileged operation.
      return canonicalKey(["secret-input-isolated", randomUUID()]);
    }
    if (req.kind === "device-code") {
      // Each device-code flow is independent — the user_code is unique and
      // the polling loop is tied to a specific outstanding request.
      return canonicalKey(["device-code", randomUUID()]);
    }
    return canonicalKey([
      "credential",
      req.callerId,
      req.repoPath,
      req.effectiveVersion,
      req.credentialId,
    ]);
  }

  function userlandDedupKeyFor(req: UserlandApprovalQueueRequest): string {
    const issuer = req.issuer ?? {
      kind: req.principal.callerKind,
      id: req.principal.callerId,
    };
    return canonicalKey([
      "userland",
      req.principal.callerId,
      issuer.kind,
      issuer.id,
      req.subject.id,
    ]);
  }

  function resolveRequesterFor(
    req: Pick<
      ApprovalQueueRequestBase,
      "callerId" | "callerKind" | "repoPath" | "effectiveVersion" | "requesterCategory"
    >
  ): ApprovalRequesterIdentity | undefined {
    return deps.resolveRequester?.({
      callerId: req.callerId,
      callerKind: req.callerKind,
      repoPath: req.repoPath,
      effectiveVersion: req.effectiveVersion,
      ...(req.requesterCategory ? { requesterCategory: req.requesterCategory } : {}),
    });
  }

  function defaultOperationFor(req: ApprovalQueueRequest): ApprovalOperationDescriptor {
    if (req.kind === "capability") {
      const object = req.resource
        ? {
            type: req.resource.type,
            label: req.resource.label,
            value: req.resource.value,
          }
        : undefined;
      if (
        req.capability === "workspace-repo-write" ||
        req.capability === "workspace-project-import" ||
        req.capability === "workspace-shared-git-remote"
      ) {
        return { kind: "workspace", verb: req.title, ...(object ? { object } : {}) };
      }
      if (req.capability === "external-network-fetch") {
        return { kind: "network", verb: req.title, ...(object ? { object } : {}) };
      }
      if (req.capability === "cors-response-read") {
        return { kind: "network", verb: req.title, ...(object ? { object } : {}) };
      }
      if (req.capability === "workerd.inspector") {
        return { kind: "inspection", verb: req.title, ...(object ? { object } : {}) };
      }
      if (req.capability === "client-config-delete") {
        return { kind: "service-setup", verb: req.title, ...(object ? { object } : {}) };
      }
      if (req.capability === "external-browser-open" || req.capability === "open-url") {
        return { kind: "browser", verb: req.title, ...(object ? { object } : {}) };
      }
      return { kind: "unknown", verb: req.title, ...(object ? { object } : {}) };
    }
    if (req.kind === "unit-batch") {
      return { kind: "workspace", verb: req.title };
    }
    if (req.kind === "client-config") {
      return {
        kind: "service-setup",
        verb: "configure",
        object: { type: "client-config", label: "Service", value: req.configId },
      };
    }
    if (req.kind === "credential-input") {
      return {
        kind: "service-setup",
        verb: "add credential",
        object: { type: "credential", label: "Credential", value: req.credentialLabel },
      };
    }
    if (req.kind === "device-code") {
      return {
        kind: "device-code",
        verb: "sign in",
        object: { type: "credential", label: "Credential", value: req.credentialLabel },
      };
    }
    if (req.kind === "secret-input") {
      return {
        kind: "service-setup",
        verb: req.title,
        object: { type: "secret-input", label: "Input", value: req.title },
      };
    }
    return {
      kind: "credential",
      verb: "use credential",
      object: { type: "credential", label: "Credential", value: req.credentialLabel },
    };
  }

  function createPendingApproval(req: ApprovalQueueRequest): PendingApproval {
    const requester = resolveRequesterFor(req);
    const callerTitle = requester?.title ?? resolveTitle(req.callerId);
    const operation = req.operation ?? defaultOperationFor(req);
    const base = {
      approvalId: randomUUID(),
      callerId: req.callerId,
      callerKind: req.callerKind,
      repoPath: req.repoPath,
      effectiveVersion: req.effectiveVersion,
      requestedAt: Date.now(),
      ...(callerTitle !== undefined ? { callerTitle } : {}),
      ...(requester ? { requester } : {}),
      operation,
      ...(req.diffReview ? { diffReview: req.diffReview } : {}),
    };
    if (req.kind === "capability") {
      return {
        ...base,
        kind: "capability",
        capability: req.capability,
        severity: req.severity,
        grantResourceKey: req.grantResourceKey,
        title: req.title,
        description: req.description,
        resource: req.resource,
        resourceScope: req.resourceScope,
        details: req.details,
      } satisfies PendingCapabilityApproval;
    }
    if (req.kind === "unit-batch") {
      return {
        ...base,
        kind: "unit-batch",
        trigger: req.trigger,
        title: req.title,
        description: req.description,
        units: req.units,
        configWrite: req.configWrite ?? null,
      } satisfies PendingUnitBatchApproval;
    }
    if (req.kind === "client-config") {
      return {
        ...base,
        kind: "client-config",
        configId: req.configId,
        authorizeUrl: req.authorizeUrl,
        tokenUrl: req.tokenUrl,
        title: req.title,
        description: req.description,
        fields: req.fields,
      } satisfies PendingClientConfigApproval;
    }
    if (req.kind === "credential-input") {
      return {
        ...base,
        kind: "credential-input",
        title: req.title,
        description: req.description,
        credentialLabel: req.credentialLabel,
        audience: req.audience,
        injection: req.injection,
        accountIdentity: req.accountIdentity,
        scopes: req.scopes,
        fields: req.fields,
      } satisfies PendingCredentialInputApproval;
    }
    if (req.kind === "secret-input") {
      return {
        ...base,
        kind: "secret-input",
        title: req.title,
        description: req.description,
        warning: req.warning,
        details: req.details,
        fields: req.fields,
      } satisfies PendingSecretInputApproval;
    }
    if (req.kind === "device-code") {
      return {
        ...base,
        kind: "device-code",
        credentialLabel: req.credentialLabel,
        userCode: req.userCode,
        verificationUri: req.verificationUri,
        verificationUriComplete: req.verificationUriComplete,
        expiresAt: req.expiresAt,
        oauthTokenOrigin: req.oauthTokenOrigin,
      } satisfies PendingDeviceCodeApproval;
    }
    return {
      ...base,
      kind: "credential",
      credentialId: req.credentialId,
      credentialLabel: req.credentialLabel,
      audience: req.audience,
      injection: req.injection,
      accountIdentity: req.accountIdentity,
      scopes: req.scopes,
      credentialUse: req.credentialUse,
      bindingLabel: req.bindingLabel,
      gitOperation: req.gitOperation,
      grantResource: req.grantResource,
      oauthAuthorizeOrigin: req.oauthAuthorizeOrigin,
      oauthTokenOrigin: req.oauthTokenOrigin,
      oauthUserinfoOrigin: req.oauthUserinfoOrigin,
      oauthAudienceDomainMismatch: req.oauthAudienceDomainMismatch,
      replacementCredentialLabel: req.replacementCredentialLabel,
    } satisfies PendingCredentialApproval;
  }

  function enqueueFieldInputRequest(
    req:
      | ClientConfigApprovalQueueRequest
      | CredentialInputApprovalQueueRequest
      | SecretInputApprovalQueueRequest,
    expectedKind: "client-config" | "credential-input" | "secret-input",
    collisionMessage: string
  ): Promise<FieldInputApprovalResult> {
    const dedupKey = dedupKeyFor(req);
    let entry = entriesByDedupKey.get(dedupKey);
    let newEntry = false;
    if (!entry) {
      const approval = createPendingApproval(req);
      entry = {
        approval,
        dedupKey,
        requestedByUserId: req.requestedByUserId,
        waiters: new Map(),
        fieldInputWaiters: new Map(),
        userlandWaiters: new Map(),
        deviceCodeWaiters: new Map(),
        externalAgentWaiters: new Map(),
        nextWaiterId: 0,
      };
      entriesById.set(approval.approvalId, entry);
      entriesByDedupKey.set(dedupKey, entry);
      newEntry = true;
    }

    if (entry.approval.kind !== expectedKind) {
      throw new Error(collisionMessage);
    }

    const bound = entry;
    return new Promise<FieldInputApprovalResult>((resolve) => {
      const waiterId = bound.nextWaiterId++;
      const waiter: FieldInputQueueWaiter = { resolve, signal: req.signal };

      if (req.signal) {
        const onAbort = () => {
          const e = entriesById.get(bound.approval.approvalId);
          if (!e) {
            resolve({ decision: "deny" });
            return;
          }
          if (e.settlement) return;
          e.fieldInputWaiters.delete(waiterId);
          if (
            e.waiters.size === 0 &&
            e.fieldInputWaiters.size === 0 &&
            e.userlandWaiters.size === 0
          ) {
            removeEntry(e);
            emitPendingChanged();
          }
          resolve({ decision: "deny" });
        };
        waiter.onAbort = onAbort;
        if (req.signal.aborted) {
          queueMicrotask(onAbort);
        } else {
          req.signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      bound.fieldInputWaiters.set(waiterId, waiter);

      if (newEntry) {
        emitPendingChanged();
      }
    });
  }

  /** Settle a field-input entry's waiters (submit succeeds; siblings deny). No emit. */
  function settleFieldInputEntry(entry: QueueEntry, values: Record<string, string>): void {
    removeEntry(entry);

    for (const waiter of entry.fieldInputWaiters.values()) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve({ decision: "submit", values });
    }
    entry.fieldInputWaiters.clear();
    for (const waiter of entry.waiters.values()) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve("deny");
    }
    entry.waiters.clear();
    for (const waiter of entry.userlandWaiters.values()) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve({ kind: "dismissed" });
    }
    entry.userlandWaiters.clear();
    for (const waiter of entry.externalAgentWaiters.values()) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve({ behavior: "deny" });
    }
    entry.externalAgentWaiters.clear();
  }

  async function submitFieldInput(
    approvalId: string,
    expectedKind: "client-config" | "credential-input" | "secret-input",
    values: Record<string, string>,
    resolver?: ApprovalResolver
  ): Promise<void> {
    const entry = entriesById.get(approvalId);
    if (!entry || entry.approval.kind !== expectedKind) return;

    // Route through the single settle coordinator so a submit also snapshots +
    // broadcasts `shell-approval:resolved` and records provenance (WP5 §6).
    await settle(entry, { decision: "submit", granted: true, resolver }, (e) =>
      settleFieldInputEntry(e, values)
    );
  }

  function settleDecisionEntry(entry: QueueEntry, decision: GrantedDecision): void {
    removeEntry(entry);
    for (const waiter of entry.waiters.values()) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(decision);
    }
    entry.waiters.clear();
    for (const waiter of entry.fieldInputWaiters.values()) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve({ decision: "deny" });
    }
    entry.fieldInputWaiters.clear();
    for (const waiter of entry.userlandWaiters.values()) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve({ kind: "dismissed" });
    }
    entry.userlandWaiters.clear();
    for (const waiter of entry.deviceCodeWaiters.values()) {
      waiter.cancel();
    }
    entry.deviceCodeWaiters.clear();
    for (const waiter of entry.externalAgentWaiters.values()) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve({ behavior: "deny" });
    }
    entry.externalAgentWaiters.clear();
  }

  function settleUserlandEntry(entry: QueueEntry, choice: string): void {
    removeEntry(entry);
    for (const waiter of entry.userlandWaiters.values()) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve({ kind: "choice", choice });
    }
    entry.userlandWaiters.clear();
    for (const waiter of entry.waiters.values()) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve("deny");
    }
    entry.waiters.clear();
    for (const waiter of entry.fieldInputWaiters.values()) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve({ decision: "deny" });
    }
    entry.fieldInputWaiters.clear();
    for (const waiter of entry.deviceCodeWaiters.values()) {
      waiter.cancel();
    }
    entry.deviceCodeWaiters.clear();
    for (const waiter of entry.externalAgentWaiters.values()) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve({ behavior: "deny" });
    }
    entry.externalAgentWaiters.clear();
  }

  function settleExternalAgentEntry(entry: QueueEntry, behavior: "allow" | "deny"): void {
    removeEntry(entry);
    for (const waiter of entry.externalAgentWaiters.values()) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve({ behavior });
    }
    entry.externalAgentWaiters.clear();
  }

  function autoApproveUserlandChoice(options: UserlandApprovalOption[]): string {
    const selected =
      options.find((option) => option.tone === "primary") ??
      options.find((option) => option.tone !== "danger") ??
      options[0];
    if (!selected) {
      throw new Error("Cannot auto-approve a userland approval without options");
    }
    return selected.value;
  }

  return {
    request(req) {
      if (autoApproveDecision) {
        return Promise.resolve(autoApproveDecision);
      }

      const dedupKey = dedupKeyFor(req);
      let entry = entriesByDedupKey.get(dedupKey);
      let newEntry = false;
      if (!entry) {
        const approval = createPendingApproval(req);
        entry = {
          approval,
          dedupKey,
          requestedByUserId: req.requestedByUserId,
          waiters: new Map(),
          fieldInputWaiters: new Map(),
          userlandWaiters: new Map(),
          deviceCodeWaiters: new Map(),
          externalAgentWaiters: new Map(),
          nextWaiterId: 0,
        };
        entriesById.set(approval.approvalId, entry);
        entriesByDedupKey.set(dedupKey, entry);
        newEntry = true;
      }

      const bound = entry;
      return new Promise<GrantedDecision>((resolve) => {
        const waiterId = bound.nextWaiterId++;
        const waiter: QueueWaiter = { resolve, signal: req.signal };

        if (req.signal) {
          const onAbort = () => {
            const e = entriesById.get(bound.approval.approvalId);
            if (!e) {
              resolve("deny");
              return;
            }
            if (e.settlement) return;
            e.waiters.delete(waiterId);
            if (
              e.waiters.size === 0 &&
              e.fieldInputWaiters.size === 0 &&
              e.userlandWaiters.size === 0
            ) {
              removeEntry(e);
              emitPendingChanged();
            }
            resolve("deny");
          };
          waiter.onAbort = onAbort;
          if (req.signal.aborted) {
            queueMicrotask(onAbort);
          } else {
            req.signal.addEventListener("abort", onAbort, { once: true });
          }
        }

        bound.waiters.set(waiterId, waiter);

        if (newEntry) {
          emitPendingChanged();
        }
      });
    },

    requestClientConfig(req) {
      return enqueueFieldInputRequest(
        req,
        "client-config",
        "Approval dedup collision for client config request"
      );
    },

    requestCredentialInput(req) {
      return enqueueFieldInputRequest(
        req,
        "credential-input",
        "Approval dedup collision for credential input request"
      );
    },

    requestSecretInput(req) {
      return enqueueFieldInputRequest(
        req,
        "secret-input",
        "Approval dedup collision for secret input request"
      );
    },

    presentDeviceCode(req) {
      const dedupKey = dedupKeyFor(req);
      const approval = createPendingApproval(req) as PendingDeviceCodeApproval;
      const entry: QueueEntry = {
        approval,
        dedupKey,
        requestedByUserId: req.requestedByUserId,
        waiters: new Map(),
        fieldInputWaiters: new Map(),
        userlandWaiters: new Map(),
        deviceCodeWaiters: new Map(),
        externalAgentWaiters: new Map(),
        nextWaiterId: 0,
      };
      entriesById.set(approval.approvalId, entry);
      entriesByDedupKey.set(dedupKey, entry);

      const controller = new AbortController();
      const waiterId = entry.nextWaiterId++;
      entry.deviceCodeWaiters.set(waiterId, {
        cancel: () => {
          if (!controller.signal.aborted) controller.abort();
        },
      });
      emitPendingChanged();

      let disposed = false;
      const handle: DeviceCodeApprovalHandle = {
        approvalId: approval.approvalId,
        cancelled: controller.signal,
        dispose: () => {
          if (disposed) return;
          const e = entriesById.get(approval.approvalId);
          if (!e) return;
          if (e.settlement) return;
          disposed = true;
          removeEntry(e);
          e.deviceCodeWaiters.clear();
          emitPendingChanged();
        },
      };
      return handle;
    },

    requestUserland(req) {
      if (autoApproveDecision) {
        return Promise.resolve({
          kind: "choice",
          choice: autoApproveUserlandChoice(req.options),
        });
      }

      const dedupKey = userlandDedupKeyFor(req);
      let entry = entriesByDedupKey.get(dedupKey);
      let newEntry = false;
      if (!entry) {
        const principalBase = {
          callerId: req.principal.callerId,
          callerKind: req.principal.callerKind,
          repoPath: req.principal.repoPath,
          effectiveVersion: req.principal.effectiveVersion,
          ...(req.principal.requesterCategory
            ? { requesterCategory: req.principal.requesterCategory }
            : {}),
        };
        const requester = req.principal.requester ?? resolveRequesterFor(principalBase);
        const callerTitle =
          req.principal.callerTitle ?? requester?.title ?? resolveTitle(req.principal.callerId);
        const enrichedIssuer = req.issuer
          ? {
              ...req.issuer,
              ...(req.issuer.label === undefined
                ? (() => {
                    const resolved = resolveTitle(req.issuer.id);
                    return resolved !== undefined ? { label: resolved } : {};
                  })()
                : {}),
            }
          : undefined;
        const approval = {
          approvalId: randomUUID(),
          callerId: req.principal.callerId,
          callerKind: req.principal.callerKind,
          repoPath: req.principal.repoPath,
          effectiveVersion: req.principal.effectiveVersion,
          requestedAt: Date.now(),
          ...(callerTitle !== undefined ? { callerTitle } : {}),
          ...(requester ? { requester } : {}),
          operation: {
            kind: "userland",
            verb: req.title,
            object: {
              type: "userland-subject",
              label: req.subject.label ?? "Subject",
              value: req.subject.id,
            },
          },
          kind: "userland",
          ...(enrichedIssuer ? { issuer: enrichedIssuer } : {}),
          subject: req.subject,
          title: req.title,
          summary: req.summary,
          warning: req.warning,
          details: req.details,
          positiveEvidence: req.positiveEvidence,
          severity: req.severity,
          defaultAction: req.defaultAction,
          promptOptions: req.promptOptions,
          options: req.options,
        } satisfies PendingUserlandApproval;
        entry = {
          approval,
          dedupKey,
          requestedByUserId: req.requestedByUserId,
          waiters: new Map(),
          fieldInputWaiters: new Map(),
          userlandWaiters: new Map(),
          deviceCodeWaiters: new Map(),
          externalAgentWaiters: new Map(),
          nextWaiterId: 0,
        };
        entriesById.set(approval.approvalId, entry);
        entriesByDedupKey.set(dedupKey, entry);
        newEntry = true;
      }

      if (entry.approval.kind !== "userland") {
        throw new Error("Approval dedup collision for userland request");
      }

      const bound = entry;
      return new Promise<UserlandApprovalResult>((resolve) => {
        const waiterId = bound.nextWaiterId++;
        const waiter: UserlandQueueWaiter = { resolve, signal: req.signal };

        if (req.signal) {
          const onAbort = () => {
            const e = entriesById.get(bound.approval.approvalId);
            if (!e) {
              resolve({ kind: "dismissed" });
              return;
            }
            if (e.settlement) return;
            e.userlandWaiters.delete(waiterId);
            if (
              e.waiters.size === 0 &&
              e.fieldInputWaiters.size === 0 &&
              e.userlandWaiters.size === 0
            ) {
              removeEntry(e);
              emitPendingChanged();
            }
            resolve({ kind: "dismissed" });
          };
          waiter.onAbort = onAbort;
          if (req.signal.aborted) {
            queueMicrotask(onAbort);
          } else {
            req.signal.addEventListener("abort", onAbort, { once: true });
          }
        }

        bound.userlandWaiters.set(waiterId, waiter);

        if (newEntry) {
          emitPendingChanged();
        }
      });
    },

    requestExternalAgent(req) {
      if (autoApproveDecision) {
        return Promise.resolve({ behavior: "allow" });
      }

      // Each relayed permission is its own one-shot decision — never deduped, so
      // one verdict can't release another tool call. Keyed by the unique
      // requestId (plus a nonce) for defensive isolation.
      const dedupKey = canonicalKey([
        "external-agent",
        req.entityId,
        req.channelId,
        req.requestId,
        randomUUID(),
      ]);
      const requester = resolveRequesterFor(req);
      const callerTitle = requester?.title ?? resolveTitle(req.callerId);
      const descriptor: ApprovalOperationDescriptor = {
        kind: "external-agent",
        verb: `run ${req.operationName}`,
        object: { type: "tool", label: "Tool", value: req.operationName },
      };
      const approval: PendingExternalAgentApproval = {
        approvalId: randomUUID(),
        callerId: req.callerId,
        callerKind: req.callerKind,
        repoPath: req.repoPath,
        effectiveVersion: req.effectiveVersion,
        requestedAt: Date.now(),
        ...(callerTitle !== undefined ? { callerTitle } : {}),
        ...(requester ? { requester } : {}),
        operation: descriptor,
        kind: "external-agent",
        entityId: req.entityId,
        channelId: req.channelId,
        capability: req.capability,
        operationName: req.operationName,
        ...(req.description !== undefined ? { description: req.description } : {}),
        ...(req.preview !== undefined ? { preview: req.preview } : {}),
        requestId: req.requestId,
        resolveToken: req.resolveToken,
      };

      const entry: QueueEntry = {
        approval,
        dedupKey,
        requestedByUserId: req.requestedByUserId,
        waiters: new Map(),
        fieldInputWaiters: new Map(),
        userlandWaiters: new Map(),
        deviceCodeWaiters: new Map(),
        externalAgentWaiters: new Map(),
        nextWaiterId: 0,
      };
      entriesById.set(approval.approvalId, entry);
      entriesByDedupKey.set(dedupKey, entry);

      return new Promise<ExternalAgentApprovalResult>((resolve) => {
        const waiterId = entry.nextWaiterId++;
        const waiter: ExternalAgentQueueWaiter = { resolve, signal: req.signal };

        if (req.signal) {
          // Auto-deny on expiry (the service arms a ~120s timeout) or caller
          // cancellation: the card disappears and the relay is denied.
          const onAbort = () => {
            const e = entriesById.get(entry.approval.approvalId);
            if (!e) {
              resolve({ behavior: "deny" });
              return;
            }
            if (e.settlement) return;
            e.externalAgentWaiters.delete(waiterId);
            if (e.externalAgentWaiters.size === 0) {
              removeEntry(e);
              emitPendingChanged();
            }
            resolve({ behavior: "deny" });
          };
          waiter.onAbort = onAbort;
          if (req.signal.aborted) {
            queueMicrotask(onAbort);
          } else {
            req.signal.addEventListener("abort", onAbort, { once: true });
          }
        }

        entry.externalAgentWaiters.set(waiterId, waiter);
        emitPendingChanged();
      });
    },

    onPendingChanged(listener) {
      pendingListeners.add(listener);
      return () => {
        pendingListeners.delete(listener);
      };
    },

    async resolve(approvalId, decision, resolver) {
      const entry = entriesById.get(approvalId);
      if (!entry) return;

      const granted: GrantedDecision = decision === "dismiss" ? "deny" : decision;
      await settle(
        entry,
        {
          decision,
          granted: granted !== "deny",
          grantScopeStored: grantScopeFor(granted),
          resolver,
        },
        (e) => settleDecisionEntry(e, granted)
      );
    },

    async resolveUserland(approvalId, choice, resolver) {
      const entry = entriesById.get(approvalId);
      if (!entry || entry.approval.kind !== "userland") return;

      if (!entry.approval.options.some((option) => option.value === choice)) {
        throw new Error(`Unknown userland approval choice: ${choice}`);
      }

      // A userland choice is a one-shot allow; the chosen option value rides in
      // `resource.key` so provenance records WHICH option was picked. Hoist the
      // subject id before `settle` so the narrowing survives the closure arg.
      const subjectId = entry.approval.subject.id;
      await settle(
        entry,
        {
          decision: "once",
          granted: true,
          resolver,
          resource: { subjectId, key: choice },
        },
        (e) => settleUserlandEntry(e, choice)
      );
    },

    async resolveExternalAgent(approvalId, behavior, resolver) {
      const entry = entriesById.get(approvalId);
      if (!entry || entry.approval.kind !== "external-agent") return;
      await settle(
        entry,
        {
          decision: behavior === "allow" ? "once" : "deny",
          granted: behavior === "allow",
          resolver,
        },
        (e) => settleExternalAgentEntry(e, behavior)
      );
    },

    async resolveExternalAgentByRequest(channelId, requestId, resolveToken, behavior, resolver) {
      const matching = Array.from(entriesById.values()).filter(
        (entry) =>
          entry.approval.kind === "external-agent" &&
          entry.approval.channelId === channelId &&
          entry.approval.requestId === requestId &&
          entry.approval.resolveToken === resolveToken
      );
      // Real verdict (allow/deny) — the waiter resolves with the user's choice,
      // exactly as the by-approvalId path does, but keyed on the runtime's
      // (channelId, requestId, resolveToken) that the inline conversation card
      // carries. Routed through the same `settle` coordinator so this inline path
      // is attributed too (WP5 §4/§6).
      for (const entry of matching) {
        await settle(
          entry,
          {
            decision: behavior === "allow" ? "once" : "deny",
            granted: behavior === "allow",
            resolver,
          },
          (e) => settleExternalAgentEntry(e, behavior)
        );
      }
      return matching.length;
    },

    settleExternalAgent(predicate) {
      const matching = Array.from(entriesById.values()).filter(
        (entry) =>
          !entry.settlement && entry.approval.kind === "external-agent" && predicate(entry.approval)
      );
      // Quiet settle: the request resolves as `deny` (the caller already has its
      // answer from elsewhere and ignores this) but no user-facing deny is
      // recorded — the card simply disappears.
      for (const entry of matching) {
        settleExternalAgentEntry(entry, "deny");
      }
      if (matching.length > 0) emitPendingChanged();
      return matching.length;
    },

    resolveMatching(predicate, decision) {
      const matching = Array.from(entriesById.values()).filter(
        (entry) => !entry.settlement && predicate(entry.approval)
      );
      for (const entry of matching) {
        settleDecisionEntry(entry, decision);
      }
      if (matching.length > 0) emitPendingChanged();
      return matching.length;
    },

    resolveMatchingUserland(predicate, choice) {
      const matching = Array.from(entriesById.values()).filter(
        (entry) =>
          !entry.settlement && entry.approval.kind === "userland" && predicate(entry.approval)
      );
      for (const entry of matching) {
        settleUserlandEntry(entry, choice);
      }
      if (matching.length > 0) emitPendingChanged();
      return matching.length;
    },

    async submitClientConfig(approvalId, values, resolver) {
      await submitFieldInput(approvalId, "client-config", values, resolver);
    },

    async submitCredentialInput(approvalId, values, resolver) {
      await submitFieldInput(approvalId, "credential-input", values, resolver);
    },

    async submitSecretInput(approvalId, values, resolver) {
      await submitFieldInput(approvalId, "secret-input", values, resolver);
    },

    listPending() {
      return Array.from(entriesById.values()).map((e) => e.approval);
    },

    cancelForCaller(callerId) {
      // Best-effort: dismiss every pending approval attributed to this caller.
      // Called by `runtime.retireEntity` after the durable retire commits.
      const matching = Array.from(entriesById.values()).filter(
        (entry) => !entry.settlement && entry.approval.callerId === callerId
      );
      for (const entry of matching) {
        removeEntry(entry);
        for (const waiter of entry.waiters.values()) {
          if (waiter.signal && waiter.onAbort) {
            waiter.signal.removeEventListener("abort", waiter.onAbort);
          }
          waiter.resolve("deny");
        }
        entry.waiters.clear();
        for (const waiter of entry.fieldInputWaiters.values()) {
          if (waiter.signal && waiter.onAbort) {
            waiter.signal.removeEventListener("abort", waiter.onAbort);
          }
          waiter.resolve({ decision: "deny" });
        }
        entry.fieldInputWaiters.clear();
        for (const waiter of entry.userlandWaiters.values()) {
          if (waiter.signal && waiter.onAbort) {
            waiter.signal.removeEventListener("abort", waiter.onAbort);
          }
          waiter.resolve({ kind: "dismissed" });
        }
        entry.userlandWaiters.clear();
        for (const waiter of entry.deviceCodeWaiters.values()) {
          waiter.cancel();
        }
        entry.deviceCodeWaiters.clear();
        for (const waiter of entry.externalAgentWaiters.values()) {
          if (waiter.signal && waiter.onAbort) {
            waiter.signal.removeEventListener("abort", waiter.onAbort);
          }
          waiter.resolve({ behavior: "deny" });
        }
        entry.externalAgentWaiters.clear();
      }
      if (matching.length > 0) emitPendingChanged();
    },
  };
}
