/**
 * ApprovalCard — the rich, presentational approval surface. It renders inside
 * the content-overlay (a separate document with NO RPC), so it is pure: it takes
 * the approval + derived caller as props and emits `ApprovalCardIntent`s up to
 * its host, which performs the actual `shellApproval.*` calls. Secret-input
 * values stay local and are only emitted on submit.
 */
import { useState } from "react";
import type { ComponentProps, CSSProperties, KeyboardEvent, ReactNode } from "react";
import {
  Badge,
  Box,
  Button,
  Code,
  Flex,
  IconButton,
  Text,
  TextField,
  Tooltip,
} from "@radix-ui/themes";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CheckCircledIcon,
  Cross2Icon,
  DragHandleDots2Icon,
  CrossCircledIcon,
  EnterIcon,
  ExclamationTriangleIcon,
  ExternalLinkIcon,
  GearIcon,
  GlobeIcon,
  LockClosedIcon,
  MinusIcon,
  PersonIcon,
} from "@radix-ui/react-icons";
import type {
  ApprovalDetailFormat,
  PendingApproval,
  PendingCapabilityApproval,
  PendingBrowserPermissionApproval,
  PendingCredentialApproval,
  PendingCredentialInputApproval,
  PendingSecretInputApproval,
  PendingClientConfigApproval,
  PendingDeviceCodeApproval,
  PendingExternalAgentApproval,
  PendingMissionReviewApproval,
  PendingUnitBatchApproval,
  PendingUserlandApproval,
} from "@vibestudio/shared/approvals";
import {
  formatAccount,
  formatInjection,
  getApprovalAttribution,
  getApprovalCopy,
  getApprovalOperationKindLabel,
  getRecommendedStandardDecision,
  getRequesterCategoryLabel,
  getStandardActionCopy,
  getUnitBatchActionCopy,
  originForUrl,
  shouldOpenApprovalDetails,
} from "@vibestudio/shared/approvalCopy";
import type { ApprovalDecision } from "@vibestudio/shared/approvals";
import { HOST_APPROVAL_COPY } from "@vibestudio/shared/hostApprovalCopy";
import { unitKindLabel } from "@vibestudio/shared/bootstrapLaunchGate";
import { AUTHORITY_DOMAINS } from "@vibestudio/shared/authority/capabilityDomains";
import { authorityRowKey } from "@vibestudio/shared/authority/authorityRowDiff";
import {
  parseApprovalMarkdown,
  type ApprovalMarkdownInline,
} from "@vibestudio/shared/approvalMarkdown";
import { DiffViewer, type DiffContentFetcher, type DiffReviewEntry } from "@workspace/ui";
import {
  approvalAccent,
  prettifyId,
  truncateId,
  type ApprovalCardIntentBody,
  type ApprovalCardIntent,
  type ApprovalQueueInfo,
  type CallerInfo,
} from "./approvalCardModel";

export interface ApprovalCardProps {
  approval: PendingApproval;
  caller: CallerInfo;
  /** Queue position for the navigator; null when a single approval is pending. */
  queue: ApprovalQueueInfo | null;
  decisionError: string | null;
  actionPending?: boolean;
  /** P3.5 diff-review payload; null/omitted → the card renders as it always has. */
  diffReview?: DiffReviewEntry[] | null;
  /** Lazy blob fetcher backing the diff viewer (host-served, content-addressed). */
  fetchContent?: DiffContentFetcher;
  /** Chrome appearance for the diff viewer's syntax theme. */
  appearance?: "light" | "dark";
  emit: (intent: ApprovalCardIntent) => void;
}

