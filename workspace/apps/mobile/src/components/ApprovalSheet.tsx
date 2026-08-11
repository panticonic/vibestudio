import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Dimensions,
  Easing,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import ReactNativeHapticFeedback from "react-native-haptic-feedback";
import type {
  ApprovalDetailFormat,
  ApprovalDecision,
  PendingApproval,
  PendingMissionReviewApproval,
  PendingBrowserPermissionApproval,
  PendingCapabilityApproval,
  PendingClientConfigApproval,
  PendingCredentialApproval,
  PendingCredentialInputApproval,
  PendingSecretInputApproval,
  PendingDeviceCodeApproval,
  PendingUnitInstallReviewApproval,
  DiffReviewEntry,
  DiffReviewFile,
} from "@vibestudio/shared/approvals";
import {
  DiffTooLargeError,
  allAdded,
  allRemoved,
  countLines,
  diffLines,
  type DiffRow,
  type LineDiffResult,
} from "@vibestudio/shared/lineDiff";
import { AUTHORITY_DOMAINS } from "@vibestudio/shared/authority/authorityDomains";
import { authorityRowKey } from "@vibestudio/shared/authority/authorityRowDiff";
import {
  parseApprovalMarkdown,
  type ApprovalMarkdownInline,
} from "@vibestudio/shared/approvalMarkdown";
import {
  type ApprovalAttribution,
  type ApprovalCallerPresentation,
  formatAccount,
  formatCredentialInputAudienceSummary,
  formatInjection,
  getApprovalAttribution,
  getApprovalCallerPresentation,
  getApprovalCopy,
  getApprovalOperationKindLabel,
  getRecommendedStandardDecision,
  getApprovalRiskTone,
  getRequesterCategoryLabel,
  getStandardApprovalDecisionActions,
  getInstallReviewActionCopy,
  originForUrl,
  shouldOpenApprovalDetails,
} from "@vibestudio/shared/approvalCopy";
import { HOST_APPROVAL_COPY } from "@vibestudio/shared/hostApprovalCopy";
import {
  clearableRows,
  compareInstallParts,
  groupInstallParts,
  groupRowsByDomain,
  installPartGroupCount,
  installRowHeadline,
  originTextSegments,
  partNotableLine,
  selectionStatusLine,
  INSTALL_BEHAVIOR_COPY,
  INSTALL_ROW_TIMING_COPY,
  type InstallReviewOrigin,
  type InstallPartGroup,
  type InstallReviewPart,
  type InstallReviewRow,
  type TemplateAcceptance,
  type TemplateInstallResolution,
} from "@vibestudio/shared/authority/unitInstallReview";
import { useAtomValue } from "jotai";
import { themeColorsAtom } from "../state/themeAtoms";
import { shellClientAtom } from "../state/shellClientAtom";
import { MobileUnitIcon, type MobileUnitIconKind } from "./MobileUnitIcon";
import {
  hairline,
  pressedOpacity,
  radius,
  shadow,
  spacing,
  touchTarget,
  type as typeRamp,
} from "../design/tokens";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Globe,
  Lock,
  Settings2,
  User,
  Workflow,
  X,
  XCircle,
  type IconComponent,
} from "../design/icons";
import { Badge } from "./ui/primitives";

type CallerInfo = ApprovalCallerPresentation;

function resolveCallerInfo(approval: PendingApproval): CallerInfo {
  return getApprovalCallerPresentation(approval);
}

function defaultInstallSelection(
  parts: PendingUnitInstallReviewApproval["parts"]
): Map<string, Set<string>> {
  return new Map(
    parts
      .filter((part) => part.change !== "removed")
      .map((part) => [
        part.identityKey,
        new Set(
          clearableRows(part)
            .filter((row) => row.selectedByDefault)
            .map((row) => row.key)
        ),
      ])
  );
}

/** Keep user choices that remain valid when the server refreshes one approval. */
function syncInstallSelection(
  parts: PendingUnitInstallReviewApproval["parts"],
  previous: ReadonlyMap<string, ReadonlySet<string>>
): Map<string, Set<string>> {
  return new Map(
    parts
      .filter((part) => part.change !== "removed")
      .map((part) => {
        const rows = clearableRows(part);
        const offerable = new Set(rows.map((row) => row.key));
        const prior = previous.get(part.identityKey);
        const selected = prior
          ? [...prior].filter((key) => offerable.has(key))
          : rows.filter((row) => row.selectedByDefault).map((row) => row.key);
        return [part.identityKey, new Set(selected)] as const;
      })
  );
}

function installOfferSignature(approval: PendingApproval | null): string {
  if (!approval || approval.kind !== "unit-install-review") return "";
  return JSON.stringify(
    approval.parts.map((part) => [
      part.identityKey,
      part.change,
      clearableRows(part).map((row) => [row.key, row.selectedByDefault]),
    ])
  );
}

export interface ApprovalSheetProps {
  approvals: PendingApproval[];
  onResolve: (approvalId: string, decision: ApprovalDecision) => Promise<void> | void;
  onSubmitClientConfig: (
    approvalId: string,
    values: Record<string, string>
  ) => Promise<void> | void;
  onSubmitCredentialInput: (
    approvalId: string,
    values: Record<string, string>
  ) => Promise<void> | void;
  onSubmitSecretInput: (approvalId: string, values: Record<string, string>) => Promise<void> | void;
  onResolveMissionReview: (
    approvalId: string,
    resolution: { decision: "approve"; selectedAuthorityKeys: string[] } | { decision: "dismiss" }
  ) => Promise<void> | void;
  /**
   * Accept a review with exactly what the user allowed now, or cancel it. Every
   * part arrives either way; this decides only what is pre-authorized.
   */
  onResolveInstallReview: (
    approvalId: string,
    resolution: TemplateInstallResolution
  ) => Promise<void> | void;
  /**
   * Optional. When supplied and the current approval comes from a panel,
   * the caller chip becomes touchable and invokes this with the panel id.
   * Mobile wires it to `activatePanel` so the user can jump to the source.
   */
  onNavigateToPanel?: (panelId: string) => void;
  /** Lazy trusted blob read. The sheet further restricts this to hashes in the approval payload. */
  onFetchDiffContent?: (approvalId: string, hash: string) => Promise<string | null>;
  /** Open the full workspace file inspector for more context or degraded files. */
  onOpenDiffFile?: (file: DiffReviewFile, entry: DiffReviewEntry) => Promise<void> | void;
}

type PendingAction =
  | ApprovalDecision
  | "submit-client-config"
  | "submit-credential-input"
  | "submit-secret-input"
  | "mission-review-approve"
  | "mission-review-dismiss";

type ButtonVariant = "primary" | "surface" | "danger" | "dangerPrimary" | "outline";

