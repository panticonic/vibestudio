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
  PendingMissionReviewApproval,
  PendingSecretInputApproval,
  PendingUnitInstallReviewApproval,
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

/**
 * Runtime ids are useful in Developer details, but they are not display names.
 * In particular, Durable Object targets look superficially like labels while
 * being both long and meaningless to the person answering the prompt.
 */
function userFacingCallerLabel(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (
    !normalized ||
    isOpaqueId(normalized) ||
    /^(?:do(?:-service)?|worker|panel|app|extension|session):/i.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
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
    const kindLabel = getRequesterCategoryLabel(approval.requester.category);
    return {
      label:
        userFacingCallerLabel(approval.requester.title) ??
        userFacingCallerLabel(approval.callerTitle) ??
        userFacingCallerLabel(
          approval.requester.breadcrumbs.find((breadcrumb) => breadcrumb.category === "agent")
            ?.label
        ) ??
        userFacingCallerLabel(basename(approval.requester.repoPath || approval.repoPath)) ??
        kindLabel,
      kindLabel,
      kind: approval.requester.kind,
      ...(approval.requester.panel?.id
        ? { panelId: approval.requester.panel.id }
        : approval.requester.kind === "panel"
          ? { panelId: approval.requester.id }
          : {}),
      shortId: truncateId(approval.requester.ephemeralInstanceKey),
    };
  }

  const kindLabel = callerKindToLabel(approval.callerKind);
  const label =
    userFacingCallerLabel(approval.callerTitle) ||
    (approval.callerKind === "system" ? "Workspace" : "") ||
    userFacingCallerLabel(basename(approval.repoPath)) ||
    kindLabel;
  return {
    label,
    kindLabel,
    kind: approval.callerKind,
    ...(approval.callerKind === "panel" ? { panelId: approval.callerId } : {}),
    shortId: truncateId(approval.callerId),
  };
}

const INSTALL_REVIEW_CATEGORY: Record<PendingUnitInstallReviewApproval["mode"], string> = {
  "adopt-root": HOST_APPROVAL_COPY.categories.workspaceSetup,
  install: HOST_APPROVAL_COPY.categories.templateAdd,
  update: HOST_APPROVAL_COPY.categories.templateUpdate,
  remove: HOST_APPROVAL_COPY.categories.templateRemove,
  "part-changed": HOST_APPROVAL_COPY.categories.partChanged,
};

export function getApprovalOperationKindLabel(kind: ApprovalOperationDescriptor["kind"]): string {
  return HOST_APPROVAL_COPY.operationKinds[kind];
}