export function ApprovalCard({
  approval,
  caller,
  queue,
  decisionError,
  actionPending = false,
  diffReview,
  fetchContent,
  appearance = "light",
  emit,
}: ApprovalCardProps) {
  // Secret-config / credential-input values are held locally and only leave the
  // surface on submit.
  const [secretConfigValues, setSecretConfigValues] = useState<Record<string, string>>({});
  const [selectedMissionAuthorityKeys, setSelectedMissionAuthorityKeys] = useState<Set<string>>(
    () =>
      new Set(
        approval.kind === "mission-review"
          ? approval.authority.diff.added.filter((row) => row.tier === "gated").map(authorityRowKey)
          : []
      )
  );
  const emitForApproval = (intent: ApprovalCardIntentBody) => {
    emit({ ...intent, approvalId: approval.approvalId });
  };
  const handleKeyboardDecision = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest("input, textarea, select")) return;
    const key = event.key.toLowerCase();
    if (event.key === "Escape") {
      event.preventDefault();
      emitForApproval({ type: "minimize" });
    } else if (event.key === "ArrowLeft" && queue?.canPrev) {
      event.preventDefault();
      emitForApproval({ type: "browse", dir: "prev" });
    } else if (event.key === "ArrowRight" && queue?.canNext) {
      event.preventDefault();
      emitForApproval({ type: "browse", dir: "next" });
    } else if (key === "d") {
      event.preventDefault();
      if (approval.kind === "external-agent") {
        emitForApproval({ type: "resolve-external-agent", behavior: "deny" });
      } else if (approval.kind === "userland") {
        const deny = approval.options.find((option) => option.value === "deny");
        if (deny) emitForApproval({ type: "resolve-userland", choice: deny.value });
      } else if (approval.kind === "browser-permission") {
        // Browser permission decisions have no one-shot "deny": dismissing
        // denies only this request, while "block" is the explicit durable act.
        emitForApproval({ type: "decide", decision: "dismiss" });
      } else if (approval.kind === "mission-review") {
        emitForApproval({
          type: "resolve-mission-review",
          resolution: { decision: "dismiss" },
        });
      } else if (approval.kind !== "device-code") {
        emitForApproval({ type: "decide", decision: "deny" });
      }
    } else if (event.key === "Enter" && !actionPending) {
      event.preventDefault();
      if (approval.kind === "client-config") {
        emitForApproval({ type: "submit-client-config", values: secretConfigValues });
      } else if (approval.kind === "credential-input") {
        emitForApproval({ type: "submit-credential-input", values: secretConfigValues });
      } else if (approval.kind === "secret-input") {
        emitForApproval({ type: "submit-secret-input", values: secretConfigValues });
      } else if (approval.kind === "external-agent") {
        emitForApproval({ type: "resolve-external-agent", behavior: "allow" });
      } else if (approval.kind === "userland") {
        const primary =
          approval.options.find((option) => option.tone === "primary") ?? approval.options[0];
        if (primary) emitForApproval({ type: "resolve-userland", choice: primary.value });
      } else if (approval.kind === "mission-review") {
        emitForApproval({
          type: "resolve-mission-review",
          resolution: {
            decision: "approve",
            selectedAuthorityKeys: [...selectedMissionAuthorityKeys],
          },
        });
      } else if (approval.kind !== "device-code") {
        emitForApproval({
          type: "decide",
          decision:
            approval.kind === "unit-batch" || approval.kind === "browser-permission"
              ? "once"
              : getRecommendedStandardDecision(approval),
        });
      }
    }
  };

  const copy = getApprovalCopy(approval);
  const attribution = getApprovalAttribution(approval);
  const accent = approvalAccent(approval);

  const actions =
    approval.kind === "client-config" ? (
      <ClientConfigActions
        approval={approval}
        values={secretConfigValues}
        onSubmit={() =>
          emitForApproval({ type: "submit-client-config", values: secretConfigValues })
        }
        onDeny={() => emitForApproval({ type: "decide", decision: "deny" })}
        onDismiss={() => emitForApproval({ type: "decide", decision: "dismiss" })}
      />
    ) : approval.kind === "credential-input" ? (
      <CredentialInputActions
        approval={approval}
        values={secretConfigValues}
        onSubmit={() =>
          emitForApproval({ type: "submit-credential-input", values: secretConfigValues })
        }
        onDeny={() => emitForApproval({ type: "decide", decision: "deny" })}
        onDismiss={() => emitForApproval({ type: "decide", decision: "dismiss" })}
      />
    ) : approval.kind === "userland" ? (
      <UserlandApprovalActions
        approval={approval}
        onChoose={(choice) => emitForApproval({ type: "resolve-userland", choice })}
      />
    ) : approval.kind === "external-agent" ? (
      <ExternalAgentActions
        onDecide={(behavior) => emitForApproval({ type: "resolve-external-agent", behavior })}
      />
    ) : approval.kind === "device-code" ? (
      <DeviceCodeActions onCancel={() => emitForApproval({ type: "device-cancel" })} />
    ) : approval.kind === "browser-permission" ? (
      <BrowserPermissionActions
        approval={approval}
        decide={(decision) => emitForApproval({ type: "decide", decision })}
      />
    ) : approval.kind === "unit-batch" ? (
      <UnitBatchActions
        approval={approval}
        decide={(decision) => emitForApproval({ type: "decide", decision })}
      />
    ) : approval.kind === "mission-review" ? (
      <MissionReviewActions
        approval={approval}
        onApprove={() =>
          emitForApproval({
            type: "resolve-mission-review",
            resolution: {
              decision: "approve",
              selectedAuthorityKeys: [...selectedMissionAuthorityKeys],
            },
          })
        }
        onDismiss={() =>
          emitForApproval({
            type: "resolve-mission-review",
            resolution: { decision: "dismiss" },
          })
        }
      />
    ) : approval.kind === "secret-input" ? (
      <SecretInputActions
        approval={approval}
        values={secretConfigValues}
        onSubmit={() =>
          emitForApproval({ type: "submit-secret-input", values: secretConfigValues })
        }
        onDeny={() => emitForApproval({ type: "decide", decision: "deny" })}
        onDismiss={() => emitForApproval({ type: "decide", decision: "dismiss" })}
      />
    ) : (
      <StandardApprovalActions
        approval={approval}
        decide={(decision) => emitForApproval({ type: "decide", decision })}
        onBlock={() => emitForApproval({ type: "decide", decision: "lock" })}
      />
    );

  return (
    <div
      key={approval.approvalId}
      className="approval-card"
      data-approval-tone={accent}
      data-approval-card=""
      role="dialog"
      tabIndex={0}
      autoFocus
      aria-keyshortcuts="Enter D Escape ArrowLeft ArrowRight"
      onKeyDown={handleKeyboardDecision}
      aria-modal="false"
      aria-labelledby={`approval-title-${approval.approvalId}`}
      aria-describedby={`approval-summary-${approval.approvalId}`}
      aria-busy={actionPending}
    >
      <span key={approval.approvalId} className="approval-attention-pulse" aria-hidden="true" />
      <div className="approval-card-scroll">
        <Flex align="start" gap="3">
          <Box className="approval-icon-box" data-beacon="true">
            <ApprovalKindIcon approval={approval} size={18} />
          </Box>

          <Flex direction="column" gap="1" style={{ minWidth: 0, flex: 1 }}>
            <Flex align="center" gap="2" wrap="wrap" style={{ minWidth: 0 }}>
              {approval.kind === "capability" && approval.authorityRow ? (
                <Badge color="blue" variant="soft">
                  {AUTHORITY_DOMAINS[approval.authorityRow.domain].label}
                  {approval.authorityRow.provenance.surface
                    ? ` · ${approval.authorityRow.provenance.surface}`
                    : ""}
                </Badge>
              ) : null}
              <Text
                id={`approval-title-${approval.approvalId}`}
                size="3"
                weight="bold"
                style={{ lineHeight: 1.25, color: "var(--gray-12)", overflowWrap: "anywhere" }}
              >
                {copy.title}
              </Text>
              {queue && queue.total > 1 ? (
                <QueueNavigator
                  index={queue.index}
                  total={queue.total}
                  canPrev={queue.canPrev}
                  canNext={queue.canNext}
                  onPrev={() => emitForApproval({ type: "browse", dir: "prev" })}
                  onNext={() => emitForApproval({ type: "browse", dir: "next" })}
                />
              ) : null}
            </Flex>

            <Box id={`approval-summary-${approval.approvalId}`}>
              <ApprovalMarkdown source={copy.summary} tone="muted" compact />
            </Box>

            <Flex align="center" gap="1" wrap="wrap" style={{ minWidth: 0 }}>
              <CallerChip caller={caller} onShow={() => emitForApproval({ type: "show-panel" })} />
              <Text size="1" color="gray" style={{ flexShrink: 0 }}>
                {caller.kindLabel.toLowerCase()}
              </Text>
              {attribution.target ? (
                <>
                  <Text size="1" color="gray" style={{ flexShrink: 0 }}>
                    {attribution.relation ?? "for"}
                  </Text>
                  <span className="approval-caller-chip" data-clickable="false">
                    <span className="approval-caller-chip-title">{attribution.target}</span>
                  </span>
                </>
              ) : null}
            </Flex>

            {approval.kind === "credential" && approval.grantResource ? (
              <ApprovalGrantSummary approval={approval} />
            ) : null}

            {copy.warning ? (
              <Flex align="start" gap="1" style={{ color: "var(--red-11)" }}>
                <Box style={{ flexShrink: 0, paddingTop: 2 }}>
                  <ExclamationTriangleIcon width={13} height={13} />
                </Box>
                <ApprovalMarkdown source={copy.warning} tone="danger" compact />
              </Flex>
            ) : null}
            {decisionError ? (
              <Flex
                align="center"
                gap="1"
                style={{ color: "var(--red-11)" }}
                role="alert"
                aria-live="assertive"
              >
                <ExclamationTriangleIcon width={13} height={13} />
                <Text size="1" style={{ lineHeight: 1.35 }}>
                  Approval action failed: {decisionError}
                </Text>
              </Flex>
            ) : null}

            {diffReview && diffReview.length > 0 && fetchContent ? (
              <DiffReviewSection
                entries={diffReview}
                fetchContent={fetchContent}
                appearance={appearance}
                onOpenInGadBrowser={(file, entry) =>
                  emitForApproval({
                    type: "open-in-gad-browser",
                    target: {
                      repoPath: entry.repoPath,
                      path: file.path,
                      oldHash: file.oldHash,
                      newHash: file.newHash,
                      oldState: entry.oldState,
                      newState: entry.newState,
                      binary: file.binary,
                      tooLarge: file.tooLarge,
                      // Ship the whole changed-file set so gad-browser can step
                      // across every file of the entry, not just the focused one.
                      files: entry.changedFiles,
                    },
                  })
                }
              />
            ) : null}

            {approval.kind === "mission-review" ? (
              <MissionReviewBody
                approval={approval}
                selected={selectedMissionAuthorityKeys}
                onToggle={(key, checked) =>
                  setSelectedMissionAuthorityKeys((current) => {
                    const next = new Set(current);
                    if (checked) next.add(key);
                    else next.delete(key);
                    return next;
                  })
                }
              />
            ) : null}

            {approval.kind === "capability" && approval.operationSubstance ? (
              <Box className="approval-operation-substance">
                <Text as="div" size="1" color="gray" weight="bold">
                  What exactly
                </Text>
                <Text as="div" size="2">
                  {approval.operationSubstance.summary}
                </Text>
                {approval.operationSubstance.detail ? (
                  <Text as="div" size="1" color="gray" style={{ whiteSpace: "pre-wrap" }}>
                    {approval.operationSubstance.detail}
                  </Text>
                ) : null}
              </Box>
            ) : null}

            <ApprovalDetails
              approval={approval}
              caller={caller}
              defaultOpen={shouldOpenApprovalDetails(approval)}
            />
            {approval.kind === "device-code" ? <DeviceCodeBody approval={approval} /> : null}
            {approval.kind === "external-agent" ? <ExternalAgentBody approval={approval} /> : null}
            {approval.kind === "client-config" ||
            approval.kind === "credential-input" ||
            approval.kind === "secret-input" ? (
              <SecretConfigFields
                approval={approval}
                values={secretConfigValues}
                onChange={(name, value) =>
                  setSecretConfigValues((previous) => ({ ...previous, [name]: value }))
                }
              />
            ) : null}
          </Flex>

          <Flex align="center" gap="1" style={{ flexShrink: 0 }}>
            <Tooltip content="Drag to move">
              <span
                className="approval-drag-handle"
                data-overlay-drag-handle=""
                role="presentation"
                aria-hidden="true"
              >
                <DragHandleDots2Icon />
              </span>
            </Tooltip>
            <Tooltip content="Minimize to notifications">
              <IconButton
                size="1"
                variant="ghost"
                color="gray"
                onClick={() => emitForApproval({ type: "minimize" })}
                aria-label="Minimize approval"
              >
                <MinusIcon />
              </IconButton>
            </Tooltip>
          </Flex>
        </Flex>
      </div>

      <fieldset className="approval-card-footer" disabled={actionPending} aria-busy={actionPending}>
        {actions}
        {actionPending ? (
          <Text size="1" color="gray" ml="2" role="status" aria-live="polite">
            Saving…
          </Text>
        ) : null}
      </fieldset>
    </div>
  );
}

/**
 * Diff-review section (P3.5). One collapsible-free block per repo entry with a
 * per-repo header carrying the host-computed diffstat totals, plus the shared
 * `DiffViewer`. For a multi-repo batch it also shows an aggregate header. The
 * whole section is presentation over host-computed data and never gates the
 * Allow/Deny controls in the footer.
 */