export function ApprovalSheet({
  approvals,
  onResolve,
  onSubmitClientConfig,
  onSubmitCredentialInput,
  onSubmitSecretInput,
  onResolveMissionReview,
  onResolveInstallReview,
  onNavigateToPanel,
  onFetchDiffContent,
  onOpenDiffFile,
}: ApprovalSheetProps) {
  const colors = useAtomValue(themeColorsAtom);
  const [browseIndex, setBrowseIndex] = useState(0);
  useEffect(() => {
    setBrowseIndex((idx) => {
      if (approvals.length === 0) return 0;
      if (idx >= approvals.length) return approvals.length - 1;
      return idx;
    });
  }, [approvals.length]);

  const current = approvals[browseIndex] ?? approvals[0] ?? null;
  const queueLength = approvals.length;
  const canPrev = queueLength > 1 && browseIndex > 0;
  const canNext = queueLength > 1 && browseIndex < queueLength - 1;
  const [values, setValues] = useState<Record<string, string>>({});
  const [selectedMissionAuthorityKeys, setSelectedMissionAuthorityKeys] = useState<Set<string>>(
    new Set()
  );
  /**
   * What the user has allowed now, per part. Seeded from the review's own
   * defaults, so one tap accepts the complete slate with everything allowed and
   * unchecking is the dial for anyone who would rather be asked (U5).
   */
  const [installSelection, setInstallSelection] = useState<Map<string, Set<string>>>(new Map());
  // Recomputed on every render so the footer status line and the acceptance
  // payload always agree with exactly what is checked on screen right now.
  const installAllowNow: TemplateAcceptance["allowNow"] = useMemo(
    () =>
      [...installSelection].map(([identityKey, permissions]) => ({
        identityKey,
        permissions: [...permissions],
      })),
    [installSelection]
  );
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);
  const translateY = useRef(new Animated.Value(Dimensions.get("window").height)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;
  const dragOffset = useRef(0);

  const callerInfo = current ? resolveCallerInfo(current) : null;
  const copy = current && callerInfo ? getApprovalCopy(current) : null;
  const attribution = current ? getApprovalAttribution(current) : null;
  const riskTone = current ? getApprovalRiskTone(current) : "standard";
  const accentColor =
    riskTone === "danger"
      ? colors.danger
      : riskTone === "caution"
        ? colors.warning
        : colors.primary;

  const isBusy = pendingAction !== null;
  const currentApprovalId = current?.approvalId;
  const currentInstallOfferSignature = installOfferSignature(current);
  const previousApprovalId = useRef<string | undefined>(undefined);

  useEffect(() => {
    const approvalChanged = previousApprovalId.current !== currentApprovalId;
    previousApprovalId.current = currentApprovalId;
    if (!current) {
      if (approvalChanged) setInstallSelection(new Map());
      return;
    }
    setInstallSelection((previous) =>
      current.kind === "unit-install-review"
        ? approvalChanged
          ? defaultInstallSelection(current.parts)
          : syncInstallSelection(current.parts, previous)
        : new Map()
    );
    if (!approvalChanged) return;
    setValues({});
    setSelectedMissionAuthorityKeys(
      new Set(
        current.kind === "mission-review"
          ? current.authority.diff.added.filter((row) => row.tier === "gated").map(authorityRowKey)
          : []
      )
    );
    setError(null);
    setPendingAction(null);
    setMinimized(false);
    setDetailsOpen(
      shouldOpenApprovalDetails(current) ||
        (current.kind === "credential" && !!current.oauthAudienceDomainMismatch)
    );
    ReactNativeHapticFeedback.trigger("impactLight");
    Animated.parallel([
      Animated.spring(translateY, {
        toValue: 0,
        useNativeDriver: true,
        stiffness: 220,
        damping: 28,
        mass: 1,
      }),
      Animated.timing(backdropOpacity, {
        toValue: 1,
        duration: 200,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
    if (copy) {
      const requester = callerInfo
        ? `Requested by ${callerInfo.label}, ${callerInfo.kindLabel.toLowerCase()}. `
        : "";
      AccessibilityInfo.announceForAccessibility(`${copy.title}. ${requester}${copy.summary}`);
    }
  }, [currentApprovalId, currentInstallOfferSignature]);

  const runAction = useCallback(
    async (action: PendingAction, task: () => Promise<void> | void) => {
      if (isBusy) return;
      setError(null);
      setPendingAction(action);
      if (action === "deny") {
        ReactNativeHapticFeedback.trigger("notificationWarning");
      } else {
        ReactNativeHapticFeedback.trigger("impactMedium");
      }
      try {
        await task();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Couldn't resolve. Try again.";
        setError(message || "Couldn't resolve. Try again.");
        AccessibilityInfo.announceForAccessibility(
          `Approval action failed. ${message || "Couldn't resolve. Try again."}`
        );
      } finally {
        setPendingAction(null);
      }
    },
    [isBusy]
  );

  const dismiss = useCallback(() => {
    if (!current || isBusy) return;
    // Backdrop taps and swipe-down mean “not now”, not denial. Keep the queue
    // entry pending and leave a visible pill to reopen it.
    setMinimized(true);
  }, [current, isBusy]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          !isBusy && gesture.dy > 8 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderMove: (_event, gesture) => {
          const next = Math.max(0, gesture.dy);
          dragOffset.current = next;
          translateY.setValue(next);
        },
        onPanResponderRelease: (_event, gesture) => {
          if (gesture.dy > 120 || gesture.vy > 0.8) {
            ReactNativeHapticFeedback.trigger("impactLight");
            dismiss();
            return;
          }
          dragOffset.current = 0;
          Animated.spring(translateY, {
            toValue: 0,
            useNativeDriver: true,
            stiffness: 220,
            damping: 28,
          }).start();
        },
      }),
    [dismiss, isBusy, translateY]
  );

  const showRequestingPanel = useCallback(() => {
    if (callerInfo?.panelId && onNavigateToPanel) {
      onNavigateToPanel(callerInfo.panelId);
    }
  }, [callerInfo, onNavigateToPanel]);

  if (!current || !copy || !callerInfo) return null;

  if (minimized) {
    return (
      <View pointerEvents="box-none" style={styles.minimizedRoot}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Review pending approval: ${copy.title}`}
          onPress={() => setMinimized(false)}
          style={({ pressed }) => [
            styles.minimizedApproval,
            { backgroundColor: colors.surface, borderColor: colors.warning },
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.minimizedApprovalText, { color: colors.text }]}>
            Approval waiting · Review
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <Modal visible transparent animationType="none" presentationStyle="overFullScreen">
      <View style={styles.modalRoot}>
        <Animated.View
          style={[styles.backdrop, { backgroundColor: colors.overlay, opacity: backdropOpacity }]}
        >
          <Pressable
            accessibilityLabel="Dismiss approval"
            disabled={isBusy}
            onPress={dismiss}
            style={StyleSheet.absoluteFill}
            testID="approval-backdrop"
          />
        </Animated.View>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.keyboardRoot}
        >
          <SafeAreaView edges={["bottom"]} style={styles.safeArea}>
            <Animated.View
              accessible
              accessibilityRole="summary"
              accessibilityLabel={`${copy.title}. Requested by ${callerInfo.label}. ${copy.summary}`}
              accessibilityHint="Review the details, then choose an action at the bottom of the sheet."
              accessibilityState={{ busy: isBusy }}
              accessibilityViewIsModal
              style={[
                styles.sheet,
                shadow.sheet,
                {
                  backgroundColor: colors.surfaceRaised,
                  borderColor: colors.border,
                  shadowColor: colors.shadow,
                  transform: [{ translateY }],
                },
              ]}
              testID="approval-sheet"
            >
              <View
                style={[styles.accentStripe, { backgroundColor: accentColor }]}
                testID="approval-accent-stripe"
              />
              <Pressable
                accessibilityLabel="Dismiss approval"
                accessibilityRole="button"
                disabled={isBusy}
                onPress={dismiss}
                style={styles.dismissButton}
                testID="approval-dismiss"
              >
                <X size={20} color={colors.textSecondary} />
              </Pressable>
              <View style={styles.handleWrap} {...panResponder.panHandlers}>
                <View style={[styles.handle, { backgroundColor: colors.border }]} />
              </View>

              <ScrollView
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={styles.scrollContent}
              >
                <ApprovalHeader
                  approval={current}
                  accentColor={accentColor}
                  queueLength={queueLength}
                  queueIndex={browseIndex}
                  canPrev={canPrev}
                  canNext={canNext}
                  onPrev={() => setBrowseIndex((idx) => Math.max(0, idx - 1))}
                  onNext={() => setBrowseIndex((idx) => Math.min(queueLength - 1, idx + 1))}
                />
                {current.kind === "capability" && current.authorityRow ? (
                  <View
                    style={[
                      styles.domainChip,
                      { backgroundColor: colors.surfaceSunken, borderColor: colors.borderSubtle },
                    ]}
                  >
                    <Text style={[styles.domainChipText, { color: colors.textSecondary }]}>
                      {AUTHORITY_DOMAINS[current.authorityRow.domain].label}
                      {current.authorityRow.provenance.surface
                        ? ` · ${current.authorityRow.provenance.surface}`
                        : ""}
                    </Text>
                  </View>
                ) : null}
                <Text style={[styles.title, { color: colors.text }]}>{copy.title}</Text>
                <CallerRow
                  caller={callerInfo}
                  attribution={attribution ?? {}}
                  canNavigate={!!onNavigateToPanel && !!callerInfo.panelId}
                  onPress={showRequestingPanel}
                />
                {copy.summary ? <ApprovalMarkdown source={copy.summary} tone="muted" /> : null}
                {copy.warning ? <WarningBand message={copy.warning} /> : null}
                {current.kind === "device-code" ? <DeviceCodePanel approval={current} /> : null}
                {/* The review IS the body: parts, rows, and selection. It is
                    not a disclosure under a request summary. */}
                {current.kind === "unit-install-review" ? (
                  <InstallReviewDetails
                    approval={current}
                    selection={installSelection}
                    onTogglePart={(part, checked) =>
                      setInstallSelection((currentSelection) => {
                        const next = new Map(currentSelection);
                        next.set(
                          part.identityKey,
                          checked
                            ? new Set(
                                clearableRows(part)
                                  .filter((row) => row.selectedByDefault)
                                  .map((row) => row.key)
                              )
                            : new Set()
                        );
                        return next;
                      })
                    }
                    onToggleRow={(part, rowKey, checked) =>
                      setInstallSelection((currentSelection) => {
                        const next = new Map(currentSelection);
                        const rows = new Set(next.get(part.identityKey) ?? []);
                        if (checked) rows.add(rowKey);
                        else rows.delete(rowKey);
                        next.set(part.identityKey, rows);
                        return next;
                      })
                    }
                  />
                ) : null}
                {current.kind === "mission-review" ? (
                  <MissionReviewPanel
                    approval={current}
                    selected={selectedMissionAuthorityKeys}
                    onToggle={(key, checked) =>
                      setSelectedMissionAuthorityKeys((currentSelection) => {
                        const next = new Set(currentSelection);
                        if (checked) next.add(key);
                        else next.delete(key);
                        return next;
                      })
                    }
                  />
                ) : null}
                {current.kind === "capability" && current.operationSubstance ? (
                  <View style={styles.detailCard}>
                    <Text style={[styles.detailLabel, { color: colors.textSecondary }]}>
                      What exactly
                    </Text>
                    <Text style={[styles.detailValue, { color: colors.text }]}>
                      {current.operationSubstance.summary}
                    </Text>
                    {current.operationSubstance.detail ? (
                      <Text style={[styles.detailValue, { color: colors.textSecondary }]}>
                        {current.operationSubstance.detail}
                      </Text>
                    ) : null}
                    {current.operationSubstance.facts?.map((fact) => (
                      <View key={`${fact.label}:${fact.value}`} style={styles.substanceFact}>
                        <Text style={[styles.substanceFactLabel, { color: colors.textSecondary }]}>
                          {fact.label}
                        </Text>
                        <Text style={[styles.substanceFactValue, { color: colors.text }]}>
                          {fact.value}
                        </Text>
                      </View>
                    ))}
                  </View>
                ) : null}
                {current.diffReview && current.diffReview.length > 0 ? (
                  <MobileDiffReview
                    approvalId={current.approvalId}
                    entries={current.diffReview}
                    fetchContent={onFetchDiffContent}
                    onOpenFile={
                      onOpenDiffFile
                        ? async (file, entry) => {
                            setMinimized(true);
                            await onOpenDiffFile(file, entry);
                          }
                        : undefined
                    }
                  />
                ) : null}
                {error ? <InlineError message={error} /> : null}
                {current.kind === "client-config" ||
                current.kind === "credential-input" ||
                current.kind === "secret-input" ? (
                  <SecretConfigFields
                    approval={current}
                    values={values}
                    onChange={(name, value) =>
                      setValues((previous) => ({ ...previous, [name]: value }))
                    }
                  />
                ) : null}
                <ApprovalDetails
                  approval={current}
                  caller={callerInfo}
                  open={detailsOpen}
                  onToggle={() => setDetailsOpen((open) => !open)}
                />
              </ScrollView>

              <View
                style={[
                  styles.actionBar,
                  { borderTopColor: colors.borderSubtle, backgroundColor: colors.surfaceRaised },
                ]}
              >
                {current.kind === "client-config" ? (
                  <ClientConfigActions
                    approval={current}
                    values={values}
                    busy={isBusy}
                    pendingAction={pendingAction}
                    onSubmit={() =>
                      runAction("submit-client-config", () =>
                        onSubmitClientConfig(current.approvalId, values)
                      )
                    }
                    onDeny={() => runAction("deny", () => onResolve(current.approvalId, "deny"))}
                  />
                ) : current.kind === "credential-input" ? (
                  <CredentialInputActions
                    approval={current}
                    values={values}
                    busy={isBusy}
                    pendingAction={pendingAction}
                    onSubmit={() =>
                      runAction("submit-credential-input", () =>
                        onSubmitCredentialInput(current.approvalId, values)
                      )
                    }
                    onDeny={() => runAction("deny", () => onResolve(current.approvalId, "deny"))}
                  />
                ) : current.kind === "secret-input" ? (
                  <SecretInputActions
                    approval={current}
                    values={values}
                    busy={isBusy}
                    pendingAction={pendingAction}
                    onSubmit={() =>
                      runAction("submit-secret-input", () =>
                        onSubmitSecretInput(current.approvalId, values)
                      )
                    }
                    onDeny={() => runAction("deny", () => onResolve(current.approvalId, "deny"))}
                  />
                ) : current.kind === "device-code" ? (
                  <DeviceCodeActions
                    busy={isBusy}
                    pendingAction={pendingAction}
                    onCancel={() =>
                      runAction("dismiss", () => onResolve(current.approvalId, "dismiss"))
                    }
                  />
                ) : current.kind === "unit-install-review" ? (
                  <InstallReviewActions
                    approval={current}
                    allowNow={installAllowNow}
                    busy={isBusy}
                    pendingAction={pendingAction}
                    onAccept={() =>
                      runAction("once", () =>
                        onResolveInstallReview(current.approvalId, {
                          decision:
                            current.mode === "update"
                              ? "update"
                              : current.mode === "adopt-root"
                                ? "adopt-root"
                                : "install",
                          allowNow: installAllowNow,
                        })
                      )
                    }
                    onCancel={() =>
                      runAction("dismiss", () =>
                        onResolveInstallReview(current.approvalId, { decision: "cancel" })
                      )
                    }
                  />
                ) : current.kind === "mission-review" ? (
                  <MissionReviewActions
                    approval={current}
                    busy={isBusy}
                    pendingAction={pendingAction}
                    onApprove={() =>
                      runAction("mission-review-approve", () =>
                        onResolveMissionReview(current.approvalId, {
                          decision: "approve",
                          selectedAuthorityKeys: [...selectedMissionAuthorityKeys],
                        })
                      )
                    }
                    onDismiss={() =>
                      runAction("mission-review-dismiss", () =>
                        onResolveMissionReview(current.approvalId, { decision: "dismiss" })
                      )
                    }
                  />
                ) : current.kind === "browser-permission" ? (
                  <BrowserPermissionActions
                    busy={isBusy}
                    pendingAction={pendingAction}
                    onChoose={(decision) =>
                      runAction(decision, () => onResolve(current.approvalId, decision))
                    }
                  />
                ) : (
                  <StandardActions
                    approval={current}
                    busy={isBusy}
                    pendingAction={pendingAction}
                    onChoose={(decision) =>
                      runAction(decision, () => onResolve(current.approvalId, decision))
                    }
                  />
                )}
              </View>
            </Animated.View>
          </SafeAreaView>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

function ApprovalHeader({
  approval,
  accentColor,
  queueLength,
  queueIndex,
  canPrev,
  canNext,
  onPrev,
  onNext,
}: {
  approval: PendingApproval;
  accentColor: string;
  queueLength: number;
  queueIndex: number;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  const CategoryIcon = getCategoryIcon(approval);
  return (
    <View style={styles.headerRow}>
      <View
        style={[styles.categoryIcon, { backgroundColor: accentColor }]}
        testID="approval-category-icon"
      >
        <CategoryIcon size={17} color="#ffffff" />
      </View>
      {queueLength > 1 ? (
        <QueueNavigator
          index={queueIndex}
          total={queueLength}
          canPrev={canPrev}
          canNext={canNext}
          onPrev={onPrev}
          onNext={onNext}
        />
      ) : null}
    </View>
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
  const colors = useAtomValue(themeColorsAtom);
  return (
    <View style={styles.queueNavigator}>
      <Pressable
        accessibilityLabel="Previous approval"
        accessibilityRole="button"
        accessibilityState={{ disabled: !canPrev }}
        disabled={!canPrev}
        onPress={onPrev}
        style={[styles.queueButton, !canPrev ? styles.disabled : null]}
        testID="approval-queue-prev"
      >
        <ChevronLeft size={16} color={colors.textSecondary} />
      </Pressable>
      <Text style={[styles.queueLabel, { color: colors.textSecondary }]}>
        {index + 1} / {total}
      </Text>
      <Pressable
        accessibilityLabel="Next approval"
        accessibilityRole="button"
        accessibilityState={{ disabled: !canNext }}
        disabled={!canNext}
        onPress={onNext}
        style={[styles.queueButton, !canNext ? styles.disabled : null]}
        testID="approval-queue-next"
      >
        <ChevronRight size={16} color={colors.textSecondary} />
      </Pressable>
    </View>
  );
}

function CallerRow({
  caller,
  attribution,
  canNavigate,
  onPress,
}: {
  caller: CallerInfo;
  attribution: ApprovalAttribution;
  canNavigate: boolean;
  onPress: () => void;
}) {
  const colors = useAtomValue(themeColorsAtom);
  const shellClient = useAtomValue(shellClientAtom);
  const iconKind: MobileUnitIconKind =
    caller.kind === "panel"
      ? "panel"
      : caller.kind === "app"
        ? "app"
        : caller.kind === "extension"
          ? "extension"
          : caller.kind === "system"
            ? "system"
            : "worker";
  const chip = (
    <View
      style={[
        styles.callerChip,
        { backgroundColor: colors.surfaceSunken, borderColor: colors.borderSubtle },
      ]}
    >
      <MobileUnitIcon
        icon={caller.icon}
        source={caller.iconSourcePath}
        kind={iconKind}
        serverUrl={shellClient?.serverUrl ?? ""}
        size={18}
        color={colors.textSecondary}
      />
      <Text numberOfLines={1} style={[styles.callerChipLabel, { color: colors.text }]}>
        {caller.label}
      </Text>
      {canNavigate ? <ArrowRight size={12} color={colors.accent} /> : null}
    </View>
  );
  return (
    <View style={styles.callerRow}>
      {canNavigate ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Show ${caller.kindLabel.toLowerCase()} ${caller.label}`}
          onPress={onPress}
          testID="approval-caller-chip"
          style={({ pressed }) => [pressed ? styles.pressed : null]}
        >
          {chip}
        </Pressable>
      ) : (
        <View testID="approval-caller-chip">{chip}</View>
      )}
      <Text style={[styles.callerRowLabel, { color: colors.textSecondary }]}>
        {caller.kindLabel.toLowerCase()}
      </Text>
      {attribution.target ? (
        <>
          <Text style={[styles.callerRowLabel, { color: colors.textSecondary }]}>
            {attribution.relation ?? "for"}
          </Text>
          <View
            style={[
              styles.callerChip,
              { backgroundColor: colors.surfaceSunken, borderColor: colors.borderSubtle },
            ]}
          >
            <Text numberOfLines={1} style={[styles.callerChipLabel, { color: colors.text }]}>
              {attribution.target}
            </Text>
          </View>
        </>
      ) : null}
    </View>
  );
}

