import { z } from "zod";
import type {
  AccountIdentity,
  CredentialGrantAction,
  CredentialBindingUse,
  CredentialInjection,
  UrlAudience,
} from "@vibestudio/credential-client/types";
import type { ApprovalDecisionId } from "./approvalContract.js";
import type { InvocationSnapshot } from "@vibestudio/rpc";
import type { UnitAuthorityRequest } from "./authorityManifest.js";

export type ApprovalDecision = ApprovalDecisionId;
export type ApprovalConfigFieldType = "text" | "secret";
export type ApprovalDetailFormat = "plain" | "markdown" | "code" | "tree";

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
// Multi-line fields (summary, detail values) legitimately carry "\n" for
// markdown code blocks; every other control character stays rejected.
const CONTROL_CHARS_EXCEPT_NEWLINE = /[\u0000-\u0009\u000B-\u001F\u007F]/;
const ZERO_WIDTH_CHARS = /[\u200B-\u200F]/g;
export function approvalCleanString(
  label: string,
  opts: { min?: number; max: number; pattern?: RegExp; multiline?: boolean }
): z.ZodType<string> {
  const controlChars = opts.multiline ? CONTROL_CHARS_EXCEPT_NEWLINE : CONTROL_CHARS;
  let schema: z.ZodType<string> = z
    .string()
    .refine((value) => !controlChars.test(value), {
      message: `${label} contains control characters`,
    })
    .transform((value) => value.replace(ZERO_WIDTH_CHARS, ""));
  if (opts.min !== undefined) {
    schema = schema.refine((value) => value.length >= opts.min!, {
      message: `${label} is too short`,
    });
  }
  schema = schema.refine((value) => value.length <= opts.max, { message: `${label} is too long` });
  if (opts.pattern) {
    schema = schema.refine((value) => opts.pattern!.test(value), {
      message: `${label} has invalid characters`,
    });
  }
  return schema;
}

export const approvalDetailSchema = z
  .object({
    label: approvalCleanString("detail label", { max: 40 }),
    value: approvalCleanString("detail value", { max: 1000, multiline: true }),
    format: z.enum(["plain", "markdown", "code", "tree"]).optional(),
  })
  .strict();

export const approvalPrincipalSchema = z
  .object({
    callerId: approvalCleanString("caller id", { min: 1, max: 200 }),
    callerKind: z.enum(["panel", "app", "worker", "do", "extension"]),
    repoPath: approvalCleanString("repo path", { min: 1, max: 300 }),
    effectiveVersion: approvalCleanString("effective version", { min: 1, max: 200 }),
    callerTitle: approvalCleanString("caller title", { max: 120 }).optional(),
  })
  .strict();

export type ApprovalRequesterKind = "panel" | "app" | "worker" | "do" | "extension" | "system";

export type ApprovalRequesterCategory =
  | "panel"
  | "workspace-app"
  | "agent"
  | "eval"
  | "worker"
  | "durable-object"
  | "extension"
  | "system"
  | "internal-service"
  | "unknown";

export interface ApprovalRequesterBreadcrumb {
  id: string;
  kind: ApprovalRequesterKind | "session" | "shell" | "server" | "extension";
  category: ApprovalRequesterCategory;
  label?: string;
  sourcePath?: string;
}

export interface ApprovalRequesterIdentity {
  id: string;
  kind: ApprovalRequesterKind;
  category: ApprovalRequesterCategory;
  /** Primary human display name chosen by the server. */
  title?: string;
  /** Nearest owning panel, when this requester belongs to panel-owned work. */
  panel?: {
    id: string;
    title?: string;
  };
  /** Code/source that created this runtime, when known. */
  sourcePath?: string;
  repoPath: string;
  effectiveVersion: string;
  contextId?: string;
  /** Stable trust/audit key: code version for normal builds, runtime id for internal/eval. */
  stableIdentityKey: string;
  /** Concrete runtime instance id. Kept visible for audit/detail views. */
  ephemeralInstanceKey: string;
  /** Eval-specific owner handle. `runId` is present only when the caller can provide it. */
  eval?: {
    ownerId?: string;
    subKey?: string;
    runId?: string;
    channelId?: string;
  };
  breadcrumbs: ApprovalRequesterBreadcrumb[];
}