function DiffReviewSection({
  entries,
  fetchContent,
  appearance,
  onOpenInGadBrowser,
}: {
  entries: DiffReviewEntry[];
  fetchContent: DiffContentFetcher;
  appearance: "light" | "dark";
  onOpenInGadBrowser: ComponentProps<typeof DiffViewer>["onOpenInGadBrowser"];
}) {
  // Line totals are shown only when EVERY entry carries them — the host omits
  // insertions/deletions for any entry with a skipped (binary/oversized/
  // truncated) file, and a partial batch total would mislead.
  const hasLineTotals = entries.every((entry) => entry.diffStat.insertions != null);
  const totals = entries.reduce(
    (acc, entry) => ({
      filesChanged: acc.filesChanged + entry.diffStat.filesChanged,
      insertions: acc.insertions + (entry.diffStat.insertions ?? 0),
      deletions: acc.deletions + (entry.diffStat.deletions ?? 0),
    }),
    { filesChanged: 0, insertions: 0, deletions: 0 }
  );
  const isBatch = entries.length > 1;
  return (
    <Box
      mt="1"
      p="2"
      style={{
        border: "1px solid var(--gray-a6)",
        borderRadius: 6,
        backgroundColor: "var(--color-panel-translucent)",
        maxWidth: 720,
      }}
    >
      <Flex direction="column" gap="2" style={{ minWidth: 0 }}>
        <Flex align="center" gap="2" wrap="wrap">
          <Text size="1" weight="medium">
            Review changes
          </Text>
          {isBatch ? (
            <Badge color="gray" variant="soft">
              {entries.length} repos · {totals.filesChanged} files
            </Badge>
          ) : null}
          {hasLineTotals ? (
            <Flex align="center" gap="2" style={{ marginLeft: "auto" }}>
              <Text size="1" style={{ color: "var(--green-11)" }}>
                +{totals.insertions}
              </Text>
              <Text size="1" style={{ color: "var(--red-11)" }}>
                −{totals.deletions}
              </Text>
            </Flex>
          ) : null}
        </Flex>
        {entries.map((entry) => (
          <Box key={`${entry.repoPath}:${entry.newState}`} style={{ minWidth: 0 }}>
            <Flex align="center" gap="2" mb="1" wrap="wrap">
              <Badge color="sky" variant="soft" radius="full">
                {entry.repoPath}
              </Badge>
              <Text size="1" color="gray" style={{ marginLeft: "auto" }}>
                {entry.diffStat.filesChanged} files
                {entry.diffStat.insertions != null
                  ? ` · +${entry.diffStat.insertions} −${entry.diffStat.deletions ?? 0}`
                  : ""}
                {entry.truncated ? " · truncated" : ""}
              </Text>
            </Flex>
            <DiffViewer
              entry={entry}
              fetchContent={fetchContent}
              appearance={appearance}
              onOpenInGadBrowser={onOpenInGadBrowser}
            />
          </Box>
        ))}
      </Flex>
    </Box>
  );
}

export function ApprovalKindIcon({
  approval,
  size = 18,
}: {
  approval: PendingApproval;
  size?: number;
}) {
  if (approval.kind === "unit-batch") return <ExclamationTriangleIcon width={size} height={size} />;
  if (approval.kind === "device-code") return <ExternalLinkIcon width={size} height={size} />;
  if (approval.kind === "capability") return <GlobeIcon width={size} height={size} />;
  if (approval.kind === "browser-permission") return <GlobeIcon width={size} height={size} />;
  if (approval.kind === "external-agent") return <PersonIcon width={size} height={size} />;
  if (approval.kind === "client-config" || approval.kind === "credential-input")
    return <GearIcon width={size} height={size} />;
  return <LockClosedIcon width={size} height={size} />;
}

function ApprovalGrantSummary({ approval }: { approval: PendingCredentialApproval }) {
  if (!approval.grantResource) return null;
  return (
    <Flex align="center" gap="2" wrap="wrap" style={{ minWidth: 0 }}>
      <Badge color="sky" variant="soft">
        {approval.bindingLabel ?? approval.grantResource.bindingId}
      </Badge>
      <Text size="1" color="gray" style={{ flexShrink: 0 }}>
        {approval.grantResource.action}
      </Text>
      <Code
        size="1"
        variant="soft"
        color="gray"
        style={{ maxWidth: "100%", overflowWrap: "anywhere" }}
      >
        {approval.grantResource.resource}
      </Code>
    </Flex>
  );
}

function QueueNavigator({
  index,
  total,
  canPrev,
  canNext,
  onPrev,
  onNext,
}: {
  index: number;
  total: number;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <Flex align="center" gap="1" style={{ marginLeft: "auto", flexShrink: 0 }}>
      <Tooltip content={canPrev ? "Previous pending approval" : "No earlier approvals"}>
        <IconButton
          size="1"
          variant="ghost"
          color="gray"
          disabled={!canPrev}
          onClick={onPrev}
          aria-label="Previous approval"
        >
          <ChevronLeftIcon />
        </IconButton>
      </Tooltip>
      <Text size="1" color="gray" style={{ minWidth: 32, textAlign: "center" }}>
        {index + 1} / {total}
      </Text>
      <Tooltip content={canNext ? "Next pending approval" : "No more approvals"}>
        <IconButton
          size="1"
          variant="ghost"
          color="gray"
          disabled={!canNext}
          onClick={onNext}
          aria-label="Next approval"
        >
          <ChevronRightIcon />
        </IconButton>
      </Tooltip>
    </Flex>
  );
}

function CallerChip({ caller, onShow }: { caller: CallerInfo; onShow: () => void }) {
  const clickable = caller.panelId !== undefined;
  const tooltip = clickable
    ? `Show panel — ${caller.label} (${caller.shortId})`
    : `${caller.kindLabel} ${caller.shortId}`;
  return (
    <Tooltip content={tooltip}>
      <span
        className="approval-caller-chip"
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : undefined}
        data-clickable={clickable ? "true" : "false"}
        onClick={clickable ? onShow : undefined}
        onKeyDown={
          clickable
            ? (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onShow();
                }
              }
            : undefined
        }
      >
        <span className="approval-caller-chip-kind" aria-hidden="true">
          {caller.kind === "panel" ? (
            <EnterIcon width={11} height={11} />
          ) : caller.kind === "worker" ? (
            <PersonIcon width={11} height={11} />
          ) : (
            <GearIcon width={11} height={11} />
          )}
        </span>
        <span className="approval-caller-chip-title">{caller.label}</span>
      </span>
    </Tooltip>
  );
}

function StandardApprovalActions({
  approval,
  decide,
  onBlock,
}: {
  approval: PendingCredentialApproval | PendingCapabilityApproval;
  decide: (decision: ApprovalDecision) => void;
  onBlock: () => void;
}) {
  const copy = getStandardActionCopy(approval);
  const recommendedDecision = getRecommendedStandardDecision(approval);
  const permits = (decision: ApprovalDecision) =>
    approval.kind !== "capability" ||
    approval.allowedDecisions === undefined ||
    approval.allowedDecisions.includes(decision);
  const isSevereCapability = approval.kind === "capability" && approval.severity === "severe";
  const critical = approval.kind === "capability" && approval.cardType === "confirm.critical";
  const agentName =
    approval.kind === "capability" ? (approval.snapshot?.agentName ?? "this agent") : "this agent";
  return (
    <Flex align="center" className="approval-actions" gap="2" wrap="wrap">
      {permits("once") ? (
        <DecisionButton
          label={copy.once.label}
          description={copy.once.description}
          color={
            recommendedDecision === "once" ? (isSevereCapability ? "amber" : "sky") : undefined
          }
          variant={recommendedDecision === "once" ? "solid" : "surface"}
          onClick={() => decide("once")}
        />
      ) : null}
      {copy.session && permits("session") && (
        <DecisionButton
          label={copy.session.label}
          description={copy.session.description}
          variant="surface"
          onClick={() => decide("session")}
        />
      )}
      {!critical && permits("task") ? (
        <DecisionButton
          label="Allow for this task"
          description="Allow while the agent works on this task"
          variant="surface"
          onClick={() => decide("task")}
        />
      ) : null}
      {!critical && permits("agent") ? (
        <DecisionButton
          label={`Always for ${agentName}`}
          description="Save this exact access for this agent until you remove it"
          variant="surface"
          onClick={() => decide("agent")}
        />
      ) : null}
      {copy.version && permits("version") && (
        <DecisionButton
          label={copy.version.label}
          description={copy.version.description}
          color={
            recommendedDecision === "version" ? (isSevereCapability ? "red" : "sky") : undefined
          }
          variant={recommendedDecision === "version" ? "solid" : "surface"}
          onClick={() => decide("version")}
        />
      )}
      {permits("deny") ? (
        <DecisionButton
          label={critical ? "Cancel" : "Don't allow"}
          description={copy.denyDescription}
          color="red"
          icon={<CrossCircledIcon />}
          style={{ marginLeft: 6 }}
          onClick={() => decide("deny")}
        />
      ) : null}
      {approval.kind === "capability" &&
      approval.snapshot &&
      approval.cardType !== "confirm.critical" &&
      permits("lock") ? (
        <DecisionButton
          label="Don't allow and don't ask again"
          description="Keep this agent from asking for this access again. Change it in Permissions."
          color="red"
          variant="surface"
          onClick={onBlock}
        />
      ) : null}
      <Tooltip content={HOST_APPROVAL_COPY.chrome.dismiss}>
        <IconButton size="1" variant="ghost" color="gray" onClick={() => decide("dismiss")}>
          <Cross2Icon />
        </IconButton>
      </Tooltip>
    </Flex>
  );
}

