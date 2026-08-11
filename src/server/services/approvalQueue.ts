/**
 * Sensitive action queue for shell-owned prompts.
 *
 * Despite the historical ApprovalQueue name, this queue handles more than
 * access approvals: one-shot actions, reusable permission grants, and
 * privileged setup prompts all share this user-decision rendezvous point.
 */

import { randomUUID } from "node:crypto";

import { canonicalKey } from "@vibestudio/shared/canonicalKey";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import { getApprovalCopy } from "@vibestudio/shared/approvalCopy";
import type { UnitAuthorityRequest } from "@vibestudio/shared/authorityManifest";
import type { CapabilityPresentationResolver } from "@vibestudio/shared/authorityPresentation";
import type { TemplateInstallResolution } from "@vibestudio/shared/authority/unitInstallReview";
import type {
  InstallReviewLanding,
  InstallReviewResolution,
  InstallReviewResolvedPart,
} from "@vibestudio/service-schemas/shellApproval";
import type { InstallReviewSelectionStore } from "./installReviewSelections.js";
import { reviewedUnitPart, unresolvedOrigin } from "@vibestudio/shared/authority/reviewedUnitParts";
import {
  summarizeParts,
  type InstallReviewOrigin,
  type InstallReviewPart,
} from "@vibestudio/shared/authority/unitInstallReview";
import type { EventService } from "@vibestudio/shared/eventsService";
import type {
  ApprovalDecision,
  ApprovalOperationDescriptor,
  ApprovalRequesterCategory,
  ApprovalRequesterIdentity,
  DiffReviewEntry,
  PendingApproval,
  ApprovalPreparationProgress,
  PendingCapabilityApproval,
  PendingBrowserPermissionApproval,
  PendingCredentialApproval,
  PendingCredentialInputApproval,
  PendingSecretInputApproval,
  PendingClientConfigApproval,
  PendingDeviceCodeApproval,
  PendingMissionReviewApproval,
  PendingUnitInstallReviewApproval,
  ReviewedUnit,
} from "@vibestudio/shared/approvals";
import type {
  AccountIdentity,
  CredentialInjection,
  UrlAudience,
} from "@vibestudio/credential-client/types";
import type { UserSubject } from "@vibestudio/identity/types";
import type {
  ApprovalProvenanceKind,
  ApprovalRequestedBy,
  ApprovalResolvedBy,
  ApprovalResolvedEvent,
  ApprovalResource,
  GrantScopeStored,
  ResolvedVia,
} from "@vibestudio/shared/governance/types";

/** A grant-or-deny verdict that can be represented by an authority row. */
export type GrantedDecision =
  | "once"
  | "task"
  | "mission"
  | "agent"
  | "lock"
  | "session"
  | "version"
  | "always"
  | "block"
  | "deny";
/** Terminal queue result. Dismiss is deliberately distinct from an explicit deny. */
export type AuthorityApprovalQueueDecision =
  | "once"
  | "task"
  | "mission"
  | "agent"
  | "lock"
  | "session"
  | "version"
  | "deny"
  | "dismiss";
export type UnitInstallReviewQueueDecision = "accepted" | "deny" | "dismiss";
export type ApprovalQueueDecision = AuthorityApprovalQueueDecision | UnitInstallReviewQueueDecision;
export type BrowserPermissionApprovalDecision = "once" | "session" | "always" | "block" | "dismiss";

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
  /** Presentation routing only; it never changes the approval's authority semantics. */
  attention?: "interrupt" | "queue";
  /**
   * The REQUESTING user's `subject.userId` (WP5 §5.1), stamped by the enqueuing
   * service so a resolution record can name both parties. Attribution only.
   */
  requestedByUserId?: string;
  requesterCategory?: ApprovalRequesterCategory;
  operation?: ApprovalOperationDescriptor;
  /**
   * Host-computed diff-review payload (provenance-aware-diff-merge-plan §9), forwarded
   * verbatim onto the pending approval. Set by the main-advance gate for
   * capability (advance/delete/restore) and unit-install-review (meta) prompts.
   */
  diffReview?: DiffReviewEntry[];
  signal?: AbortSignal;
}

export interface CredentialApprovalQueueRequest extends ApprovalQueueRequestBase {
  kind?: "credential";
  allowedDecisions: PendingCredentialApproval["allowedDecisions"];
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
   * Producer identity for an otherwise exact duplicate. `null` isolates this
   * request. A value may narrow coalescing, but never widens it across distinct
   * consent facts.
   */
  dedupKey?: string | null;
  title: string;
  description?: string;
  resource?: PendingCapabilityApproval["resource"];
  resourceScope?: PendingCapabilityApproval["resourceScope"];
  grantResourceKey?: string;
  details?: PendingCapabilityApproval["details"];
  snapshot?: PendingCapabilityApproval["snapshot"];
  cardType?: PendingCapabilityApproval["cardType"];
  allowedDecisions?: PendingCapabilityApproval["allowedDecisions"];
  authorityRow?: PendingCapabilityApproval["authorityRow"];
  operationSubstance?: PendingCapabilityApproval["operationSubstance"];
}

export interface BrowserPermissionApprovalQueueRequest extends ApprovalQueueRequestBase {
  kind: "browser-permission";
  ownerUserId: string;
  workspaceId: string;
  environmentKey: string;
  panelId: string;
  origin: string;
  topLevelUrl: string;
  capabilities: PendingBrowserPermissionApproval["capabilities"];
  deviceLabel: string;
}

/**
 * Assemble the parts a review renders from the units its producers described.
 *
 * Every classification — timing, clearance, notability — happens here, on the
 * server, from facts the platform verified. The client renders; it never
 * decides, and an acceptance that names a row this did not offer is refused.
 */
function installReviewParts(
  req: UnitInstallReviewQueueRequest,
  /**
   * Where a part came from before whatever owns it now, asked per repository.
   *
   * A dep rather than a field every request site has to remember, for the same
   * reason admission asks for its source rather than being told: a site that
   * forgot would silently drop the only audit trail explaining the grants a
   * removed template's parts still hold (§U2, §7.7). A request that already
   * knows the answer may still say so, and wins.
   */
  historicalOriginFor?: (repoPath: string) => string | null,
  presentationFor?: CapabilityPresentationResolver
): InstallReviewPart[] {
  // One review can coalesce several producers — declared extensions and the ones
  // a host target requires, apps staged by more than one reconcile pass — and
  // the same unit version legitimately arrives from more than one of them.
  // Listing it twice is never right: the user would read the same part, with the
  // same rows, as though it were two things being added.
  const units = new Map<string, ReviewedUnit>();
  for (const unit of req.units) {
    units.set(`${unit.source.repo}\0${unit.ev ?? ""}`, unit);
  }
  // Receiver definitions carried by the same operation, so a service declared by
  // one part is classified rather than unknown for the part that calls it.
  const userlandDefinitions = new Map(
    [...units.values()].flatMap((unit) =>
      (unit.authority?.provides ?? []).map(
        (definition) => [`workspace-service:${definition.name}`, definition] as const
      )
    )
  );
  return [...units.values()].map((unit) => {
    const repoPath = unit.source.repo;
    const previousRequests = req.previousRequests?.get(repoPath);
    const previouslyCleared = req.previouslyCleared?.get(repoPath);
    const section = req.sections?.get(repoPath);
    // Only for a part whose current ownership and recorded source disagree —
    // the resolver answers null while a live template still claims it, so this
    // never doubles the origin line the card already shows.
    const originallyInstalledFrom =
      req.originallyInstalledFrom?.get(repoPath) ?? historicalOriginFor?.(repoPath) ?? null;
    return reviewedUnitPart({
      unit,
      identityKey: req.identityKeys?.get(repoPath) ?? `${repoPath}@${unit.ev ?? ""}`,
      origin: req.origins?.get(repoPath) ?? unresolvedOrigin(),
      userlandDefinitions,
      ...(presentationFor ? { presentationFor } : {}),
      ...(previousRequests === undefined ? {} : { previousRequests }),
      ...(previouslyCleared ? { previouslyCleared } : {}),
      ...(section ? { section } : {}),
      ...(originallyInstalledFrom ? { originallyInstalledFrom } : {}),
      change: previousRequests === undefined ? "added" : "changed",
    });
  });
}