export interface ApprovalOperationDescriptor {
  kind:
    | "browser"
    | "credential"
    | "filesystem"
    | "git"
    | "inspection"
    | "network"
    | "panel"
    | "runtime"
    | "worker-lifecycle"
    | "workspace"
    | "service-setup"
    | "device-code"
    | "unknown";
  verb: string;
  object?: {
    type: string;
    label: string;
    value: string;
  };
  /** Lets related low-level prompts collapse around one user-recognizable operation. */
  groupKey?: string;
}

/** Host-verified description of the exact prepared effect a decision covers. */
export interface OperationSubstance {
  kind: "change-set" | "send" | "deletion" | "custom";
  summary: string;
  detail?: string;
  /** Host-verified facts that make the prepared effect scannable without
   *  exposing transport arguments or asking the UI to interpret JSON. */
  facts?: Array<{
    label: string;
    value: string;
  }>;
  /** Must equal the prepared-state digest sealed into the invocation snapshot. */
  digest: string;
}

export type ApprovalResourceScope =
  | {
      kind: "exact";
      key: string;
      label?: string;
    }
  | {
      kind: "origin";
      origin: string;
    }
  | {
      kind: "domain";
      domain: string;
    }
  | {
      kind: "network";
      value: "*";
    };

const approvalInputFieldSchema = z
  .object({
    name: approvalCleanString("field name", {
      min: 1,
      max: 128,
      pattern: /^[a-zA-Z0-9][a-zA-Z0-9._@+=:-]{0,127}$/,
    }),
    label: approvalCleanString("field label", { min: 1, max: 128 }),
    type: z.enum(["text", "secret"]),
    required: z.boolean().optional(),
    description: approvalCleanString("field description", { max: 512 }).optional(),
  })
  .strict();

export const secretInputRequestSchema = z
  .object({
    title: approvalCleanString("title", { min: 1, max: 120 }),
    description: approvalCleanString("description", { max: 1000, multiline: true }).optional(),
    warning: approvalCleanString("warning", { max: 200 }).optional(),
    details: z.array(approvalDetailSchema).max(8).optional(),
    fields: z.array(approvalInputFieldSchema).length(1),
  })
  .strict();

/** The verified runtime caller that issued the prompt. Populated by the dispatcher. */
export interface ApprovalPrincipal {
  callerId: string;
  callerKind: "panel" | "app" | "worker" | "do" | "extension";
  repoPath: string;
  effectiveVersion: string;
  /**
   * Server-controlled human-readable name for this caller — e.g. a panel's
   * current title or a worker's `runtime.setTitle()` value. Approval UIs
   * should prefer this over the opaque `callerId`. Optional because not
   * every entity sets one; consumers fall back to the id.
   */
  callerTitle?: string;
  requesterCategory?: ApprovalRequesterCategory;
  requester?: ApprovalRequesterIdentity;
}

/**
 * One file's change within a {@link DiffReviewEntry}. `oldHash`/`newHash` are
 * content-store digests (blobstore addresses); which are present depends on
 * `kind` (removed → `oldHash` only, added → `newHash` only, changed → both).
 * The approval UI fetches those two trusted blobs by hash and line-diffs them
 * client-side. `binary`/`tooLarge` mark files rendered diffstat-only.
 */
export interface DiffReviewFile {
  path: string;
  kind: "added" | "removed" | "changed";
  oldHash?: string;
  newHash?: string;
  binary?: boolean;
  tooLarge?: boolean;
}

/**
 * One repo's worth of changes in a batch main-advance approval, host-computed
 * from `diffTrees` (provenance-aware-diff-merge-plan §9). File contents are never inlined:
 * only content hashes travel, and the approval card lazily fetches the trusted
 * blobs by hash. `newState` is `null` for a delete entry (all files `removed`);
 * `insertions`/`deletions` are OPTIONAL — omitted whenever any file in the entry
 * was skipped for line counting (binary/oversized/truncated), so `diffStat`
 * totals are always accurate or absent, never partial. `filesChanged` is always
 * exact even when `changedFiles` is truncated (`truncated: true`).
 */
export interface DiffReviewEntry {
  repoPath: string;
  oldState: string;
  newState: string | null;
  diffStat: { filesChanged: number; insertions?: number; deletions?: number };
  changedFiles: DiffReviewFile[];
  truncated?: boolean;
}

