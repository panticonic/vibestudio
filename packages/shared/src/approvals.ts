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
import type {
  EvalAuthorityCeiling,
  EvalCeilingPurpose,
  UnitAuthorityRequest,
} from "./authorityManifest.js";

export type ApprovalDecision = ApprovalDecisionId;
export type ApprovalConfigFieldType = "text" | "secret";
export type ApprovalDetailFormat = "plain" | "markdown" | "code" | "tree";

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
// Multi-line fields (summary, detail values) legitimately carry "\n" for
// markdown code blocks; every other control character stays rejected.
const CONTROL_CHARS_EXCEPT_NEWLINE = /[\u0000-\u0009\u000B-\u001F\u007F]/;
const ZERO_WIDTH_CHARS = /[\u200B-\u200F]/g;
const SUBJECT_ID_PATTERN = /^[A-Za-z0-9._:/-]+$/;
const OPTION_VALUE_PATTERN = /^[A-Za-z0-9_-]+$/;
export const USERLAND_APPROVAL_RESERVED_SUBJECT_PREFIXES = [
  "shell:",
  "server:",
  "system:",
  "@",
] as const;

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

export const userlandApprovalSubjectIdSchema = approvalCleanString("subject id", {
  min: 1,
  max: 128,
  pattern: SUBJECT_ID_PATTERN,
}).refine(
  (id) => !USERLAND_APPROVAL_RESERVED_SUBJECT_PREFIXES.some((prefix) => id.startsWith(prefix)),
  { message: "subject id uses a reserved prefix" }
);

export const userlandApprovalDetailSchema = z
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

export const userlandApprovalOptionSchema = z
  .object({
    value: approvalCleanString("option value", {
      min: 1,
      max: 40,
      pattern: OPTION_VALUE_PATTERN,
    }).refine((value) => value !== "dismiss", { message: "option value is reserved" }),
    label: approvalCleanString("option label", { min: 1, max: 40 }),
    description: approvalCleanString("option description", { max: 120 }).optional(),
    tone: z.enum(["primary", "danger", "neutral"]).optional(),
  })
  .strict();

export const userlandApprovalRequestSchema = z
  .object({
    subject: z
      .object({
        id: userlandApprovalSubjectIdSchema,
        label: approvalCleanString("subject label", { max: 80 }).optional(),
      })
      .strict(),
    title: approvalCleanString("title", { min: 1, max: 120 }),
    summary: approvalCleanString("summary", { max: 1000, multiline: true }).optional(),
    warning: approvalCleanString("warning", { max: 200 }).optional(),
    details: z.array(userlandApprovalDetailSchema).max(8).optional(),
    positiveEvidence: z.array(userlandApprovalDetailSchema).max(6).optional(),
    severity: z.enum(["standard", "dangerous"]).optional(),
    defaultAction: z.enum(["allow", "deny"]).optional(),
    promptOptions: z.enum(["scoped", "choices"]).optional(),
    options: z.array(userlandApprovalOptionSchema).min(1).max(6).optional(),
  })
  .strict()
  .superRefine((req, ctx) => {
    const values = new Set<string>();
    for (const [index, option] of (req.options ?? []).entries()) {
      if (values.has(option.value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options", index, "value"],
          message: "option values must be unique",
        });
      }
      values.add(option.value);
    }
  });

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
    | "userland"
    | "external-agent"
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
    details: z.array(userlandApprovalDetailSchema).max(8).optional(),
    fields: z.array(approvalInputFieldSchema).length(1),
  })
  .strict();

// A tool-input preview is arbitrary source text (JSON, shell, code) that may
// carry tabs/newlines. Rather than reject those (approvalCleanString rejects all
// control chars, tabs included), we STRIP zero-width and non-whitespace control
// characters while keeping tab, newline, and CR so the monospace preview renders
// faithfully.
const PREVIEW_STRIP = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F]/g;
export const externalAgentPreviewSchema = z
  .string()
  .max(8000, { message: "preview is too long" })
  .transform((value) => value.replace(PREVIEW_STRIP, ""));

/**
 * Request shape for `userlandApproval.requestExternal`: a bound external agent
 * runtime relaying a tool-use permission prompt into the workspace approvals
 * system.
 * The runtime supplies these fields; the service derives the bound runtime
 * entity from the verified caller and stamps `kind: "external-agent"` onto the
 * pending approval it files. Resolution is per-request (allow/deny), with no
 * durable grant.
 */
export const externalAgentApprovalRequestSchema = z
  .object({
    channelId: approvalCleanString("channel id", { min: 1, max: 200 }),
    capability: approvalCleanString("capability", {
      min: 1,
      max: 120,
      pattern: /^[A-Za-z0-9._:-]+$/,
    }),
    operation: approvalCleanString("operation", { min: 1, max: 200 }),
    description: approvalCleanString("description", { max: 1000, multiline: true }).optional(),
    preview: externalAgentPreviewSchema.optional(),
    requestId: approvalCleanString("request id", {
      min: 1,
      max: 200,
      pattern: /^[A-Za-z0-9._:/-]+$/,
    }),
    resolveToken: approvalCleanString("resolve token", {
      min: 16,
      max: 200,
      pattern: /^[A-Za-z0-9._:/-]+$/,
    }),
  })
  .strict();