function BrowserPermissionActions({
  approval: _approval,
  decide,
}: {
  approval: PendingBrowserPermissionApproval;
  decide: (decision: ApprovalDecision) => void;
}) {
  const copy = HOST_APPROVAL_COPY.actions.browserPermission;
  return (
    <Flex align="center" className="approval-actions" gap="2" wrap="wrap">
      <DecisionButton
        label={copy.once.label}
        description={copy.once.description}
        color="sky"
        variant="solid"
        onClick={() => decide("once")}
      />
      <DecisionButton
        label={copy.session.label}
        description={copy.session.description}
        variant="surface"
        onClick={() => decide("session")}
      />
      <DecisionButton
        label={copy.always.label}
        description={copy.always.description}
        variant="surface"
        onClick={() => decide("always")}
      />
      <DecisionButton
        label={copy.block.label}
        description={copy.block.description}
        color="red"
        variant="surface"
        onClick={() => decide("block")}
      />
      <Tooltip content={HOST_APPROVAL_COPY.chrome.dismiss}>
        <IconButton size="1" variant="ghost" color="gray" onClick={() => decide("dismiss")}>
          <Cross2Icon />
        </IconButton>
      </Tooltip>
    </Flex>
  );
}

function MissionReviewBody({
  approval,
  selected,
  onToggle,
}: {
  approval: PendingMissionReviewApproval;
  selected: ReadonlySet<string>;
  onToggle: (key: string, checked: boolean) => void;
}) {
  return (
    <Flex direction="column" gap="3" className="approval-mission-review">
      <Box>
        <Text size="1" color="gray">
          Task description
        </Text>
        <Text as="p" size="2">
          {approval.taskSummary}
        </Text>
      </Box>
      <Text size="2">Runs: {approval.triggerSummary}</Text>
      <Flex direction="column" gap="2">
        <Text size="2" weight="bold">
          What it can do
        </Text>
        {approval.authority.rows.length === 0 ? (
          <Text size="2" color="gray">
            No standing permissions
          </Text>
        ) : (
          approval.authority.rows.map((row) => {
            const key = authorityRowKey(row);
            const isNew = approval.authority.diff.added.some(
              (candidate) => authorityRowKey(candidate) === key
            );
            const interactiveOnly = row.tier === "critical";
            const selectable = isNew && !interactiveOnly;
            const retiered = approval.authority.diff.retiered.some(
              ({ after }) => authorityRowKey(after) === key
            );
            return (
              <label key={key} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                {selectable ? (
                  <input
                    type="checkbox"
                    checked={selected.has(key)}
                    onChange={(event) => onToggle(key, event.currentTarget.checked)}
                    aria-label={`${row.action} ${row.resource}`}
                  />
                ) : (
                  <LockClosedIcon style={{ marginTop: 2 }} />
                )}
                <Flex direction="column" gap="1">
                  <Flex align="center" gap="2">
                    <Badge color="blue" variant="soft">
                      {AUTHORITY_DOMAINS[row.domain].label}
                    </Badge>
                    <Text size="2">
                      {row.action} — {row.resource}
                    </Text>
                    <Badge
                      color={interactiveOnly ? "amber" : isNew || retiered ? "amber" : "gray"}
                      variant="soft"
                    >
                      {interactiveOnly
                        ? "asks every time"
                        : isNew
                          ? "new"
                          : retiered
                            ? "permission changed"
                            : "already allowed"}
                    </Badge>
                  </Flex>
                </Flex>
              </label>
            );
          })
        )}
      </Flex>
      <Flex direction="column" gap="1">
        <Text size="1">
          If it needs a new permission within its toolkit, it pauses and asks you.
        </Text>
        <Text size="1">
          To do anything beyond its toolkit, it stops and proposes an update for your review.
        </Text>
        <Text size="1">Actions that can’t be undone always wait for you.</Text>
      </Flex>
      <Flex gap="2" wrap="wrap">
        {approval.toolkitDomains.map((domain) => (
          <Badge key={domain} color="gray" variant="soft">
            Uses {AUTHORITY_DOMAINS[domain].label.toLowerCase()}
          </Badge>
        ))}
      </Flex>
      <Text size="1">Can reach: {approval.networkSummary}</Text>
      <Text size="1">Works with content from: {approval.lineageSummary}</Text>
      {approval.charterChanges.map((change) => (
        <Text key={change.field} size="1" color={change.widening ? "red" : "gray"}>
          {change.field}: {change.before ?? "not set"} → {change.after}
        </Text>
      ))}
      <Text size="1" color="gray">
        Like all agents, it can’t change your safety controls.
      </Text>
      <details>
        <summary>For developers</summary>
        <Code size="1">
          {approval.closureDigest} · {approval.charter.harness.unit}@{approval.charter.harness.ev} ·{" "}
          {approval.charter.model.modelId}
        </Code>
      </details>
    </Flex>
  );
}

function MissionReviewActions({
  approval,
  onApprove,
  onDismiss,
}: {
  approval: PendingMissionReviewApproval;
  onApprove: () => void;
  onDismiss: () => void;
}) {
  return (
    <Flex direction="column" align="end" gap="1">
      <Flex align="center" gap="2">
        <Button color="sky" onClick={onApprove} data-testid="mission-review-approve">
          <CheckCircledIcon />
          {approval.reviewKind === "out-of-charter"
            ? "Allow and update mission"
            : "Approve mission"}
        </Button>
        <Button variant="soft" color="gray" onClick={onDismiss}>
          {approval.reviewKind === "out-of-charter" ? "Don’t add" : "Not now"}
        </Button>
      </Flex>
      <Text size="1" color="gray">
        You can pause or change this anytime. Changes take effect after you review them.
      </Text>
    </Flex>
  );
}

function UnitBatchActions({
  approval,
  decide,
}: {
  approval: PendingUnitBatchApproval;
  decide: (decision: "once" | "session" | "deny" | "dismiss") => void;
}) {
  const copy = getUnitBatchActionCopy(approval);
  return (
    <Flex align="center" className="approval-actions" gap="2" wrap="wrap">
      <DecisionButton
        label={copy.once.label}
        description={copy.once.description}
        color="amber"
        variant="solid"
        onClick={() => decide("once")}
      />
      {copy.session ? (
        <DecisionButton
          label={copy.session.label}
          description={copy.session.description}
          variant="surface"
          onClick={() => decide("session")}
        />
      ) : null}
      <DecisionButton
        label={copy.deny.label}
        description={copy.deny.description}
        color="red"
        icon={<CrossCircledIcon />}
        style={{ marginLeft: 6 }}
        onClick={() => decide("deny")}
      />
      <Tooltip content={HOST_APPROVAL_COPY.chrome.dismiss}>
        <IconButton size="1" variant="ghost" color="gray" onClick={() => decide("dismiss")}>
          <Cross2Icon />
        </IconButton>
      </Tooltip>
    </Flex>
  );
}

function ClientConfigActions({
  approval,
  values,
  onSubmit,
  onDeny,
  onDismiss,
}: {
  approval: PendingClientConfigApproval;
  values: Record<string, string>;
  onSubmit: () => void;
  onDeny: () => void;
  onDismiss: () => void;
}) {
  const missingRequired = approval.fields.some(
    (field) => field.required && !values[field.name]?.trim()
  );
  return (
    <Flex align="center" className="approval-actions" gap="2" wrap="wrap">
      <Tooltip
        content={
          missingRequired
            ? HOST_APPROVAL_COPY.forms.missingFields
            : HOST_APPROVAL_COPY.forms.saveServiceDescription
        }
      >
        <Button size="1" variant="solid" color="sky" disabled={missingRequired} onClick={onSubmit}>
          <CheckCircledIcon />
          {HOST_APPROVAL_COPY.forms.saveService}
        </Button>
      </Tooltip>
      <DecisionButton
        label={HOST_APPROVAL_COPY.chrome.deny}
        description={HOST_APPROVAL_COPY.forms.saveServiceDenied}
        color="red"
        icon={<CrossCircledIcon />}
        onClick={onDeny}
      />
      <Tooltip content={HOST_APPROVAL_COPY.chrome.dismiss}>
        <IconButton size="1" variant="ghost" color="gray" onClick={onDismiss}>
          <Cross2Icon />
        </IconButton>
      </Tooltip>
    </Flex>
  );
}

function SecretInputActions({
  approval,
  values,
  onSubmit,
  onDeny,
  onDismiss,
}: {
  approval: PendingSecretInputApproval;
  values: Record<string, string>;
  onSubmit: () => void;
  onDeny: () => void;
  onDismiss: () => void;
}) {
  const missingRequired = approval.fields.some(
    (field) => field.required && !values[field.name]?.trim()
  );
  return (
    <Flex align="center" className="approval-actions" gap="2" wrap="wrap">
      <Tooltip
        content={
          missingRequired
            ? HOST_APPROVAL_COPY.forms.missingValues
            : HOST_APPROVAL_COPY.forms.submitDescription
        }
      >
        <Button size="1" variant="solid" color="sky" disabled={missingRequired} onClick={onSubmit}>
          <CheckCircledIcon />
          {HOST_APPROVAL_COPY.forms.submit}
        </Button>
      </Tooltip>
      <DecisionButton
        label={HOST_APPROVAL_COPY.chrome.deny}
        description={HOST_APPROVAL_COPY.forms.inputDenied}
        color="red"
        icon={<CrossCircledIcon />}
        onClick={onDeny}
      />
      <Tooltip content={HOST_APPROVAL_COPY.chrome.dismiss}>
        <IconButton size="1" variant="ghost" color="gray" onClick={onDismiss}>
          <Cross2Icon />
        </IconButton>
      </Tooltip>
    </Flex>
  );
}