function getCategoryIcon(approval: PendingApproval): IconComponent {
  if (approval.kind === "capability") return ExternalLink;
  if (
    approval.kind === "client-config" ||
    approval.kind === "credential-input" ||
    approval.kind === "secret-input"
  )
    return Settings2;
  if (approval.kind === "device-code") return ExternalLink;
  return Lock;
}

function WarningBand({ message }: { message: string }) {
  const colors = useAtomValue(themeColorsAtom);
  return (
    <View
      accessibilityRole="alert"
      style={[styles.warningBand, { backgroundColor: colors.dangerSoft }]}
    >
      <AlertTriangle size={14} color={colors.danger} />
      <View style={styles.markdownFlex}>
        <ApprovalMarkdown source={message} tone="danger" compact />
      </View>
    </View>
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
  const colors = useAtomValue(themeColorsAtom);
  const blocks = parseApprovalMarkdown(source);
  if (blocks.length === 0) return null;
  const color =
    tone === "danger" ? colors.danger : tone === "muted" ? colors.textSecondary : colors.text;
  return (
    <View style={[styles.markdownBlock, compact ? styles.markdownBlockCompact : null]}>
      {blocks.map((block, index) => {
        if (block.kind === "code-block") {
          return (
            <Text
              key={index}
              selectable
              style={[
                styles.markdownCodeBlock,
                { color: colors.text, backgroundColor: colors.codeBackground },
              ]}
            >
              {block.text}
            </Text>
          );
        }
        if (block.kind === "bullet-list" || block.kind === "ordered-list") {
          return (
            <View key={index} style={styles.markdownList}>
              {block.items.map((item, itemIndex) => (
                <View key={itemIndex} style={styles.markdownListRow}>
                  <Text style={[styles.markdownBullet, { color }]}>
                    {block.kind === "ordered-list" ? `${itemIndex + 1}.` : "-"}
                  </Text>
                  <Text style={[styles.markdownText, { color }]}>
                    <ApprovalMarkdownInlineNodes nodes={item} color={color} />
                  </Text>
                </View>
              ))}
            </View>
          );
        }
        return (
          <Text key={index} style={[styles.markdownText, { color }]}>
            <ApprovalMarkdownInlineNodes nodes={block.children} color={color} />
          </Text>
        );
      })}
    </View>
  );
}

function ApprovalMarkdownInlineNodes({
  nodes,
  color,
}: {
  nodes: ApprovalMarkdownInline[];
  color: string;
}) {
  const colors = useAtomValue(themeColorsAtom);
  return (
    <>
      {nodes.map((node, index) => {
        if (node.kind === "code") {
          return (
            <Text
              key={index}
              style={[
                styles.markdownInlineCode,
                { color: colors.text, backgroundColor: colors.codeBackground },
              ]}
            >
              {node.text}
            </Text>
          );
        }
        if (node.kind === "strong") {
          return (
            <Text key={index} style={styles.markdownStrong}>
              <ApprovalMarkdownInlineNodes nodes={node.children} color={color} />
            </Text>
          );
        }
        if (node.kind === "emphasis") {
          return (
            <Text key={index} style={styles.markdownEmphasis}>
              <ApprovalMarkdownInlineNodes nodes={node.children} color={color} />
            </Text>
          );
        }
        return (
          <Text key={index} style={{ color }}>
            {node.text}
          </Text>
        );
      })}
    </>
  );
}

function InlineError({ message }: { message: string }) {
  const colors = useAtomValue(themeColorsAtom);
  return (
    <View style={[styles.warningBand, { backgroundColor: colors.dangerSoft }]}>
      <AlertTriangle size={14} color={colors.danger} />
      <Text style={[styles.warningText, { color: colors.danger }]}>{message}</Text>
    </View>
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
  const colors = useAtomValue(themeColorsAtom);
  return (
    <View style={styles.fields}>
      <Text style={[styles.helperText, { color: colors.textSecondary }]}>
        {approval.kind === "secret-input"
          ? HOST_APPROVAL_COPY.forms.ephemeralSecretHelp
          : HOST_APPROVAL_COPY.forms.storedSecretHelp}
      </Text>
      {approval.fields.map((field) => (
        <View key={field.name} style={styles.fieldBlock}>
          <View style={styles.fieldLabelRow}>
            <Text style={[styles.fieldLabel, { color: colors.text }]}>{field.label}</Text>
            {field.required ? (
              <Badge label={HOST_APPROVAL_COPY.chrome.required} tone="warning" />
            ) : null}
            {field.type === "secret" ? <Badge label={HOST_APPROVAL_COPY.chrome.secret} /> : null}
          </View>
          <TextInput
            accessibilityLabel={field.label}
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={(text) => onChange(field.name, text)}
            placeholder={field.label}
            placeholderTextColor={colors.textTertiary}
            secureTextEntry={field.type === "secret"}
            style={[
              styles.input,
              {
                backgroundColor: colors.surfaceSunken,
                borderColor: colors.border,
                color: colors.text,
              },
            ]}
            testID={`approval-field-${field.name}`}
            value={values[field.name] ?? ""}
          />
          {field.description ? (
            <ApprovalMarkdown source={field.description} tone="muted" compact />
          ) : null}
        </View>
      ))}
    </View>
  );
}

function requesterBreadcrumbSummary(approval: PendingApproval): string | null {
  const breadcrumbs = approval.requester?.breadcrumbs ?? [];
  if (breadcrumbs.length <= 1) return null;
  return (
    breadcrumbs
      .map((breadcrumb) => {
        if (breadcrumb.category === "unknown") return breadcrumb.label;
        const kind = getRequesterCategoryLabel(breadcrumb.category);
        return breadcrumb.label ? `${kind}: ${breadcrumb.label}` : kind;
      })
      .filter(Boolean)
      .join(" > ") || null
  );
}

function evalSummary(approval: PendingApproval): string | null {
  const evalMeta = approval.requester?.eval;
  if (!evalMeta) return null;
  const parts = [
    evalMeta.ownerId ? `owner ${evalMeta.ownerId}` : null,
    evalMeta.subKey ? `scope ${evalMeta.subKey}` : null,
    evalMeta.runId ? `run ${evalMeta.runId}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(", ") : "Eval sandbox";
}

function ApprovalDetails({
  approval,
  caller,
  open,
  onToggle,
}: {
  approval: PendingApproval;
  caller: CallerInfo;
  open: boolean;
  onToggle: () => void;
}) {
  const colors = useAtomValue(themeColorsAtom);
  const breadcrumbSummary = requesterBreadcrumbSummary(approval);
  const requesterEvalSummary = evalSummary(approval);
  return (
    <View style={styles.detailsBlock}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        style={styles.detailsSummary}
      >
        <ChevronDown
          size={14}
          color={colors.textSecondary}
          // Visual hint: chevron points down when open, right when closed.
          // Native RN can't rotate icons declaratively without animated value;
          // we keep it static and rely on accessibilityState for assistive tech.
        />
        <Text style={[styles.detailsSummaryText, { color: colors.textSecondary }]}>
          Request details
        </Text>
      </Pressable>
      {open ? (
        <View style={styles.detailRows}>
          <DetailRow
            icon={User}
            label="Requester"
            value={`${caller.kindLabel} · ${caller.label}`}
            secondary={approval.callerId}
            secondarySelectable
          />
          {breadcrumbSummary ? (
            <DetailRow icon={Workflow} label="Chain" value={breadcrumbSummary} code />
          ) : null}
          {requesterEvalSummary ? (
            <DetailRow icon={Settings2} label="Eval" value={requesterEvalSummary} code />
          ) : null}
          {approval.requester ? (
            <DetailRow
              icon={Lock}
              label="Trust key"
              value={approval.requester.stableIdentityKey}
              code
            />
          ) : null}
          {approval.operation ? (
            <DetailRow
              icon={Settings2}
              label="Operation"
              value={`${getApprovalOperationKindLabel(approval.operation.kind)} · ${approval.operation.verb}${
                approval.operation.object ? ` · ${approval.operation.object.value}` : ""
              }`}
              code
            />
          ) : null}
          <DetailRow icon={Globe} label="Requester repo" value={approval.repoPath} code />
          <DetailRow icon={Lock} label="Requester version" value={approval.effectiveVersion} code />
          {approval.kind === "credential" ? (
            <CredentialDetails approval={approval} />
          ) : approval.kind === "client-config" ? (
            <ClientConfigDetails approval={approval} />
          ) : approval.kind === "credential-input" ? (
            <CredentialInputDetails approval={approval} />
          ) : approval.kind === "secret-input" ? (
            <SecretInputDetails approval={approval} />
          ) : approval.kind === "device-code" ? (
            <DeviceCodeDetails approval={approval} />
          ) : approval.kind === "unit-install-review" ? null : approval.kind ===
            "browser-permission" ? (
            <BrowserPermissionDetails approval={approval} />
          ) : approval.kind === "mission-review" ? null : (
            <CapabilityDetails approval={approval} />
          )}
        </View>
      ) : null}
    </View>
  );
}

function CredentialDetails({ approval }: { approval: PendingCredentialApproval }) {
  const oauthOrigins = [
    approval.oauthAuthorizeOrigin,
    approval.oauthTokenOrigin,
    approval.oauthUserinfoOrigin,
  ].filter((origin): origin is string => !!origin);
  return (
    <>
      <DetailRow icon={Lock} label="Account" value={formatAccount(approval)} code />
      <DetailRow icon={Lock} label="Injects as" value={formatInjection(approval)} code />
      {approval.bindingLabel ? (
        <DetailRow icon={Lock} label="Binding" value={approval.bindingLabel} code />
      ) : null}
      {approval.grantResource ? (
        <DetailRow
          icon={Globe}
          label="Grant"
          value={`${approval.grantResource.bindingId} ${approval.grantResource.action} ${approval.grantResource.resource}`}
          code
        />
      ) : null}
      {approval.gitOperation ? (
        <>
          <DetailRow icon={Lock} label="Operation" value={approval.gitOperation.label} code />
          <DetailRow icon={Globe} label="Remote" value={approval.gitOperation.remote} code />
        </>
      ) : null}
      <DetailRow
        icon={Globe}
        label="Audience"
        value={approval.audience.map((audience) => `${audience.match}: ${audience.url}`).join("\n")}
        code
      />
      {oauthOrigins.length > 0 ? (
        <DetailRow
          icon={Globe}
          label="OAuth"
          value={oauthOrigins.join("\n")}
          danger={!!approval.oauthAudienceDomainMismatch}
          code
        />
      ) : null}
      {approval.oauthAudienceDomainMismatch ? (
        <DetailRow
          icon={AlertTriangle}
          label="Warning"
          value="OAuth domain differs from audience"
          danger
        />
      ) : null}
      {approval.scopes.length > 0 ? (
        <DetailRow icon={Lock} label="Scopes" value={approval.scopes.join(", ")} code />
      ) : null}
    </>
  );
}

function ClientConfigDetails({ approval }: { approval: PendingClientConfigApproval }) {
  const tokenOrigin = originForUrl(approval.tokenUrl);
  const authorizeOrigin = originForUrl(approval.authorizeUrl);
  return (
    <>
      <DetailRow icon={Lock} label="Client" value={approval.configId} code />
      <DetailRow icon={Globe} label="Authorize" value={approval.authorizeUrl} code />
      <DetailRow icon={Globe} label="Token URL" value={approval.tokenUrl} code />
      <DetailRow
        icon={Lock}
        label="Binding"
        value={`Secret use limited to ${tokenOrigin}${authorizeOrigin !== tokenOrigin ? `\nSign-in starts at ${authorizeOrigin}` : ""}`}
      />
      <DetailRow
        icon={Lock}
        label="Fields"
        value={approval.fields
          .map((field) => `${field.name}${field.type === "secret" ? " (secret)" : ""}`)
          .join(", ")}
        code
      />
    </>
  );
}

function CredentialInputDetails({ approval }: { approval: PendingCredentialInputApproval }) {
  return (
    <>
      <DetailRow icon={Lock} label="Service" value={approval.credentialLabel} code />
      <DetailRow icon={Lock} label="Injects as" value={formatInjection(approval)} code />
      <DetailRow
        icon={Globe}
        label="Audience"
        value={formatCredentialInputAudienceSummary(approval)}
        code
      />
      <DetailRow
        icon={Lock}
        label="Fields"
        value={approval.fields
          .map((field) => `${field.name}${field.type === "secret" ? " (secret)" : ""}`)
          .join(", ")}
        code
      />
      {approval.scopes.length > 0 ? (
        <DetailRow icon={Lock} label="Scopes" value={approval.scopes.join(", ")} code />
      ) : null}
    </>
  );
}

function SecretInputDetails({ approval }: { approval: PendingSecretInputApproval }) {
  return (
    <>
      {(approval.details ?? []).map((detail) => (
        <DetailRow
          key={detail.label}
          icon={Lock}
          label={detail.label}
          value={detail.value}
          code={!detail.format}
          format={detail.format}
        />
      ))}
      <DetailRow
        icon={Lock}
        label="Fields"
        value={approval.fields
          .map((field) => `${field.name}${field.type === "secret" ? " (secret)" : ""}`)
          .join(", ")}
        code
      />
    </>
  );
}

function CapabilityDetails({ approval }: { approval: PendingCapabilityApproval }) {
  return (
    <>
      {approval.resource ? (
        <DetailRow
          icon={Globe}
          label={approval.resource.label}
          value={approval.resource.value}
          code
        />
      ) : null}
      {(approval.details ?? []).map((detail) => (
        <DetailRow
          key={detail.label}
          icon={Lock}
          label={detail.label}
          value={detail.value}
          code={!detail.format}
          format={detail.format}
        />
      ))}
    </>
  );
}

function BrowserPermissionDetails({ approval }: { approval: PendingBrowserPermissionApproval }) {
  return (
    <>
      <DetailRow icon={Globe} label="Site" value={approval.origin} code />
      <DetailRow icon={Lock} label="Permissions" value={approval.capabilities.join(", ")} code />
      <DetailRow icon={Settings2} label="Device" value={approval.deviceLabel} code />
    </>
  );
}

function DeviceCodeDetails({ approval }: { approval: PendingDeviceCodeApproval }) {
  return (
    <>
      <DetailRow icon={Lock} label="Service" value={approval.credentialLabel} code />
      <DetailRow icon={Globe} label="Verify at" value={approval.verificationUri} code />
      <DetailRow
        icon={Lock}
        label="Provider"
        value={originForUrl(approval.oauthTokenOrigin)}
        code
      />
    </>
  );
}

/** Beyond five, Worth knowing folds — a threshold, never a cap. Nothing is dropped. */
const NOTABLE_COLLAPSE_THRESHOLD = 5;
/** Search appears above this many template parts, and is absent below it (§7.2). */
const SEARCH_THRESHOLD = 12;

/**
 * Where bytes came from, at human scale, for the `From` slot specifically.
 *
 * The origin URL is the only thing allowed to appear here — never a version,
 * never a kind label, never the template's self-given name (§7.6.3). The host's
 * own build is the one thing worth naming honestly in this slot, since its
 * identity ships in the build rather than being asserted by a third party.
 */
function installOriginLabel(origin: InstallReviewOrigin): string {
  if (origin.originStatus === "multiple-template-contributors") {
    return "Multiple template contributions";
  }
  if (origin.originStatus === "unresolved") return "";
  if (origin.url) return origin.url;
  if (origin.isHostBuild) return origin.version ? `Vibestudio ${origin.version}` : "Vibestudio";
  return origin.originKey;
}

/**
 * In a differential review the row states what CHANGED about what a part can
 * do — nothing else. This is driven by whether the part's own rows carry a
 * `change` mark, not by the review's mode: a part the upgrade adds outright
 * carries no diff marks and reads as an ordinary footprint, exactly as install
 * does, while a part whose declared authority moved reads as a diff regardless
 * of what the surrounding operation is called.
 */
function installReviewSummaryLine(part: InstallReviewPart): string {
  const changed = [...part.notableRows, ...part.everydayRows].filter((row) => row.change);
  if (changed.length === 0) return partNotableLine(part);
  return changed
    .slice(0, 3)
    .map((row) => `${row.change === "removed" ? "− " : "+ "}${installRowHeadline(row)}`)
    .join(" · ");
}

function installReviewSummaryFragment(part: InstallReviewPart): string {
  const summary = installReviewSummaryLine(part);
  return summary.length === 0 ? summary : `${summary[0]?.toLowerCase() ?? ""}${summary.slice(1)}`;
}

/**
 * The install review, as a full-screen mobile route (§7.2, §7.8).
 *
 * Same server-owned decision, same rows, same copy, same selection semantics as
 * desktop — responsive presentation must not produce a weaker review anywhere.
 * List and detail are separate navigation levels here; the back gesture never
 * submits and never silently discards.
 */
function InstallReviewDetails({
  approval,
  selection,
  onTogglePart,
  onToggleRow,
}: {
  approval: PendingUnitInstallReviewApproval;
  selection: ReadonlyMap<string, ReadonlySet<string>>;
  onTogglePart: (part: InstallReviewPart, checked: boolean) => void;
  onToggleRow: (part: InstallReviewPart, rowKey: string, checked: boolean) => void;
}) {
  const colors = useAtomValue(themeColorsAtom);
  const copy = HOST_APPROVAL_COPY.installReview;
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [groupExpansion, setGroupExpansion] = useState<Map<string, boolean>>(() => new Map());

  // One comparator, shared with the desktop list (§7.8): a differential review
  // leads with what changed, a first encounter leads with what is worth
  // knowing. Sorting by title alone scattered the handful of parts that have
  // something to say through fifty that read `Nothing unusual`, and on a phone
  // — where the list is one column and the fold is four rows down — that is
  // where a notable part goes to be missed.
  const sortedParts = useMemo(
    () =>
      [...approval.parts].sort((left, right) => compareInstallParts(approval.mode, left, right)),
    [approval.parts, approval.mode]
  );
  // A repair touches units the template does not own (§5.3): it is never mixed
  // into the template's own list and never folded away.
  const templateParts = sortedParts.filter((part) => part.section === "template");
  const repairParts = sortedParts.filter((part) => part.section === "repair");
  const needle = query.trim().toLowerCase();
  const filtersShown = templateParts.length > SEARCH_THRESHOLD;
  const kinds = useMemo(
    () => [...new Set(templateParts.map((part) => part.label))].sort(),
    [templateParts]
  );
  const visibleParts = filtersShown
    ? templateParts.filter(
        (part) =>
          (kindFilter === "" || part.label === kindFilter) &&
          (needle === "" ||
            part.title.toLowerCase().includes(needle) ||
            part.purpose.toLowerCase().includes(needle))
      )
    : templateParts;
  const groups = groupInstallParts(visibleParts);
  const anythingNotable = templateParts.some((part) => part.notableRows.length > 0);
  const filtering = filtersShown && (needle !== "" || kindFilter !== "");
  const groupIsOpen = (group: InstallPartGroup): boolean => {
    if (filtering) return true;
    const explicit = groupExpansion.get(group.key);
    if (explicit !== undefined) return explicit;
    return !(anythingNotable && !group.hasNotablePart);
  };
  const hiddenByFilter = templateParts.length - visibleParts.length;
  const hiddenAllowed = templateParts.filter(
    (part) => !visibleParts.includes(part) && (selection.get(part.identityKey)?.size ?? 0) > 0
  ).length;

  // An upgrade that changes nothing about what any part can do is one line —
  // and the sheet header already carries it.
  if (approval.parts.length === 0 && approval.unchangedPartCount > 0) return null;

  return (
    <>
      <Text style={[styles.helperText, { color: colors.textSecondary }]}>
        {copy.adds(approval.summary)}
      </Text>
      {filtersShown ? (
        <View style={styles.installReviewFilters}>
          <TextInput
            accessibilityLabel={copy.filters.search}
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setQuery}
            placeholder={copy.filters.search}
            placeholderTextColor={colors.textTertiary}
            style={[
              styles.input,
              {
                backgroundColor: colors.surfaceSunken,
                borderColor: colors.border,
                color: colors.text,
              },
            ]}
            testID="install-review-search"
            value={query}
          />
          <ScrollView
            horizontal
            contentContainerStyle={styles.installReviewKindFilters}
            keyboardShouldPersistTaps="handled"
            showsHorizontalScrollIndicator={false}
          >
            {["", ...kinds].map((kind) => {
              const selected = kindFilter === kind;
              const label = kind || copy.filters.allKinds;
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`${copy.filters.kind}: ${label}`}
                  key={kind || "all"}
                  onPress={() => setKindFilter(kind)}
                  style={({ pressed }) => [
                    styles.installReviewKindFilter,
                    {
                      backgroundColor: selected ? colors.accentSoft : colors.surfaceSunken,
                      borderColor: selected ? colors.primary : colors.border,
                      opacity: pressed ? pressedOpacity : 1,
                    },
                  ]}
                  testID={`install-review-kind-${kind || "all"}`}
                >
                  <Text
                    style={[
                      styles.installReviewKindFilterText,
                      { color: selected ? colors.primary : colors.textSecondary },
                    ]}
                  >
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}
      <View style={styles.installReviewGroups}>
        {groups.map((group) => {
          const open = groupIsOpen(group);
          return (
            <View
              key={group.key}
              style={[styles.installReviewGroup, { borderColor: colors.borderSubtle }]}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: filtering, expanded: open }}
                accessibilityLabel={`${group.title}. ${installPartGroupCount(group)} parts. ${group.parts
                  .map((part) => `${part.title}: ${installReviewSummaryFragment(part)}`)
                  .join(". ")}`}
                disabled={filtering}
                onPress={() =>
                  setGroupExpansion((previous) => {
                    const next = new Map(previous);
                    next.set(group.key, !open);
                    return next;
                  })
                }
                style={({ pressed }) => [
                  styles.installReviewGroupHeader,
                  {
                    backgroundColor: colors.surfaceSunken,
                    opacity: pressed ? pressedOpacity : 1,
                  },
                ]}
                testID={`install-review-group-${group.key}`}
              >
                <View style={styles.installReviewGroupTitleRow}>
                  <Text style={[styles.installReviewGroupTitle, { color: colors.text }]}>
                    {group.title}
                  </Text>
                  <View
                    style={[
                      styles.installReviewGroupBadge,
                      { backgroundColor: colors.surfaceSunken },
                    ]}
                  >
                    <Text
                      style={[styles.installReviewGroupBadgeText, { color: colors.textSecondary }]}
                    >
                      {installPartGroupCount(group)}
                    </Text>
                  </View>
                  {open ? (
                    <ChevronDown size={16} color={colors.textSecondary} />
                  ) : (
                    <ChevronRight size={16} color={colors.textSecondary} />
                  )}
                </View>
              </Pressable>
              {open ? (
                <View style={styles.installReviewGroupParts}>
                  {group.parts.map((part) => (
                    <InstallReviewPartRow
                      key={part.identityKey}
                      part={part}
                      mode={approval.mode}
                      selected={selection.get(part.identityKey) ?? new Set()}
                      onTogglePart={(checked) => onTogglePart(part, checked)}
                      onToggleRow={(rowKey, checked) => onToggleRow(part, rowKey, checked)}
                    />
                  ))}
                </View>
              ) : null}
            </View>
          );
        })}
      </View>
      {hiddenByFilter > 0 ? (
        // A filter narrows what's on screen, never what's granted. Everything
        // it hides is still selected exactly as it was and still gets installed.
        <Text style={[styles.helperText, { color: colors.textSecondary }]}>
          {copy.filters.hidden(hiddenByFilter, hiddenAllowed)}
        </Text>
      ) : null}
      {approval.unchangedPartCount > 0 ? (
        <Text style={[styles.helperText, { color: colors.textSecondary }]}>
          {copy.summary.unchangedParts(approval.unchangedPartCount)}
        </Text>
      ) : null}
      {repairParts.length > 0 ? (
        <View style={styles.detailsBlock} testID="install-review-repairs">
          <Text style={[styles.detailsSummaryText, { color: colors.text }]}>
            {copy.sections.repairs(repairParts.length)}
          </Text>
          {repairParts.map((part) => (
            <InstallReviewPartRow
              key={part.identityKey}
              part={part}
              mode={approval.mode}
              selected={selection.get(part.identityKey) ?? new Set()}
              onTogglePart={(checked) => onTogglePart(part, checked)}
              onToggleRow={(rowKey, checked) => onToggleRow(part, rowKey, checked)}
            />
          ))}
        </View>
      ) : null}
      {approval.charters?.map((charter) => (
        <Text key={charter.name} style={[styles.helperText, { color: colors.textSecondary }]}>
          {charter.name} — {charter.schedule}. {charter.purpose}
        </Text>
      ))}
    </>
  );
}

function InstallReviewPartRow({
  part,
  mode,
  selected,
  onTogglePart,
  onToggleRow,
}: {
  part: InstallReviewPart;
  mode: PendingUnitInstallReviewApproval["mode"];
  selected: ReadonlySet<string>;
  onTogglePart: (checked: boolean) => void;
  onToggleRow: (rowKey: string, checked: boolean) => void;
}) {
  const colors = useAtomValue(themeColorsAtom);
  const shellClient = useAtomValue(shellClientAtom);
  const [open, setOpen] = useState(false);
  const clearable = clearableRows(part);
  const allSelected = clearable.length > 0 && clearable.every((row) => selected.has(row.key));
  const noneSelected = clearable.every((row) => !selected.has(row.key));
  const copy = HOST_APPROVAL_COPY.installReview;

  return (
    <View style={styles.detailsBlock}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${part.title}, ${part.label}. ${installReviewSummaryLine(part)}`}
        onPress={() => setOpen((current) => !current)}
        style={styles.detailsSummary}
        testID={`install-review-part-${part.identityKey}`}
      >
        {open ? (
          <ChevronDown size={14} color={colors.textSecondary} />
        ) : (
          <ChevronRight size={14} color={colors.textSecondary} />
        )}
        <MobileUnitIcon
          icon={part.icon}
          source={part.repoPath}
          kind={
            part.kind === "panel"
              ? "panel"
              : part.kind === "app"
                ? "app"
                : part.kind === "extension"
                  ? "extension"
                  : "worker"
          }
          serverUrl={shellClient?.serverUrl ?? ""}
          size={20}
          color={colors.textSecondary}
        />
        <View style={styles.unitReviewSummary}>
          <Text style={[styles.detailsSummaryText, { color: colors.text }]}>
            {part.title} · {part.label}
          </Text>
          {part.purpose ? (
            <Text style={[styles.unitReviewChange, { color: colors.textSecondary }]}>
              {part.purpose}
            </Text>
          ) : null}
          <Text style={[styles.unitReviewChange, { color: colors.textSecondary }]}>
            {mode === "update" && part.change === "added" ? "New · " : ""}
            {installReviewSummaryLine(part)}
          </Text>
        </View>
      </Pressable>
      {clearable.length > 0 && part.change !== "removed" ? (
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: allSelected }}
          accessibilityLabel={`Allow ${part.title} now`}
          onPress={() => onTogglePart(!allSelected)}
          style={styles.detailsSummary}
        >
          <Text style={[styles.unitReviewChange, { color: colors.textSecondary }]}>
            {allSelected
              ? "Allowed now"
              : noneSelected
                ? copy.willAsk
                : "Allowed now, except what you unchecked"}
          </Text>
        </Pressable>
      ) : null}
      {open ? (
        <InstallReviewPartDetail part={part} selected={selected} onToggleRow={onToggleRow} />
      ) : null}
    </View>
  );
}