export type ExternalAgentApprovalRequest = z.infer<typeof externalAgentApprovalRequestSchema>;

/**
 * Argument for `userlandApproval.settleExternal`: the quiet-settle path. When a
 * relayed permission is answered elsewhere, the runtime withdraws the workspace
 * card without recording a deny. Scoped by the caller's verified bound-agent
 * record plus `channelId`, so one runtime cannot settle another's requests.
 */
export const externalAgentSettleSchema = z
  .object({
    channelId: approvalCleanString("channel id", { min: 1, max: 200 }),
    requestId: approvalCleanString("request id", {
      min: 1,
      max: 200,
      pattern: /^[A-Za-z0-9._:/-]+$/,
    }),
    resolution: z.enum(["answered-elsewhere"]).optional(),
  })
  .strict();

export type ExternalAgentSettle = z.infer<typeof externalAgentSettleSchema>;

/** Verdict returned to the relaying runtime by `requestExternal`. */
export type ExternalAgentApprovalResult = { behavior: "allow" | "deny" };

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

/** What a userland approval is about. The issuing provider supplies this. */
export interface UserlandApprovalSubject {
  id: string;
  label?: string;
}

/**
 * Who is asking the user. For direct panel/worker calls this equals the
 * principal; for extension-issued approvals (via `ctx.approvals.request`),
 * this identifies the extension acting on behalf of the principal.
 *
 * `label` is a server-controlled display title (panel title, worker
 * `setTitle` value, extension manifest name) — present when the server can
 * resolve it. Consumers should prefer `label` over `id` in UI.
 */
export interface UserlandApprovalIssuer {
  kind: "panel" | "app" | "worker" | "do" | "extension";
  id: string;
  label?: string;
}