function CredentialInputActions({
  approval,
  values,
  onSubmit,
  onDeny,
  onDismiss,
}: {
  approval: PendingCredentialInputApproval;
  values: Record<string, string>;
  onSubmit: () => void;
  onDeny: () => void;
  onDismiss: () => void;
}) {
  const missingRequired = approval.fields.some(
    (field) => field.required && !values[field.name]?.trim()
  );
  return (
    <Flex align="center" className="approval-actions" gap="2" wrap="wrap">
      <Tooltip
        content={
          missingRequired
            ? HOST_APPROVAL_COPY.forms.missingSecret
            : HOST_APPROVAL_COPY.forms.saveServiceDescription
        }
      >
        <Button size="1" variant="solid" color="sky" disabled={missingRequired} onClick={onSubmit}>
          <CheckCircledIcon />
          {HOST_APPROVAL_COPY.forms.saveService}
        </Button>
      </Tooltip>
      <DecisionButton
        label={HOST_APPROVAL_COPY.chrome.deny}
        description={HOST_APPROVAL_COPY.forms.saveServiceDenied}
        color="red"
        icon={<CrossCircledIcon />}
        onClick={onDeny}
      />
      <Tooltip content={HOST_APPROVAL_COPY.chrome.dismiss}>
        <IconButton size="1" variant="ghost" color="gray" onClick={onDismiss}>
          <Cross2Icon />
        </IconButton>
      </Tooltip>
    </Flex>
  );
}

function UserlandApprovalActions({
  approval,
  onChoose,
}: {
  approval: PendingUserlandApproval;
  onChoose: (choice: string) => void;
}) {
  const oneTimeOption =
    approval.promptOptions === "scoped"
      ? null
      : (approval.options.find((option) => option.tone === "primary") ??
        approval.options.find((option) => option.tone !== "danger") ??
        null);
  return (
    <Flex direction="column" align="end" gap="1">
      <Flex align="center" className="approval-actions" gap="2" wrap="wrap">
        {approval.options.map((option) => (
          <DecisionButton
            key={option.value}
            label={option.label}
            description={option.description ?? option.label}
            color={option.tone === "danger" ? "red" : option.tone === "primary" ? "sky" : undefined}
            variant={option.tone === "primary" ? "solid" : "surface"}
            icon={option.tone === "danger" ? <CrossCircledIcon /> : <CheckCircledIcon />}
            onClick={() => onChoose(option.value)}
          />
        ))}
        {oneTimeOption ? (
          <DecisionButton
            label={HOST_APPROVAL_COPY.chrome.onlyThisTime}
            description={HOST_APPROVAL_COPY.chrome.onlyThisTimeDescription}
            variant="surface"
            icon={<CheckCircledIcon />}
            onClick={() => onChoose(`once:${oneTimeOption.value}`)}
          />
        ) : null}
        <Tooltip content={HOST_APPROVAL_COPY.chrome.dismiss}>
          <IconButton size="1" variant="ghost" color="gray" onClick={() => onChoose("dismiss")}>
            <Cross2Icon />
          </IconButton>
        </Tooltip>
      </Flex>
      <Text size="1" color="gray">
        {approval.promptOptions === "scoped"
          ? HOST_APPROVAL_COPY.chrome.scopedChoiceHint
          : HOST_APPROVAL_COPY.chrome.rememberedChoiceHint}
      </Text>
    </Flex>
  );
}

function ExternalAgentActions({ onDecide }: { onDecide: (behavior: "allow" | "deny") => void }) {
  return (
    <Flex align="center" className="approval-actions" gap="2" wrap="wrap">
      <DecisionButton
        label={HOST_APPROVAL_COPY.externalAgent.allow}
        description={HOST_APPROVAL_COPY.externalAgent.allowDescription}
        color="sky"
        variant="solid"
        onClick={() => onDecide("allow")}
      />
      <DecisionButton
        label={HOST_APPROVAL_COPY.externalAgent.deny}
        description={HOST_APPROVAL_COPY.externalAgent.denyDescription}
        color="red"
        icon={<CrossCircledIcon />}
        onClick={() => onDecide("deny")}
      />
    </Flex>
  );
}

function ExternalAgentBody({ approval }: { approval: PendingExternalAgentApproval }) {
  if (!approval.preview) return null;
  return (
    <pre
      style={{
        margin: "4px 0 0",
        maxWidth: "100%",
        maxHeight: 220,
        overflow: "auto",
        borderRadius: 6,
        padding: "8px 10px",
        background: "var(--gray-a3)",
        fontSize: 12,
        lineHeight: 1.45,
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      }}
    >
      <code>{approval.preview}</code>
    </pre>
  );
}

function ExternalAgentDetails({ approval }: { approval: PendingExternalAgentApproval }) {
  return (
    <>
      <Detail
        icon={<GearIcon />}
        label="Tool"
        value={<InlineCode>{approval.operationName}</InlineCode>}
      />
      <Detail
        icon={<LockClosedIcon />}
        label="Capability"
        value={<InlineCode>{approval.capability}</InlineCode>}
      />
      <Detail icon={<PersonIcon />} label="Agent" value={<IdCode value={approval.entityId} />} />
      {approval.description ? (
        <Detail
          icon={<GearIcon />}
          label="Request"
          value={
            <Text size="1" style={{ lineHeight: 1.35, overflowWrap: "anywhere" }}>
              {approval.description}
            </Text>
          }
        />
      ) : null}
      <Detail
        icon={<LockClosedIcon />}
        label="Request id"
        value={<IdCode value={approval.requestId} />}
      />
    </>
  );
}

function DecisionButton({
  label,
  description,
  color,
  variant = "soft",
  icon = <CheckCircledIcon />,
  style,
  onClick,
}: {
  label: string;
  description: string;
  color?: "amber" | "red" | "sky";
  variant?: "solid" | "soft" | "surface" | "outline";
  icon?: ReactNode;
  style?: CSSProperties;
  onClick: () => void;
}) {
  return (
    <Tooltip content={description}>
      <Button size="1" variant={variant} color={color} style={style} onClick={onClick}>
        {icon}
        {label}
      </Button>
    </Tooltip>
  );
}

function DeviceCodeBody({ approval }: { approval: PendingDeviceCodeApproval }) {
  return (
    <Box
      mt="1"
      p="2"
      style={{
        border: "1px solid var(--gray-a6)",
        borderRadius: 6,
        backgroundColor: "var(--color-panel-translucent)",
        maxWidth: 680,
      }}
    >
      <Flex direction="column" gap="2">
        <Text size="1" color="gray">
          {HOST_APPROVAL_COPY.deviceSignIn.enterCode}
        </Text>
        <Code
          size="6"
          weight="bold"
          style={{
            letterSpacing: "0.3em",
            paddingInline: 12,
            paddingBlock: 6,
            userSelect: "all",
            alignSelf: "flex-start",
          }}
        >
          {approval.userCode}
        </Code>
        <Text size="1" color="gray">
          at <InlineCode>{originForUrl(approval.verificationUri)}</InlineCode>
        </Text>
        <Text size="1" color="gray" style={{ lineHeight: 1.35 }}>
          {HOST_APPROVAL_COPY.deviceSignIn.verificationHelp}
        </Text>
      </Flex>
    </Box>
  );
}

function DeviceCodeActions({ onCancel }: { onCancel: () => void }) {
  return (
    <Button onClick={onCancel} size="2" variant="soft" color="gray">
      {HOST_APPROVAL_COPY.forms.cancel}
    </Button>
  );
}

function DeviceCodeDetails({ approval }: { approval: PendingDeviceCodeApproval }) {
  return (
    <>
      <Detail
        icon={<LockClosedIcon />}
        label="Service"
        value={<InlineCode>{approval.credentialLabel}</InlineCode>}
      />
      <Detail
        icon={<GlobeIcon />}
        label="Verify at"
        value={<InlineCode>{approval.verificationUri}</InlineCode>}
      />
      <Detail
        icon={<LockClosedIcon />}
        label="Provider"
        value={<InlineCode>{originForUrl(approval.oauthTokenOrigin)}</InlineCode>}
      />
    </>
  );
}

function Detail({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <Flex align="start" gap="2" style={{ minWidth: 0, color: "var(--gray-11)" }}>
      <Box style={{ display: "inline-flex", flexShrink: 0, paddingTop: 2 }}>{icon}</Box>
      <Text size="1" color="gray" style={{ width: 78, flexShrink: 0 }}>
        {label}
      </Text>
      <Box style={{ minWidth: 0, flex: 1 }}>{value}</Box>
    </Flex>
  );
}

