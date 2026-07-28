import type {
  ApprovalDecision,
  ApprovalOperationDescriptor,
  ApprovalRequesterCategory,
  PendingApproval,
  PendingBrowserPermissionApproval,
  PendingCapabilityApproval,
  PendingCredentialApproval,
  PendingCredentialInputApproval,
  PendingDeviceCodeApproval,
  PendingExternalAgentApproval,
  PendingMissionReviewApproval,
  PendingSecretInputApproval,
  PendingUnitBatchApproval,
  PendingUserlandApproval,
} from "./approvals.js";
import { HOST_APPROVAL_COPY } from "./hostApprovalCopy.js";

/** Both git transports carry `gitOperation` metadata from the egress proxy. */
function isGitCredentialUse(use: unknown): boolean {
  return use === "git-http" || use === "git-ssh";
}

function truncateId(id: string, head = 8, tail = 4): string {
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

function isOpaqueId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value) || /^[0-9a-f]{24,}$/i.test(value);
}

/** Drop common id prefixes for a friendlier fallback label when no title exists. */
function prettifyApprovalId(id: string): string {
  const stripped = id.replace(/^(do-service:|do:|worker:|panel:|app:|extension:)/, "");
  const segments = stripped.split(":");
  const last = segments[segments.length - 1] ?? stripped;
  return truncateId(last);
}

function isIdentityScopedVersionApproval(approval: PendingApproval): boolean {
  if (
    approval.requester?.category === "eval" ||
    approval.requester?.category === "internal-service"
  ) {
    return true;
  }
  return approval.effectiveVersion === "internal" || approval.repoPath === "vibestudio/internal";
}

function identityTrustKind(approval: PendingApproval): "agent" | "service" {
  const category = approval.requester?.category;
  return category === "agent" || category === "eval" ? "agent" : "service";
}

function trustVersionLabel(approval: PendingApproval, fallback = "Trust version"): string {
  if (isIdentityScopedVersionApproval(approval)) {
    return identityTrustKind(approval) === "agent"
      ? HOST_APPROVAL_COPY.trust.agentIdentityLabel
      : HOST_APPROVAL_COPY.trust.serviceIdentityLabel;
  }
  return fallback === "Trust version" ? HOST_APPROVAL_COPY.trust.versionLabel : fallback;
}

function trustSubject(approval: PendingApproval): string {
  if (isIdentityScopedVersionApproval(approval)) {
    return identityTrustKind(approval) === "agent"
      ? HOST_APPROVAL_COPY.trust.agentIdentitySubject
      : HOST_APPROVAL_COPY.trust.serviceIdentitySubject;
  }
  return HOST_APPROVAL_COPY.trust.versionSubject;
}

function exactTrustSubject(approval: PendingApproval): string {
  if (isIdentityScopedVersionApproval(approval)) {
    return identityTrustKind(approval) === "agent"
      ? HOST_APPROVAL_COPY.trust.exactAgentIdentitySubject
      : HOST_APPROVAL_COPY.trust.exactServiceIdentitySubject;
  }
  return HOST_APPROVAL_COPY.trust.exactVersionSubject;
}

function networkTrustLabel(approval: PendingApproval): string {
  if (isIdentityScopedVersionApproval(approval)) {
    return identityTrustKind(approval) === "agent"
      ? HOST_APPROVAL_COPY.trust.agentIdentityWithNetworkLabel
      : HOST_APPROVAL_COPY.trust.serviceIdentityWithNetworkLabel;
  }
  return HOST_APPROVAL_COPY.trust.versionWithNetworkLabel;
}

function corsTrustLabel(approval: PendingApproval): string {
  if (isIdentityScopedVersionApproval(approval)) {
    return identityTrustKind(approval) === "agent"
      ? HOST_APPROVAL_COPY.trust.agentIdentityWithCorsLabel
      : HOST_APPROVAL_COPY.trust.serviceIdentityWithCorsLabel;
  }
  return HOST_APPROVAL_COPY.trust.versionWithCorsLabel;
}

export type ApprovalRiskTone = "standard" | "caution" | "danger";

export function getRequesterCategoryLabel(category: ApprovalRequesterCategory): string {
  return HOST_APPROVAL_COPY.requesterCategories[category];
}