export interface PendingApprovalBase {
  // principal == { callerId, callerKind, repoPath, effectiveVersion }
  approvalId: string;
  callerId: string;
  // "system" is a host-initiated principal (e.g. workspace-startup extension
  // reconciliation), not a userland caller pretending to be one.
  callerKind: "panel" | "app" | "worker" | "do" | "extension" | "system";
  repoPath: string;
  effectiveVersion: string;
  requestedAt: number;
  /** Validation lifecycle for publication reviews; ordinary approvals are immediately ready. */
  lifecycle?: {
    state: "preparing" | "ready" | "failed" | "cancelled";
    diagnostics?: readonly string[];
  };
  /** Whether shell chrome should open this request immediately or keep it in the waiting pill. */
  attention?: "interrupt" | "queue";
  /**
   * Server-resolved display title for the caller, if known. Surfaced by the
   * shell instead of the opaque `callerId`. The id remains available for
   * audit/inspection in the approval bar's expandable details.
   */
  callerTitle?: string;
  /**
   * Structured requester identity. Optional for wire compatibility; when present,
   * UIs should prefer it over raw caller fields.
   */
  requester?: ApprovalRequesterIdentity;
  /** Structured operation metadata used for copy, grouping, and risk display. */
  operation?: ApprovalOperationDescriptor;
  /**
   * Host-computed diff-review payload (provenance-aware-diff-merge-plan §9). Attached by
   * the main-advance approval gate to workspace-main-advance / repo
   * deletion / restore prompts; absent on every other approval. Content hashes
   * only — the approval card fetches the trusted blobs lazily by hash.
   */
  diffReview?: DiffReviewEntry[];
}

export interface PendingCredentialApproval extends PendingApprovalBase {
  kind: "credential";
  /** Host-derived decisions whose scopes the credential grant store can represent exactly. */
  allowedDecisions: ReadonlyArray<"once" | "session" | "agent" | "version" | "deny">;
  credentialId: string;
  credentialLabel: string;
  audience: UrlAudience[];
  injection: CredentialInjection;
  accountIdentity: AccountIdentity;
  scopes: string[];
  credentialUse?: CredentialBindingUse;
  bindingLabel?: string;
  gitOperation?: {
    action: "read" | "write";
    label: string;
    remote: string;
    service?: string;
    force?: boolean;
    overwrites?:
      | {
          relationship: "related";
          count: number;
          commits: Array<{ sha: string; summary: string }>;
          truncated: boolean;
        }
      | {
          relationship: "unrelated";
          count: null;
          commits: Array<{ sha: string; summary: string }>;
          truncated: boolean;
        };
  };
  grantResource?: {
    bindingId: string;
    resource: string;
    action: CredentialGrantAction;
  };
  oauthAuthorizeOrigin?: string;
  oauthTokenOrigin?: string;
  oauthUserinfoOrigin?: string;
  oauthAudienceDomainMismatch?: boolean;
  replacementCredentialLabel?: string;
}

export interface PendingCapabilityApproval extends PendingApprovalBase {
  kind: "capability";
  capability: string;
  severity?: "standard" | "severe";
  grantResourceKey?: string;
  title: string;
  description?: string;
  resource?: {
    type: string;
    label: string;
    value: string;
  };
  resourceScope?: ApprovalResourceScope;
  details?: Array<{
    label: string;
    value: string;
    format?: ApprovalDetailFormat;
  }>;
  snapshot?: InvocationSnapshot;
  cardType?:
    | "permission.gated"
    | "permission.outside"
    | "confirm.critical"
    | "template.add"
    | "template.update"
    | "template.remove"
    | "template.suggest";
  /** Host-derived decisions this exact authority request can meaningfully mint. */
  allowedDecisions?: ApprovalDecision[];
  /** Canonical server-side projection used by every authority surface. */
  authorityRow?: import("./authority/authorityRows.js").AuthorityRow;
  /** Exact receiver-prepared effect shown separately from the authority row. */
  operationSubstance?: OperationSubstance;
}

export type BrowserSitePermissionCapability =
  | "camera"
  | "microphone"
  | "geolocation"
  | "notifications"
  | "downloads"
  | "clipboard"
  | "autofill"
  | "popups";

export interface PendingBrowserPermissionApproval extends PendingApprovalBase {
  kind: "browser-permission";
  ownerUserId: string;
  workspaceId: string;
  environmentKey: string;
  panelId: string;
  origin: string;
  topLevelUrl: string;
  capabilities: BrowserSitePermissionCapability[];
  deviceLabel: string;
}