function ApprovalDetails({
  approval,
  caller,
  defaultOpen,
}: {
  approval: PendingApproval;
  caller: CallerInfo;
  defaultOpen: boolean;
}) {
  const detailsProps = defaultOpen ? { open: true } : {};
  return (
    <details className="approval-details" {...detailsProps}>
      <summary>
        <ChevronDownIcon className="approval-details-chevron" width={13} height={13} />
        Request details
      </summary>
      <Flex direction="column" gap="2" pt="2">
        <Detail
          icon={<PersonIcon />}
          label="Requester"
          value={
            <Flex align="center" gap="2" wrap="wrap">
              <InlineCode>
                {caller.kindLabel} · {caller.label}
              </InlineCode>
              <Tooltip content={`Full id — click to select: ${approval.callerId}`}>
                <Code
                  size="1"
                  variant="soft"
                  color="gray"
                  style={{ cursor: "text", userSelect: "all" }}
                >
                  {caller.shortId}
                </Code>
              </Tooltip>
            </Flex>
          }
        />
        {approval.requester?.breadcrumbs && approval.requester.breadcrumbs.length > 1 ? (
          <Detail
            icon={<GearIcon />}
            label="Chain"
            value={<RequesterBreadcrumbs approval={approval} />}
          />
        ) : null}
        {approval.requester?.eval ? (
          <Detail
            icon={<GearIcon />}
            label="Eval"
            value={
              <Flex align="center" gap="1" wrap="wrap">
                {approval.requester.eval.ownerId ? (
                  <InlineCode>owner {approval.requester.eval.ownerId}</InlineCode>
                ) : null}
                {approval.requester.eval.subKey ? (
                  <InlineCode>scope {approval.requester.eval.subKey}</InlineCode>
                ) : null}
                {approval.requester.eval.runId ? (
                  <InlineCode>run {approval.requester.eval.runId}</InlineCode>
                ) : null}
              </Flex>
            }
          />
        ) : null}
        {approval.requester ? (
          <Detail
            icon={<LockClosedIcon />}
            label="Trust key"
            value={<IdCode value={approval.requester.stableIdentityKey} />}
          />
        ) : null}
        {approval.operation ? (
          <Detail
            icon={<GearIcon />}
            label="Operation"
            value={
              <Flex align="center" gap="1" wrap="wrap">
                <InlineCode>
                  {getApprovalOperationKindLabel(approval.operation.kind)} ·{" "}
                  {approval.operation.verb}
                </InlineCode>
                {approval.operation.object ? (
                  <InlineCode>{approval.operation.object.value}</InlineCode>
                ) : null}
              </Flex>
            }
          />
        ) : null}
        <Detail
          icon={<GlobeIcon />}
          label="Requester repo"
          value={<InlineCode>{approval.repoPath}</InlineCode>}
        />
        <Detail
          icon={<LockClosedIcon />}
          label="Requester version"
          value={<IdCode value={approval.effectiveVersion} />}
        />
        {approval.kind === "credential" ? (
          <CredentialDetails approval={approval} />
        ) : approval.kind === "client-config" ? (
          <ClientConfigDetails approval={approval} />
        ) : approval.kind === "credential-input" ? (
          <CredentialInputDetails approval={approval} />
        ) : approval.kind === "userland" ? (
          <UserlandDetails approval={approval} />
        ) : approval.kind === "external-agent" ? (
          <ExternalAgentDetails approval={approval} />
        ) : approval.kind === "device-code" ? (
          <DeviceCodeDetails approval={approval} />
        ) : approval.kind === "unit-batch" ? (
          <UnitBatchDetails approval={approval} />
        ) : approval.kind === "secret-input" ? (
          <SecretInputDetails approval={approval} />
        ) : approval.kind === "browser-permission" ? (
          <BrowserPermissionDetails approval={approval} />
        ) : approval.kind === "mission-review" ? null : (
          <CapabilityDetails approval={approval} />
        )}
      </Flex>
    </details>
  );
}

function RequesterBreadcrumbs({ approval }: { approval: PendingApproval }) {
  const breadcrumbs = approval.requester?.breadcrumbs ?? [];
  return (
    <Flex align="center" gap="1" wrap="wrap" style={{ minWidth: 0 }}>
      {breadcrumbs.flatMap((breadcrumb, index) => {
        const categoryLabel =
          breadcrumb.category === "unknown" ? null : getRequesterCategoryLabel(breadcrumb.category);
        const text = categoryLabel
          ? breadcrumb.label
            ? `${categoryLabel}: ${breadcrumb.label}`
            : categoryLabel
          : breadcrumb.label;
        if (!text) return [];
        return [
          <Flex key={`${breadcrumb.id}:${index}`} align="center" gap="1" style={{ minWidth: 0 }}>
            {index > 0 ? (
              <Text size="1" color="gray" style={{ flexShrink: 0 }}>
                &gt;
              </Text>
            ) : null}
            <Badge color="gray" variant="soft" style={{ maxWidth: 260 }}>
              {text}
            </Badge>
          </Flex>,
        ];
      })}
    </Flex>
  );
}

function SecretConfigFields({
  approval,
  values,
  onChange,
}: {
  approval:
    | PendingClientConfigApproval
    | PendingCredentialInputApproval
    | PendingSecretInputApproval;
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
}) {
  return (
    <Flex direction="column" gap="2" pt="1" style={{ maxWidth: 620 }}>
      <Text size="1" color="gray" style={{ lineHeight: 1.35 }}>
        {approval.kind === "secret-input"
          ? HOST_APPROVAL_COPY.forms.ephemeralSecretHelp
          : HOST_APPROVAL_COPY.forms.storedSecretHelp}
      </Text>
      {approval.fields.map((field) => (
        <Flex key={field.name} direction="column" gap="1">
          <Flex align="center" gap="2" wrap="wrap">
            <Text size="1" weight="medium">
              {field.label}
            </Text>
            {field.required ? (
              <Badge color="amber" variant="soft">
                {HOST_APPROVAL_COPY.chrome.required}
              </Badge>
            ) : null}
            {field.type === "secret" ? (
              <Badge color="gray" variant="soft">
                {HOST_APPROVAL_COPY.chrome.secret}
              </Badge>
            ) : null}
          </Flex>
          <TextField.Root
            size="2"
            type={field.type === "secret" ? "password" : "text"}
            value={values[field.name] ?? ""}
            placeholder={field.label}
            onChange={(event) => onChange(field.name, event.currentTarget.value)}
          />
          {field.description ? (
            <Text size="1" color="gray">
              {field.description}
            </Text>
          ) : null}
        </Flex>
      ))}
    </Flex>
  );
}

function ClientConfigDetails({ approval }: { approval: PendingClientConfigApproval }) {
  const authorizeOrigin = originForUrl(approval.authorizeUrl);
  const tokenOrigin = originForUrl(approval.tokenUrl);
  return (
    <>
      <Detail
        icon={<LockClosedIcon />}
        label="Client"
        value={<IdCode value={approval.configId} />}
      />
      <Detail
        icon={<GlobeIcon />}
        label="Authorize"
        value={
          <Code size="1" variant="soft" style={{ maxWidth: 520, overflowWrap: "anywhere" }}>
            {approval.authorizeUrl}
          </Code>
        }
      />
      <Detail
        icon={<LockClosedIcon />}
        label="Token URL"
        value={
          <Code
            size="1"
            color="amber"
            variant="soft"
            style={{ maxWidth: 520, overflowWrap: "anywhere" }}
          >
            {approval.tokenUrl}
          </Code>
        }
      />
      <Detail
        icon={<LockClosedIcon />}
        label="Binding"
        value={
          <Flex align="center" gap="1" wrap="wrap">
            <Badge color="amber" variant="soft">
              Secret use limited to {tokenOrigin}
            </Badge>
            {authorizeOrigin !== tokenOrigin ? (
              <Badge color="gray" variant="outline">
                Sign-in starts at {authorizeOrigin}
              </Badge>
            ) : null}
          </Flex>
        }
      />
      <Detail
        icon={<LockClosedIcon />}
        label="Fields"
        value={
          <Flex align="center" gap="1" wrap="wrap">
            {approval.fields.map((field) => (
              <Badge
                key={field.name}
                color={field.type === "secret" ? "amber" : "gray"}
                variant="outline"
              >
                {field.name}
                {field.type === "secret" ? " (secret)" : ""}
              </Badge>
            ))}
          </Flex>
        }
      />
    </>
  );
}

function SecretInputDetails({ approval }: { approval: PendingSecretInputApproval }) {
  return (
    <>
      {approval.description ? (
        <Detail
          icon={<LockClosedIcon />}
          label="Request"
          value={
            <Text size="1" style={{ lineHeight: 1.35, overflowWrap: "anywhere" }}>
              {approval.description}
            </Text>
          }
        />
      ) : null}
      {(approval.details ?? []).map((detail) => (
        <Detail
          key={detail.label}
          icon={<LockClosedIcon />}
          label={detail.label}
          value={<FormattedDetailValue value={detail.value} format={detail.format} />}
        />
      ))}
    </>
  );
}