export interface ApprovalCallerPresentation {
  label: string;
  kindLabel: string;
  kind: PendingApproval["callerKind"];
  panelId?: string;
  shortId: string;
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

export function getApprovalCallerPresentation(
  approval: PendingApproval
): ApprovalCallerPresentation {
  if (approval.requester) {
    return {
      label:
        approval.requester.title ?? approval.callerTitle ?? prettifyApprovalId(approval.callerId),
      kindLabel: getRequesterCategoryLabel(approval.requester.category),
      kind: approval.requester.kind,
      ...(approval.requester.panel?.id
        ? { panelId: approval.requester.panel.id }
        : approval.requester.kind === "panel"
          ? { panelId: approval.requester.id }
          : {}),
      shortId: truncateId(approval.requester.ephemeralInstanceKey),
    };
  }

  const label =
    approval.callerTitle?.trim() ||
    (approval.callerKind === "system" ? "Workspace" : "") ||
    (approval.callerKind === "worker" ||
    approval.callerKind === "app" ||
    approval.callerKind === "do" ||
    approval.callerKind === "extension"
      ? basename(approval.repoPath)
      : "") ||
    prettifyApprovalId(approval.callerId);
  const kindLabel = callerKindToLabel(approval.callerKind);
  return {
    label,
    kindLabel,
    kind: approval.callerKind,
    ...(approval.callerKind === "panel" ? { panelId: approval.callerId } : {}),
    shortId: truncateId(approval.callerId),
  };
}

export function getApprovalOperationKindLabel(kind: ApprovalOperationDescriptor["kind"]): string {
  return HOST_APPROVAL_COPY.operationKinds[kind];
}

export function getApprovalRiskTone(approval: PendingApproval): ApprovalRiskTone {
  if (approval.kind === "mission-review") return "caution";
  if (approval.kind === "unit-batch") {
    return approval.units.some((unit) => unit.unitKind === "extension") ? "danger" : "caution";
  }
  if (approval.kind === "credential" && approval.oauthAudienceDomainMismatch) {
    return "caution";
  }
  if (approval.kind === "capability") {
    if (approval.severity === "severe") return "danger";
  }
  return "standard";
}

export function getApprovalCategoryLabel(approval: PendingApproval): string {
  if (approval.kind === "mission-review") return "Mission review";
  if (approval.kind === "browser-permission") {
    return "Website permission";
  }
  if (approval.kind === "credential") {
    if (isOAuthCredentialConnectionApproval(approval)) {
      return HOST_APPROVAL_COPY.categories.connectionRequest;
    }
    if (isGitCredentialUse(approval.credentialUse)) {
      return approval.gitOperation?.action === "write"
        ? HOST_APPROVAL_COPY.categories.gitWrite
        : HOST_APPROVAL_COPY.categories.gitRead;
    }
    return HOST_APPROVAL_COPY.categories.accessRequest;
  }
  if (approval.kind === "client-config") {
    return HOST_APPROVAL_COPY.categories.serviceSetup;
  }
  if (approval.kind === "credential-input") {
    return HOST_APPROVAL_COPY.categories.serviceSetup;
  }
  if (approval.kind === "secret-input") {
    return HOST_APPROVAL_COPY.categories.privilegedInput;
  }
  if (approval.kind === "userland") {
    if (approval.severity === "dangerous") return HOST_APPROVAL_COPY.categories.privilegedAction;
    return `${userlandCallerKindLabel(approval.callerKind)} request`;
  }
  if (approval.kind === "external-agent") {
    return HOST_APPROVAL_COPY.categories.agentTool;
  }
  if (approval.kind === "device-code") {
    return HOST_APPROVAL_COPY.categories.deviceSignIn;
  }
  if (approval.kind === "unit-batch") {
    if (approval.units.length === 0) {
      if (approval.trigger === "management") return HOST_APPROVAL_COPY.categories.unitManagement;
      if (approval.trigger === "source-change") return HOST_APPROVAL_COPY.categories.unitSource;
      return HOST_APPROVAL_COPY.categories.workspaceSetup;
    }
    if (approval.trigger === "management") {
      if (approval.units.every((unit) => unit.unitKind === "app"))
        return HOST_APPROVAL_COPY.categories.appManagement;
      if (approval.units.every((unit) => unit.unitKind === "extension"))
        return HOST_APPROVAL_COPY.categories.extensionManagement;
      return HOST_APPROVAL_COPY.categories.unitManagement;
    }
    if (approval.trigger === "source-change") {
      if (approval.units.every((unit) => unit.unitKind === "app"))
        return HOST_APPROVAL_COPY.categories.appSource;
      if (approval.units.every((unit) => unit.unitKind === "extension"))
        return HOST_APPROVAL_COPY.categories.extensionSource;
      return HOST_APPROVAL_COPY.categories.unitSource;
    }
    if (approval.units.every((unit) => unit.unitKind === "app"))
      return HOST_APPROVAL_COPY.categories.appSetup;
    if (approval.units.every((unit) => unit.unitKind === "extension"))
      return HOST_APPROVAL_COPY.categories.extensionSetup;
    return HOST_APPROVAL_COPY.categories.workspaceSetup;
  }
  if (approval.capability === "workspace-main-advance") {
    const isWorkspaceSourceChange = approval.grantResourceKey?.startsWith(
      "workspace-source-change:"
    );
    if (isWorkspaceSourceChange) {
      return HOST_APPROVAL_COPY.categories.workspaceSource;
    }
    return approval.resource?.value === "meta"
      ? HOST_APPROVAL_COPY.categories.configEdit
      : HOST_APPROVAL_COPY.categories.writeRequest;
  }
  if (approval.capability === "workspace-shared-git-remote") {
    return HOST_APPROVAL_COPY.categories.remoteConfig;
  }
  if (approval.capability === "workspace-project-import") {
    return HOST_APPROVAL_COPY.categories.projectImport;
  }
  if (approval.capability === "network.response.read") {
    return HOST_APPROVAL_COPY.categories.networkAccess;
  }
  if (approval.capability === "cors-response-read") {
    return HOST_APPROVAL_COPY.categories.networkAccess;
  }
  if (approval.capability === "workerd.inspector") {
    return HOST_APPROVAL_COPY.categories.inspection;
  }
  if (approval.capability === "client-config-delete") {
    return HOST_APPROVAL_COPY.categories.serviceSetup;
  }
  if (isBrowserOpenApproval(approval)) {
    return isOAuthExternalApproval(approval)
      ? HOST_APPROVAL_COPY.categories.signInAction
      : HOST_APPROVAL_COPY.categories.browserAction;
  }
  return HOST_APPROVAL_COPY.categories.capabilityRequest;
}

export interface ApprovalActionCopy {
  once: { label: string; description: string };
  /** Null when the decision is not offered (e.g. force pushes are once-only). */
  session: { label: string; description: string } | null;
  version: { label: string; description: string } | null;
  denyDescription: string;
}

export type StandardApprovalDecision = Extract<
  ApprovalDecision,
  "once" | "session" | "task" | "agent" | "version" | "deny" | "lock"
>;

export interface StandardApprovalDecisionAction {
  decision: StandardApprovalDecision;
  label: string;
  description: string;
}

export function getAllowedStandardApprovalDecisions(
  approval: PendingCredentialApproval | PendingCapabilityApproval
): readonly StandardApprovalDecision[] {
  if (approval.kind === "credential") return approval.allowedDecisions;
  if (approval.allowedDecisions) {
    return approval.allowedDecisions.filter(
      (decision): decision is StandardApprovalDecision =>
        decision === "once" ||
        decision === "session" ||
        decision === "task" ||
        decision === "agent" ||
        decision === "version" ||
        decision === "deny" ||
        decision === "lock"
    );
  }
  return approval.cardType === "confirm.critical"
    ? ["once", "deny"]
    : ["once", "session", "version", "deny"];
}

function approvalAgentName(
  approval: PendingCredentialApproval | PendingCapabilityApproval
): string {
  if (approval.kind === "capability" && approval.snapshot?.agentName) {
    return approval.snapshot.agentName;
  }
  return (
    approval.requester?.breadcrumbs.find((breadcrumb) => breadcrumb.category === "agent")?.label ??
    "this agent"
  );
}

export function getStandardApprovalDecisionActions(
  approval: PendingCredentialApproval | PendingCapabilityApproval
): StandardApprovalDecisionAction[] {
  const copy = getStandardActionCopy(approval);
  const critical = approval.kind === "capability" && approval.cardType === "confirm.critical";
  const agentName = approvalAgentName(approval);
  const candidates: StandardApprovalDecisionAction[] = [
    { decision: "once", ...copy.once },
    ...(copy.session ? [{ decision: "session" as const, ...copy.session }] : []),
    {
      decision: "task",
      label: "Allow for this task",
      description: "Allow while the agent works on this task.",
    },
    {
      decision: "agent",
      label: `Always for ${agentName}`,
      description: "Save this exact access for this agent until you remove it.",
    },
    ...(copy.version ? [{ decision: "version" as const, ...copy.version }] : []),
    {
      decision: "deny",
      label: critical ? "Cancel" : "Don't allow",
      description: copy.denyDescription,
    },
    {
      decision: "lock",
      label: "Don't allow and don't ask again",
      description: "Keep this agent from asking for this access again. Change it in Permissions.",
    },
  ];
  const allowed = new Set(getAllowedStandardApprovalDecisions(approval));
  return candidates.filter((action) => allowed.has(action.decision));
}

function buildStandardActionCopy(
  approval: PendingCredentialApproval | PendingCapabilityApproval
): ApprovalActionCopy {
  if (approval.kind === "capability" && approval.cardType === "confirm.critical") {
    return {
      once: HOST_APPROVAL_COPY.actions.critical.once,
      session: null,
      version: null,
      denyDescription: HOST_APPROVAL_COPY.actions.critical.deny,
    };
  }
  if (approval.kind === "credential") {
    return buildCredentialActionCopy(approval);
  }
  return buildCapabilityActionCopy(approval);
}

function buildCredentialActionCopy(approval: PendingCredentialApproval): ApprovalActionCopy {
  if (isOAuthCredentialConnectionApproval(approval)) {
    return {
      once: HOST_APPROVAL_COPY.actions.oauthConnect.once,
      session: HOST_APPROVAL_COPY.actions.oauthConnect.session,
      version: {
        label: trustVersionLabel(approval),
        description: `Save and allow ${exactTrustSubject(approval)} to use it.`,
      },
      denyDescription: HOST_APPROVAL_COPY.actions.oauthConnect.deny,
    };
  }
  if (isGitCredentialUse(approval.credentialUse)) {
    const isWrite = approval.gitOperation?.action === "write";
    if (approval.gitOperation?.force) {
      return {
        once: HOST_APPROVAL_COPY.actions.forcePush.once,
        session: null,
        version: null,
        denyDescription: HOST_APPROVAL_COPY.actions.forcePush.deny,
      };
    }
    return {
      once: isWrite
        ? HOST_APPROVAL_COPY.actions.gitWrite.once
        : HOST_APPROVAL_COPY.actions.gitRead.once,
      session: isWrite
        ? HOST_APPROVAL_COPY.actions.gitWrite.session
        : HOST_APPROVAL_COPY.actions.gitRead.session,
      version: {
        label: trustVersionLabel(approval),
        description: isWrite
          ? `Allow ${exactTrustSubject(approval)} to push to this remote.`
          : `Allow ${exactTrustSubject(approval)} to read from this remote.`,
      },
      denyDescription: isWrite
        ? HOST_APPROVAL_COPY.actions.gitWrite.deny
        : HOST_APPROVAL_COPY.actions.gitRead.deny,
    };
  }
  return {
    once: {
      label: HOST_APPROVAL_COPY.actions.credentialUse.onceLabel,
      description: `Use ${formatCredentialUseTarget(approval)} for this request only.`,
    },
    session: {
      label: HOST_APPROVAL_COPY.actions.credentialUse.sessionLabel,
      description: `Keep using ${formatCredentialUseTarget(approval)} until you restart.`,
    },
    version: {
      label: trustVersionLabel(approval),
      description: `Allow ${exactTrustSubject(approval)} to use ${formatCredentialUseTarget(approval)}.`,
    },
    denyDescription: HOST_APPROVAL_COPY.actions.credentialUse.deny,
  };
}

const CAPABILITY_ACTION_HANDLERS: Record<
  string,
  (approval: PendingCapabilityApproval) => ApprovalActionCopy | null
> = {
  "workspace-main-advance"(approval) {
    const isWorkspaceSourceChange = approval.grantResourceKey?.startsWith(
      "workspace-source-change:"
    );
    if (isWorkspaceSourceChange) {
      const destination = approval.resource?.value ?? "this workspace source tree";
      return {
        once: HOST_APPROVAL_COPY.actions.workspaceSource.once,
        session: {
          label: HOST_APPROVAL_COPY.actions.workspaceSource.sessionLabel,
          description: `Allow code updates to ${destination} until you restart.`,
        },
        version: {
          label: trustVersionLabel(approval),
          description: `Allow ${trustSubject(approval)} to update ${destination}.`,
        },
        denyDescription: HOST_APPROVAL_COPY.actions.workspaceSource.deny,
      };
    }
    const isMeta = approval.resource?.value === "meta";
    return {
      once: isMeta
        ? HOST_APPROVAL_COPY.actions.workspaceConfig.once
        : HOST_APPROVAL_COPY.actions.workspaceWrite.once,
      session: isMeta
        ? HOST_APPROVAL_COPY.actions.workspaceConfig.session
        : HOST_APPROVAL_COPY.actions.workspaceWrite.session,
      version: {
        label: trustVersionLabel(approval),
        description: isMeta
          ? `Allow ${trustSubject(approval)} to edit workspace config.`
          : `Allow ${trustSubject(approval)} to write to this repository.`,
      },
      denyDescription: isMeta
        ? HOST_APPROVAL_COPY.actions.workspaceConfig.deny
        : HOST_APPROVAL_COPY.actions.workspaceWrite.deny,
    };
  },
  "workspace-shared-git-remote"(approval) {
    return {
      once: HOST_APPROVAL_COPY.actions.sharedRemote.once,
      session: HOST_APPROVAL_COPY.actions.sharedRemote.session,
      version: {
        label: trustVersionLabel(approval),
        description: `Allow ${trustSubject(approval)} to change shared remotes.`,
      },
      denyDescription: HOST_APPROVAL_COPY.actions.sharedRemote.deny,
    };
  },
  "workspace-project-import"(approval) {
    return {
      once: HOST_APPROVAL_COPY.actions.projectImport.once,
      session: HOST_APPROVAL_COPY.actions.projectImport.session,
      version: {
        label: trustVersionLabel(approval),
        description: `Allow ${trustSubject(approval)} to import project repos.`,
      },
      denyDescription: HOST_APPROVAL_COPY.actions.projectImport.deny,
    };
  },
  "network.response.read"(approval) {
    const destination = formatNetworkDestination(approval.resource?.value ?? "this destination");
    return {
      once: HOST_APPROVAL_COPY.actions.network.once,
      session: {
        label: HOST_APPROVAL_COPY.actions.network.originLabel,
        description: `Allow internet requests to ${destination} until you restart.`,
      },
      version: {
        label: networkTrustLabel(approval),
        description: `Allow ${exactTrustSubject(approval)} to use the internet without asking for each site.`,
      },
      denyDescription: `Do not connect to ${destination}.`,
    };
  },
  "cors-response-read"(approval) {
    const destination = formatNetworkDestination(approval.resource?.value ?? "this destination");
    return {
      once: HOST_APPROVAL_COPY.actions.cors.once,
      session: {
        label: HOST_APPROVAL_COPY.actions.cors.originLabel,
        description: `Allow reading data from ${destination} until you restart.`,
      },
      version: {
        label: corsTrustLabel(approval),
        description: `Allow ${exactTrustSubject(approval)} to read data from other sites without asking for each one.`,
      },
      denyDescription: `Do not read responses from ${destination}.`,
    };
  },
};

function buildCapabilityActionCopy(approval: PendingCapabilityApproval): ApprovalActionCopy {
  if (isOAuthExternalApproval(approval)) {
    return {
      once: HOST_APPROVAL_COPY.actions.browserSignIn.once,
      session: HOST_APPROVAL_COPY.actions.browserSignIn.session,
      version: {
        label: trustVersionLabel(approval),
        description: `Allow this sign-in origin for ${exactTrustSubject(approval)}.`,
      },
      denyDescription: HOST_APPROVAL_COPY.actions.browserSignIn.deny,
    };
  }
  const handler = CAPABILITY_ACTION_HANDLERS[approval.capability];
  if (handler) {
    const result = handler(approval);
    if (result) return result;
  }
  if (isBrowserOpenApproval(approval)) {
    return {
      once: HOST_APPROVAL_COPY.actions.browserOpen.once,
      session: HOST_APPROVAL_COPY.actions.browserOpen.session,
      version: {
        label: trustVersionLabel(approval),
        description: `Allow this browser origin for ${exactTrustSubject(approval)}.`,
      },
      denyDescription: HOST_APPROVAL_COPY.actions.browserOpen.deny,
    };
  }
  const target = genericCapabilityTarget(approval);
  return {
    once: HOST_APPROVAL_COPY.actions.generic.once,
    session: {
      label: HOST_APPROVAL_COPY.actions.generic.session.label,
      description: `Allow requests for ${target} until you restart.`,
    },
    version: {
      label: trustVersionLabel(approval),
      description: `Allow ${exactTrustSubject(approval)} to request ${target}.`,
    },
    denyDescription: `Do not allow ${target}.`,
  };
}

export function getStandardActionCopy(
  approval: PendingCredentialApproval | PendingCapabilityApproval
): ApprovalActionCopy {
  const copy = buildStandardActionCopy(approval);
  if (
    !copy.version ||
    !isIdentityScopedVersionApproval(approval) ||
    identityTrustKind(approval) !== "agent"
  ) {
    return copy;
  }
  return {
    ...copy,
    version: {
      ...copy.version,
      description: `${copy.version.description} ${HOST_APPROVAL_COPY.trust.agentCodeReviewBoundary}`,
    },
  };
}

/**
 * The durable reviewed-subject grant is the normal choice whenever the
 * approval supports one: exact code identity for installed units, stable agent
 * identity for agent-owned eval. Once-only operations such as force pushes do
 * not offer either durable choice.
 */
export function getRecommendedStandardDecision(
  approval: PendingCredentialApproval | PendingCapabilityApproval
): Extract<StandardApprovalDecision, "once" | "session" | "task" | "agent" | "version"> {
  const allowed = getAllowedStandardApprovalDecisions(approval);
  const copy = getStandardActionCopy(approval);
  if (copy.version && allowed.includes("version")) return "version";
  if (allowed.includes("agent")) return "agent";
  if (allowed.includes("once")) return "once";
  if (allowed.includes("task")) return "task";
  return "session";
}

export interface UnitBatchActionCopy {
  once: { label: string; description: string };
  session?: { label: string; description: string };
  deny: { label: string; description: string };
}

export function getUnitBatchActionCopy(approval: PendingUnitBatchApproval): UnitBatchActionCopy {
  const count = approval.units.length;
  const unitLabel = unitBatchLabel(approval).singular;
  const composition = unitBatchComposition(approval);
  const isSourceChange = approval.trigger === "source-change";
  const isManagement = approval.trigger === "management";

  return {
    once: {
      label: isSourceChange
        ? HOST_APPROVAL_COPY.unitReview.actionLabels.sourceChange
        : isManagement
          ? HOST_APPROVAL_COPY.unitReview.actionLabels.management
          : count > 1
            ? HOST_APPROVAL_COPY.unitReview.actionLabels.all
            : count === 1
              ? HOST_APPROVAL_COPY.unitReview.actionLabels.management
              : HOST_APPROVAL_COPY.unitReview.actionLabels.allow,
      description: isSourceChange
        ? HOST_APPROVAL_COPY.unitReview.actionDescriptions.sourceChange(unitLabel)
        : isManagement
          ? HOST_APPROVAL_COPY.unitReview.actionDescriptions.management(unitLabel)
          : count > 0
            ? unitBatchApproveDescription(approval, unitLabel)
            : HOST_APPROVAL_COPY.unitReview.actionDescriptions.config,
    },
    ...(approval.trigger === "meta-change" || isSourceChange
      ? {
          session: {
            label: HOST_APPROVAL_COPY.unitReview.actionLabels.devSession,
            description: isSourceChange
              ? HOST_APPROVAL_COPY.unitReview.actionDescriptions.sourceDevSession(unitLabel)
              : HOST_APPROVAL_COPY.unitReview.actionDescriptions.configDevSession,
          },
        }
      : {}),
    deny: {
      label:
        isSourceChange || isManagement || count <= 1
          ? HOST_APPROVAL_COPY.unitReview.actionLabels.deny
          : HOST_APPROVAL_COPY.unitReview.actionLabels.denyAll,
      description: isSourceChange
        ? HOST_APPROVAL_COPY.unitReview.actionDescriptions.rejectSource
        : isManagement
          ? HOST_APPROVAL_COPY.unitReview.actionDescriptions.rejectManagement
          : count > 0
            ? unitLabel === HOST_APPROVAL_COPY.unitReview.kinds.mixed.singular
              ? HOST_APPROVAL_COPY.unitReview.actionDescriptions.rejectComposition(composition)
              : HOST_APPROVAL_COPY.unitReview.actionDescriptions.rejectKind(unitLabel, count)
            : HOST_APPROVAL_COPY.unitReview.actionDescriptions.rejectConfig,
    },
  };
}

/**
 * The secondary attribution chip: who/what the request runs on behalf of, or
 * the identity it uses. The primary requester (panel/worker/app) is resolved
 * and rendered by the shell from its own semantic caller info — never from a
 * raw id here. This is only the *second* chip, shown as "<relation> <target>".
 */
export interface ApprovalAttribution {
  relation?: "for" | "using" | "as";
  target?: string;
}

export function getApprovalAttribution(approval: PendingApproval): ApprovalAttribution {
  if (approval.kind === "userland") {
    const issuer = approval.issuer;
    if (issuer && (issuer.kind !== approval.callerKind || issuer.id !== approval.callerId)) {
      return { relation: "for", target: issuer.label ?? prettifyApprovalId(issuer.id) };
    }
    return {};
  }
  if (approval.kind === "credential") {
    // git + non-oauth use: the headline names the destination, so the chip
    // names the credential identity in play. OAuth connect headlines already
    // name the credential, so surface the account instead when we have one.
    if (isGitCredentialUse(approval.credentialUse)) {
      return { relation: "using", target: approval.credentialLabel };
    }
    if (isOAuthCredentialConnectionApproval(approval)) {
      const account = formatAccount(approval);
      return account && account !== approval.credentialId && !isOpaqueId(account)
        ? { relation: "as", target: account }
        : {};
    }
    const account = formatAccount(approval);
    return account && account !== approval.credentialId && !isOpaqueId(account)
      ? { relation: "as", target: account }
      : { relation: "using", target: approval.credentialLabel };
  }
  return {};
}

/**
 * Headline + (push/bootstrap) summary copy.
 *
 * `title` is the headline: the capability stated in plain language with its
 * object folded in ("Open github.com/foo", "Push to github.com/foo/bar",
 * "Connect Google Calendar"). It carries no requester — attribution is the
 * shell's job (see {@link getApprovalAttribution}).
 *
 * `summary` is a short, requester-free description rendered below the headline
 * on interactive cards and reused by compact surfaces such as push.
 */
export function getApprovalCopy(approval: PendingApproval): {
  title: string;
  summary: string;
  warning?: string;
} {
  switch (approval.kind) {
    case "mission-review":
      return getMissionReviewCopy(approval);
    case "browser-permission":
      return getBrowserPermissionCopy(approval);
    case "unit-batch":
      return getUnitBatchCopy(approval);
    case "capability":
      return getCapabilityCopy(approval);
    case "client-config":
      return HOST_APPROVAL_COPY.headlines.setupService(formatServiceName(approval.configId));
    case "credential-input":
      return HOST_APPROVAL_COPY.headlines.credentialInput(
        approval.credentialLabel,
        formatCredentialInputAudienceSummary(approval)
      );
    case "secret-input":
      return {
        title: approval.title,
        summary: approval.description ?? HOST_APPROVAL_COPY.headlines.secretInputFallback,
        warning: approval.warning,
      };
    case "userland":
      return getUserlandCopy(approval);
    case "external-agent":
      return getExternalAgentCopy(approval);
    case "device-code":
      return HOST_APPROVAL_COPY.headlines.deviceSignIn(
        approval.credentialLabel,
        approval.userCode,
        originForUrl(approval.verificationUri)
      );
    case "credential":
      return getCredentialCopy(approval);
  }
}

function getMissionReviewCopy(approval: PendingMissionReviewApproval) {
  return {
    title:
      approval.reviewKind === "out-of-charter"
        ? `${approval.title} needs a new permission`
        : `Review ${approval.title}`,
    summary:
      approval.reviewKind === "out-of-charter"
        ? `${approval.title} stopped before doing something outside its approved toolkit.`
        : `${approval.title} is ready for your review.`,
  };
}

function getBrowserPermissionCopy(approval: PendingBrowserPermissionApproval) {
  const capabilities = approval.capabilities.join(" and ");
  return {
    title: `Allow ${capabilities} on ${approval.origin}?`,
    summary: `${approval.origin} wants to use ${capabilities} on ${approval.deviceLabel}.`,
  };
}

function getUnitBatchCopy(approval: PendingUnitBatchApproval) {
  const count = approval.units.length;
  const unitLabel = unitBatchLabel(approval);
  const composition = unitBatchComposition(approval);
  const fallbackTitle = HOST_APPROVAL_COPY.unitReview.title(
    approval.trigger,
    count,
    unitLabel.singular,
    composition
  );
  const fallbackSummary = HOST_APPROVAL_COPY.unitReview.summary(
    approval.trigger,
    count,
    unitLabel.singular,
    unitLabel.nativeCode,
    composition
  );
  return {
    title: concreteBatchCopy(approval.title, fallbackTitle),
    summary: concreteBatchCopy(approval.description, fallbackSummary),
    ...(count > 0 ? { warning: unitBatchWarning(approval) } : {}),
  };
}

function getUserlandCopy(approval: PendingUserlandApproval) {
  const subjectName = approval.subject.label ?? approval.subject.id;
  return {
    title: approval.title,
    summary: approval.summary ?? `Decision about ${subjectName}.`,
    warning: approval.warning,
  };
}

function getExternalAgentCopy(approval: PendingExternalAgentApproval) {
  const fallback = HOST_APPROVAL_COPY.headlines.externalAgent(approval.operationName);
  return { title: fallback.title, summary: approval.description ?? fallback.summary };
}

type ApprovalCopyResult = { title: string; summary: string; warning?: string };

const CAPABILITY_COPY_HANDLERS: Record<
  string,
  (approval: PendingCapabilityApproval) => ApprovalCopyResult | null
> = {
  "workspace-main-advance"(approval) {
    const destination = approval.resource?.value ?? "this repository";
    if (approval.grantResourceKey?.startsWith("workspace-source-change:")) {
      return HOST_APPROVAL_COPY.headlines.workspaceSourceUpdate(destination);
    }
    if (destination === "meta") {
      return HOST_APPROVAL_COPY.headlines.workspaceConfigEdit;
    }
    return HOST_APPROVAL_COPY.headlines.repositoryWrite(destination);
  },
  "workspace-shared-git-remote"(approval) {
    const destination = approval.resource?.value ?? "this repository";
    const operation =
      approval.details?.find((detail) => detail.label === "Operation")?.value ??
      "change a shared remote";
    const fallback = HOST_APPROVAL_COPY.headlines.sharedRemote(destination, operation);
    return { ...fallback, title: approval.title || fallback.title };
  },
  "workspace-project-import"(approval) {
    const destination = approval.resource?.value ?? "this project";
    const fallback = HOST_APPROVAL_COPY.headlines.projectImport(destination);
    return { ...fallback, title: approval.title || fallback.title };
  },
  "network.response.read"(approval) {
    const destination = formatNetworkDestination(approval.resource?.value ?? "this destination");
    const fallback = HOST_APPROVAL_COPY.headlines.networkConnect(destination);
    return { title: fallback.title, summary: approval.description ?? fallback.summary };
  },
  "cors-response-read"(approval) {
    const destination = formatNetworkDestination(approval.resource?.value ?? "this destination");
    const fallback = HOST_APPROVAL_COPY.headlines.corsRead(destination);
    return { title: fallback.title, summary: approval.description ?? fallback.summary };
  },
  "workerd.inspector"(approval) {
    const target = approval.resource?.value ?? approval.operation?.object?.value ?? "workerd";
    const fallback = HOST_APPROVAL_COPY.headlines.inspectRuntime(target);
    return {
      title: targetAwareGenericTitle(approval.title, fallback.title),
      summary: approval.description ?? fallback.summary,
    };
  },
  "context.boundary"(approval) {
    const owner = approval.details?.find((d) => d.label === "Owner")?.value;
    const target =
      approval.resource?.value ?? approval.operation?.object?.value ?? "another context";
    const subject = owner
      ? `the workspace branch owned by ${owner}`
      : `workspace branch ${target}`;
    const fallbackTitle = contextBoundaryFallbackTitle(
      approval.operation?.verb ?? approval.title,
      subject
    );
    return {
      title: targetAwareGenericTitle(approval.title, fallbackTitle),
      summary:
        approval.description ?? HOST_APPROVAL_COPY.headlines.contextBoundarySummary(subject),
      warning: HOST_APPROVAL_COPY.headlines.contextBoundaryWarning,
    };
  },
  "client-config-delete"(approval) {
    const target = approval.resource?.value ?? "this service configuration";
    const fallback = HOST_APPROVAL_COPY.headlines.disableService(formatServiceName(target));
    return {
      title: targetAwareGenericTitle(approval.title, fallback.title),
      summary: approval.description ?? fallback.summary,
    };
  },
};

function getCapabilityCopy(approval: PendingCapabilityApproval): ApprovalCopyResult {
  const handler = CAPABILITY_COPY_HANDLERS[approval.capability];
  if (handler) {
    const result = handler(approval);
    if (result) return result;
  }
  if (isBrowserOpenApproval(approval)) {
    const isOAuth = isOAuthExternalApproval(approval);
    const destination = formatCapabilityDestination(approval, isOAuth);
    return isOAuth
      ? HOST_APPROVAL_COPY.headlines.browserSignIn(destination)
      : HOST_APPROVAL_COPY.headlines.browserOpen(destination);
  }
  const target = genericCapabilityTarget(approval);
  const fallback = HOST_APPROVAL_COPY.headlines.genericCapability(target);
  return {
    title: targetAwareGenericTitle(approval.title, fallback.title),
    summary: approval.description ?? fallback.summary,
  };
}

function getCredentialCopy(approval: PendingCredentialApproval): ApprovalCopyResult {
  const audience = formatAudienceSummary(approval);
  if (isGitCredentialUse(approval.credentialUse)) {
    const operation = approval.gitOperation;
    const remote = operation?.remote ? formatGitRemoteSummary(operation.remote) : audience;
    const label = operation?.label ?? "git operation";
    if (operation?.force) {
      return HOST_APPROVAL_COPY.headlines.forcePush(
        remote,
        approval.credentialLabel,
        operation.overwrites
      );
    }
    return HOST_APPROVAL_COPY.headlines.git(
      operation?.action === "write" ? "write" : "read",
      remote,
      label,
      approval.credentialLabel
    );
  }
  if (isOAuthCredentialConnectionApproval(approval)) {
    return {
      ...HOST_APPROVAL_COPY.headlines.oauthConnect(
        approval.credentialLabel,
        audience,
        approval.replacementCredentialLabel
      ),
      warning: approval.oauthAudienceDomainMismatch
        ? HOST_APPROVAL_COPY.headlines.domainMismatch
        : undefined,
    };
  }
  return {
    ...HOST_APPROVAL_COPY.headlines.credentialUse(
      approval.bindingLabel ?? approval.credentialLabel,
      approval.credentialLabel,
      formatCredentialUseTarget(approval)
    ),
    warning: approval.oauthAudienceDomainMismatch
      ? HOST_APPROVAL_COPY.headlines.domainMismatch
      : undefined,
  };
}

function concreteBatchCopy(value: string | undefined, fallback: string): string {
  const candidate = value?.trim();
  return candidate && !/\bunits?\b/iu.test(candidate) ? candidate : fallback;
}

function userlandCallerKindLabel(
  kind: "panel" | "app" | "worker" | "do" | "extension" | "system"
): string {
  return callerKindToLabel(kind);
}

const CALLER_KIND_TO_CATEGORY: Record<string, keyof typeof HOST_APPROVAL_COPY.requesterCategories> = {
  panel: "panel",
  app: "workspace-app",
  worker: "worker",
  do: "durable-object",
  extension: "extension",
  system: "system",
};

function callerKindToLabel(kind: string): string {
  const categoryKey = CALLER_KIND_TO_CATEGORY[kind] ?? kind;
  return (
    HOST_APPROVAL_COPY.requesterCategories[
      categoryKey as keyof typeof HOST_APPROVAL_COPY.requesterCategories
    ] ?? "Requester"
  );
}

export function getCapabilityPrimaryDestination(approval: PendingCapabilityApproval): string {
  return (
    approval.details?.find((detail) => detail.label.toLowerCase() === "url")?.value ??
    approval.resource?.value ??
    "an external destination"
  );
}

export function shouldOpenApprovalDetails(approval: PendingApproval): boolean {
  return approval.kind === "unit-batch" || approval.kind === "mission-review";
}

function isBrowserOpenApproval(approval: PendingCapabilityApproval): boolean {
  return approval.capability === "external-browser-open" || approval.capability === "open-url";
}

function genericCapabilityTarget(approval: PendingCapabilityApproval): string {
  return (
    approval.operation?.object?.value ??
    approval.resource?.value ??
    approval.details?.find((detail) => detail.label.toLowerCase() === "target")?.value ??
    approval.details?.find((detail) => detail.label.toLowerCase() === "target origin")?.value ??
    approval.capability
  );
}

function contextBoundaryFallbackTitle(verb: string | undefined, subject: string): string {
  const normalized = verb?.trim().toLowerCase();
  if (normalized === "create do" || normalized === "create do in another context") {
    return "Launch background process in another workspace branch";
  }
  if (normalized === "create worker" || normalized === "create worker in another context") {
    return "Launch background process in another workspace branch";
  }
  if (normalized === "create panel" || normalized === "create panel in another context") {
    return "Open panel in another workspace branch";
  }
  if (normalized === "open panel" || normalized === "open panel in another context") {
    return "Open panel in another workspace branch";
  }
  if (normalized === "navigate panel" || normalized === "navigate panel in another context") {
    return "Switch panel to another workspace branch";
  }
  if (normalized === "create app" || normalized === "create app in another context") {
    return "Launch app in another workspace branch";
  }
  if (normalized === "create session" || normalized === "create session in another context") {
    return "Start session in another workspace branch";
  }
  return `Control ${subject}`;
}

function targetAwareGenericTitle(title: string | undefined, fallback: string): string {
  if (!title) return fallback;
  const normalized = title.trim().toLowerCase();
  const genericTitles = new Set([
    "allow network access",
    "allow cross-origin response access",
    "create runtime entity in another context",
    "create do in another context",
    "create worker in another context",
    "create panel in another context",
    "open panel in another context",
    "navigate panel in another context",
    "create app in another context",
    "create session in another context",
    "disable service configuration",
    "profile workers via the workerd inspector",
  ]);
  return genericTitles.has(normalized) ? fallback : title;
}

function unitBatchLabel(approval: PendingUnitBatchApproval): {
  singular: string;
  plural: string;
  nativeCode: boolean;
  scheduledJob: boolean;
} {
  const hasExtensions = approval.units.some((unit) => unit.unitKind === "extension");
  const hasApps = approval.units.some((unit) => unit.unitKind === "app");
  const hasPanels = approval.units.some((unit) => unit.unitKind === "panel");
  const hasWorkers = approval.units.some((unit) => unit.unitKind === "worker");
  const hasScheduledJobs = approval.units.some((unit) => unit.unitKind === "scheduled-job");
  const hasAgentHeartbeats = approval.units.some((unit) => unit.unitKind === "agent-heartbeat");
  const presentKindCount = [
    hasExtensions,
    hasApps,
    hasPanels,
    hasWorkers,
    hasScheduledJobs,
    hasAgentHeartbeats,
  ].filter(Boolean).length;
  if (hasExtensions && presentKindCount === 1) {
    return {
      ...HOST_APPROVAL_COPY.unitReview.kinds.extension,
      nativeCode: true,
      scheduledJob: false,
    };
  }
  if (hasApps && presentKindCount === 1) {
    return { ...HOST_APPROVAL_COPY.unitReview.kinds.app, nativeCode: false, scheduledJob: false };
  }
  if (hasPanels && presentKindCount === 1) {
    return { ...HOST_APPROVAL_COPY.unitReview.kinds.panel, nativeCode: false, scheduledJob: false };
  }
  if (hasWorkers && presentKindCount === 1) {
    return {
      ...HOST_APPROVAL_COPY.unitReview.kinds.worker,
      nativeCode: false,
      scheduledJob: false,
    };
  }
  if (hasScheduledJobs && presentKindCount === 1) {
    return {
      ...HOST_APPROVAL_COPY.unitReview.kinds.scheduledJob,
      nativeCode: false,
      scheduledJob: true,
    };
  }
  if (hasAgentHeartbeats && presentKindCount === 1) {
    return {
      ...HOST_APPROVAL_COPY.unitReview.kinds.agentHeartbeat,
      nativeCode: false,
      scheduledJob: true,
    };
  }
  return {
    ...HOST_APPROVAL_COPY.unitReview.kinds.mixed,
    nativeCode: hasExtensions,
    scheduledJob: hasScheduledJobs,
  };
}

function unitBatchWarning(approval: PendingUnitBatchApproval): string {
  const count = (kind: PendingUnitBatchApproval["units"][number]["unitKind"]) =>
    approval.units.filter((unit) => unit.unitKind === kind).length;
  const warnings: string[] = [];
  const extensions = count("extension");
  const apps = count("app");
  const panels = count("panel");
  const workers = count("worker");
  const scheduledJobs = count("scheduled-job");
  const agentHeartbeats = count("agent-heartbeat");
  if (extensions) warnings.push(HOST_APPROVAL_COPY.unitReview.warningEffects.extension(extensions));
  if (apps) warnings.push(HOST_APPROVAL_COPY.unitReview.warningEffects.app(apps));
  if (panels) warnings.push(HOST_APPROVAL_COPY.unitReview.warningEffects.panel(panels));
  if (workers) warnings.push(HOST_APPROVAL_COPY.unitReview.warningEffects.worker(workers));
  if (scheduledJobs)
    warnings.push(HOST_APPROVAL_COPY.unitReview.warningEffects.scheduledJob(scheduledJobs));
  if (agentHeartbeats)
    warnings.push(HOST_APPROVAL_COPY.unitReview.warningEffects.agentHeartbeat(agentHeartbeats));
  return HOST_APPROVAL_COPY.unitReview.warning(warnings);
}

function unitBatchComposition(approval: PendingUnitBatchApproval): string {
  const labels = [
    ["extension", HOST_APPROVAL_COPY.unitReview.kinds.extension],
    ["app", HOST_APPROVAL_COPY.unitReview.kinds.app],
    ["panel", HOST_APPROVAL_COPY.unitReview.kinds.panel],
    ["worker", HOST_APPROVAL_COPY.unitReview.kinds.worker],
    ["scheduled-job", HOST_APPROVAL_COPY.unitReview.kinds.scheduledJob],
    ["agent-heartbeat", HOST_APPROVAL_COPY.unitReview.kinds.agentHeartbeat],
  ] as const;
  const parts = labels.flatMap(([kind, label]) => {
    const count = approval.units.filter((entry) => entry.unitKind === kind).length;
    return count === 0 ? [] : [`${count} ${count === 1 ? label.singular : label.plural}`];
  });
  if (parts.length === 0) return "this workspace configuration change";
  if (parts.length === 1) return parts[0]!;
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function unitBatchApproveDescription(
  approval: PendingUnitBatchApproval,
  unitLabel: string
): string {
  const count = approval.units.length;
  if (unitLabel === HOST_APPROVAL_COPY.unitReview.kinds.scheduledJob.singular) {
    return HOST_APPROVAL_COPY.unitReview.actionDescriptions.scheduledJobs(count);
  }
  if (unitLabel === HOST_APPROVAL_COPY.unitReview.kinds.agentHeartbeat.singular) {
    return HOST_APPROVAL_COPY.unitReview.actionDescriptions.agentHeartbeats(count);
  }
  if (unitLabel === HOST_APPROVAL_COPY.unitReview.kinds.panel.singular) {
    return HOST_APPROVAL_COPY.unitReview.actionDescriptions.panels(count);
  }
  if (unitLabel === HOST_APPROVAL_COPY.unitReview.kinds.worker.singular) {
    return HOST_APPROVAL_COPY.unitReview.actionDescriptions.workers(count);
  }
  if (unitLabel === HOST_APPROVAL_COPY.unitReview.kinds.mixed.singular) {
    return HOST_APPROVAL_COPY.unitReview.actionDescriptions.mixed(unitBatchComposition(approval));
  }
  const hasExtensions = approval.units.some((unit) => unit.unitKind === "extension");
  return HOST_APPROVAL_COPY.unitReview.actionDescriptions.install(count, unitLabel, hasExtensions);
}

export function originForUrl(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return raw;
  }
}

export function formatAudienceSummary(approval: PendingCredentialApproval): string {
  if (approval.audience.length === 0) return "an unspecified audience";
  const first = approval.audience[0];
  if (!first) return "an unspecified audience";
  const audience = formatUrlForSummary(first.url, first.match === "origin" ? "origin" : "path");
  const extraCount = approval.audience.length - 1;
  return extraCount > 0 ? `${audience} and ${extraCount} more` : audience;
}

export function formatCredentialUseTarget(approval: PendingCredentialApproval): string {
  if (approval.grantResource?.resource) {
    const resource = formatCredentialGrantResourceSummary(approval.grantResource.resource);
    return approval.bindingLabel ? `${approval.bindingLabel} at ${resource}` : resource;
  }
  if (approval.bindingLabel) {
    return approval.bindingLabel;
  }
  return formatAudienceSummary(approval);
}

function formatCredentialGrantResourceSummary(raw: string): string {
  try {
    const url = new URL(raw);
    const segments = url.pathname.split("/").filter(Boolean);
    if (
      (url.hostname === "api.github.com" || url.hostname === "uploads.github.com") &&
      segments[0] === "repos" &&
      segments[1] &&
      segments[2]
    ) {
      return `github.com/${segments[1]}/${segments[2]}`;
    }
  } catch {
    // fall through to generic formatting
  }
  return formatUrlForSummary(raw, "path");
}

export function formatGitRemoteSummary(raw: string): string {
  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
    return path ? `${url.hostname}/${path}` : url.hostname;
  } catch {
    return raw;
  }
}