/**
 * The notable/everyday split (§7.2, §10): Worth knowing carries every headline
 * row and every behavioral fact, collapsing behind a disclosure only past five
 * — never dropping one — and auto-expanded whenever something here always
 * confirms, because that is the one row a person must not miss behind a tap.
 * The ordinary machinery of the part folds behind its own count, with the
 * shared honesty line attached only once it is opened.
 */
function InstallReviewPartDetail({
  part,
  selected,
  onToggleRow,
}: {
  part: InstallReviewPart;
  selected: ReadonlySet<string>;
  onToggleRow: (rowKey: string, checked: boolean) => void;
}) {
  const colors = useAtomValue(themeColorsAtom);
  const copy = HOST_APPROVAL_COPY.installReview;
  const [showAllNotable, setShowAllNotable] = useState(false);
  const [showEveryday, setShowEveryday] = useState(false);

  const notable = part.notableRows;
  const hasCritical = notable.some((row) => row.timing === "asks-every-time");
  const collapsed = notable.length > NOTABLE_COLLAPSE_THRESHOLD && !showAllNotable && !hasCritical;
  const shownNotable = collapsed ? notable.slice(0, NOTABLE_COLLAPSE_THRESHOLD) : notable;

  return (
    <View style={styles.detailRows}>
      {notable.length > 0 ? (
        <View style={styles.detailsBlock}>
          <View style={styles.detailRows}>
            {shownNotable.map((row) => (
              <InstallReviewRowLine
                key={row.key}
                row={row}
                checked={selected.has(row.key)}
                onToggle={(checked) => onToggleRow(row.key, checked)}
              />
            ))}
          </View>
          {collapsed ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={copy.sections.showAllNotable(notable.length)}
              onPress={() => setShowAllNotable(true)}
              style={styles.disclosureButton}
            >
              <Text style={[styles.disclosureButtonText, { color: colors.primary }]}>
                {copy.sections.showAllNotable(notable.length)}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {part.everydayRows.length > 0 ? (
        <View style={styles.detailsBlock}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showEveryday }}
            accessibilityLabel={copy.sections.everyday(part.everydayRows.length)}
            onPress={() => setShowEveryday((open) => !open)}
            style={styles.disclosureButton}
          >
            <ChevronDown size={12} color={colors.primary} />
            <Text style={[styles.disclosureButtonText, { color: colors.primary }]}>
              {copy.sections.everyday(part.everydayRows.length)}
            </Text>
          </Pressable>
          {showEveryday ? (
            <View style={styles.detailRows}>
              <Text style={[styles.unitReviewChange, { color: colors.textSecondary }]}>
                {copy.sections.everydayFraming}
              </Text>
              {/* Grouped by domain (§7.2), same as the desktop detail. Nine
                  ordinary rows in a flat column are nine things to read on a
                  phone; under `Files`, `The web`, `Your workspace` they are
                  three, and the grouping is what makes "ordinary" legible
                  rather than merely long. */}
              {groupRowsByDomain(part.everydayRows).map((group) => (
                <View key={group.label} style={styles.detailRows}>
                  <Text
                    style={[
                      styles.unitReviewChange,
                      { color: colors.textSecondary, fontWeight: "600" },
                    ]}
                  >
                    {group.label}
                  </Text>
                  {group.rows.map((row) => (
                    <InstallReviewRowLine
                      key={row.key}
                      row={row}
                      checked={selected.has(row.key)}
                      onToggle={(checked) => onToggleRow(row.key, checked)}
                    />
                  ))}
                </View>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
      {/* Identity at human scale: origin URL, never a version, kind label, or
          digest in this slot (§7.6.3). */}
      <DetailRow
        icon={Globe}
        label="From"
        value={installOriginLabel(part.origin)}
        emphasizeOrigin={part.origin}
      />
      {/* The emphasis above is visual only, so the same fact is also stated in
          words — this row's accessibility label is exactly `originDomainFact`,
          the string the terminal form prints. */}
      {part.origin.registrableDomain && !part.origin.isHostBuild ? (
        <DetailRow icon={Globe} label="Domain" value={part.origin.registrableDomain} />
      ) : null}
      {part.originallyInstalledFrom ? (
        <DetailRow
          icon={Globe}
          label="Originally installed from"
          value={part.originallyInstalledFrom}
        />
      ) : null}
    </View>
  );
}

function InstallReviewRowLine({
  row,
  checked,
  onToggle,
}: {
  row: InstallReviewRow;
  checked: boolean;
  onToggle: (checked: boolean) => void;
}) {
  const colors = useAtomValue(themeColorsAtom);
  const headline = installRowHeadline(row);
  const detail =
    row.kind === "behavior" ? INSTALL_BEHAVIOR_COPY[row.fact].detail : row.row.resource;
  const timing = INSTALL_ROW_TIMING_COPY[row.timing];

  // Contextual and critical rows carry no checkbox — this decision cannot grant
  // them, and their timing line carries the whole meaning.
  const body = (
    <View style={styles.unitReviewSummary}>
      <Text style={[styles.detailsSummaryText, { color: colors.text }]}>
        {row.change === "added" ? "+ " : row.change === "removed" ? "− " : ""}
        {headline}
      </Text>
      <Text style={[styles.unitReviewChange, { color: colors.textSecondary }]}>{detail}</Text>
      {timing ? (
        <Text style={[styles.unitReviewChange, { color: colors.textSecondary }]}>{timing}</Text>
      ) : null}
    </View>
  );

  if (!row.selectable) return <View style={styles.detailsSummary}>{body}</View>;
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={`Allow ${headline} now`}
      onPress={() => onToggle(!checked)}
      style={styles.detailsSummary}
    >
      <Text style={[styles.detailsSummaryText, { color: colors.text }]}>{checked ? "☑" : "☐"}</Text>
      {body}
    </Pressable>
  );
}

const MOBILE_DIFF_CONTEXT_LINES = 3;
const MOBILE_DIFF_MAX_CHANGED_ROWS = 400;
const MOBILE_DIFF_MAX_COMPARISON_CELLS = 750_000;
const MOBILE_DIFF_MAX_DISPLAY_ROWS = 1_600;
type MobileDiffDisplayRow = DiffRow | { type: "omitted"; count: number; key: string };

/** Preserve every changed line while folding long unchanged runs. */
function compactMobileDiffRows(rows: readonly DiffRow[]): MobileDiffDisplayRow[] {
  const keep = new Set<number>();
  rows.forEach((row, index) => {
    if (row.type === "context") return;
    for (
      let nearby = Math.max(0, index - MOBILE_DIFF_CONTEXT_LINES);
      nearby <= Math.min(rows.length - 1, index + MOBILE_DIFF_CONTEXT_LINES);
      nearby += 1
    ) {
      keep.add(nearby);
    }
  });
  if (keep.size === 0) return rows.slice(0, MOBILE_DIFF_CONTEXT_LINES * 2 + 1);
  const result: MobileDiffDisplayRow[] = [];
  let index = 0;
  while (index < rows.length) {
    if (keep.has(index)) {
      const row = rows[index];
      if (!row) throw new Error(`Diff row ${index} is missing`);
      result.push(row);
      index += 1;
      continue;
    }
    const start = index;
    while (index < rows.length && !keep.has(index)) index += 1;
    result.push({ type: "omitted", count: index - start, key: `${start}:${index}` });
  }
  return result;
}

function diffPayloadHashes(entries: readonly DiffReviewEntry[]): Set<string> {
  const hashes = new Set<string>();
  for (const entry of entries) {
    for (const file of entry.changedFiles) {
      if (file.oldHash) hashes.add(file.oldHash);
      if (file.newHash) hashes.add(file.newHash);
    }
  }
  return hashes;
}

function MobileDiffReview({
  approvalId,
  entries,
  fetchContent,
  onOpenFile,
}: {
  approvalId: string;
  entries: readonly DiffReviewEntry[];
  fetchContent?: ApprovalSheetProps["onFetchDiffContent"];
  onOpenFile?: ApprovalSheetProps["onOpenDiffFile"];
}) {
  const colors = useAtomValue(themeColorsAtom);
  const allowedHashes = useMemo(() => diffPayloadHashes(entries), [entries]);
  const cache = useRef(new Map<string, string>());
  const inFlight = useRef(new Map<string, Promise<string>>());
  useEffect(() => {
    cache.current.clear();
    inFlight.current.clear();
  }, [approvalId]);
  const fetchPayloadContent = useCallback(
    async (hash: string) => {
      if (!allowedHashes.has(hash))
        throw new Error("This file is not part of the reviewed change.");
      const cached = cache.current.get(hash);
      if (cached !== undefined) return cached;
      const pending = inFlight.current.get(hash);
      if (pending) return pending;
      if (!fetchContent) throw new Error("File contents are unavailable on this client.");
      const request = fetchContent(approvalId, hash).then((text) => {
        if (text == null) throw new Error("This reviewed file is no longer available.");
        cache.current.set(hash, text);
        return text;
      });
      inFlight.current.set(hash, request);
      try {
        return await request;
      } finally {
        inFlight.current.delete(hash);
      }
    },
    [allowedHashes, approvalId, fetchContent]
  );
  const totals = entries.reduce(
    (sum, entry) => ({
      files: sum.files + entry.diffStat.filesChanged,
      insertions: sum.insertions + (entry.diffStat.insertions ?? 0),
      deletions: sum.deletions + (entry.diffStat.deletions ?? 0),
    }),
    { files: 0, insertions: 0, deletions: 0 }
  );
  const hasLineTotals = entries.every((entry) => entry.diffStat.insertions != null);
  return (
    <View
      style={[styles.mobileDiffReview, { borderColor: colors.border }]}
      testID="approval-diff-review"
    >
      <View style={styles.mobileDiffReviewHeading}>
        <View style={styles.mobileDiffReviewHeadingCopy}>
          <Text style={[styles.mobileDiffReviewTitle, { color: colors.text }]}>Review changes</Text>
          <Text style={[styles.mobileDiffMeta, { color: colors.textSecondary }]}>
            {totals.files} {totals.files === 1 ? "file" : "files"} · {entries.length}{" "}
            {entries.length === 1 ? "repository" : "repositories"}
          </Text>
        </View>
        {hasLineTotals ? (
          <Text style={styles.mobileDiffCounts}>
            <Text style={{ color: colors.success }}>+{totals.insertions}</Text>
            <Text style={{ color: colors.textSecondary }}> · </Text>
            <Text style={{ color: colors.danger }}>−{totals.deletions}</Text>
          </Text>
        ) : null}
      </View>
      <Text style={[styles.mobileDiffHelp, { color: colors.textSecondary }]}>
        Open a repository, then a file, to inspect the exact reviewed change before deciding.
      </Text>
      <View style={styles.mobileDiffRepositories}>
        {entries.map((entry, index) => (
          <MobileDiffRepository
            key={`${entry.repoPath}:${entry.oldState}:${entry.newState ?? "deleted"}`}
            entry={entry}
            defaultOpen={index === 0}
            fetchContent={fetchPayloadContent}
            onOpenFile={onOpenFile}
          />
        ))}
      </View>
    </View>
  );
}

function MobileDiffRepository({
  entry,
  defaultOpen,
  fetchContent,
  onOpenFile,
}: {
  entry: DiffReviewEntry;
  defaultOpen: boolean;
  fetchContent: (hash: string) => Promise<string>;
  onOpenFile?: ApprovalSheetProps["onOpenDiffFile"];
}) {
  const colors = useAtomValue(themeColorsAtom);
  const [open, setOpen] = useState(defaultOpen);
  const counts =
    entry.diffStat.insertions == null
      ? ""
      : ` · +${entry.diffStat.insertions} −${entry.diffStat.deletions ?? 0}`;
  return (
    <View style={[styles.mobileDiffRepository, { borderColor: colors.borderSubtle }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={({ pressed }) => [
          styles.mobileDiffRepositoryHeader,
          { backgroundColor: colors.surfaceSunken, opacity: pressed ? pressedOpacity : 1 },
        ]}
        testID={`approval-diff-repo-${entry.repoPath}`}
      >
        {open ? (
          <ChevronDown size={16} color={colors.textSecondary} />
        ) : (
          <ChevronRight size={16} color={colors.textSecondary} />
        )}
        <View style={styles.mobileDiffRepositoryCopy}>
          <Text
            numberOfLines={2}
            style={[styles.mobileDiffRepositoryTitle, { color: colors.text }]}
          >
            {entry.repoPath}
          </Text>
          <Text style={[styles.mobileDiffMeta, { color: colors.textSecondary }]}>
            {entry.diffStat.filesChanged} {entry.diffStat.filesChanged === 1 ? "file" : "files"}
            {counts}
            {entry.truncated ? " · list truncated" : ""}
          </Text>
        </View>
      </Pressable>
      {open ? (
        <View style={styles.mobileDiffFiles}>
          {entry.changedFiles.map((file) => (
            <MobileDiffFile
              key={file.path}
              entry={entry}
              file={file}
              fetchContent={fetchContent}
              onOpenFile={onOpenFile}
            />
          ))}
          {entry.changedFiles.length === 0 ? (
            <Text style={[styles.mobileDiffHelp, { color: colors.textSecondary }]}>
              No file details were included.
            </Text>
          ) : null}
          {entry.truncated ? (
            <Text style={[styles.mobileDiffWarning, { color: colors.warning }]}>
              More files changed than this inline list can show. Use the full inspector for
              repository context.
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

type MobileFileDiffState =
  | { status: "idle" | "loading" }
  | { status: "ready"; result: LineDiffResult; rows: MobileDiffDisplayRow[] }
  | { status: "error"; message: string };

function MobileDiffFile({
  entry,
  file,
  fetchContent,
  onOpenFile,
}: {
  entry: DiffReviewEntry;
  file: DiffReviewFile;
  fetchContent: (hash: string) => Promise<string>;
  onOpenFile?: ApprovalSheetProps["onOpenDiffFile"];
}) {
  const colors = useAtomValue(themeColorsAtom);
  const degraded = Boolean(file.binary || file.tooLarge);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<MobileFileDiffState>({ status: "idle" });
  useEffect(() => {
    if (!open || degraded) return;
    let cancelled = false;
    setState({ status: "loading" });
    void (async () => {
      try {
        const load = (hash: string | undefined, side: string) => {
          if (!hash) throw new Error(`The reviewed ${side} content hash is missing.`);
          return fetchContent(hash);
        };
        let result: LineDiffResult;
        if (file.kind === "added") {
          result = allAdded(await load(file.newHash, "new"));
        } else if (file.kind === "removed") {
          result = allRemoved(await load(file.oldHash, "old"));
        } else {
          const [oldText, newText] = await Promise.all([
            load(file.oldHash, "old"),
            load(file.newHash, "new"),
          ]);
          const oldLineCount = oldText === "" ? 0 : countLines(oldText);
          const newLineCount = newText === "" ? 0 : countLines(newText);
          if (oldLineCount * newLineCount > MOBILE_DIFF_MAX_COMPARISON_CELLS) {
            throw new DiffTooLargeError("This file is too large to compare smoothly on a phone.");
          }
          result = diffLines(oldText, newText);
        }
        if (result.insertions + result.deletions > MOBILE_DIFF_MAX_CHANGED_ROWS) {
          throw new DiffTooLargeError(
            `This file changes ${result.insertions + result.deletions} lines, which is too much for a useful phone-sized inline diff.`
          );
        }
        const rows = compactMobileDiffRows(result.rows);
        if (rows.length > MOBILE_DIFF_MAX_DISPLAY_ROWS) {
          throw new DiffTooLargeError(
            "This change is too spread out for a useful phone-sized inline diff."
          );
        }
        if (!cancelled) setState({ status: "ready", result, rows });
      } catch (error) {
        if (!cancelled)
          setState({
            status: "error",
            message: error instanceof Error ? error.message : "Could not load this file diff.",
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [degraded, fetchContent, file.kind, file.newHash, file.oldHash, open]);
  const tone =
    file.kind === "added"
      ? [colors.success, colors.successSoft]
      : file.kind === "removed"
        ? [colors.danger, colors.dangerSoft]
        : [colors.warning, colors.warningSoft];
  const degradedMessage = file.binary
    ? "Binary file — inline text diff is not available."
    : file.tooLarge
      ? "This file is too large for an inline diff."
      : null;
  return (
    <View style={[styles.mobileDiffFile, { borderColor: colors.borderSubtle }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: degraded, expanded: degraded ? undefined : open }}
        disabled={degraded}
        onPress={() => {
          if (open) {
            setOpen(false);
            return;
          }
          if (state.status === "error") setState({ status: "idle" });
          setOpen(true);
        }}
        style={styles.mobileDiffFileHeader}
        testID={`approval-diff-file-${file.path}`}
      >
        {degraded ? null : open ? (
          <ChevronDown size={15} color={colors.textSecondary} />
        ) : (
          <ChevronRight size={15} color={colors.textSecondary} />
        )}
        <Text style={[styles.mobileDiffKind, { color: tone[0], backgroundColor: tone[1] }]}>
          {file.kind}
        </Text>
        <Text numberOfLines={2} style={[styles.mobileDiffFilePath, { color: colors.text }]}>
          {file.path}
        </Text>
      </Pressable>
      {degradedMessage ? (
        <MobileDiffFallback
          message={degradedMessage}
          file={file}
          entry={entry}
          onOpenFile={onOpenFile}
        />
      ) : null}
      {open ? (
        <View style={styles.mobileDiffFileBody}>
          {state.status === "idle" || state.status === "loading" ? (
            <View style={styles.mobileDiffLoading}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={[styles.mobileDiffHelp, { color: colors.textSecondary }]}>
                Loading reviewed content…
              </Text>
            </View>
          ) : state.status === "ready" ? (
            <>
              <Text style={[styles.mobileDiffMeta, { color: colors.textSecondary }]}>
                <Text style={{ color: colors.success }}>+{state.result.insertions}</Text>
                {" · "}
                <Text style={{ color: colors.danger }}>−{state.result.deletions}</Text>
                {" · unchanged context is folded"}
              </Text>
              <MobileDiffRows rows={state.rows} />
              {onOpenFile ? (
                <MobileOpenDiffFileButton file={file} entry={entry} onOpenFile={onOpenFile} />
              ) : null}
            </>
          ) : state.status === "error" ? (
            <MobileDiffFallback
              message={state.message}
              file={file}
              entry={entry}
              onOpenFile={onOpenFile}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function MobileDiffRows({ rows }: { rows: readonly MobileDiffDisplayRow[] }) {
  const colors = useAtomValue(themeColorsAtom);
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator style={styles.mobileDiffCodeScroll}>
      <View style={[styles.mobileDiffCode, { backgroundColor: colors.codeBackground }]}>
        {rows.map((row, index) =>
          row.type === "omitted" ? (
            <Text key={row.key} style={[styles.mobileDiffOmitted, { color: colors.textTertiary }]}>
              ··· {row.count} unchanged {row.count === 1 ? "line" : "lines"} ···
            </Text>
          ) : (
            <View
              key={`${row.type}:${row.oldLineNo ?? ""}:${row.newLineNo ?? ""}:${index}`}
              style={[
                styles.mobileDiffCodeRow,
                {
                  backgroundColor:
                    row.type === "added"
                      ? colors.successSoft
                      : row.type === "removed"
                        ? colors.dangerSoft
                        : "transparent",
                },
              ]}
            >
              <Text style={[styles.mobileDiffLineNumber, { color: colors.textTertiary }]}>
                {(row.type === "removed" ? row.oldLineNo : row.newLineNo) ?? ""}
              </Text>
              <Text
                style={[
                  styles.mobileDiffMarker,
                  {
                    color:
                      row.type === "added"
                        ? colors.success
                        : row.type === "removed"
                          ? colors.danger
                          : colors.textTertiary,
                  },
                ]}
              >
                {row.type === "added" ? "+" : row.type === "removed" ? "−" : " "}
              </Text>
              <Text selectable style={[styles.mobileDiffCodeText, { color: colors.text }]}>
                {row.text || " "}
              </Text>
            </View>
          )
        )}
      </View>
    </ScrollView>
  );
}

function MobileDiffFallback({
  message,
  file,
  entry,
  onOpenFile,
}: {
  message: string;
  file: DiffReviewFile;
  entry: DiffReviewEntry;
  onOpenFile?: ApprovalSheetProps["onOpenDiffFile"];
}) {
  const colors = useAtomValue(themeColorsAtom);
  return (
    <View style={[styles.mobileDiffFallback, { backgroundColor: colors.warningSoft }]}>
      <Text style={[styles.mobileDiffWarning, { color: colors.warning }]}>{message}</Text>
      {onOpenFile ? (
        <MobileOpenDiffFileButton file={file} entry={entry} onOpenFile={onOpenFile} />
      ) : null}
    </View>
  );
}

function MobileOpenDiffFileButton({
  file,
  entry,
  onOpenFile,
}: {
  file: DiffReviewFile;
  entry: DiffReviewEntry;
  onOpenFile: NonNullable<ApprovalSheetProps["onOpenDiffFile"]>;
}) {
  const colors = useAtomValue(themeColorsAtom);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${file.path} in the full file inspector`}
      onPress={() => void onOpenFile(file, entry)}
      style={({ pressed }) => [
        styles.mobileDiffOpenFile,
        { opacity: pressed ? pressedOpacity : 1 },
      ]}
      testID={`approval-diff-open-${file.path}`}
    >
      <Text style={[styles.mobileDiffOpenFileText, { color: colors.primary }]}>
        Open full file inspector
      </Text>
      <ChevronRight size={14} color={colors.primary} />
    </Pressable>
  );
}

function DeviceCodePanel({ approval }: { approval: PendingDeviceCodeApproval }) {
  const colors = useAtomValue(themeColorsAtom);
  return (
    <View
      style={[
        styles.issuerPanel,
        { backgroundColor: colors.surfaceSunken, borderColor: colors.borderSubtle },
      ]}
    >
      <Text style={[styles.helperText, { color: colors.textSecondary }]}>
        {HOST_APPROVAL_COPY.deviceSignIn.enterCode}
      </Text>
      <Text
        accessibilityLabel={`Device code ${approval.userCode}`}
        selectable
        style={[styles.deviceCode, { color: colors.text, backgroundColor: colors.codeBackground }]}
      >
        {approval.userCode}
      </Text>
      <Text style={[styles.helperText, { color: colors.textSecondary }]}>
        at{" "}
        <Text style={[styles.codeText, { color: colors.text }]}>
          {originForUrl(approval.verificationUri)}
        </Text>
      </Text>
      <Text style={[styles.helperText, { color: colors.textSecondary }]}>
        {HOST_APPROVAL_COPY.deviceSignIn.verificationHelp}
      </Text>
    </View>
  );
}

function DeviceCodeActions({
  busy,
  pendingAction,
  onCancel,
}: {
  busy: boolean;
  pendingAction: PendingAction | null;
  onCancel: () => void;
}) {
  return (
    <View style={styles.actionRow}>
      <DecisionButton
        label={HOST_APPROVAL_COPY.forms.cancel}
        description={HOST_APPROVAL_COPY.forms.cancelDeviceSignInDescription}
        variant="outline"
        disabled={busy}
        loading={pendingAction === "dismiss"}
        icon={XCircle}
        onPress={onCancel}
        testID="approval-action-device-cancel"
      />
    </View>
  );
}

function DetailRow({
  icon: RowIcon,
  label,
  value,
  code,
  format,
  danger,
  secondary,
  secondarySelectable,
  emphasizeOrigin,
}: {
  icon: IconComponent;
  label: string;
  value: string;
  /**
   * When the value is an identity string, the origin it belongs to — so the
   * registrable domain is emphasized WITHIN the URL rather than the URL being
   * shortened to it (§7.6.3). Weight and an underline, never colour, so the
   * emphasis survives a monochrome display; the row's accessibility label
   * already reads the whole string, and the `Domain` row beside it states in
   * words what the emphasis draws.
   */
  emphasizeOrigin?: InstallReviewOrigin;
  code?: boolean;
  format?: ApprovalDetailFormat;
  danger?: boolean;
  /** Optional supplementary value (e.g. the full opaque id under a label). */
  secondary?: string;
  secondarySelectable?: boolean;
}) {
  const colors = useAtomValue(themeColorsAtom);
  const content =
    format === "markdown" ? (
      <ApprovalMarkdown source={value} tone={danger ? "danger" : "default"} compact />
    ) : format === "tree" ? (
      <CollapsibleTree value={value} colors={colors} />
    ) : (
      <Text
        selectable={code || format === "code"}
        style={[
          styles.detailValue,
          code || format === "code" ? styles.codeText : null,
          {
            color: danger ? colors.danger : colors.text,
            backgroundColor: code || format === "code" ? colors.codeBackground : "transparent",
          },
        ]}
      >
        {emphasizeOrigin
          ? originTextSegments(value, emphasizeOrigin).map((segment, index) => (
              <Text
                key={index}
                style={
                  segment.emphasized
                    ? { fontWeight: "800", textDecorationLine: "underline" }
                    : undefined
                }
              >
                {segment.text}
              </Text>
            ))
          : value}
      </Text>
    );
  return (
    <View accessibilityLabel={`${label}: ${value}`} style={styles.detailRow}>
      <RowIcon size={14} color={danger ? colors.danger : colors.textSecondary} />
      <Text style={[styles.detailLabel, { color: colors.textSecondary }]}>{label}</Text>
      <View style={styles.detailValueColumn}>
        {content}
        {secondary ? (
          <Text
            selectable={secondarySelectable}
            style={[
              styles.detailValueSecondary,
              styles.codeText,
              { color: colors.textSecondary, backgroundColor: colors.codeBackground },
            ]}
          >
            {secondary}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function CollapsibleTree({
  value,
  colors,
}: {
  value: string;
  colors: { text: string; codeBackground: string; textSecondary: string };
}) {
  const [open, setOpen] = useState(false);
  const lines = value.split("\n");
  const summary = lines[0] ?? "";
  const hasBody = lines.length > 1;
  if (!hasBody) {
    return <Text style={[styles.detailValue, { color: colors.text }]}>{summary}</Text>;
  }
  return (
    <View>
      <Pressable onPress={() => setOpen((prev) => !prev)} style={{ flexDirection: "row", gap: 4 }}>
        <Text style={[styles.detailValue, { color: colors.textSecondary, flexShrink: 0 }]}>
          {open ? "▾" : "▸"}
        </Text>
        <Text style={[styles.detailValue, { color: colors.text }]}>{summary}</Text>
      </Pressable>
      {open ? (
        <Text
          style={[
            styles.detailValue,
            styles.codeText,
            {
              color: colors.text,
              backgroundColor: colors.codeBackground,
              marginTop: 4,
              padding: 6,
              borderRadius: 6,
            },
          ]}
        >
          {lines.slice(1).join("\n")}
        </Text>
      ) : null}
    </View>
  );
}

function StandardActions({
  approval,
  busy,
  pendingAction,
  onChoose,
}: {
  approval: PendingCredentialApproval | PendingCapabilityApproval;
  busy: boolean;
  pendingAction: PendingAction | null;
  onChoose: (decision: ApprovalDecision) => void;
}) {
  const recommendedDecision = getRecommendedStandardDecision(approval);
  const isSevereCapability = approval.kind === "capability" && approval.severity === "severe";
  const actions = getStandardApprovalDecisionActions(approval);
  // Task scope is the recommended answer for ordinary gated work. Keep it in
  // the primary row with the narrow one-shot and decline choices; standing
  // trust remains in the secondary row.
  const primaryDecisionSet =
    recommendedDecision === "task"
      ? new Set(["once", "task", "deny"])
      : new Set(["once", "version", "deny"]);
  const primaryActions = actions.filter((action) => primaryDecisionSet.has(action.decision));
  const secondaryActions = actions.filter((action) => !primaryDecisionSet.has(action.decision));
  return (
    <View style={styles.actionGroups}>
      <View style={styles.actionRow}>
        {primaryActions.map((action) => {
          const recommended = action.decision === recommendedDecision;
          return (
            <DecisionButton
              key={action.decision}
              label={action.label}
              description={action.description}
              variant={
                action.decision === "deny"
                  ? "danger"
                  : recommended
                    ? isSevereCapability
                      ? "dangerPrimary"
                      : "primary"
                    : "surface"
              }
              disabled={busy}
              loading={pendingAction === action.decision}
              {...(action.decision === "deny" || isSevereCapability
                ? { icon: action.decision === "deny" ? XCircle : AlertTriangle }
                : action.decision === "version"
                  ? { icon: CheckCircle2 }
                  : {})}
              onPress={() => onChoose(action.decision)}
              testID={`approval-action-${action.decision}`}
            />
          );
        })}
      </View>
      <View style={styles.actionRow}>
        {secondaryActions.map((action) => {
          const destructive = action.decision === "lock";
          return (
            <DecisionButton
              key={action.decision}
              label={action.label}
              description={action.description}
              variant={destructive ? "danger" : "outline"}
              disabled={busy}
              loading={pendingAction === action.decision}
              {...(destructive ? { icon: XCircle } : {})}
              onPress={() => onChoose(action.decision)}
              testID={`approval-action-${action.decision}`}
            />
          );
        })}
      </View>
    </View>
  );
}

function BrowserPermissionActions({
  busy,
  pendingAction,
  onChoose,
}: {
  busy: boolean;
  pendingAction: PendingAction | null;
  onChoose: (decision: ApprovalDecision) => void;
}) {
  const copy = HOST_APPROVAL_COPY.actions.browserPermission;
  const actions: Array<{
    decision: "once" | "session" | "always" | "block";
    label: string;
    description: string;
    variant: ButtonVariant;
  }> = [
    {
      decision: "once",
      ...copy.once,
      variant: "primary",
    },
    {
      decision: "session",
      ...copy.session,
      variant: "surface",
    },
    {
      decision: "always",
      ...copy.always,
      variant: "outline",
    },
    {
      decision: "block",
      ...copy.block,
      variant: "danger",
    },
  ];
  return (
    <View style={styles.actionGroups}>
      <View style={styles.actionRow}>
        {actions.map((action) => (
          <DecisionButton
            key={action.decision}
            label={action.label}
            description={action.description}
            variant={action.variant}
            disabled={busy}
            loading={pendingAction === action.decision}
            icon={action.decision === "block" ? XCircle : undefined}
            onPress={() => onChoose(action.decision)}
            testID={`approval-action-${action.decision}`}
          />
        ))}
        <DecisionButton
          label={copy.dismiss.label}
          description={copy.dismiss.description}
          variant="surface"
          disabled={busy}
          loading={pendingAction === "dismiss"}
          onPress={() => onChoose("dismiss")}
          testID="approval-action-dismiss"
        />
      </View>
    </View>
  );
}

function MissionReviewPanel({
  approval,
  selected,
  onToggle,
}: {
  approval: PendingMissionReviewApproval;
  selected: ReadonlySet<string>;
  onToggle: (key: string, checked: boolean) => void;
}) {
  const colors = useAtomValue(themeColorsAtom);
  return (
    <View style={styles.detailsBlock}>
      <Text style={[styles.detailLabel, { color: colors.textSecondary }]}>Task description</Text>
      <Text style={[styles.detailValue, { color: colors.text }]}>{approval.taskSummary}</Text>
      <Text style={[styles.detailValue, { color: colors.text }]}>
        Runs: {approval.triggerSummary}
      </Text>
      <Text style={[styles.detailLabel, { color: colors.textSecondary }]}>What it can do</Text>
      {approval.authority.rows.map((row) => {
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
          <Pressable
            key={key}
            accessibilityRole={selectable ? "checkbox" : undefined}
            accessibilityState={selectable ? { checked: selected.has(key) } : undefined}
            disabled={!selectable}
            onPress={() => onToggle(key, !selected.has(key))}
            style={styles.detailRow}
            testID={selectable ? `mission-authority-${row.capability}` : undefined}
          >
            <Text style={[styles.detailLabel, { color: colors.text }]}>
              {selectable ? (selected.has(key) ? "☑" : "☐") : "🔒"}{" "}
              {AUTHORITY_DOMAINS[row.domain].label}
            </Text>
            <Text style={[styles.detailValue, { color: colors.textSecondary }]}>
              {row.action} — {row.resource} ·{" "}
              {interactiveOnly
                ? "asks every time"
                : isNew
                  ? "new"
                  : retiered
                    ? "permission changed"
                    : "already allowed"}
            </Text>
          </Pressable>
        );
      })}
      <Text style={[styles.detailValue, { color: colors.textSecondary }]}>
        If it needs a new permission within its toolkit, it pauses and asks you.
      </Text>
      <Text style={[styles.detailValue, { color: colors.textSecondary }]}>
        To do anything beyond its toolkit, it stops and proposes an update for your review.
      </Text>
      <Text style={[styles.detailValue, { color: colors.textSecondary }]}>
        Actions that can’t be undone always wait for you.
      </Text>
      <Text style={[styles.detailValue, { color: colors.text }]}>
        Uses:{" "}
        {approval.toolkitDomains
          .map((domain) => AUTHORITY_DOMAINS[domain].label.toLowerCase())
          .join(" · ") || "no standing toolkit"}
      </Text>
      <Text style={[styles.detailValue, { color: colors.text }]}>
        Can reach: {approval.networkSummary}
      </Text>
      <Text style={[styles.detailValue, { color: colors.text }]}>
        Works with content from: {approval.lineageSummary}
      </Text>
      {approval.charterChanges.map((change) => (
        <Text
          key={change.field}
          style={[styles.detailValue, { color: change.widening ? colors.danger : colors.text }]}
        >
          {change.field}: {change.before ?? "not set"} → {change.after}
        </Text>
      ))}
      <Text style={[styles.detailValue, { color: colors.textSecondary }]}>
        Like all agents, it can’t change your safety controls.
      </Text>
      <MissionDeveloperDetails approval={approval} />
    </View>
  );
}

function MissionDeveloperDetails({ approval }: { approval: PendingMissionReviewApproval }) {
  const colors = useAtomValue(themeColorsAtom);
  const [open, setOpen] = useState(false);
  return (
    <View style={[styles.missionDeveloperDetails, { borderTopColor: colors.borderSubtle }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={styles.detailsSummary}
        testID="mission-developer-details"
      >
        {open ? (
          <ChevronDown size={14} color={colors.textSecondary} />
        ) : (
          <ChevronRight size={14} color={colors.textSecondary} />
        )}
        <Text style={[styles.detailsSummaryText, { color: colors.textSecondary }]}>
          Developer details
        </Text>
      </Pressable>
      {open ? (
        <View style={styles.detailRows}>
          <DetailRow icon={Lock} label="Closure" value={approval.closureDigest} code />
          <DetailRow
            icon={Settings2}
            label="Harness"
            value={`${approval.charter.harness.unit}@${approval.charter.harness.ev}`}
            code
          />
          <DetailRow icon={Settings2} label="Model" value={approval.charter.model.modelId} code />
        </View>
      ) : null}
    </View>
  );
}

function MissionReviewActions({
  approval,
  busy,
  pendingAction,
  onApprove,
  onDismiss,
}: {
  approval: PendingMissionReviewApproval;
  busy: boolean;
  pendingAction: PendingAction | null;
  onApprove: () => void;
  onDismiss: () => void;
}) {
  return (
    <View style={styles.actionGroups}>
      <View style={styles.actionRow}>
        <DecisionButton
          label={
            approval.reviewKind === "out-of-charter"
              ? "Allow and update mission"
              : "Approve mission"
          }
          description="Approve this exact reviewed mission closure."
          variant="primary"
          disabled={busy}
          loading={pendingAction === "mission-review-approve"}
          onPress={onApprove}
          testID="approval-action-mission-approve"
        />
        <DecisionButton
          label={approval.reviewKind === "out-of-charter" ? "Don’t add" : "Not now"}
          description="Leave this mission unapproved."
          variant="surface"
          disabled={busy}
          loading={pendingAction === "mission-review-dismiss"}
          onPress={onDismiss}
          testID="approval-action-mission-dismiss"
        />
      </View>
    </View>
  );
}

function InstallReviewActions({
  approval,
  allowNow,
  busy,
  pendingAction,
  onAccept,
  onCancel,
}: {
  approval: PendingUnitInstallReviewApproval;
  allowNow: TemplateAcceptance["allowNow"];
  busy: boolean;
  pendingAction: PendingAction | null;
  onAccept: () => void;
  onCancel: () => void;
}) {
  const colors = useAtomValue(themeColorsAtom);
  const copy = getInstallReviewActionCopy(approval);
  // The footer restates the selection in plain terms and updates live as rows
  // are checked and unchecked (§7.2) — never shown for the one-line "no
  // permission changes" upgrade, which the header already states in full.
  const statusLine =
    approval.parts.length === 0 && approval.unchangedPartCount > 0
      ? null
      : selectionStatusLine({ parts: approval.parts, allowNow });
  return (
    <View style={styles.actionGroups}>
      {statusLine ? (
        <Text
          accessibilityLiveRegion="polite"
          style={[styles.helperText, { color: colors.textSecondary }]}
        >
          {statusLine}
        </Text>
      ) : null}
      <View style={styles.actionRow}>
        <DecisionButton
          label={copy.accept.label}
          description={copy.accept.description}
          variant="primary"
          disabled={busy}
          loading={pendingAction === "once"}
          onPress={onAccept}
          testID="approval-action-accept-install-review"
        />
        {/* No "Not now" on the creation review: the workspace already exists,
            and the equivalent escape is unchecking everything. */}
        {copy.decline ? (
          <DecisionButton
            label={copy.decline.label}
            description={copy.decline.description}
            variant="outline"
            disabled={busy}
            loading={pendingAction === "dismiss"}
            icon={XCircle}
            onPress={onCancel}
            testID="approval-action-cancel-install-review"
          />
        ) : null}
      </View>
    </View>
  );
}

function ClientConfigActions(props: {
  approval: PendingClientConfigApproval;
  values: Record<string, string>;
  busy: boolean;
  pendingAction: PendingAction | null;
  onSubmit: () => void;
  onDeny: () => void;
}) {
  return <InputApprovalActions {...props} submitAction="submit-client-config" />;
}

function CredentialInputActions(props: {
  approval: PendingCredentialInputApproval;
  values: Record<string, string>;
  busy: boolean;
  pendingAction: PendingAction | null;
  onSubmit: () => void;
  onDeny: () => void;
}) {
  return <InputApprovalActions {...props} submitAction="submit-credential-input" />;
}

function SecretInputActions(props: {
  approval: PendingSecretInputApproval;
  values: Record<string, string>;
  busy: boolean;
  pendingAction: PendingAction | null;
  onSubmit: () => void;
  onDeny: () => void;
}) {
  return (
    <InputApprovalActions
      {...props}
      submitAction="submit-secret-input"
      submitLabel={HOST_APPROVAL_COPY.forms.continue}
      submitDescription={HOST_APPROVAL_COPY.forms.useSecretOnceDescription}
      denyDescription={HOST_APPROVAL_COPY.forms.secretDenied}
    />
  );
}

function InputApprovalActions({
  approval,
  values,
  busy,
  pendingAction,
  onSubmit,
  onDeny,
  submitAction,
  submitLabel = HOST_APPROVAL_COPY.forms.saveService,
  submitDescription = HOST_APPROVAL_COPY.forms.saveServiceDescription,
  denyDescription = HOST_APPROVAL_COPY.forms.saveServiceDenied,
}: {
  approval:
    | PendingClientConfigApproval
    | PendingCredentialInputApproval
    | PendingSecretInputApproval;
  values: Record<string, string>;
  busy: boolean;
  pendingAction: PendingAction | null;
  onSubmit: () => void;
  onDeny: () => void;
  submitAction: PendingAction;
  submitLabel?: string;
  submitDescription?: string;
  denyDescription?: string;
}) {
  const missingRequired = approval.fields.some(
    (field) => field.required && !values[field.name]?.trim()
  );
  return (
    <View style={styles.actionRow}>
      <DecisionButton
        label={submitLabel}
        description={submitDescription}
        variant="primary"
        disabled={busy || missingRequired}
        loading={pendingAction === submitAction}
        onPress={onSubmit}
        testID="approval-submit"
      />
      <DecisionButton
        label={HOST_APPROVAL_COPY.chrome.deny}
        description={denyDescription}
        variant="danger"
        disabled={busy}
        loading={pendingAction === "deny"}
        icon={XCircle}
        onPress={onDeny}
        testID="approval-action-deny"
      />
    </View>
  );
}

function DecisionButton({
  label,
  description,
  variant,
  disabled,
  loading,
  icon: ButtonIcon = CheckCircle2,
  onPress,
  testID,
}: {
  label: string;
  description: string;
  variant: ButtonVariant;
  disabled: boolean;
  loading: boolean;
  icon?: IconComponent;
  onPress: () => void;
  testID: string;
}) {
  const colors = useAtomValue(themeColorsAtom);
  const style = buttonStyle(colors, variant);
  return (
    <Pressable
      accessibilityLabel={`${label}. ${description}`}
      accessibilityRole="button"
      accessibilityState={{ disabled, busy: loading }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.decisionButton,
        style.button,
        disabled ? styles.disabled : null,
        pressed && !disabled ? styles.pressed : null,
      ]}
      testID={testID}
    >
      {loading ? (
        <ActivityIndicator color={style.text.color} size="small" />
      ) : (
        <ButtonIcon size={16} color={style.text.color} />
      )}
      <Text numberOfLines={2} adjustsFontSizeToFit style={[styles.decisionText, style.text]}>
        {label}
      </Text>
    </Pressable>
  );
}

function buttonStyle(
  colors: {
    background: string;
    border: string;
    danger: string;
    primary: string;
    text: string;
  },
  variant: ButtonVariant
) {
  if (variant === "primary") {
    return {
      button: { backgroundColor: colors.primary, borderColor: colors.primary },
      text: { color: "#ffffff" },
    };
  }
  if (variant === "danger") {
    return {
      button: { backgroundColor: "transparent", borderColor: colors.danger },
      text: { color: colors.danger },
    };
  }
  if (variant === "dangerPrimary") {
    return {
      button: { backgroundColor: colors.danger, borderColor: colors.danger },
      text: { color: "#ffffff" },
    };
  }
  if (variant === "outline") {
    return {
      button: { backgroundColor: "transparent", borderColor: colors.border },
      text: { color: colors.text },
    };
  }
  return {
    button: { backgroundColor: colors.background, borderColor: colors.border },
    text: { color: colors.text },
  };
}

const styles = StyleSheet.create({
  minimizedRoot: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "flex-end",
    justifyContent: "flex-end",
    padding: spacing.lg,
  },
  minimizedApproval: {
    borderRadius: radius.pill,
    borderWidth: 1,
    minHeight: touchTarget,
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
  },
  minimizedApprovalText: {
    ...typeRamp.bodyStrong,
  },
  modalRoot: {
    flex: 1,
    justifyContent: "flex-end",
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  keyboardRoot: {
    flex: 1,
    justifyContent: "flex-end",
  },
  safeArea: {
    justifyContent: "flex-end",
  },
  sheet: {
    alignSelf: "stretch",
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: hairline,
    maxHeight: Dimensions.get("window").height * 0.9,
    minHeight: Dimensions.get("window").height * 0.4,
    overflow: "hidden",
  },
  accentStripe: {
    height: 3,
  },
  dismissButton: {
    alignItems: "center",
    height: touchTarget,
    justifyContent: "center",
    position: "absolute",
    right: spacing.xs,
    top: spacing.sm,
    width: touchTarget,
    zIndex: 2,
  },
  handleWrap: {
    alignItems: "center",
    paddingBottom: spacing.sm,
    paddingTop: spacing.sm,
  },
  handle: {
    borderRadius: radius.pill,
    height: 4,
    width: 40,
  },
  scrollContent: {
    paddingBottom: spacing.lg,
    paddingHorizontal: spacing.lg,
  },
  headerRow: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    paddingRight: 42,
  },
  categoryIcon: {
    alignItems: "center",
    borderRadius: radius.sm,
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  queueNavigator: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.xs,
    marginLeft: "auto",
  },
  queueButton: {
    alignItems: "center",
    borderRadius: radius.sm,
    height: 28,
    justifyContent: "center",
    width: 28,
  },
  queueLabel: {
    ...typeRamp.micro,
    fontVariant: ["tabular-nums"],
    minWidth: 36,
    textAlign: "center",
  },
  title: {
    ...typeRamp.title,
    marginTop: spacing.lg,
  },
  domainChip: {
    alignSelf: "flex-start",
    borderRadius: radius.pill,
    borderWidth: hairline,
    marginTop: spacing.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  domainChipText: {
    ...typeRamp.caption,
  },
  detailCard: {
    borderRadius: radius.md,
    borderWidth: hairline,
    gap: spacing.xs,
    marginTop: spacing.md,
    padding: spacing.md,
  },
  substanceFact: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    marginTop: 6,
  },
  substanceFactLabel: {
    width: 104,
    fontSize: 12,
    lineHeight: 17,
  },
  substanceFactValue: {
    flex: 1,
    fontSize: 12,
    fontWeight: "600",
    lineHeight: 17,
  },
  callerRow: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  callerRowLabel: {
    ...typeRamp.micro,
  },
  callerChip: {
    alignItems: "center",
    borderRadius: radius.pill,
    borderWidth: 1,
    flexDirection: "row",
    gap: 5,
    maxWidth: 220,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  callerChipLabel: {
    ...typeRamp.micro,
    flexShrink: 1,
  },
  warningBand: {
    alignItems: "flex-start",
    borderRadius: radius.sm,
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.md,
    padding: spacing.md,
  },
  warningText: {
    ...typeRamp.caption,
    flex: 1,
  },
  markdownFlex: {
    flex: 1,
  },
  markdownBlock: {
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  markdownBlockCompact: {
    marginTop: 0,
  },
  markdownText: {
    ...typeRamp.caption,
  },
  markdownList: {
    gap: 3,
  },
  markdownListRow: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing.xs,
  },
  markdownBullet: {
    ...typeRamp.caption,
    width: 18,
  },
  markdownStrong: {
    fontWeight: "700",
  },
  markdownEmphasis: {
    fontStyle: "italic",
  },
  markdownInlineCode: {
    borderRadius: radius.sm / 2,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    fontSize: 12,
    paddingHorizontal: spacing.xs,
    paddingVertical: 1,
  },
  markdownCodeBlock: {
    borderRadius: radius.sm,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    fontSize: 12,
    lineHeight: 17,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs + 2,
  },
  issuerPanel: {
    borderRadius: radius.md,
    borderWidth: hairline,
    marginTop: spacing.md,
    padding: spacing.md,
  },
  helperText: {
    ...typeRamp.caption,
  },
  fields: {
    gap: spacing.md,
    marginTop: spacing.md,
  },
  fieldBlock: {
    gap: spacing.xs + 2,
  },
  fieldLabelRow: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  fieldLabel: {
    ...typeRamp.caption,
    fontWeight: "500",
  },
  input: {
    borderRadius: radius.md,
    borderWidth: hairline,
    fontSize: 15,
    minHeight: touchTarget,
    paddingHorizontal: spacing.md,
  },
  installReviewFilters: {
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  installReviewKindFilters: {
    gap: spacing.sm,
    paddingRight: spacing.md,
  },
  installReviewKindFilter: {
    alignItems: "center",
    borderRadius: radius.pill,
    borderWidth: hairline,
    justifyContent: "center",
    minHeight: 36,
    paddingHorizontal: spacing.md,
  },
  installReviewKindFilterText: {
    ...typeRamp.caption,
    fontWeight: "600",
  },
  installReviewGroups: {
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  installReviewGroup: {
    borderRadius: radius.md,
    borderWidth: hairline,
    overflow: "hidden",
  },
  installReviewGroupHeader: {
    gap: spacing.xs,
    minHeight: touchTarget,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  installReviewGroupTitleRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "space-between",
  },
  installReviewGroupTitle: {
    ...typeRamp.bodyStrong,
    flex: 1,
  },
  installReviewGroupBadge: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
    minWidth: 22,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    marginLeft: spacing.xs,
  },
  installReviewGroupBadgeText: {
    ...typeRamp.caption,
    fontWeight: "600" as const,
  },
  installReviewGroupParts: {
    paddingBottom: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  mobileDiffReview: {
    borderRadius: radius.md,
    borderWidth: hairline,
    gap: spacing.sm,
    marginTop: spacing.md,
    padding: spacing.md,
  },
  mobileDiffReviewHeading: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing.sm,
    justifyContent: "space-between",
  },
  mobileDiffReviewHeadingCopy: { flex: 1, gap: 2 },
  mobileDiffReviewTitle: { ...typeRamp.bodyStrong },
  mobileDiffCounts: { ...typeRamp.caption, flexShrink: 0, fontWeight: "600" },
  mobileDiffMeta: { ...typeRamp.micro, fontWeight: "500" },
  mobileDiffHelp: { ...typeRamp.caption },
  mobileDiffRepositories: { gap: spacing.sm },
  mobileDiffRepository: { borderRadius: radius.sm, borderWidth: hairline, overflow: "hidden" },
  mobileDiffRepositoryHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    minHeight: touchTarget,
    padding: spacing.sm,
  },
  mobileDiffRepositoryCopy: { flex: 1, gap: 2 },
  mobileDiffRepositoryTitle: { ...typeRamp.caption, fontWeight: "600" },
  mobileDiffFiles: { gap: spacing.sm, padding: spacing.sm },
  mobileDiffFile: { borderRadius: radius.sm, borderWidth: hairline, overflow: "hidden" },
  mobileDiffFileHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
    minHeight: touchTarget,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  mobileDiffKind: {
    ...typeRamp.micro,
    borderRadius: radius.pill,
    overflow: "hidden",
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  mobileDiffFilePath: { ...typeRamp.caption, flex: 1, fontWeight: "600" },
  mobileDiffFileBody: { gap: spacing.sm, padding: spacing.sm, paddingTop: 0 },
  mobileDiffLoading: { alignItems: "center", flexDirection: "row", gap: spacing.sm },
  mobileDiffCodeScroll: { borderRadius: radius.sm, maxHeight: 420 },
  mobileDiffCode: { minWidth: 640, paddingVertical: spacing.xs },
  mobileDiffCodeRow: { flexDirection: "row", minHeight: 20 },
  mobileDiffLineNumber: {
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    fontSize: 11,
    paddingRight: spacing.xs,
    textAlign: "right",
    width: 42,
  },
  mobileDiffMarker: {
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    fontSize: 12,
    fontWeight: "700",
    textAlign: "center",
    width: 20,
  },
  mobileDiffCodeText: {
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    fontSize: 11,
    lineHeight: 20,
    paddingRight: spacing.md,
  },
  mobileDiffOmitted: {
    ...typeRamp.micro,
    fontStyle: "italic",
    lineHeight: 24,
    paddingLeft: spacing.md,
  },
  mobileDiffFallback: { gap: spacing.xs, padding: spacing.sm },
  mobileDiffWarning: { ...typeRamp.caption, fontWeight: "500" },
  mobileDiffOpenFile: {
    alignItems: "center",
    alignSelf: "flex-start",
    flexDirection: "row",
    gap: spacing.xs,
    minHeight: touchTarget,
  },
  mobileDiffOpenFileText: { ...typeRamp.caption, fontWeight: "600" },
  detailsBlock: {
    marginTop: spacing.md,
  },
  missionDeveloperDetails: {
    borderTopWidth: hairline,
    marginTop: spacing.md,
    paddingTop: spacing.sm,
  },
  detailsSummary: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.xs + 2,
    minHeight: 34,
  },
  detailsSummaryText: {
    ...typeRamp.caption,
    fontWeight: "600",
  },
  unitReviewSummary: {
    flex: 1,
    gap: 2,
  },
  unitReviewChange: {
    fontSize: 12,
    fontWeight: "400",
  },
  detailRows: {
    gap: 9,
    paddingTop: spacing.xs + 2,
  },
  disclosureButton: {
    alignItems: "center",
    alignSelf: "flex-start",
    flexDirection: "row",
    gap: spacing.xs,
    minHeight: touchTarget,
  },
  disclosureButtonText: {
    ...typeRamp.caption,
    fontWeight: "600",
  },
  detailRow: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing.sm,
  },
  detailLabel: {
    ...typeRamp.micro,
    fontWeight: "500",
    flexShrink: 0,
    letterSpacing: undefined,
    width: 80,
  },
  detailValueColumn: {
    flex: 1,
    flexDirection: "column",
    gap: spacing.xs,
    minWidth: 0,
  },
  detailValue: {
    ...typeRamp.caption,
    borderRadius: radius.sm - 2,
    flexWrap: "wrap",
    fontWeight: "500",
    minWidth: 0,
  },
  detailValueSecondary: {
    ...typeRamp.micro,
    fontWeight: "400",
    letterSpacing: undefined,
    alignSelf: "flex-start",
    borderRadius: radius.sm - 2,
    lineHeight: 16,
  },
  sealedDetailReveal: {
    alignSelf: "flex-start",
    borderRadius: radius.sm,
    borderWidth: hairline,
    minHeight: touchTarget,
    justifyContent: "center",
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  codeText: {
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    paddingHorizontal: spacing.xs + 2,
    paddingVertical: 2,
  },
  deviceCode: {
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    fontSize: 28,
    fontWeight: "700",
    letterSpacing: 4,
    paddingHorizontal: spacing.md + 2,
    paddingVertical: spacing.sm + 2,
    marginVertical: spacing.sm,
    alignSelf: "flex-start",
    borderRadius: radius.sm,
  },
  actionBar: {
    borderTopWidth: hairline,
    paddingBottom: spacing.md + 2,
    paddingHorizontal: spacing.md + 2,
    paddingTop: spacing.md,
  },
  actionGroups: {
    gap: spacing.sm,
  },
  actionRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  decisionButton: {
    alignItems: "center",
    borderRadius: radius.md,
    borderWidth: 1,
    flex: 1,
    flexDirection: "row",
    gap: spacing.xs + 2,
    justifyContent: "center",
    minHeight: touchTarget,
    minWidth: 96,
    paddingHorizontal: spacing.md,
  },
  decisionText: {
    ...typeRamp.bodyStrong,
    flexShrink: 1,
    letterSpacing: 0,
    textAlign: "center",
  },
  disabled: {
    opacity: 0.5,
  },
  pressed: {
    opacity: pressedOpacity,
  },
  rememberedHint: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.xs + 2,
    marginTop: spacing.md,
  },
});