export function getApprovalRiskTone(approval: PendingApproval): ApprovalRiskTone {
  if (approval.kind === "mission-review") return "caution";
  if (approval.kind === "unit-install-review") {
    // Adopting a root is the workspace describing itself — the welcome after
    // creation, and the launch gate before it. It arrives with every extension
    // the base ships, which under a per-part rule painted `Welcome — here's
    // what's in your workspace` red and put a hazard triangle over it. Nothing
    // is wrong, nobody is being warned, and dressing an inventory as an alarm is
    // the theater §1 rules out: a surface that always looks urgent teaches
    // people that urgent means nothing.
    if (approval.mode === "adopt-root") return "standard";
    // Adding or updating a template someone chose is ordinary. Native code
    // running outside our protections is the one thing here worth a raised
    // voice, and a raised voice is amber — the copy still says it in full, and
    // §7.2 keeps that sentence unhidable regardless of tone.
    return approval.parts.some((part) => part.kind === "extension") ? "caution" : "standard";
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
  if (approval.kind === "device-code") {
    return HOST_APPROVAL_COPY.categories.deviceSignIn;
  }
  if (approval.kind === "unit-install-review") {
    return INSTALL_REVIEW_CATEGORY[approval.mode];
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
  "once" | "session" | "task" | "mission" | "agent" | "version" | "deny" | "lock"
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
        decision === "mission" ||
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
  const candidates = [
    approval.requester?.title,
    approval.requester?.breadcrumbs.find((breadcrumb) => breadcrumb.category === "agent")?.label,
    approval.callerTitle,
    approval.kind === "capability" ? approval.snapshot?.agentName : undefined,
  ];
  return candidates.map(userFacingCallerLabel).find(Boolean) ?? "this agent";
}

export function getStandardApprovalDecisionActions(
  approval: PendingCredentialApproval | PendingCapabilityApproval
): StandardApprovalDecisionAction[] {
  const copy = getStandardActionCopy(approval);
  const critical = approval.kind === "capability" && approval.cardType === "confirm.critical";
  const templateActions =
    approval.kind === "capability" && approval.cardType?.startsWith("template.")
      ? {
          once:
            approval.cardType === "template.add"
              ? "Add template"
              : approval.cardType === "template.update"
                ? "Update"
                : approval.cardType === "template.remove"
                  ? "Remove"
                  : "Send suggestion",
          deny:
            approval.cardType === "template.add" || approval.cardType === "template.update"
              ? "Not now"
              : "Cancel",
        }
      : null;
  const agentName = approvalAgentName(approval);
  const candidates: StandardApprovalDecisionAction[] = [
    {
      decision: "once",
      ...copy.once,
      ...(templateActions ? { label: templateActions.once } : {}),
    },
    ...(copy.session ? [{ decision: "session" as const, ...copy.session }] : []),
    {
      decision: "task",
      label: "Allow for this task",
      description: "Allow while the agent works on this task.",
    },
    {
      decision: "mission",
      label: "Allow for this mission",
      description: "Allow until this reviewed automation changes or ends.",
    },
    {
      decision: "agent",
      label: `Always for ${agentName}`,
      description: "Save this exact access for this agent until you remove it.",
    },
    ...(copy.version ? [{ decision: "version" as const, ...copy.version }] : []),
    {
      decision: "deny",
      label: templateActions?.deny ?? (critical ? "Cancel" : "Don't allow"),
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
 * A task grant is the normal choice whenever the approval offers one: it lets
 * the agent finish the current task without turning an ordinary approval into
 * standing trust. Durable reviewed-subject grants remain the recommendation
 * only for approvals that do not have a task-scoped option. Once-only
 * operations such as force pushes do not offer either reusable choice.
 */
export function getRecommendedStandardDecision(
  approval: PendingCredentialApproval | PendingCapabilityApproval
): Extract<StandardApprovalDecision, "once" | "session" | "task" | "agent" | "version"> {
  const allowed = getAllowedStandardApprovalDecisions(approval);
  const copy = getStandardActionCopy(approval);
  if (allowed.includes("task")) return "task";
  if (copy.version && allowed.includes("version")) return "version";
  if (allowed.includes("agent")) return "agent";
  if (allowed.includes("once")) return "once";
  return "session";
}

/**
 * The two actions an install review offers, and what each one means.
 *
 * There is no third "allow for a while": clearance is a durable decision the
 * user can revisit in Permissions, and a timed version of it would be a promise
 * about the future that nothing enforces.
 */
export interface InstallReviewActionCopy {
  accept: { label: string; description: string };
  /** Absent on the creation review, where the workspace already exists. */
  decline?: { label: string; description: string };
}

export function getInstallReviewActionCopy(
  approval: PendingUnitInstallReviewApproval
): InstallReviewActionCopy {
  const copy = HOST_APPROVAL_COPY.installReview;
  const accept = {
    label: copy.actionLabels[approval.mode],
    description: copy.actionDescriptions[approval.mode],
  };
  if (approval.mode === "adopt-root") {
    // §7.1: no "Not now" — the workspace is already created. The equivalent
    // escape is deselecting everything, which leaves every part asking at use.
    return { accept };
  }
  const addsOnly =
    approval.mode === "part-changed" &&
    approval.parts.length > 0 &&
    approval.parts.every((part) => part.change === "added");
  if (addsOnly) {
    return {
      accept: {
        label: copy.actionLabels["adopt-root"],
        description: copy.actionDescriptions["adopt-root"],
      },
      decline: {
        label: copy.actionLabels.notNow,
        description: copy.actionDescriptions.notNow,
      },
    };
  }
  return {
    accept,
    decline:
      approval.mode === "part-changed"
        ? { label: copy.actionLabels.keepOld, description: copy.actionDescriptions.keepOld }
        : { label: copy.actionLabels.notNow, description: copy.actionDescriptions.notNow },
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
    case "unit-install-review":
      return getInstallReviewCopy(approval);
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
        summary: spoken(approval.description) ?? HOST_APPROVAL_COPY.headlines.secretInputFallback,
        warning: approval.warning,
      };
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

/**
 * Text a producer supplied, or nothing — never the empty string.
 *
 * Every fallback in this file guards against a *missing* value with `??`, which
 * is the wrong test for text that arrives from outside the host. A template may
 * simply omit its description; a hostile one may supply a description that
 * sanitization strips to nothing. Both produce `""`, both pass `??`, and both
 * render a card with a blank summary — the one outcome a copy layer exists to
 * prevent, and the one an attacker gets for free by writing something we refuse
 * to print. Whitespace counts as nothing for the same reason.
 */
function spoken(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function getInstallReviewCopy(approval: PendingUnitInstallReviewApproval): ApprovalCopyResult {
  const copy = HOST_APPROVAL_COPY.installReview;
  const templateTitle = spoken(approval.template?.title);
  // The producer's own heading wins when it set one: the launch gate asks
  // "Start this workspace?", the creation review welcomes. Both are adopt-root,
  // and only the producer knows which surface it is.
  const title =
    approval.mode === "adopt-root"
      ? (spoken(approval.title) ?? copy.heading["adopt-root"])
      : approval.mode === "part-changed"
        ? (spoken(approval.title) ??
          (approval.parts.length === 1
            ? copy.heading["part-changed"](spoken(approval.parts[0]?.title) ?? "A part")
            : `${approval.parts.length} parts changed`))
        : templateTitle
          ? copy.heading[approval.mode](templateTitle)
          : approval.title;
  // A template that gave itself no purpose — or one whose purpose sanitization
  // refused to print — falls through to the operation's own description rather
  // than heading a card with an empty line where the reason should be.
  const summary =
    approval.mode === "part-changed"
      ? (spoken(approval.description) ??
        (approval.parts.length === 1
          ? copy.summary.partChanged
          : "Someone edited these parts in your workspace."))
      : approval.parts.length === 0 && approval.unchangedPartCount > 0
        ? copy.summary.noPermissionChanges(approval.unchangedPartCount)
        : (spoken(approval.template?.purpose) ??
          spoken(approval.description) ??
          // Last resort, and never blank: the platform's own count of what is
          // arriving. It says nothing the template claimed, which is exactly
          // right for a template that claimed nothing printable.
          copy.adds(approval.summary));
  return {
    title,
    summary,
    // The one warning that never hides: native code runs outside our
    // protections, and that is true of every extension regardless of origin.
    ...(approval.parts.some((part) => part.kind === "extension")
      ? { warning: copy.nativeCodeWarning }
      : {}),
  };
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
    return { title: fallback.title, summary: spoken(approval.description) ?? fallback.summary };
  },
  "cors-response-read"(approval) {
    const destination = formatNetworkDestination(approval.resource?.value ?? "this destination");
    const fallback = HOST_APPROVAL_COPY.headlines.corsRead(destination);
    return { title: fallback.title, summary: spoken(approval.description) ?? fallback.summary };
  },
  "workerd.inspector"(approval) {
    const target = approval.resource?.value ?? approval.operation?.object?.value ?? "workerd";
    const fallback = HOST_APPROVAL_COPY.headlines.inspectRuntime(target);
    return {
      title: targetAwareGenericTitle(approval.title, fallback.title),
      summary: spoken(approval.description) ?? fallback.summary,
    };
  },
  "context.boundary"(approval) {
    const owner = approval.details?.find((d) => d.label === "Owner")?.value;
    const target =
      approval.resource?.value ?? approval.operation?.object?.value ?? "another context";
    const subject = owner ? `the workspace branch owned by ${owner}` : `workspace branch ${target}`;
    const fallbackTitle = contextBoundaryFallbackTitle(
      approval.operation?.verb ?? approval.title,
      subject
    );
    return {
      title: targetAwareGenericTitle(approval.title, fallbackTitle),
      summary:
        spoken(approval.description) ??
        HOST_APPROVAL_COPY.headlines.contextBoundarySummary(subject),
      warning: HOST_APPROVAL_COPY.headlines.contextBoundaryWarning,
    };
  },
  "client-config-delete"(approval) {
    const target = approval.resource?.value ?? "this service configuration";
    const fallback = HOST_APPROVAL_COPY.headlines.disableService(formatServiceName(target));
    return {
      title: targetAwareGenericTitle(approval.title, fallback.title),
      summary: spoken(approval.description) ?? fallback.summary,
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
    summary: spoken(approval.description) ?? fallback.summary,
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
      spoken(approval.bindingLabel) ?? approval.credentialLabel,
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

const CALLER_KIND_TO_CATEGORY: Record<string, keyof typeof HOST_APPROVAL_COPY.requesterCategories> =
  {
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
  return approval.kind === "unit-install-review" || approval.kind === "mission-review";
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