export function formatAccount(approval: PendingCredentialApproval): string {
  const identity = approval.accountIdentity;
  return (
    identity.email ??
    identity.username ??
    identity.workspaceName ??
    identity.providerUserId ??
    approval.credentialId
  );
}

export function formatCredentialInputAudienceSummary(
  approval: PendingCredentialInputApproval
): string {
  if (approval.audience.length === 0) return "this service";
  const first = approval.audience[0];
  if (!first) return "this service";
  const audience = formatUrlForSummary(first.url, first.match === "origin" ? "origin" : "path");
  const extraCount = approval.audience.length - 1;
  return extraCount > 0 ? `${audience} and ${extraCount} more` : audience;
}

export function formatInjection(
  approval: PendingCredentialApproval | PendingCredentialInputApproval
): string {
  const injection = approval.injection;
  if (injection.type === "query-param") {
    return `query ${injection.name}`;
  }
  if (injection.type === "basic-auth") {
    return "basic auth";
  }
  if (injection.type === "oauth1-signature") {
    return "OAuth 1 signature";
  }
  if (injection.type === "cookie") {
    return "cookie";
  }
  if (injection.type === "aws-sigv4") {
    return `AWS SigV4 ${injection.service}/${injection.region}`;
  }
  if (injection.type === "ssh-key") {
    return "SSH key";
  }
  return `header ${injection.name}`;
}