/**
 * The result state of a review, in the words §7.2 gives it.
 *
 * Three tenses, and which one is used is decided by evidence, never by hope:
 * past tense only for a landing that was reported, present continuous for one
 * nobody watched, and a named failure when parts did not arrive. `News added`
 * on an operation the server did not see finish would be the one lie this
 * surface cannot afford — the user would go looking for a panel that is not
 * there and conclude the permission screen lies.
 */
const INSTALL_RESULT_VERB: Record<
  PendingUnitInstallReviewApproval["mode"],
  { done: string; doing: string }
> = {
  install: { done: "added", doing: "Adding" },
  update: { done: "updated", doing: "Updating" },
  remove: { done: "removed", doing: "Removing" },
  "adopt-root": { done: "ready", doing: "Setting up" },
  "part-changed": { done: "updated", doing: "Updating" },
};

/** What this decision was about: the template, or the one part that changed. */
function installResultSubject(approval: PendingUnitInstallReviewApproval): string | null {
  const templateTitle = approval.template?.title?.trim();
  if (templateTitle) return templateTitle;
  if (approval.mode === "part-changed") return approval.parts[0]?.title?.trim() || null;
  return null;
}

function installResultHeading(input: {
  approval: PendingUnitInstallReviewApproval;
  decision: "accepted" | "cancelled";
  subject: string | null;
  landing: InstallReviewLanding | undefined;
}): string {
  const { approval, subject, landing } = input;
  const verb = INSTALL_RESULT_VERB[approval.mode];
  // Adopting a root is the workspace itself, which has no title to name and
  // reads badly in the template's grammar: "Your workspace ready".
  const workspaceScale = approval.mode === "adopt-root" || !subject;
  if (input.decision === "cancelled") {
    return workspaceScale ? "Nothing changed" : `${subject} was not ${verb.done}`;
  }
  if (!landing) {
    return workspaceScale ? "Setting up your workspace…" : `${verb.doing} ${subject}…`;
  }
  if (landing.failed.length === 0) {
    return workspaceScale ? "Your workspace is ready" : `${subject} ${verb.done}`;
  }
  if (landing.landed.length === 0) {
    return workspaceScale
      ? "Nothing could be set up"
      : `${subject} could not be ${verb.done === "ready" ? "set up" : verb.done}`;
  }
  return workspaceScale
    ? "Only part of your workspace was set up"
    : `${subject} was only partly ${verb.done}`;
}

function installResultDetail(input: {
  decision: "accepted" | "cancelled";
  landing: InstallReviewLanding | undefined;
}): string | undefined {
  if (input.decision === "cancelled") {
    // The one place this system may promise a clean slate without asking
    // anyone: cancel never reached the operation, so there is nothing to unwind
    // (§8).
    return "Your workspace is unchanged.";
  }
  const landing = input.landing;
  if (!landing || landing.failed.length === 0) return undefined;
  const names = landing.failed.map((failure) => failure.title).join(", ");
  // "leaves nothing behind" is a claim about residue, and only the operation
  // that failed knows whether its own partial failure unwound. Say it when it
  // was guaranteed; otherwise say what is certain — which parts are missing —
  // and say nothing at all about the rest.
  const residue = landing.workspaceUnchanged
    ? " Nothing was left behind."
    : landing.landed.length > 0
      ? ` The other ${landing.landed.length === 1 ? "part" : `${landing.landed.length} parts`} arrived.`
      : "";
  return `These parts did not arrive: ${names}.${residue}`;
}

/**
 * Where to go next, when the accepted slate contains something a person opens.
 *
 * A panel is the openable thing; an agent or an extension has no place to send
 * anyone. Never offered for a part a reported landing says did not arrive —
 * `Open News →` pointing at nothing is worse than no link.
 */
function installResultEntryPoint(
  approval: PendingUnitInstallReviewApproval,
  landing: InstallReviewLanding | undefined
): InstallReviewResolution["entryPoint"] {
  if (approval.mode === "remove") return undefined;
  const openable = approval.parts.filter(
    (part) =>
      (part.kind === "panel" || part.kind === "app") &&
      part.section !== "repair" &&
      part.change !== "removed" &&
      (!landing || landing.landed.includes(part.identityKey))
  );
  const chosen = openable.find((part) => part.kind === "panel") ?? openable[0];
  if (!chosen) return undefined;
  return {
    identityKey: chosen.identityKey,
    repoPath: chosen.repoPath,
    title: chosen.displayName ?? chosen.title,
    kind: chosen.kind === "panel" ? "panel" : "app",
  };
}

export interface UnitInstallReviewQueueRequest extends ApprovalQueueRequestBase {
  kind: "unit-install-review";
  dedupKey?: string | null;
  mode: PendingUnitInstallReviewApproval["mode"];
  title: string;
  description: string;
  /** The units this operation lands, as their producers describe them. */
  units: ReviewedUnit[];
  template?: PendingUnitInstallReviewApproval["template"];
  charters?: PendingUnitInstallReviewApproval["charters"];
  /** Parts updated with no declared-authority change; shown as one line (§5.4). */
  unchangedPartCount?: number;
  configWrite?: PendingUnitInstallReviewApproval["configWrite"];
  /** Previously admitted declarations, keyed by repo path, for a differential review. */
  previousRequests?: ReadonlyMap<string, readonly UnitAuthorityRequest[]>;
  /** Rows the user had already cleared, keyed by repo path (§7.3). */
  previouslyCleared?: ReadonlyMap<string, ReadonlySet<string>>;
  /** Where each unit's bytes came from, keyed by repo path. */
  origins?: ReadonlyMap<string, InstallReviewOrigin>;
  /** Identity keys, keyed by repo path, so acceptance can name exact versions. */
  identityKeys?: ReadonlyMap<string, string>;
  /**
   * Which section each part belongs to, keyed by repo path (§5.3).
   *
   * A template publication may also carry agent-authored fixes to parts the
   * template does not own. Those are changes the user did not ask for, arriving
   * inside an operation about something else, so they are shown separately and
   * default to unchecked. Absent for operations with only one kind of part.
   */
  sections?: ReadonlyMap<string, "template" | "repair">;
  /**
   * `News 1.2.0` — where a part came from, keyed by repo path, for parts whose
   * current ownership is no longer the relationship that brought them (§U2).
   *
   * Supplied only by a request site that has already resolved it; otherwise the
   * queue asks its own resolver, so no site can drop the fact by forgetting.
   */
  originallyInstalledFrom?: ReadonlyMap<string, string>;
  /**
   * This requester will call `reportInstallLanding` once its operation has
   * concluded, either way (§7.2).
   *
   * Opt-in, and load-bearing that it is: an accepted resolution waits for the
   * report, so declaring it without sending one would hang the surface that
   * asked. A requester that does not declare it produces a resolution whose
   * landing is simply absent — the card then says the operation is under way,
   * which is the only honest thing to say about an outcome nobody watched.
   */
  reportsLanding?: boolean;
  /**
   * Exact operation rendezvous for a requester that reports landing after the
   * approval entry itself has settled and left the pending queue.
   */
  landingToken?: string;
}

