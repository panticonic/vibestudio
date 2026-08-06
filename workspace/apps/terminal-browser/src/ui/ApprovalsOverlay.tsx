import React from "react";
import { Box, Text } from "ink";
import type { PendingApproval } from "@vibestudio/shared/approvals";
import {
  getApprovalCallerPresentation,
  getInstallReviewActionCopy,
} from "@vibestudio/shared/approvalCopy";
import { HOST_APPROVAL_COPY } from "@vibestudio/shared/hostApprovalCopy";
import {
  INSTALL_ROW_TIMING_COPY,
  clearableRows,
  defaultAcceptance,
  installRowHeadline,
  originDomainFact,
  originTextSegments,
  partNotableLine,
  selectionStatusLine,
  type InstallReviewPart,
  type InstallReviewRow,
  type TemplateAcceptance,
} from "@vibestudio/shared/authority/unitInstallReview";
import {
  parseApprovalMarkdown,
  type ApprovalMarkdownInline,
} from "@vibestudio/shared/approvalMarkdown";

/** A `unit-install-review` approval, narrowed the same way every other surface narrows it. */
type PendingUnitInstallReviewApproval = Extract<PendingApproval, { kind: "unit-install-review" }>;

/**
 * Per-part cleared row keys (U5: selecting means allow now, deselecting means
 * ask when needed) — the same shape the desktop card keeps, so a host that
 * wires real toggling has nothing new to invent.
 *
 * Absent (the default) means the platform's own default acceptance: every
 * part checked, every install-clearable row checked (one click adds the
 * complete slate).
 */
export type InstallSelection = ReadonlyMap<string, ReadonlySet<string>>;

const INSTALL_REVIEW_COPY = HOST_APPROVAL_COPY.installReview;

export interface ApprovalsOverlayProps {
  pending: PendingApproval[];
  selectedIndex: number;
  /**
   * Which part of the current install review is focused for inspection — the
   * same index-into-a-list mechanic `selectedIndex` already uses for the
   * approval list itself, so a host that wires part navigation reuses the
   * established pattern rather than a new one. Defaults to the first part, so
   * a review always shows full detail for at least one part.
   */
  partIndex?: number;
  /** Per-part selection for the current install review (see `InstallSelection`). */
  installSelection?: InstallSelection;
  /**
   * The clearable row key the host has expanded the focused part into, if
   * any (`installReviewNav.ts`'s row-focus mode). Highlights that row the
   * same way `selectedIndex`/`partIndex` highlight their own focus, so a
   * terminal user can see which permission ⎵ will toggle.
   */
  focusedRowKey?: string;
}

function summarizeTitle(a: PendingApproval): string {
  const caller = getApprovalCallerPresentation(a).label;
  switch (a.kind) {
    case "unit-install-review":
      return a.title;
    case "capability":
      return `${a.title} · ${caller}`;
    case "credential":
      return `Credential · ${a.credentialLabel}`;
    default:
      return `${a.kind} · ${caller}`;
  }
}

function genericDetail(a: PendingApproval): string {
  switch (a.kind) {
    case "capability":
      return a.capability;
    case "credential":
      return getApprovalCallerPresentation(a).label;
    default:
      return a.effectiveVersion ?? "";
  }
}

/**
 * Host-owned, un-spoofable approvals overlay over the global shell queue. While
 * it's open the focused session's input is suspended and its output buffered,
 * so a worker cannot paint a fake prompt over it.
 */
export function ApprovalsOverlay({
  pending,
  selectedIndex,
  partIndex,
  installSelection,
  focusedRowKey,
}: ApprovalsOverlayProps): React.ReactElement {
  const current = pending[selectedIndex];
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold color="yellow">
        {`Approvals (${pending.length})`}
      </Text>
      {pending.length === 0 ? (
        <Text dimColor>Nothing pending. Esc to dismiss.</Text>
      ) : (
        <>
          {pending.map((a, i) => {
            const title = summarizeTitle(a);
            return (
              <Text key={a.approvalId} inverse={i === selectedIndex}>
                {`${i + 1}. ${title}`}
              </Text>
            );
          })}
          {current ? (
            <Box flexDirection="column" marginTop={1}>
              {current.kind === "unit-install-review" ? (
                <InstallReviewDetail
                  approval={current}
                  partIndex={partIndex ?? 0}
                  selection={installSelection}
                  focusedRowKey={focusedRowKey}
                />
              ) : (
                <ApprovalMarkdown source={genericDetail(current)} />
              )}
              <Text>{approvalHint(current, focusedRowKey !== undefined)}</Text>
            </Box>
          ) : null}
        </>
      )}
    </Box>
  );
}