/** A persisted decision for one flat (principal, subject) pair. */
export interface UserlandApprovalGrant {
  principal: {
    callerId: string;
    callerKind: "panel" | "app" | "worker" | "do" | "extension";
    repoPath?: string;
    effectiveVersion?: string;
  };
  issuer?: UserlandApprovalIssuer;
  subject: UserlandApprovalSubject;
  choice: string;
  grantedAt: number;
  scope?: UserlandApprovalGrantScope;
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
    overwrites?: {
      count: number;
      commits: Array<{ sha: string; summary: string }>;
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
  cardType?: "permission.gated" | "permission.outside" | "confirm.critical";
  /** Host-derived decisions this exact authority request can meaningfully mint. */
  allowedDecisions?: ApprovalDecision[];
}

export type BrowserSitePermissionCapability =
  | "camera"
  | "microphone"
  | "geolocation"
  | "notifications";

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

export type UnitBatchEntryKind =
  | "extension"
  | "app"
  | "panel"
  | "worker"
  | "scheduled-job"
  | "agent-heartbeat";

/**
 * One workspace-owned unit in a joint `unit-batch` approval. Carries the
 * informed-consent overview the prompt renders per row.
 */
export interface UnitBatchEntry {
  unitKind: UnitBatchEntryKind;
  unitName: string;
  displayName: string;
  version?: string | null;
  target?: "electron" | "react-native" | "terminal" | null;
  source: { kind: "workspace-repo"; repo: string; ref: string };
  ev?: string | null;
  /** Native or host capabilities granted by running this unit. */
  capabilities: string[];
  /** Exact, version-bound manifest review plus human-oriented change groups. */
  authority?: {
    requests: readonly UnitAuthorityRequest[];
    evalCeilings: readonly EvalAuthorityCeiling[];
    groups: Array<{
      id: string;
      label: string;
      description: string;
      requestCount: number;
      addedCount: number;
      items: Array<{
        capability: string;
        title: string;
        description: string;
        added: boolean;
      }>;
    }>;
    removedCount: number;
    /** Authority this version may expose to evaluated code. It is reviewed in
     * the same decision, but remains a ceiling rather than a grant. */
    eval: Array<{
      purpose: EvalCeilingPurpose;
      label: string;
      groups: Array<{
        id: string;
        label: string;
        description: string;
        requestCount: number;
        addedCount: number;
        items: Array<{
          capability: string;
          title: string;
          description: string;
          added: boolean;
        }>;
      }>;
      removedCount: number;
    }>;
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
 * Joint, informed-consent approval for the set of unapproved declared
 * workspace units. Raised at workspace startup (`trigger: "startup"`, system
 * principal) and at the protected-main boundary whenever committed source,
 * dependencies, providers, or workspace configuration change an exact unit
 * identity (`trigger: "meta-change"`). The same accepted identity is handed to
 * activation, so publication and activation never ask the same question twice.
 * One decision approves or denies the whole set.
 */
export interface PendingUnitBatchApproval extends PendingApprovalBase {
  kind: "unit-batch";
  trigger: "startup" | "meta-change" | "source-change" | "management";
  title: string;
  description: string;
  units: UnitBatchEntry[];
  /** Present on `meta-change`: the workspace-config write this state advance performs. */
  configWrite?: { repoPath: string; summary: string } | null;
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
 * A tool-use permission prompt relayed from a bound external agent runtime,
 * filed as a first-class workspace approval. Resolution is binary per-request
 * (allow/deny), has no durable grant, and returns `{ behavior }` to the relaying runtime. The card
 * renders a monospace `preview` of the tool input. Quiet-settled (card removed
 * without a recorded deny) when the permission is answered elsewhere.
 */
export interface PendingExternalAgentApproval extends PendingApprovalBase {
  kind: "external-agent";
  /** Runtime entity the linked agent serves. Derived and stamped by the host. */
  entityId: string;
  /** Agentic channel carrying the external-agent prompt. */
  channelId: string;
  /** Capability namespace, e.g. `external-agent.tool`. */
  capability: string;
  /**
   * The tool/operation the agent wants to run, e.g. `Bash`. Named `operationName`
   * (not `operation`) because `PendingApprovalBase.operation` is the structured
   * {@link ApprovalOperationDescriptor}; the runtime-facing request field is still
   * `operation`.
   */
  operationName: string;
  description?: string;
  /** Monospace-rendered tool input preview. */
  preview?: string;
  /** Correlates the verdict back to the external agent's pending request. */
  requestId: string;
  /** Opaque one-shot token emitted only with the inline channel signal. */
  resolveToken: string;
}

export interface UserlandApprovalOption {
  value: string;
  label: string;
  description?: string;
  tone?: "primary" | "danger" | "neutral";
}

export type UserlandApprovalPromptOptions = "scoped" | "choices";
export type UserlandApprovalGrantScope = "caller" | "session" | "version";

export interface PendingUserlandApproval extends PendingApprovalBase {
  kind: "userland";
  /** Issuer of the request — the panel/worker/extension that asked. */
  issuer?: UserlandApprovalIssuer;
  subject: UserlandApprovalSubject;
  title: string;
  summary?: string;
  warning?: string;
  details?: Array<{
    label: string;
    value: string;
    format?: ApprovalDetailFormat;
  }>;
  positiveEvidence?: Array<{
    label: string;
    value: string;
    format?: ApprovalDetailFormat;
  }>;
  severity?: "standard" | "dangerous";
  defaultAction?: "allow" | "deny";
  promptOptions: UserlandApprovalPromptOptions;
  options: UserlandApprovalOption[];
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

/**
 * Consumer contract: call this at every privileged-action boundary. Do not
 * cache the result. The host owns persistence, deduplication, scope, and
 * revocation. If you think you need a local allowlist, you are about to
 * introduce a bug.
 */
export interface UserlandApprovalRequest {
  /** Optional issuer override. Direct panel/worker callers can omit (issuer = principal). */
  issuer?: UserlandApprovalIssuer;
  subject: UserlandApprovalSubject;
  title: string;
  summary?: string;
  warning?: string;
  details?: Array<{
    label: string;
    value: string;
    format?: ApprovalDetailFormat;
  }>;
  /** Positive proof for security claims displayed by the prompt. */
  positiveEvidence?: Array<{
    label: string;
    value: string;
    format?: ApprovalDetailFormat;
  }>;
  /** Dangerous prompts default to denial and render with stronger copy. */
  severity?: "standard" | "dangerous";
  /** Default action for scoped prompts. Dangerous actions should use deny. */
  defaultAction?: "allow" | "deny";
  /**
   * `scoped` (default) shows host-managed Allow once / Session / Trust version-or-identity
   * choices and returns `choice: "allow"` or `choice: "deny"`.
   * `choices` shows the supplied `options` and persists the selected choice
   * for this concrete caller until revoked.
   */
  promptOptions?: UserlandApprovalPromptOptions;
  options?: UserlandApprovalOption[];
}

export type UserlandApprovalChoice =
  | { kind: "choice"; choice: string }
  | { kind: "dismissed" }
  | { kind: "uncallable"; reason: "no-user-context" };

export type SecretInputResult =
  | { decision: "submit"; values: Record<string, string> }
  | { decision: "deny" };

export type SecretInputRequest = z.infer<typeof secretInputRequestSchema>;

export type PendingApproval =
  | PendingCredentialApproval
  | PendingCapabilityApproval
  | PendingUnitBatchApproval
  | PendingClientConfigApproval
  | PendingCredentialInputApproval
  | PendingSecretInputApproval
  | PendingUserlandApproval
  | PendingExternalAgentApproval
  | PendingDeviceCodeApproval
  | PendingBrowserPermissionApproval;