export interface UnitApprovalDiffStat {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface UnitApprovalGitIdentity {
  name: string;
  email: string;
}

export interface UnitApprovalCommit {
  author: UnitApprovalGitIdentity;
  committer: UnitApprovalGitIdentity;
  message: string;
  timestamp: number;
}

/**
 * The four kinds of executable unit a review presents. Scheduled jobs and agent
 * heartbeats are deliberately absent: they are unattended charters, not units
 * with a source identity and a manifest, and they are reviewed as charters
 * alongside the parts (docs/template-install-unit-approval-ux-plan.md §8).
 */
export type ReviewedUnitKind = "extension" | "app" | "panel" | "worker";

/**
 * One workspace-owned unit an arriving publication lands, as its producer
 * describes it. The review surface renders `InstallReviewPart`s derived from
 * these; this is the raw material, not the decision contract.
 */
export interface ReviewedUnit {
  unitKind: ReviewedUnitKind;
  unitName: string;
  displayName: string;
  version?: string | null;
  /** One sentence, from the unit's own description: what it is for. */
  purpose?: string;
  target?: "electron" | "react-native" | "terminal" | null;
  source: { kind: "workspace-repo"; repo: string; ref: string };
  ev?: string | null;
  /** Native or host capabilities granted by running this unit. */
  capabilities: string[];
  /** Exact, version-bound manifest review plus human-oriented change groups. */
  authority?: {
    requests: readonly UnitAuthorityRequest[];
    serviceRequests: readonly import("./authorityManifest.js").WorkspaceServiceProtocolRequest[];
    previousServiceRequests: readonly import("./authorityManifest.js").WorkspaceServiceProtocolRequest[];
    serviceBindings?: readonly {
      protocol: string;
      availability: "required" | "optional";
      serviceName: string | null;
      providerUnit: string | null;
      catalogDigest: string | null;
    }[];
    /** Receiver-owned userland capabilities in the proposed exact build. */
    provides: readonly import("./authorityManifest.js").UserlandCapabilityDefinition[];
    /** Receiver-owned capabilities in the previously approved exact build. */
    previousProvides: readonly import("./authorityManifest.js").UserlandCapabilityDefinition[];
    rows: import("./authority/authorityRows.js").AuthorityRow[];
    diff: import("./authority/authorityRowDiff.js").AuthorityRowDiff;
  };
  dependencyEvs?: Record<string, string>;
  externalDeps?: Record<string, string>;
  integrity?: string | null;
  provider?: {
    name: string;
    activeEv: string | null;
    activeBuildKey: string | null;
    contractVersion: string;
  } | null;
  commit?: UnitApprovalCommit | null;
}

/**
 * An unattended charter arriving with a publication — a scheduled job or an
 * agent heartbeat.
 *
 * These have no source identity and no manifest, so they are not parts. They do
 * act without anyone opening anything and they cost money, which is exactly what
 * a reasonable person wants to know before accepting, so they ride the same
 * review as a plainly-worded behavioral fact rather than disappearing into a
 * config-file summary.
 */
export interface InstallReviewCharter {
  kind: "scheduled-job" | "agent-heartbeat";
  name: string;
  /** `every hour at :05` — the schedule in words, never a cron string. */
  schedule: string;
  /** One sentence: what it does when it wakes up. */
  purpose: string;
  change: "added" | "removed" | "changed";
}

/**
 * The one review every arrival of code shares
 * (docs/template-install-unit-approval-ux-plan.md §7).
 *
 * Creating a workspace from a template, installing one, updating one, and
 * accepting an edit to a part already in the workspace are the same decision
 * with the same rows and the same copy. What differs is the heading, whether
 * there is a "Not now", and whether the list is differential.
 *
 * Accepting admits every part the operation lands — selected or not — and mints
 * standing clearance only for what `allowNow` names. Selection withholds a
 * grant; it never withholds a part (U5).
 */
export interface PendingUnitInstallReviewApproval extends PendingApprovalBase {
  kind: "unit-install-review";
  mode: import("./authority/unitInstallReview.js").UnitInstallReviewMode;
  title: string;
  description: string;
  /** The template being adopted, installed, or updated. Absent for a plain edit. */
  template?: import("./authority/unitInstallReview.js").InstallReviewTemplate | null;
  parts: import("./authority/unitInstallReview.js").InstallReviewPart[];
  summary: import("./authority/unitInstallReview.js").InstallReviewSummary;
  /**
   * Parts this operation also updates whose declared authority did not change.
   * Rendered as one line — `9 other parts updated with no permission changes` —
   * because digest churn is not a decision anyone can evaluate (U7, §5.4).
   */
  unchangedPartCount: number;
  charters?: InstallReviewCharter[];
  /** Present when the same publication writes workspace config. */
  configWrite?: { repoPath: string; summary: string } | null;
}

/**
 * Review of one content-addressed unattended mission closure. The permission
 * section is the same AuthorityRow/AuthorityRowDiff projection used by unit
 * review, JIT approval, and Permissions; charter mechanics stay typed side
 * sections rather than becoming a second permission language.
 */
export interface PendingMissionReviewApproval extends PendingApprovalBase {
  kind: "mission-review";
  missionId: string;
  revision: number;
  closureDigest: string;
  reviewKind: "draft" | "revision" | "out-of-charter";
  title: string;
  taskSummary: string;
  triggerSummary: string;
  authority: {
    rows: import("./authority/authorityRows.js").AuthorityRow[];
    diff: import("./authority/authorityRowDiff.js").AuthorityRowDiff;
  };
  toolkitDomains: import("./authority/authorityDomains.js").AuthorityDomainId[];
  networkSummary: string;
  lineageSummary: string;
  charter: import("./authority/mission.js").MissionCharter;
  charterChanges: Array<{
    field: "task" | "schedule" | "toolkit" | "network" | "data-flow" | "model";
    before?: string;
    after: string;
    widening: boolean;
  }>;
  blockedAt?: number;
}

export interface PendingClientConfigField {
  name: string;
  label: string;
  type: ApprovalConfigFieldType;
  required: boolean;
  description?: string;
}

export interface PendingClientConfigApproval extends PendingApprovalBase {
  kind: "client-config";
  configId: string;
  authorizeUrl: string;
  tokenUrl: string;
  title: string;
  description?: string;
  fields: PendingClientConfigField[];
}

export interface PendingCredentialInputApproval extends PendingApprovalBase {
  kind: "credential-input";
  title: string;
  description?: string;
  credentialLabel: string;
  audience: UrlAudience[];
  injection: CredentialInjection;
  accountIdentity: AccountIdentity;
  scopes: string[];
  fields: PendingClientConfigField[];
}

export interface PendingSecretInputApproval extends PendingApprovalBase {
  kind: "secret-input";
  title: string;
  description?: string;
  warning?: string;
  details?: Array<{
    label: string;
    value: string;
    format?: ApprovalDetailFormat;
  }>;
  fields: PendingClientConfigField[];
}

/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628) flow status.
 *
 * Surfaced on the trusted approval bar so the user can read the `userCode`
 * to type into the provider's verification page (when the provider doesn't
 * embed it in `verification_uri_complete`), and so the polling loop is
 * cancellable. The server auto-resolves this approval when polling
 * completes — granted, denied, or expired — without user interaction.
 */
export interface PendingDeviceCodeApproval extends PendingApprovalBase {
  kind: "device-code";
  credentialLabel: string;
  /** The short code the user types into the provider's page. */
  userCode: string;
  /** The page the user opens to enter the code. */
  verificationUri: string;
  /**
   * Some providers (Google, GitHub, others) return a URL with the code
   * pre-filled. When present, the vibestudio shell auto-opens this URL; the
   * user code is still displayed in case the user prefers to type it.
   */
  verificationUriComplete?: string;
  /** Wall-clock ms when the device authorization expires. */
  expiresAt: number;
  /** Origin of the OAuth provider's token endpoint (for display). */
  oauthTokenOrigin: string;
}

export type SecretInputResult =
  | { decision: "submit"; values: Record<string, string> }
  | { decision: "deny" };

export type SecretInputRequest = z.infer<typeof secretInputRequestSchema>;

export type PendingApproval =
  | PendingCredentialApproval
  | PendingCapabilityApproval
  | PendingUnitInstallReviewApproval
  | PendingMissionReviewApproval
  | PendingClientConfigApproval
  | PendingCredentialInputApproval
  | PendingSecretInputApproval
  | PendingDeviceCodeApproval
  | PendingBrowserPermissionApproval;