/**
 * The keys this approval answers to, shown on screen because an unlabelled
 * binding is not one a terminal user can discover (§7.6.7's keyboard-complete
 * standard). A `unit-install-review` gets its own row: the accept/decline
 * words are `getInstallReviewActionCopy`'s (never invented here), and the
 * part/row keys change their own hint once a part is expanded — mirroring
 * `installReviewNav.ts`'s two focus levels.
 */
function approvalHint(approval: PendingApproval, rowExpanded: boolean): string {
  if (approval.kind !== "unit-install-review") {
    return "[1] once  [2] session  [3] version  [4] deny  · ↑/↓ select · Esc dismiss";
  }
  const actions = getInstallReviewActionCopy(approval);
  const decisions = [`[1] ${actions.accept.label}`];
  if (actions.decline) decisions.push(`[4] ${actions.decline.label}`);
  const focus = rowExpanded
    ? "←/→ permission  ⎵ toggle permission  ⇥ close part"
    : "←/→ part  ⎵ toggle part  ⇥ open part";
  return `${decisions.join("  ")}  · ${focus}  · ↑/↓ select · Esc dismiss`;
}

/**
 * The install-review detail: the same content and the same decision as the
 * window (docs/template-install-unit-approval-ux-plan.md §7.8, §13.6) — every
 * part, its title, kind, and notable line, never a truncated "…and N more".
 * The focused part additionally expands into its full "Worth knowing" rows
 * and the everyday fold, matching the collection route's row anatomy (§7.2).
 *
 * Never renders a capability string, effective version, commit id, or digest.
 */
function InstallReviewDetail({
  approval,
  partIndex,
  selection,
  focusedRowKey,
}: {
  approval: PendingUnitInstallReviewApproval;
  partIndex: number;
  selection: InstallSelection | undefined;
  focusedRowKey: string | undefined;
}): React.ReactElement {
  const focused = Math.min(Math.max(partIndex, 0), Math.max(approval.parts.length - 1, 0));
  const acceptance = installAcceptanceFrom(approval, selection);
  return (
    <Box flexDirection="column">
      <Text bold>{installReviewHeading(approval)}</Text>
      <Text>{approval.description}</Text>
      {approval.parts.map((part, i) => (
        <Box flexDirection="column" key={part.identityKey}>
          <Text inverse={i === focused}>
            {`${partCheckboxGlyph(part, selection)} ${partChangeSign(part)}${part.title}   ${part.label}`}
          </Text>
          <Text dimColor>{`    ${partNotableLine(part)}`}</Text>
          {i === focused ? (
            <PartDetail part={part} selection={selection} focusedRowKey={focusedRowKey} />
          ) : null}
        </Box>
      ))}
      {approval.unchangedPartCount > 0 ? (
        <Text dimColor>
          {INSTALL_REVIEW_COPY.summary.unchangedParts(approval.unchangedPartCount)}
        </Text>
      ) : null}
      <Text>{selectionStatusLine({ parts: approval.parts, allowNow: acceptance.allowNow })}</Text>
    </Box>
  );
}