function CredentialInputDetails({ approval }: { approval: PendingCredentialInputApproval }) {
  return (
    <>
      <Detail
        icon={<LockClosedIcon />}
        label="Service"
        value={<InlineCode>{approval.credentialLabel}</InlineCode>}
      />
      <Detail
        icon={<LockClosedIcon />}
        label="Injects as"
        value={<InlineCode>{formatInjection(approval)}</InlineCode>}
      />
      <Detail
        icon={<GlobeIcon />}
        label="Audience"
        value={
          <Flex align="center" gap="1" wrap="wrap">
            {approval.audience.map((audience) => (
              <Code
                key={`${audience.match}:${audience.url}`}
                size="1"
                variant="soft"
                style={{ maxWidth: 360 }}
              >
                {audience.match ?? "origin"}: {audience.url}
              </Code>
            ))}
          </Flex>
        }
      />
      <Detail
        icon={<LockClosedIcon />}
        label="Fields"
        value={
          <Flex align="center" gap="1" wrap="wrap">
            {approval.fields.map((field) => (
              <Badge
                key={field.name}
                color={field.type === "secret" ? "amber" : "gray"}
                variant="outline"
              >
                {field.name}
                {field.type === "secret" ? " (secret)" : ""}
              </Badge>
            ))}
          </Flex>
        }
      />
      {approval.scopes.length > 0 ? (
        <Detail
          icon={<LockClosedIcon />}
          label="Scopes"
          value={
            <Flex align="center" gap="1" wrap="wrap">
              {approval.scopes.map((scope) => (
                <Badge key={scope} color="gray" variant="outline">
                  {scope}
                </Badge>
              ))}
            </Flex>
          }
        />
      ) : null}
    </>
  );
}

function CredentialDetails({ approval }: { approval: PendingCredentialApproval }) {
  const oauthOrigins = [
    approval.oauthAuthorizeOrigin,
    approval.oauthTokenOrigin,
    approval.oauthUserinfoOrigin,
  ].filter((origin): origin is string => typeof origin === "string" && origin.length > 0);

  return (
    <>
      <Detail
        icon={<LockClosedIcon />}
        label="Account"
        value={<InlineCode>{formatAccount(approval)}</InlineCode>}
      />
      <Detail
        icon={<LockClosedIcon />}
        label="Injects as"
        value={<InlineCode>{formatInjection(approval)}</InlineCode>}
      />
      {approval.bindingLabel ? (
        <Detail
          icon={<LockClosedIcon />}
          label="Binding"
          value={<InlineCode>{approval.bindingLabel}</InlineCode>}
        />
      ) : null}
      {approval.grantResource ? (
        <Detail
          icon={<GlobeIcon />}
          label="Grant"
          value={
            <InlineCode>
              {approval.grantResource.bindingId} {approval.grantResource.action}{" "}
              {approval.grantResource.resource}
            </InlineCode>
          }
        />
      ) : null}
      {approval.gitOperation ? (
        <>
          <Detail
            icon={<LockClosedIcon />}
            label="Operation"
            value={<InlineCode>{approval.gitOperation.label}</InlineCode>}
          />
          <Detail
            icon={<GlobeIcon />}
            label="Remote"
            value={<InlineCode>{approval.gitOperation.remote}</InlineCode>}
          />
        </>
      ) : null}
      <Detail
        icon={<GlobeIcon />}
        label="Audience"
        value={
          <Flex align="center" gap="1" wrap="wrap">
            {approval.audience.map((audience) => (
              <Code
                key={`${audience.match}:${audience.url}`}
                size="1"
                variant="soft"
                style={{ maxWidth: 360 }}
              >
                {audience.match ?? "origin"}: {audience.url}
              </Code>
            ))}
          </Flex>
        }
      />
      {oauthOrigins.length > 0 ? (
        <Detail
          icon={<GlobeIcon />}
          label="OAuth"
          value={
            <Flex align="center" gap="1" wrap="wrap">
              {oauthOrigins.map((origin) => (
                <Code
                  key={origin}
                  size="1"
                  color={approval.oauthAudienceDomainMismatch ? "red" : "gray"}
                  variant="soft"
                  style={{ maxWidth: 360 }}
                >
                  {origin}
                </Code>
              ))}
            </Flex>
          }
        />
      ) : null}
      {approval.oauthAudienceDomainMismatch ? (
        <Detail
          icon={<ExclamationTriangleIcon />}
          label="Warning"
          value={
            <Badge color="red" variant="soft">
              OAuth domain differs from audience
            </Badge>
          }
        />
      ) : null}
      {approval.scopes.length > 0 ? (
        <Detail
          icon={<LockClosedIcon />}
          label="Scopes"
          value={
            <Flex align="center" gap="1" wrap="wrap">
              {approval.scopes.map((scope) => (
                <Badge key={scope} color="gray" variant="outline">
                  {scope}
                </Badge>
              ))}
            </Flex>
          }
        />
      ) : null}
    </>
  );
}

function CapabilityDetails({ approval }: { approval: PendingCapabilityApproval }) {
  const detailRows = approval.details ?? [];
  return (
    <>
      {approval.resource ? (
        <Detail
          icon={<GlobeIcon />}
          label={approval.resource.label}
          value={<InlineCode>{approval.resource.value}</InlineCode>}
        />
      ) : null}
      {detailRows.map((detail) => (
        <Detail
          key={detail.label}
          icon={<LockClosedIcon />}
          label={detail.label}
          value={<InlineCode>{detail.value}</InlineCode>}
        />
      ))}
    </>
  );
}

function BrowserPermissionDetails({ approval }: { approval: PendingBrowserPermissionApproval }) {
  return (
    <>
      <Detail
        icon={<GlobeIcon />}
        label="Site"
        value={<InlineCode>{approval.origin}</InlineCode>}
      />
      <Detail
        icon={<LockClosedIcon />}
        label="Permissions"
        value={<InlineCode>{approval.capabilities.join(", ")}</InlineCode>}
      />
      <Detail
        icon={<GearIcon />}
        label="Device"
        value={<InlineCode>{approval.deviceLabel}</InlineCode>}
      />
    </>
  );
}

function UnitBatchDetails({ approval }: { approval: PendingUnitBatchApproval }) {
  return (
    <>
      {approval.configWrite ? (
        <Detail
          icon={<GearIcon />}
          label="Workspace config"
          value={
            <InlineCode>
              {approval.configWrite.repoPath} · {approval.configWrite.summary}
            </InlineCode>
          }
        />
      ) : null}
      {approval.units.length === 0 ? (
        <Text size="1" color="gray">
          {HOST_APPROVAL_COPY.unitReview.noDeclaredComponents}
        </Text>
      ) : null}
      {approval.units.map((entry) => {
        const deps = Object.entries(entry.dependencyEvs ?? {});
        const external = Object.entries(entry.externalDeps ?? {});
        const addedRows = entry.authority?.diff.added ?? [];
        const retieredRows = entry.authority?.diff.retiered ?? [];
        const addedPermissionCount = addedRows.length + retieredRows.length;
        const removedPermissionCount = entry.authority?.diff.removed.length ?? 0;
        const addedDomains = [...new Set(addedRows.map((row) => row.domain))];
        return (
          <details key={`${entry.unitKind}:${entry.unitName}`} className="approval-details">
            <summary>
              <ChevronDownIcon className="approval-details-chevron" width={13} height={13} />
              {entry.displayName}
              {entry.version ? ` · v${entry.version}` : ""}
              {addedDomains.map((domain) => (
                <Badge key={domain} color="green" variant="soft" ml="1">
                  + {AUTHORITY_DOMAINS[domain].label}
                </Badge>
              ))}
              {entry.authority && addedPermissionCount === 0 ? (
                <Badge color="gray" variant="soft" ml="1">
                  {HOST_APPROVAL_COPY.chrome.noNewPermissions}
                </Badge>
              ) : null}
            </summary>
            <Flex direction="column" gap="2" pt="2">
              <Detail
                icon={<ExclamationTriangleIcon />}
                label={unitKindLabel(entry)}
                value={<InlineCode>{entry.unitName}</InlineCode>}
              />
              {entry.target ? (
                <Detail
                  icon={<GearIcon />}
                  label="Target"
                  value={<InlineCode>{entry.target}</InlineCode>}
                />
              ) : null}
              <Detail
                icon={<GlobeIcon />}
                label="Source"
                value={<InlineCode>{`${entry.source.repo}@${entry.source.ref}`}</InlineCode>}
              />
              {entry.ev ? (
                <Detail icon={<LockClosedIcon />} label="EV" value={<IdCode value={entry.ev} />} />
              ) : null}
              {entry.integrity ? (
                <Detail
                  icon={<LockClosedIcon />}
                  label="Integrity"
                  value={<IdCode value={entry.integrity} />}
                />
              ) : null}
              {entry.provider ? (
                <Detail
                  icon={<GearIcon />}
                  label="Provider"
                  value={
                    <InlineCode>{`${entry.provider.name}@${entry.provider.activeEv ?? "unknown"}`}</InlineCode>
                  }
                />
              ) : null}
              {entry.authority ? (
                <Detail
                  icon={<LockClosedIcon />}
                  label="Permissions"
                  value={
                    <Flex direction="column" gap="2">
                      {addedRows.map((row) => (
                        <Flex
                          key={`${row.capability}:${row.resource}`}
                          align="center"
                          gap="1"
                          wrap="wrap"
                        >
                          <Badge color="amber" variant="soft">
                            {AUTHORITY_DOMAINS[row.domain].label}
                          </Badge>
                          <Text size="1" color="green">
                            + {row.action} — {row.resource}
                          </Text>
                        </Flex>
                      ))}
                      {retieredRows.map(({ before, after }) => (
                        <Text key={`${after.capability}:${after.resource}`} size="1" color="amber">
                          {after.action} — {after.resource}: {before.tier} → {after.tier}
                        </Text>
                      ))}
                      {entry.authority.diff.unchanged.length > 0 ? (
                        <details className="approval-details">
                          <summary>{HOST_APPROVAL_COPY.chrome.unchangedPermissions}</summary>
                          <Flex direction="column" gap="1" pt="1">
                            {entry.authority.diff.unchanged.map((row) => (
                              <Text key={`${row.capability}:${row.resource}`} size="1" color="gray">
                                {row.action} — {row.resource}
                              </Text>
                            ))}
                          </Flex>
                        </details>
                      ) : null}
                      {removedPermissionCount > 0 ? (
                        <Text size="1" color="gray">
                          {removedPermissionCount} permission request
                          {removedPermissionCount === 1 ? "" : "s"} removed
                        </Text>
                      ) : null}
                    </Flex>
                  }
                />
              ) : null}
              {entry.capabilities.length > 0 ? (
                <Detail
                  icon={<GearIcon />}
                  label="Host integration"
                  value={
                    <Flex align="center" gap="1" wrap="wrap">
                      {entry.capabilities.map((capability) => (
                        <Badge key={capability} color="gray" variant="soft">
                          {capability}
                        </Badge>
                      ))}
                    </Flex>
                  }
                />
              ) : null}
              {deps.length > 0 ? (
                <Detail
                  icon={<LockClosedIcon />}
                  label="Deps"
                  value={
                    <Flex align="center" gap="1" wrap="wrap">
                      {deps.map(([name, ev]) => (
                        <Code key={name} size="1" variant="soft" style={{ maxWidth: 360 }}>
                          {name}: {truncateId(ev)}
                        </Code>
                      ))}
                    </Flex>
                  }
                />
              ) : null}
              {external.length > 0 ? (
                <Detail
                  icon={<LockClosedIcon />}
                  label="External"
                  value={
                    <Flex align="center" gap="1" wrap="wrap">
                      {external.map(([name, version]) => (
                        <Code key={name} size="1" variant="soft">
                          {name}@{version}
                        </Code>
                      ))}
                    </Flex>
                  }
                />
              ) : null}
            </Flex>
          </details>
        );
      })}
    </>
  );
}