/** How an accepted operation actually went, from the site that performed it. */
export interface InstallLandingReport {
  /** Identity keys whose admission committed. Nothing else counts as landed. */
  landed: readonly string[];
  /** Parts that did not land, with a reason a person can read. */
  failed?: readonly { identityKey: string; reason: string }[];
  /**
   * The reporter guarantees the workspace is untouched.
   *
   * Never inferred. §8 requires cancel and failure to leave no grants and no
   * partial activation, but only the operation knows whether its own partial
   * failure actually unwound — so this is a claim its owner makes, not one the
   * queue makes on its behalf.
   */
  workspaceUnchanged?: boolean;
}

export interface MissionReviewApprovalQueueRequest extends ApprovalQueueRequestBase {
  kind: "mission-review";
  missionId: string;
  revision: number;
  closureDigest: string;
  reviewKind: PendingMissionReviewApproval["reviewKind"];
  title: string;
  taskSummary: string;
  triggerSummary: string;
  authority: PendingMissionReviewApproval["authority"];
  toolkitDomains: PendingMissionReviewApproval["toolkitDomains"];
  networkSummary: string;
  lineageSummary: string;
  charter: PendingMissionReviewApproval["charter"];
  charterChanges: PendingMissionReviewApproval["charterChanges"];
  blockedAt?: number;
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
  | UnitInstallReviewQueueRequest
  | MissionReviewApprovalQueueRequest
  | ClientConfigApprovalQueueRequest
  | CredentialInputApprovalQueueRequest
  | SecretInputApprovalQueueRequest
  | DeviceCodeApprovalQueueRequest
  | BrowserPermissionApprovalQueueRequest;
export type DecisionApprovalQueueRequest =
  | CredentialApprovalQueueRequest
  | CapabilityApprovalQueueRequest
  | UnitInstallReviewQueueRequest;
type AuthorityApprovalQueueRequest = Exclude<
  DecisionApprovalQueueRequest,
  UnitInstallReviewQueueRequest
>;

export type MissionReviewApprovalResult =
  | {
      decision: "approve";
      selectedAuthorityKeys: string[];
      decidedBy: `user:${string}`;
    }
  | { decision: "dismiss"; decidedBy: `user:${string}` }
  | { decision: "cancelled" };

export type ClientConfigApprovalResult =
  | { decision: "submit"; values: Record<string, string> }
  | { decision: "deny" };
export type FieldInputApprovalResult = ClientConfigApprovalResult;
interface QueueWaiter {
  resolve: (decision: ApprovalQueueDecision | BrowserPermissionApprovalDecision) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface FieldInputQueueWaiter {
  resolve: (result: FieldInputApprovalResult) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface DeviceCodeQueueWaiter {
  cancel: () => void;
}

interface MissionReviewQueueWaiter {
  resolve: (result: MissionReviewApprovalResult) => void;
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
  deviceCodeWaiters: Map<number, DeviceCodeQueueWaiter>;
  missionReviewWaiters: Map<number, MissionReviewQueueWaiter>;
  nextWaiterId: number;
  /** The single in-flight human settlement; competing verdicts are rejected. */
  settlement?: Promise<void>;
}

function preparationDiagnostics(error: unknown): string[] {
  const structured = (error as { errorData?: { diagnostics?: unknown } } | null)?.errorData
    ?.diagnostics;
  if (Array.isArray(structured)) {
    const diagnostics = structured.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const row = value as { file?: unknown; line?: unknown; message?: unknown };
      if (typeof row.message !== "string") return [];
      const location =
        typeof row.file === "string" && row.file.length > 0
          ? `${row.file}${typeof row.line === "number" && row.line > 0 ? `:${row.line}` : ""}: `
          : "";
      return [`${location}${row.message}`];
    });
    if (diagnostics.length > 0) return diagnostics;
  }
  return [error instanceof Error ? error.message : String(error)];
}

export interface ApprovalQueue {
  beginPreparation?(req: CapabilityApprovalQueueRequest & { dedupKey: string }): string;
  updatePreparation?(dedupKey: string, progress: ApprovalPreparationProgress): void;
  failPreparation?(dedupKey: string, error: unknown): void;
  discardPreparation?(dedupKey: string): void;
  request(req: UnitInstallReviewQueueRequest): Promise<UnitInstallReviewQueueDecision>;
  request(req: AuthorityApprovalQueueRequest): Promise<AuthorityApprovalQueueDecision>;
  requestWithHandle?(req: DecisionApprovalQueueRequest): ApprovalQueueRequestHandle;
  requestBrowserPermission?(
    req: BrowserPermissionApprovalQueueRequest
  ): Promise<BrowserPermissionApprovalDecision>;
  requestClientConfig(req: ClientConfigApprovalQueueRequest): Promise<ClientConfigApprovalResult>;
  requestCredentialInput(
    req: CredentialInputApprovalQueueRequest
  ): Promise<FieldInputApprovalResult>;
  requestSecretInput(req: SecretInputApprovalQueueRequest): Promise<FieldInputApprovalResult>;
  requestMissionReview(
    req: MissionReviewApprovalQueueRequest
  ): Promise<MissionReviewApprovalResult>;
  presentDeviceCode(req: DeviceCodeApprovalQueueRequest): DeviceCodeApprovalHandle;
  onPendingChanged?(listener: (pending: PendingApproval[]) => void): () => void;
  resolve(
    approvalId: string,
    decision: ApprovalDecision,
    resolver?: ApprovalResolver
  ): Promise<void>;
  resolveMissionReview(
    approvalId: string,
    resolution: { decision: "approve"; selectedAuthorityKeys: string[] } | { decision: "dismiss" },
    resolver: ApprovalResolver
  ): Promise<void>;
  /**
   * Accept a pending install review with exactly what the user selected, or
   * cancel it.
   *
   * The server derives the offerable set itself and rejects anything outside
   * it: an unknown identity, an unknown row, or a row whose policy keeps it
   * asking at use. A client renders what it was given and never invents a row.
   *
   * `resolver` is optional because the launch gate answers before any workspace
   * session exists and may carry no authenticated subject. Who is allowed to
   * answer is a property of the surface, enforced by the service handler that
   * owns it — not of the queue, which only records what was decided.
   */
  resolveInstallReview(
    approvalId: string,
    resolution: TemplateInstallResolution,
    resolver?: ApprovalResolver
  ): Promise<InstallReviewResolution>;
  /**
   * Say how an accepted operation went, from the site that performed it.
   *
   * Called once, after the operation commits or fails, by a requester that
   * declared `reportsLanding`. It is what turns the resolution's `landing` from
   * absent into a fact, and therefore what lets the card say `News added`
   * rather than `Adding News…`. A report for an approval with no open channel
   * is dropped: nobody is waiting for it, and inventing a listener would be a
   * second way for the same landing to be described.
   *
   * Optional on the interface for the same reason `resolveMatching` is: the
   * queue implementation always has it, and the many narrow stand-ins that only
   * ever answer capability prompts do not need to grow a method to stay valid.
   */
  reportInstallLanding?(approvalId: string, report: InstallLandingReport): void;
  reportInstallLandingByToken?(landingToken: string, report: InstallLandingReport): void;
  resolveMatching?(
    predicate: (approval: PendingApproval) => boolean,
    decision: GrantedDecision
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

export interface ApprovalQueueRequestHandle<
  Decision extends ApprovalQueueDecision = ApprovalQueueDecision,
> {
  approvalId: string;
  decision: Promise<Decision>;
}

export interface ApprovalQueueWithListeners extends ApprovalQueue {
  requestWithHandle(
    req: UnitInstallReviewQueueRequest
  ): ApprovalQueueRequestHandle<UnitInstallReviewQueueDecision>;
  requestWithHandle(
    req: AuthorityApprovalQueueRequest
  ): ApprovalQueueRequestHandle<AuthorityApprovalQueueDecision>;
  onPendingChanged(listener: (pending: PendingApproval[]) => void): () => void;
  resolveMatching(
    predicate: (approval: PendingApproval) => boolean,
    decision: GrantedDecision
  ): number;
}

export type SensitiveActionQueue = ApprovalQueue;

export function createApprovalQueue(deps: {
  eventService: EventService;
  /**
   * Carries what the user checked from the review that accepted it to the
   * admission that mints it. Absent only in tests that never accept a review.
   */
  installReviewSelections?: InstallReviewSelectionStore;
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
  /**
   * Host governance writer (WP5 §6 step 4). The single `settle` coordinator
   * hands it the same workspace-neutral snapshot it broadcasts on
   * `shell-approval:resolved`. The authenticated hub route stamps the
   * authoritative workspace id; child callers cannot supply or spoof it. A
   * human resolution does not settle until this write is acknowledged. Absent
   * → provenance is not persisted (the live surface still fires).
   */
  recordProvenance?: (record: ApprovalResolvedEvent) => void | Promise<void>;
  /**
   * Where a part was originally installed from, when that is a different fact
   * from where it comes from now (§U2, §7.7).
   *
   * Derived server-side from the template lock and the admission ledger — never
   * asserted by anything under review — and asked here so every review surface
   * shows it without each request site having to carry it. Absent in tests and
   * in hosts with no workspace: a part then simply states no history, which is
   * the honest failure.
   */
  originallyInstalledFrom?: (repoPath: string) => string | null;
  /** Exact workspace-owned review metadata for dynamic service envelopes. */
  presentationFor?: CapabilityPresentationResolver;
}): ApprovalQueueWithListeners {
  const { eventService } = deps;
  const resolveTitle = deps.resolveTitle ?? (() => undefined);
  const entriesById = new Map<string, QueueEntry>();
  const entriesByDedupKey = new Map<string, QueueEntry>();
  const preparationsByProducerKey = new Map<string, QueueEntry>();
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

  /**
   * Landing reports in flight, keyed by approval id (§7.2 result state).
   *
   * A decision and its landing are two events, in that order: the review
   * settles, the operation that lands the parts resumes, and only then is there
   * anything true to say about whether they arrived. The queue keeps the
   * question open across that gap so the resolution can answer it, and holds
   * exactly one channel per approval — a second report is the same landing
   * described twice, never a second landing.
   */
  const landingChannels = new Map<
    string,
    {
      promise: Promise<InstallLandingReport | null>;
      settle: (report: InstallLandingReport) => void;
    }
  >();
  const landingApprovalIdsByToken = new Map<string, string>();
  const landingTokensByApprovalId = new Map<string, Set<string>>();

  function openLandingChannel(approvalId: string, landingToken?: string): void {
    // A duplicate watched requester shares the one operation and therefore the
    // one landing report. Never replace the channel a resolver may already be
    // awaiting.
    if (landingToken) {
      const existing = landingApprovalIdsByToken.get(landingToken);
      if (existing && existing !== approvalId) {
        throw new Error(`Install landing token ${landingToken} is already bound to another review`);
      }
    }
    if (!landingChannels.has(approvalId)) {
      let settle!: (report: InstallLandingReport) => void;
      const promise = new Promise<InstallLandingReport | null>((resolve) => {
        settle = resolve;
      });
      landingChannels.set(approvalId, { promise, settle });
    }
    if (landingToken) {
      landingApprovalIdsByToken.set(landingToken, approvalId);
      const tokens = landingTokensByApprovalId.get(approvalId) ?? new Set<string>();
      tokens.add(landingToken);
      landingTokensByApprovalId.set(approvalId, tokens);
    }
  }

  /** Drop a channel nobody will report on — a cancelled review lands nothing. */
  function closeLandingChannel(approvalId: string): void {
    landingChannels.delete(approvalId);
    for (const token of landingTokensByApprovalId.get(approvalId) ?? []) {
      landingApprovalIdsByToken.delete(token);
    }
    landingTokensByApprovalId.delete(approvalId);
  }

  function removeEntry(entry: QueueEntry): void {
    if (entriesById.get(entry.approval.approvalId) !== entry) return;
    entriesById.delete(entry.approval.approvalId);
    entriesByDedupKey.delete(entry.dedupKey);
    for (const [key, prepared] of preparationsByProducerKey) {
      if (prepared === entry) preparationsByProducerKey.delete(key);
    }
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
      case "browser-permission":
        return {
          capability: approval.capabilities.join(","),
          value: approval.origin,
        };
      case "credential":
        return { credentialId: approval.credentialId, value: approval.credentialLabel };
      case "credential-input":
        return { value: approval.credentialLabel };
      case "client-config":
        return { value: approval.configId };
      case "device-code":
        return { value: approval.credentialLabel };
      case "secret-input":
      case "unit-install-review":
        return { value: approval.title };
      case "mission-review":
        return { key: approval.missionId, value: approval.closureDigest };
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
    return decision === "task" ||
      decision === "mission" ||
      decision === "agent" ||
      decision === "lock" ||
      decision === "session" ||
      decision === "version" ||
      decision === "always" ||
      decision === "block"
      ? decision
      : null;
  }

  function dedupKeyFor(req: ApprovalQueueRequest): string {
    if (req.kind === "capability") {
      if (req.dedupKey === null) {
        return canonicalKey(["capability-isolated", randomUUID()]);
      }
      // A groupKey is navigation/presentation metadata, not a consent identity.
      // Coalesce only byte-for-byte equivalent security and user-visible facts;
      // otherwise one card could release waiters for an action it never showed.
      return canonicalKey([
        "capability",
        canonicalJson({
          callerId: req.callerId,
          callerKind: req.callerKind,
          repoPath: req.repoPath,
          effectiveVersion: req.effectiveVersion,
          requestedByUserId: req.requestedByUserId ?? null,
          requesterCategory: req.requesterCategory ?? null,
          producerKey: req.dedupKey ?? null,
          capability: req.capability,
          severity: req.severity ?? null,
          title: req.title,
          description: req.description ?? null,
          resource: req.resource ?? null,
          resourceScope: req.resourceScope ?? null,
          grantResourceKey: req.grantResourceKey ?? null,
          details: req.details ?? null,
          snapshot: req.snapshot ?? null,
          cardType: req.cardType ?? null,
          allowedDecisions: req.allowedDecisions ? [...req.allowedDecisions].sort() : null,
          authorityRow: req.authorityRow ?? null,
          operationSubstance: req.operationSubstance ?? null,
          operation: req.operation ?? null,
          diffReview: req.diffReview ?? null,
        }),
      ]);
    }
    if (req.kind === "browser-permission") {
      return canonicalKey([
        "browser-permission",
        req.ownerUserId,
        req.workspaceId,
        req.environmentKey,
        req.panelId,
        req.origin,
        ...req.capabilities.slice().sort(),
      ]);
    }
    if (req.kind === "unit-install-review") {
      if (req.dedupKey === null) {
        return canonicalKey(["unit-install-review-isolated", randomUUID()]);
      }
      // A producer key may narrow coalescing, never replace the consent facts.
      // Bind every server-derived and user-visible fact so a reused producer
      // key cannot let a newer operation ride an older card.
      return canonicalKey([
        "unit-install-review",
        req.dedupKey ?? null,
        canonicalJson(unitInstallReviewConsentFacts(req)),
      ]);
    }
    if (req.kind === "mission-review") {
      return canonicalKey(["mission-review", req.missionId, req.revision, req.closureDigest]);
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

  function unitInstallReviewConsentFacts(req: UnitInstallReviewQueueRequest): unknown {
    const sortedMap = <T>(map: ReadonlyMap<string, T> | undefined, value: (item: T) => unknown) =>
      map
        ? [...map.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => [key, value(item)])
        : null;
    const units = req.units
      .map((unit) => canonicalJson(unit))
      .sort()
      .map((unit) => JSON.parse(unit) as unknown);
    return {
      callerId: req.callerId,
      callerKind: req.callerKind,
      repoPath: req.repoPath,
      effectiveVersion: req.effectiveVersion,
      requestedByUserId: req.requestedByUserId ?? null,
      requesterCategory: req.requesterCategory ?? null,
      mode: req.mode,
      landingToken: req.landingToken ?? null,
      title: req.title,
      description: req.description,
      units,
      template: req.template ?? null,
      charters: req.charters ?? null,
      unchangedPartCount: req.unchangedPartCount ?? 0,
      previousRequests: sortedMap(req.previousRequests, (requests) => requests),
      previouslyCleared: sortedMap(req.previouslyCleared, (keys) => [...keys].sort()),
      origins: sortedMap(req.origins, (origin) => origin),
      originallyInstalledFrom: sortedMap(req.originallyInstalledFrom, (origin) => origin),
      identityKeys: sortedMap(req.identityKeys, (identity) => identity),
      sections: sortedMap(req.sections, (section) => section),
      configWrite: req.configWrite ?? null,
      operation: req.operation ?? null,
      diffReview: req.diffReview ?? null,
    };
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
    if (req.kind === "browser-permission") {
      return {
        kind: "browser",
        verb: `use ${req.capabilities.join(" and ")}`,
        object: { type: "site", label: "Website", value: req.origin },
      };
    }
    if (req.kind === "capability") {
      const object = req.resource
        ? {
            type: req.resource.type,
            label: req.resource.label,
            value: req.resource.value,
          }
        : undefined;
      if (
        req.capability === "workspace-main-advance" ||
        req.capability === "workspace-project-import" ||
        req.capability === "workspace-shared-git-remote"
      ) {
        return { kind: "workspace", verb: req.title, ...(object ? { object } : {}) };
      }
      if (req.capability === "network.response.read") {
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
    if (req.kind === "unit-install-review") {
      return { kind: "workspace", verb: req.title };
    }
    if (req.kind === "mission-review") {
      return {
        kind: "runtime",
        verb: "review mission",
        object: { type: "mission", label: "Mission", value: req.title },
      };
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
      lifecycle: { state: "ready" as const },
      ...(req.attention ? { attention: req.attention } : {}),
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
        snapshot: req.snapshot,
        cardType: req.cardType,
        allowedDecisions: req.allowedDecisions,
        authorityRow: req.authorityRow,
        operationSubstance: req.operationSubstance,
      } satisfies PendingCapabilityApproval;
    }
    if (req.kind === "browser-permission") {
      return {
        ...base,
        kind: "browser-permission",
        ownerUserId: req.ownerUserId,
        workspaceId: req.workspaceId,
        environmentKey: req.environmentKey,
        panelId: req.panelId,
        origin: req.origin,
        topLevelUrl: req.topLevelUrl,
        capabilities: req.capabilities,
        deviceLabel: req.deviceLabel,
      } satisfies PendingBrowserPermissionApproval;
    }
    if (req.kind === "unit-install-review") {
      const parts = installReviewParts(req, deps.originallyInstalledFrom, deps.presentationFor);
      const approval = {
        ...base,
        kind: "unit-install-review",
        mode: req.mode,
        title: req.title,
        description: req.description,
        template: req.template ?? null,
        parts,
        summary: summarizeParts(parts),
        unchangedPartCount: req.unchangedPartCount ?? 0,
        ...(req.charters?.length ? { charters: req.charters } : {}),
        configWrite: req.configWrite ?? null,
      } satisfies PendingUnitInstallReviewApproval;
      const copy = getApprovalCopy(approval);
      return { ...approval, title: copy.title, description: copy.summary };
    }
    if (req.kind === "mission-review") {
      return {
        ...base,
        kind: "mission-review",
        missionId: req.missionId,
        revision: req.revision,
        closureDigest: req.closureDigest,
        reviewKind: req.reviewKind,
        title: req.title,
        taskSummary: req.taskSummary,
        triggerSummary: req.triggerSummary,
        authority: req.authority,
        toolkitDomains: req.toolkitDomains,
        networkSummary: req.networkSummary,
        lineageSummary: req.lineageSummary,
        charter: req.charter,
        charterChanges: req.charterChanges,
        ...(req.blockedAt === undefined ? {} : { blockedAt: req.blockedAt }),
      } satisfies PendingMissionReviewApproval;
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
      allowedDecisions: req.allowedDecisions,
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
        deviceCodeWaiters: new Map(),
        missionReviewWaiters: new Map(),
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
          if (e.waiters.size === 0 && e.fieldInputWaiters.size === 0) {
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
    dismissMissionReviewWaiters(entry);
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

  function settleDecisionEntry(
    entry: QueueEntry,
    decision: ApprovalQueueDecision | BrowserPermissionApprovalDecision
  ): void {
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
    for (const waiter of entry.deviceCodeWaiters.values()) {
      waiter.cancel();
    }
    entry.deviceCodeWaiters.clear();
    dismissMissionReviewWaiters(entry);
  }

  function dismissMissionReviewWaiters(entry: QueueEntry): void {
    for (const waiter of entry.missionReviewWaiters.values()) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve({ decision: "cancelled" });
    }
    entry.missionReviewWaiters.clear();
  }

  function enqueueDecisionWithHandle(
    req: UnitInstallReviewQueueRequest
  ): ApprovalQueueRequestHandle<UnitInstallReviewQueueDecision>;
  function enqueueDecisionWithHandle(
    req: AuthorityApprovalQueueRequest
  ): ApprovalQueueRequestHandle<AuthorityApprovalQueueDecision>;
  function enqueueDecisionWithHandle(req: DecisionApprovalQueueRequest): ApprovalQueueRequestHandle;
  function enqueueDecisionWithHandle(req: BrowserPermissionApprovalQueueRequest): {
    approvalId: string;
    decision: Promise<BrowserPermissionApprovalDecision>;
  };
  function enqueueDecisionWithHandle(
    req: DecisionApprovalQueueRequest | BrowserPermissionApprovalQueueRequest
  ): {
    approvalId: string;
    decision: Promise<ApprovalQueueDecision | BrowserPermissionApprovalDecision>;
  } {
    if (
      "credentialId" in req &&
      (!Array.isArray(req.allowedDecisions) || req.allowedDecisions.length === 0)
    ) {
      throw new Error("Credential approvals must declare their allowed decisions");
    }
    const dedupKey = dedupKeyFor(req);
    const preparationKey =
      "dedupKey" in req && typeof req.dedupKey === "string" ? req.dedupKey : null;
    let entry =
      (preparationKey ? preparationsByProducerKey.get(preparationKey) : undefined) ??
      entriesByDedupKey.get(dedupKey);
    let newEntry = false;
    if (entry?.approval.lifecycle?.state === "preparing") {
      const prepared = entry.approval;
      const ready = createPendingApproval(req);
      entry.approval = {
        ...ready,
        approvalId: prepared.approvalId,
        requestedAt: prepared.requestedAt,
        lifecycle: { state: "ready" },
      } as PendingApproval;
      entriesByDedupKey.delete(entry.dedupKey);
      entry.dedupKey = dedupKey;
      entriesByDedupKey.set(dedupKey, entry);
      if (preparationKey) preparationsByProducerKey.delete(preparationKey);
      emitPendingChanged();
      console.log("[Approvals] Publication review ready", {
        approvalId: prepared.approvalId,
        timeToReadyMs: Date.now() - prepared.requestedAt,
      });
    }
    if (!entry) {
      const approval = createPendingApproval(req);
      entry = {
        approval,
        dedupKey,
        requestedByUserId: req.requestedByUserId,
        waiters: new Map(),
        fieldInputWaiters: new Map(),
        deviceCodeWaiters: new Map(),
        missionReviewWaiters: new Map(),
        nextWaiterId: 0,
      };
      entriesById.set(approval.approvalId, entry);
      entriesByDedupKey.set(dedupKey, entry);
      newEntry = true;
      // A requester that promises to say how the landing went gets a channel
      // opened for it now, while its approval id is in hand. Opened only on the
      // promise: a resolution must never wait on a report nobody will send.
    }

    const bound = entry;
    // A duplicate requester may be the first one that can observe the
    // operation's landing. Upgrade the shared pending entry to a watched
    // review even when the original waiter did not promise a report.
    if (req.kind === "unit-install-review" && req.reportsLanding) {
      try {
        openLandingChannel(bound.approval.approvalId, req.landingToken);
      } catch (error) {
        if (newEntry) removeEntry(bound);
        throw error;
      }
    }
    const decision = new Promise<ApprovalQueueDecision | BrowserPermissionApprovalDecision>(
      (resolve) => {
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
            if (e.waiters.size === 0 && e.fieldInputWaiters.size === 0) {
              if (e.approval.kind === "unit-install-review") {
                closeLandingChannel(e.approval.approvalId);
              }
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
      }
    );
    return { approvalId: bound.approval.approvalId, decision };
  }

  function requestDecision(
    req: UnitInstallReviewQueueRequest
  ): Promise<UnitInstallReviewQueueDecision>;
  function requestDecision(
    req: AuthorityApprovalQueueRequest
  ): Promise<AuthorityApprovalQueueDecision>;
  function requestDecision(req: DecisionApprovalQueueRequest): Promise<ApprovalQueueDecision> {
    return enqueueDecisionWithHandle(req).decision;
  }

  function requestDecisionWithHandle(
    req: UnitInstallReviewQueueRequest
  ): ApprovalQueueRequestHandle<UnitInstallReviewQueueDecision>;
  function requestDecisionWithHandle(
    req: AuthorityApprovalQueueRequest
  ): ApprovalQueueRequestHandle<AuthorityApprovalQueueDecision>;
  function requestDecisionWithHandle(
    req: DecisionApprovalQueueRequest
  ): ApprovalQueueRequestHandle {
    return enqueueDecisionWithHandle(req);
  }

  function enqueueMissionReview(
    req: MissionReviewApprovalQueueRequest
  ): Promise<MissionReviewApprovalResult> {
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
        deviceCodeWaiters: new Map(),
        missionReviewWaiters: new Map(),
        nextWaiterId: 0,
      };
      entriesById.set(approval.approvalId, entry);
      entriesByDedupKey.set(dedupKey, entry);
      newEntry = true;
    }
    if (entry.approval.kind !== "mission-review") {
      throw new Error("Approval dedup collision for mission review");
    }
    const bound = entry;
    return new Promise<MissionReviewApprovalResult>((resolve) => {
      const waiterId = bound.nextWaiterId++;
      const waiter: MissionReviewQueueWaiter = { resolve, signal: req.signal };
      const onAbort = () => {
        const current = entriesById.get(bound.approval.approvalId);
        if (!current) {
          resolve({ decision: "cancelled" });
          return;
        }
        if (current.settlement) return;
        current.missionReviewWaiters.delete(waiterId);
        if (
          current.waiters.size === 0 &&
          current.fieldInputWaiters.size === 0 &&
          current.missionReviewWaiters.size === 0
        ) {
          removeEntry(current);
          emitPendingChanged();
        }
        resolve({ decision: "cancelled" });
      };
      if (req.signal) {
        waiter.onAbort = onAbort;
        if (req.signal.aborted) queueMicrotask(onAbort);
        else req.signal.addEventListener("abort", onAbort, { once: true });
      }
      bound.missionReviewWaiters.set(waiterId, waiter);
      if (newEntry) emitPendingChanged();
    });
  }

  function settleMissionReviewEntry(entry: QueueEntry, result: MissionReviewApprovalResult): void {
    removeEntry(entry);
    for (const waiter of entry.missionReviewWaiters.values()) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(result);
    }
    entry.missionReviewWaiters.clear();
  }

  return {
    beginPreparation(req) {
      if (typeof req.dedupKey !== "string") {
        throw new Error("Preparing approvals require a stable producer key");
      }
      const producerKey = req.dedupKey;
      const dedupKey = dedupKeyFor(req);
      const existing = preparationsByProducerKey.get(producerKey);
      if (existing) return existing.approval.approvalId;
      const approval = {
        ...createPendingApproval(req),
        // Preparation is progress, not a decision. It may be inspected from
        // the notification pill, but must never seize the approval surface
        // before there is anything the user can answer. The ready request
        // replaces this object atomically and restores its requested attention.
        attention: "queue" as const,
        lifecycle: { state: "preparing" as const },
      };
      const entry: QueueEntry = {
        approval,
        dedupKey,
        requestedByUserId: req.requestedByUserId,
        waiters: new Map(),
        fieldInputWaiters: new Map(),
        deviceCodeWaiters: new Map(),
        missionReviewWaiters: new Map(),
        nextWaiterId: 0,
      };
      entriesById.set(approval.approvalId, entry);
      entriesByDedupKey.set(dedupKey, entry);
      preparationsByProducerKey.set(producerKey, entry);
      if (req.signal) {
        const cancel = () => {
          const current = preparationsByProducerKey.get(producerKey);
          if (!current || current.approval.lifecycle?.state !== "preparing") return;
          current.approval = {
            ...current.approval,
            lifecycle: { state: "cancelled", diagnostics: ["Publication was cancelled"] },
          };
          emitPendingChanged();
          console.log("[Approvals] Publication review cancelled", {
            approvalId: current.approval.approvalId,
            elapsedMs: Date.now() - current.approval.requestedAt,
          });
        };
        if (req.signal.aborted) queueMicrotask(cancel);
        else req.signal.addEventListener("abort", cancel, { once: true });
      }
      emitPendingChanged();
      console.log("[Approvals] Publication preparation visible", {
        approvalId: approval.approvalId,
        timeToVisibleMs: Date.now() - approval.requestedAt,
      });
      return approval.approvalId;
    },

    updatePreparation(dedupKey, progress) {
      const entry = preparationsByProducerKey.get(dedupKey);
      if (!entry || entry.approval.lifecycle?.state !== "preparing") return;
      entry.approval = {
        ...entry.approval,
        lifecycle: {
          state: "preparing",
          progress: { ...progress, updatedAt: Date.now() },
        },
      };
      emitPendingChanged();
    },

    failPreparation(dedupKey, error) {
      const entry = preparationsByProducerKey.get(dedupKey);
      if (!entry || entry.approval.lifecycle?.state !== "preparing") return;
      entry.approval = {
        ...entry.approval,
        attention: "interrupt",
        lifecycle: {
          state: "failed",
          diagnostics: preparationDiagnostics(error),
        },
      };
      emitPendingChanged();
      console.log("[Approvals] Publication review failed", {
        approvalId: entry.approval.approvalId,
        elapsedMs: Date.now() - entry.approval.requestedAt,
      });
    },

    discardPreparation(dedupKey) {
      const entry = preparationsByProducerKey.get(dedupKey);
      if (!entry || entry.approval.lifecycle?.state !== "preparing") return;
      preparationsByProducerKey.delete(dedupKey);
      removeEntry(entry);
      emitPendingChanged();
    },

    request: requestDecision,

    requestWithHandle: requestDecisionWithHandle,

    requestBrowserPermission(req) {
      return enqueueDecisionWithHandle(req).decision;
    },

    requestMissionReview(req) {
      return enqueueMissionReview(req);
    },

    requestClientConfig(req) {
      // Auto-approval is an unattended mode. Field-input prompts cannot be
      // truthfully approved because the host has no value to submit; leaving
      // them pending would deadlock the caller, while fabricating sensitive
      // material would violate the prompt contract. Deny immediately so the
      // requesting workflow receives its normal explicit rejection path.
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
        deviceCodeWaiters: new Map(),
        missionReviewWaiters: new Map(),
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

    onPendingChanged(listener) {
      pendingListeners.add(listener);
      return () => {
        pendingListeners.delete(listener);
      };
    },

    async resolve(approvalId, decision, resolver) {
      const entry = entriesById.get(approvalId);
      if (!entry) return;
      if (entry.approval.lifecycle?.state === "preparing") {
        throw new Error("Approval is still preparing and cannot be resolved");
      }
      if (
        (entry.approval.lifecycle?.state === "failed" ||
          entry.approval.lifecycle?.state === "cancelled") &&
        decision !== "dismiss" &&
        decision !== "deny"
      ) {
        throw new Error(`Approval is ${entry.approval.lifecycle.state} and cannot be granted`);
      }
      if (entry.approval.kind === "unit-install-review") {
        throw new Error("Unit install reviews must be resolved through resolveInstallReview");
      }
      if (
        (entry.approval.kind === "capability" || entry.approval.kind === "credential") &&
        decision !== "dismiss" &&
        entry.approval.allowedDecisions &&
        !(entry.approval.allowedDecisions as readonly ApprovalDecision[]).includes(decision)
      ) {
        throw new Error(`${entry.approval.kind} approval does not accept decision '${decision}'`);
      }
      if (
        entry.approval.kind === "browser-permission" &&
        !["once", "session", "always", "block", "dismiss"].includes(decision)
      ) {
        throw new Error(`Browser permission approval does not accept decision '${decision}'`);
      }
      if (
        entry.approval.kind !== "browser-permission" &&
        (decision === "always" || decision === "block")
      ) {
        throw new Error(`Approval kind '${entry.approval.kind}' does not accept '${decision}'`);
      }
      if (
        entry.approval.kind === "capability" &&
        entry.approval.cardType === "confirm.critical" &&
        decision !== "once" &&
        decision !== "deny" &&
        decision !== "dismiss"
      ) {
        throw new Error("Critical confirmations only accept confirm-once, deny, or dismiss");
      }

      const granted = decision;
      await settle(
        entry,
        {
          decision,
          granted: granted !== "deny" && granted !== "block" && granted !== "dismiss",
          grantScopeStored: granted === "dismiss" ? null : grantScopeFor(granted),
          resolver,
        },
        (e) => settleDecisionEntry(e, granted)
      );
    },

    async resolveMissionReview(approvalId, resolution, resolver) {
      const entry = entriesById.get(approvalId);
      if (!entry || entry.approval.kind !== "mission-review") return;
      const available = new Set(
        entry.approval.authority.rows.map(
          (row) => `${row.capability}\0${JSON.stringify(row.resourceScope)}`
        )
      );
      if (
        resolution.decision === "approve" &&
        (new Set(resolution.selectedAuthorityKeys).size !==
          resolution.selectedAuthorityKeys.length ||
          resolution.selectedAuthorityKeys.some((key) => !available.has(key)))
      ) {
        throw new Error("Mission review selection contains an unknown authority row");
      }
      const result: MissionReviewApprovalResult =
        resolution.decision === "dismiss"
          ? { decision: "dismiss", decidedBy: `user:${resolver.subject.userId}` }
          : {
              decision: "approve",
              selectedAuthorityKeys: resolution.selectedAuthorityKeys,
              decidedBy: `user:${resolver.subject.userId}`,
            };
      await settle(
        entry,
        {
          decision: resolution.decision === "approve" ? "approve" : "dismiss",
          granted: resolution.decision === "approve",
          grantScopeStored: resolution.decision === "approve" ? "mission" : null,
          resolver,
        },
        (current) => settleMissionReviewEntry(current, result)
      );
    },

    async resolveInstallReview(approvalId, resolution, resolver) {
      const entry = entriesById.get(approvalId);
      if (!entry || entry.approval.kind !== "unit-install-review") {
        // Already answered, or never here. Historically a silent no-op, and it
        // stays one — a second answer to a settled review must not resolve
        // anything twice. It reports the one thing that is certainly true: this
        // call decided nothing.
        // A previous resolver may still be waiting for the operation's landing.
        // A stale second answer must not delete that rendezvous; the reporter
        // will close it after the first resolution receives its result.
        return {
          approvalId,
          mode: "install",
          decision: "cancelled",
          heading: "This review is no longer open",
          parts: [],
        };
      }
      const approval = entry.approval;
      if (approval.lifecycle?.state !== undefined && approval.lifecycle.state !== "ready") {
        throw new Error(`Install review is ${approval.lifecycle.state} and cannot be resolved`);
      }
      const parts = new Map(approval.parts.map((part) => [part.identityKey, part]));
      if (resolution.decision === "cancel") {
        // Cancel leaves the workspace untouched, and the selection can never be
        // applied later by a stale hand-off.
        deps.installReviewSelections?.discard([...parts.keys()]);
        closeLandingChannel(approvalId);
        await settle(
          entry,
          { decision: "dismiss", granted: false, grantScopeStored: null, resolver },
          (current) => settleDecisionEntry(current, "dismiss")
        );
        const subject = installResultSubject(approval);
        return {
          approvalId,
          mode: approval.mode,
          decision: "cancelled",
          heading: installResultHeading({
            approval,
            decision: "cancelled",
            subject,
            landing: undefined,
          }),
          ...(installResultDetail({ decision: "cancelled", landing: undefined })
            ? { detail: installResultDetail({ decision: "cancelled", landing: undefined })! }
            : {}),
          ...(subject ? { subject } : {}),
          parts: [],
        };
      }

      const selections: Array<[string, readonly string[]]> = [];
      const seenIdentityKeys = new Set<string>();
      for (const allowed of resolution.allowNow) {
        if (seenIdentityKeys.has(allowed.identityKey)) {
          throw new Error("Install review acceptance repeats a part");
        }
        seenIdentityKeys.add(allowed.identityKey);
        const part = parts.get(allowed.identityKey);
        if (!part) {
          throw new Error("Install review acceptance names a part that is not under review");
        }
        // Only rows this review actually offered may be cleared. Contextual and
        // critical rows carry no checkbox precisely because a decision here
        // cannot grant them, so accepting one is refused rather than ignored.
        const offerable = new Set(
          [...part.notableRows, ...part.everydayRows]
            .filter((row) => row.selectable)
            .map((row) => row.key)
        );
        const requested = allowed.permissions ?? [...offerable];
        if (new Set(requested).size !== requested.length) {
          throw new Error("Install review acceptance repeats a permission");
        }
        const refused = requested.filter((key) => !offerable.has(key));
        if (refused.length > 0) {
          throw new Error(
            `Install review acceptance names ${refused.length} permission(s) this review did not offer`
          );
        }
        selections.push([allowed.identityKey, requested]);
      }
      // Every part is admitted, selected or not: a part absent from `allowNow`
      // still arrives and still runs, it simply holds no standing grant (U5).
      for (const identityKey of parts.keys()) {
        if (!selections.some(([key]) => key === identityKey)) selections.push([identityKey, []]);
      }
      deps.installReviewSelections?.record(selections);
      await settle(
        entry,
        { decision: "version", granted: true, grantScopeStored: "version", resolver },
        // The review answers a product question (accept these exact parts), not
        // an authority-scope question. Version admission is recorded above and
        // in installReviewSelections; callers receive the semantic outcome and
        // decide how their own protected operation is authorized.
        (current) => settleDecisionEntry(current, "accepted")
      );

      // The decision is recorded; the operation that lands these parts runs
      // next. Wait for its report only when its requester promised one — this
      // is the one point where the queue can hold the answering surface open
      // long enough to tell the user what actually happened, and the one place
      // it must not wait on a report that will never come.
      const channel = landingChannels.get(approvalId);
      const report = channel ? await channel.promise : null;
      closeLandingChannel(approvalId);
      const allowedNow = new Set(
        selections.filter(([, rowKeys]) => rowKeys.length > 0).map(([identityKey]) => identityKey)
      );
      const landing: InstallReviewLanding | undefined = report
        ? {
            landed: report.landed.filter((identityKey) => parts.has(identityKey)),
            failed: (report.failed ?? []).map((failure) => ({
              identityKey: failure.identityKey,
              // The part's own title, not the reporter's — a failure names the
              // part in the same words the card just used for it.
              title: parts.get(failure.identityKey)?.title ?? failure.identityKey,
              reason: failure.reason,
            })),
            workspaceUnchanged: report.workspaceUnchanged === true,
          }
        : undefined;
      const subject = installResultSubject(approval);
      const detail = installResultDetail({ decision: "accepted", landing });
      const entryPoint = installResultEntryPoint(approval, landing);
      const resolved: InstallReviewResolvedPart[] = approval.parts.map((part) => ({
        identityKey: part.identityKey,
        title: part.title,
        kind: part.kind,
        label: part.label,
        clearance: allowedNow.has(part.identityKey) ? "allowed-now" : "asks-when-needed",
      }));
      return {
        approvalId,
        mode: approval.mode,
        decision: "accepted",
        heading: installResultHeading({ approval, decision: "accepted", subject, landing }),
        ...(detail ? { detail } : {}),
        ...(subject ? { subject } : {}),
        parts: resolved,
        ...(entryPoint ? { entryPoint } : {}),
        ...(landing ? { landing } : {}),
      };
    },

    reportInstallLanding(approvalId, report) {
      landingChannels.get(approvalId)?.settle(report);
    },

    reportInstallLandingByToken(landingToken, report) {
      const approvalId = landingApprovalIdsByToken.get(landingToken);
      if (approvalId) landingChannels.get(approvalId)?.settle(report);
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
        if (entry.approval.kind === "unit-install-review") {
          closeLandingChannel(entry.approval.approvalId);
        }
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
        for (const waiter of entry.deviceCodeWaiters.values()) {
          waiter.cancel();
        }
        entry.deviceCodeWaiters.clear();
        dismissMissionReviewWaiters(entry);
      }
      if (matching.length > 0) emitPendingChanged();
    },
  };
}