/** The focused part's "Worth knowing" rows, in full, plus the everyday fold. */
function PartDetail({
  part,
  selection,
  focusedRowKey,
}: {
  part: InstallReviewPart;
  selection: InstallSelection | undefined;
  focusedRowKey: string | undefined;
}): React.ReactElement | null {
  const domainFact = originDomainFact(part.origin);
  const originUrl = part.origin.url;
  if (
    part.notableRows.length === 0 &&
    part.everydayRows.length === 0 &&
    !originUrl &&
    part.origin.originStatus !== "unresolved"
  ) {
    return null;
  }
  const selected = selectedRowKeys(part, selection);
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {originUrl ? (
        <>
          {/* Where the bytes came from — the one non-asserted fact this level
              has, and level 3 of the disclosure (§7.6.5). The URL is written
              whole and the registrable domain is bold inside it, so a lookalike
              like github.com.attacker.net stands out as attacker.net. */}
          <Text>
            {originTextSegments(originUrl, part.origin).map((segment, index) => (
              <Text key={index} bold={segment.emphasized} underline={segment.emphasized}>
                {segment.text}
              </Text>
            ))}
          </Text>
          {/* Bold is not readable on every terminal and not readable at all to
              anyone using a screen reader over one, so the same fact is stated
              in the words the launch gate's plain-text form uses. */}
          {domainFact ? <Text dimColor>{domainFact}</Text> : null}
        </>
      ) : null}
      {part.notableRows.length > 0 ? (
        <>
          {part.notableRows.map((row) => (
            <InstallRowLine
              key={row.key}
              row={row}
              selected={selected.has(row.key)}
              focused={row.key === focusedRowKey}
            />
          ))}
        </>
      ) : null}
      {part.everydayRows.length > 0 ? (
        focusedRowKey === undefined ? (
          <Text dimColor>{INSTALL_REVIEW_COPY.sections.everyday(part.everydayRows.length)}</Text>
        ) : (
          <>
            <Text bold>{INSTALL_REVIEW_COPY.sections.everyday(part.everydayRows.length)}</Text>
            {part.everydayRows.map((row) => (
              <InstallRowLine
                key={row.key}
                row={row}
                selected={selected.has(row.key)}
                focused={row.key === focusedRowKey}
              />
            ))}
          </>
        )
      ) : null}
    </Box>
  );
}

/**
 * One row: its plain-language headline, a differential sign when this is an
 * update (§5.4), a checkbox only when the row is install-clearable (§7.2 —
 * contextual and critical rows are disclosures, never checkboxes), and the
 * timing line that carries the whole meaning of a row this decision cannot
 * pre-authorize. `focused` marks the row the host's ⇥/←/→ have drilled into —
 * the same `inverse` convention the part and approval rows already use.
 */
function InstallRowLine({
  row,
  selected,
  focused,
}: {
  row: InstallReviewRow;
  selected: boolean;
  focused?: boolean;
}): React.ReactElement {
  const sign = rowChangeSign(row);
  const box = row.selectable ? (selected ? "☑ " : "☐ ") : "";
  const timing = row.kind === "permission" ? INSTALL_ROW_TIMING_COPY[row.timing] : null;
  return (
    <Box flexDirection="column">
      <Text inverse={focused}>{`  ${sign}${box}${installRowHeadline(row)}`}</Text>
      {timing ? <Text dimColor>{`      ${timing}`}</Text> : null}
    </Box>
  );
}

function rowChangeSign(row: InstallReviewRow): string {
  if (row.change === "added") return "+ ";
  if (row.change === "removed") return "− ";
  if (row.change === "retiered") return "~ ";
  return "";
}

function partChangeSign(part: InstallReviewPart): string {
  if (part.change === "added") return "+ ";
  if (part.change === "removed") return "− ";
  if (part.change === "changed") return "~ ";
  return "";
}

/**
 * `☑`/`☐`/`◐` mirror the collection route's own row anatomy (§7.2). A part
 * with nothing install-clearable — everything it declares is contextual,
 * critical, or it is being removed — gets the distinct non-interactive
 * marker the plan requires rather than a checkbox that would promise a grant
 * this decision cannot make.
 */
function partCheckboxGlyph(
  part: InstallReviewPart,
  selection: InstallSelection | undefined
): string {
  if (part.change === "removed") return "·";
  const clearable = clearableRows(part);
  if (clearable.length === 0) return "·";
  const selected = selectedRowKeys(part, selection);
  const count = clearable.filter((row) => selected.has(row.key)).length;
  if (count === 0) return "☐";
  if (count === clearable.length) return "☑";
  return "◐";
}