function UserlandDetails({ approval }: { approval: PendingUserlandApproval }) {
  const issuer = approval.issuer;
  const showIssuer =
    issuer && (issuer.kind !== approval.callerKind || issuer.id !== approval.callerId);
  return (
    <>
      {showIssuer && issuer ? (
        <Detail
          icon={<PersonIcon />}
          label="Asked by"
          value={
            <Flex align="center" gap="2" wrap="wrap">
              <InlineCode>
                {issuer.kind} · {issuer.label ?? prettifyId(issuer.id)}
              </InlineCode>
              <Tooltip content={`Full id — click to select: ${issuer.id}`}>
                <Code
                  size="1"
                  variant="soft"
                  color="gray"
                  style={{ cursor: "text", userSelect: "all" }}
                >
                  {truncateId(issuer.id)}
                </Code>
              </Tooltip>
            </Flex>
          }
        />
      ) : null}
      <Detail
        icon={<LockClosedIcon />}
        label="Subject"
        value={<IdCode value={approval.subject.id} />}
      />
      {approval.subject.label ? (
        <Detail
          icon={<LockClosedIcon />}
          label="Label"
          value={<InlineCode>{approval.subject.label}</InlineCode>}
        />
      ) : null}
      {(approval.details ?? []).map((detail) => (
        <Detail
          key={detail.label}
          icon={<LockClosedIcon />}
          label={detail.label}
          value={<FormattedDetailValue value={detail.value} format={detail.format} />}
        />
      ))}
      {(approval.positiveEvidence ?? []).map((detail) => (
        <Detail
          key={`evidence:${detail.label}`}
          icon={<CheckCircledIcon />}
          label={detail.label}
          value={<FormattedDetailValue value={detail.value} format={detail.format} />}
        />
      ))}
    </>
  );
}

function ApprovalMarkdown({
  source,
  tone = "default",
  compact = false,
}: {
  source: string;
  tone?: "default" | "muted" | "danger";
  compact?: boolean;
}) {
  const blocks = parseApprovalMarkdown(source);
  if (blocks.length === 0) return null;
  const color =
    tone === "danger" ? "var(--red-11)" : tone === "muted" ? "var(--gray-11)" : undefined;
  return (
    <Flex
      direction="column"
      gap={compact ? "1" : "2"}
      style={{ color, lineHeight: 1.4, minWidth: 0 }}
    >
      {blocks.map((block, index) => {
        if (block.kind === "code-block") {
          return (
            <pre
              key={index}
              style={{
                margin: 0,
                maxWidth: "100%",
                overflowX: "auto",
                borderRadius: 6,
                padding: "6px 8px",
                background: "var(--gray-a3)",
                fontSize: 12,
              }}
            >
              <code>{block.text}</code>
            </pre>
          );
        }
        if (block.kind === "bullet-list" || block.kind === "ordered-list") {
          const Tag = block.kind === "bullet-list" ? "ul" : "ol";
          return (
            <Tag key={index} style={{ margin: 0, paddingLeft: 18 }}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>
                  <Text as="span" size="1" style={{ lineHeight: 1.4 }}>
                    <ApprovalMarkdownInlineNodes nodes={item} />
                  </Text>
                </li>
              ))}
            </Tag>
          );
        }
        return (
          <Text key={index} size="1" style={{ lineHeight: 1.4, overflowWrap: "anywhere" }}>
            <ApprovalMarkdownInlineNodes nodes={block.children} />
          </Text>
        );
      })}
    </Flex>
  );
}

function ApprovalMarkdownInlineNodes({ nodes }: { nodes: ApprovalMarkdownInline[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        if (node.kind === "code") {
          return (
            <Code key={index} size="1" variant="soft">
              {node.text}
            </Code>
          );
        }
        if (node.kind === "strong") {
          return (
            <strong key={index}>
              <ApprovalMarkdownInlineNodes nodes={node.children} />
            </strong>
          );
        }
        if (node.kind === "emphasis") {
          return (
            <em key={index}>
              <ApprovalMarkdownInlineNodes nodes={node.children} />
            </em>
          );
        }
        return <span key={index}>{node.text}</span>;
      })}
    </>
  );
}

function FormattedDetailValue({ value, format }: { value: string; format?: ApprovalDetailFormat }) {
  if (format === "markdown") return <ApprovalMarkdown source={value} compact />;
  if (format === "tree") return <CollapsibleTree value={value} />;
  if (format === "plain") {
    return (
      <Text size="1" style={{ lineHeight: 1.35, overflowWrap: "anywhere" }}>
        {value}
      </Text>
    );
  }
  return <InlineCode>{value}</InlineCode>;
}

function CollapsibleTree({ value }: { value: string }) {
  const [open, setOpen] = useState(false);
  const lines = value.split("\n");
  const summary = lines[0] ?? "";
  const hasBody = lines.length > 1;
  if (!hasBody) {
    return (
      <Text size="1" style={{ lineHeight: 1.35, overflowWrap: "anywhere" }}>
        {summary}
      </Text>
    );
  }
  return (
    <Flex direction="column" gap="1">
      <Flex
        align="center"
        gap="1"
        onClick={() => setOpen((prev) => !prev)}
        style={{ cursor: "pointer", userSelect: "none" }}
      >
        <Text size="1" style={{ lineHeight: 1.35, color: "var(--gray-11)", flexShrink: 0 }}>
          {open ? "▾" : "▸"}
        </Text>
        <Text size="1" style={{ lineHeight: 1.35, overflowWrap: "anywhere" }}>
          {summary}
        </Text>
      </Flex>
      {open ? (
        <pre
          style={{
            margin: 0,
            maxWidth: "100%",
            overflowX: "auto",
            borderRadius: 6,
            padding: "6px 8px",
            background: "var(--gray-a3)",
            fontSize: 12,
          }}
        >
          <code>{lines.slice(1).join("\n")}</code>
        </pre>
      ) : null}
    </Flex>
  );
}

function InlineCode({ children }: { children: ReactNode }) {
  return (
    <Code size="1" variant="soft" style={{ maxWidth: "100%" }}>
      {children}
    </Code>
  );
}

function IdCode({ value, prefix }: { value: string; prefix?: string }) {
  const fullText = prefix ? `${prefix} ${value}` : value;
  const display = `${prefix ? `${prefix} ` : ""}${truncateId(value)}`;
  return (
    <Code size="1" variant="soft" title={fullText} style={{ maxWidth: "100%" }}>
      {display}
    </Code>
  );
}