export function isOAuthCredentialConnectionApproval(approval: PendingCredentialApproval): boolean {
  return !!approval.oauthAuthorizeOrigin && !!approval.oauthTokenOrigin && !approval.credentialUse;
}

export function isOAuthExternalApproval(approval: PendingCapabilityApproval): boolean {
  return (
    approval.details?.some((detail) => detail.label.toLowerCase() === "oauth callback") === true
  );
}

export function formatCapabilityDestination(
  approval: PendingCapabilityApproval,
  oauth: boolean
): string {
  const rawDestination = getCapabilityPrimaryDestination(approval);
  return formatUrlForSummary(rawDestination, oauth ? "origin" : "path");
}

export function formatNetworkDestination(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol === "mailto:") {
      return "email";
    }
    const host = url.host || url.hostname;
    const path = compactPath(url.pathname);
    return path ? `${host}${path}` : host;
  } catch {
    return raw.length > 64 ? `${raw.slice(0, 61)}...` : raw;
  }
}

export function formatUrlForSummary(raw: string, mode: "origin" | "path" = "path"): string {
  try {
    const url = new URL(raw);
    if (url.protocol === "mailto:") {
      return "email";
    }
    const host = url.hostname;
    if (mode === "origin") {
      return host;
    }
    const path = compactPath(url.pathname);
    return path ? `${host}${path}` : host;
  } catch {
    return raw.length > 64 ? `${raw.slice(0, 61)}...` : raw;
  }
}

export function compactPath(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) {
    return "";
  }
  const first = segments[0] ?? "";
  if (!first || first.length > 32) {
    return "";
  }
  return `/${first}${segments.length > 1 ? "/..." : ""}`;
}

export function formatServiceName(configId: string): string {
  return (
    configId
      .split(/[-_.]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || "this service"
  );
}