/**
 * The effective cleared set for a part: the controlled selection when the
 * host has wired one, or the platform's own default (§8's `selectedByDefault`)
 * when it has not. Exported so the host's key-binding reducer can materialize
 * the same defaults it is about to start toggling (`installReviewNav.ts`).
 */
export function selectedRowKeys(
  part: InstallReviewPart,
  selection: InstallSelection | undefined
): ReadonlySet<string> {
  if (selection) return selection.get(part.identityKey) ?? new Set();
  return new Set(
    clearableRows(part)
      .filter((row) => row.selectedByDefault)
      .map((row) => row.key)
  );
}

/**
 * A controlled selection into the same `TemplateAcceptance` the server
 * expects (§8) — the payload `approvalsClient.resolveInstallReview` sends.
 * Falls back to the platform's own default acceptance when the host has not
 * wired per-part toggling.
 */
export function installAcceptanceFrom(
  approval: PendingUnitInstallReviewApproval,
  selection: InstallSelection | undefined
): TemplateAcceptance {
  if (!selection) return defaultAcceptance(approval.mode, approval.parts);
  return {
    decision:
      approval.mode === "update"
        ? "update"
        : approval.mode === "adopt-root"
          ? "adopt-root"
          : "install",
    allowNow: approval.parts
      .filter((part) => part.change !== "removed")
      .map((part) => ({
        identityKey: part.identityKey,
        permissions: [...(selection.get(part.identityKey) ?? new Set<string>())],
      })),
  };
}

function installReviewHeading(approval: PendingUnitInstallReviewApproval): string {
  const heading = INSTALL_REVIEW_COPY.heading;
  switch (approval.mode) {
    case "adopt-root":
      return heading["adopt-root"];
    case "install":
      return heading.install(approval.template?.title ?? approval.title);
    case "update":
      return heading.update(approval.template?.title ?? approval.title);
    case "remove":
      return heading.remove(approval.template?.title ?? approval.title);
    case "part-changed":
      return heading["part-changed"](approval.parts[0]?.title ?? approval.title);
  }
}

function ApprovalMarkdown({ source }: { source: string }): React.ReactElement | null {
  const blocks = parseApprovalMarkdown(source);
  if (blocks.length === 0) return null;
  return (
    <Box flexDirection="column">
      {blocks.map((block, index) => {
        if (block.kind === "code-block") {
          return (
            <Box key={index} flexDirection="column" paddingLeft={1}>
              {block.text.split(/\r?\n/).map((line, lineIndex) => (
                <Text key={lineIndex} color="cyan">
                  {line || " "}
                </Text>
              ))}
            </Box>
          );
        }
        if (block.kind === "bullet-list" || block.kind === "ordered-list") {
          return (
            <Box key={index} flexDirection="column">
              {block.items.map((item, itemIndex) => (
                <Text key={itemIndex} dimColor>
                  {block.kind === "ordered-list" ? `${itemIndex + 1}. ` : "- "}
                  <ApprovalMarkdownInlineNodes nodes={item} />
                </Text>
              ))}
            </Box>
          );
        }
        return (
          <Text key={index} dimColor>
            <ApprovalMarkdownInlineNodes nodes={block.children} />
          </Text>
        );
      })}
    </Box>
  );
}

function ApprovalMarkdownInlineNodes({
  nodes,
}: {
  nodes: ApprovalMarkdownInline[];
}): React.ReactElement {
  return (
    <>
      {nodes.map((node, index) => {
        if (node.kind === "code") {
          return (
            <Text key={index} color="cyan">
              {node.text}
            </Text>
          );
        }
        if (node.kind === "strong") {
          return (
            <Text key={index} bold>
              <ApprovalMarkdownInlineNodes nodes={node.children} />
            </Text>
          );
        }
        if (node.kind === "emphasis") {
          return (
            <Text key={index}>
              <ApprovalMarkdownInlineNodes nodes={node.children} />
            </Text>
          );
        }
        return <React.Fragment key={index}>{node.text}</React.Fragment>;
      })}
    </>
  );
}
