/**
 * The one surface every arrival of code shares
 * (docs/template-install-unit-approval-ux-plan.md §7.2).
 *
 * Creating a workspace from a template, installing one, updating one, and
 * accepting an edit to a part already here are the same decision with the same
 * rows and the same copy. What differs is the heading, whether there is a "Not
 * now", and whether the list is differential.
 *
 * Two things this deliberately does NOT do:
 *
 *   it never renders a capability string, an effective version, or a digest —
 *     everything a person reads comes from the reviewed presentation registry,
 *     in the words a person would use;
 *   it never offers a checkbox for something this decision cannot grant. A
 *     contextual or critical row is a disclosure, and its timing line carries
 *     the whole meaning: it will ask, and the user will pick.
 *
 * One click adds the complete slate with everything allowed. Unchecking is the
 * dial for anyone who wants to be asked instead — and unchecking withholds a
 * grant, never a part.
 *
 * Two shapes, one review (§7.2, §7.8). In `card` layout it renders inside the
 * floating approval card, which is notification-shaped and never wider than the
 * host allows: a part's detail opens under its row. In `dialog` layout it
 * renders inside the full-surface review dialog, where the list and a persistent
 * detail pane are siblings — and below roughly 720 logical pixels that dialog
 * collapses to the same list/detail model in place, so no window size can leave
 * the review clipped or scrolling sideways. Same parts, same rows, same words,
 * same decision: only the arrangement differs.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Dispatch, KeyboardEvent as ReactKeyboardEvent, SetStateAction } from "react";
import { Badge, Button, Checkbox, Flex, Text, Tooltip } from "@radix-ui/themes";
import { PanelIcon } from "./PanelIcon";
import { ChevronDownIcon, InfoCircledIcon, LockClosedIcon } from "@radix-ui/react-icons";
import type { PendingUnitInstallReviewApproval } from "@vibestudio/shared/approvals";
// The resolution is the *answer* to a review, so it lives with the method that
// returns it (shellApproval), not with the review snapshot in shared.
import type { InstallReviewResolution } from "@vibestudio/service-schemas/shellApproval";
import { getInstallReviewActionCopy } from "@vibestudio/shared/approvalCopy";
import { HOST_APPROVAL_COPY } from "@vibestudio/shared/hostApprovalCopy";
import { AUTHORITY_DOMAINS } from "@vibestudio/shared/authority/authorityDomains";
import { OriginText } from "./OriginText";
import {
  clearableRows,
  compareInstallParts,
  groupInstallParts,
  groupRowsByDomain,
  INSTALL_BEHAVIOR_COPY,
  INSTALL_ROW_TIMING_COPY,
  installRowHeadline,
  installPartGroupCount,
  originDomainFact,
  partNotableLine,
  selectionStatusLine,
  summarizeParts,
  type InstallReviewPart,
  type InstallPartGroup,
  type InstallReviewRow,
  type TemplateAcceptance,
  type TemplateInstallResolution,
} from "@vibestudio/shared/authority/unitInstallReview";

const COPY = HOST_APPROVAL_COPY.installReview;

/** Beyond five, Worth knowing folds — a threshold, never a cap. Nothing is dropped. */
const NOTABLE_COLLAPSE_THRESHOLD = 5;
/** Search and a kind filter appear above this many parts, and are absent below it. */
const SEARCH_THRESHOLD = 12;
/** Beyond three changes the row states how many more there are; it never just stops. */
const DIFFERENTIAL_LINE_LIMIT = 3;
/** Below this the two panes collapse to list-and-detail in place (§7.2). */
const TWO_PANE_MIN_WIDTH = 720;

function changeSummary(approval: PendingUnitInstallReviewApproval): string {
  if (approval.mode !== "part-changed") return COPY.adds(approval.summary);
  const added = approval.parts.filter((part) => part.change === "added");
  const changed = approval.parts.filter((part) => part.change === "changed");
  const removed = approval.parts.filter((part) => part.change === "removed");
  return [
    added.length > 0 ? COPY.adds(summarizeParts(added)) : null,
    changed.length > 0 ? COPY.updates(summarizeParts(changed)) : null,
    removed.length > 0 ? COPY.removes(summarizeParts(removed, { includeRemoved: true })) : null,
  ]
    .filter((line): line is string => line !== null)
    .join(" · ");
}

function foldedGroupSummary(group: InstallPartGroup, differential: boolean): string {
  const shown = group.parts.slice(0, 2).map((part) => {
    const summary = differential ? differentialLine(part) : partNotableLine(part);
    const fragment =
      summary.length === 0 ? summary : `${summary[0]?.toLowerCase() ?? ""}${summary.slice(1)}`;
    return `${part.title}: ${fragment}`;
  });
  const remaining = group.parts.length - shown.length;
  return [...shown, ...(remaining > 0 ? [`${remaining} more`] : [])].join(" · ");
}

/**
 * Which shape the review is wearing.
 *
 * `card` is the floating approval card — notification-shaped, host-sized, one
 * column. `dialog` is the full-surface review, which is the only shape allowed
 * to spend a wide window on a second pane. The distinction is a prop rather than
 * a media query alone because a wide *window* says nothing about the width the
 * card was given: the content overlay is capped far below the window, and a card
 * that split itself into two panes on that evidence would put two columns into
 * 472 logical pixels.
 */
export type InstallReviewLayout = "card" | "dialog";

export interface InstallReviewProps {
  approval: PendingUnitInstallReviewApproval;
  /**
   * What is checked right now. Owned by the card rather than held privately
   * here, because the card's Enter shortcut has to accept the review exactly as
   * it stands on screen — a selection this component kept to itself would be
   * invisible to it, and Enter would silently grant what the user unchecked.
   */
  selection: InstallSelection;
  onSelectionChange: Dispatch<SetStateAction<InstallSelection>>;
  layout?: InstallReviewLayout;
}

/** Cleared row keys, per part identity key. */
export type InstallSelection = Map<string, Set<string>>;

/** One click adds the complete slate: every part, every row offered by default. */
export function defaultInstallSelection(parts: readonly InstallReviewPart[]): InstallSelection {
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

/**
 * The identity of a review's *offer*: which parts, and which rows each one puts
 * on screen. A refreshed snapshot that changes either of those has changed what
 * a selection can legally name, which is what the card watches.
 */
export function installSelectionSignature(parts: readonly InstallReviewPart[]): string {
  return parts
    .map(
      (part) =>
        `${part.identityKey}:${clearableRows(part)
          .map((row) => row.key)
          .join(",")}`
    )
    .join("|");
}

/**
 * Re-seat a selection on a refreshed snapshot.
 *
 * The user's choices survive by identity key, because a snapshot refresh is not
 * a new decision — nobody reconsidered anything by watching the queue reload.
 * Two rules keep it honest: a row the new snapshot no longer offers is dropped
 * (naming it would have the server reject the whole acceptance), and a row that
 * appears for the first time in a part the user has already worked on stays
 * unchecked, because this decision may only clear what was actually on screen.
 */
export function syncInstallSelection(
  parts: readonly InstallReviewPart[],
  previous: InstallSelection
): InstallSelection {
  const next = defaultInstallSelection(parts);
  for (const part of parts) {
    const prior = previous.get(part.identityKey);
    if (!prior || !next.has(part.identityKey)) continue;
    const offered = new Set(clearableRows(part).map((row) => row.key));
    next.set(part.identityKey, new Set([...prior].filter((key) => offered.has(key))));
  }
  return next;
}

/**
 * Whether this review is a diff rather than a footprint.
 *
 * Driven by the data, not by the mode string: `part-changed` carries the same
 * change marks an update does — that is the whole point of the card — and reading
 * a hardcoded "update" showed it a full footprint where §7.4 shows one line of
 * diff. An install and a first adoption have nothing to diff against, so they
 * are never differential no matter what marks ride along.
 */
export function isDifferentialReview(approval: PendingUnitInstallReviewApproval): boolean {
  if (approval.mode === "install" || approval.mode === "adopt-root") return false;
  return approval.parts.some(
    (part) =>
      part.change === "changed" ||
      part.change === "removed" ||
      [...part.notableRows, ...part.everydayRows].some((row) => row.change !== undefined)
  );
}

export function installAcceptanceFrom(
  approval: PendingUnitInstallReviewApproval,
  selection: InstallSelection
): TemplateAcceptance {
  return {
    decision:
      approval.mode === "update"
        ? "update"
        : approval.mode === "adopt-root"
          ? "adopt-root"
          : "install",
    allowNow: [...selection].map(([identityKey, permissions]) => ({
      identityKey,
      permissions: [...permissions],
    })),
  };
}

/**
 * Whether the full surface is wide enough for list and detail to sit side by
 * side (§7.2). Only the dialog ever asks: the card has no second pane to give.
 *
 * The window is the measure, matching how the panel chrome decides its own
 * small-window mode — one window, one answer, rather than two components
 * disagreeing about what "small" means. Where `matchMedia` is unavailable the
 * answer is "collapsed", because the list/detail model is the one that is
 * usable at every size.
 */
function useTwoPane(active: boolean): boolean {
  const query = `(min-width: ${TWO_PANE_MIN_WIDTH}px)`;
  const [wide, setWide] = useState(() => matchesQuery(query));
  useEffect(() => {
    if (!active || typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setWide(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [active, query]);
  return active && wide;
}

function matchesQuery(query: string): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(query).matches;
}

export function InstallReview({
  approval,
  selection,
  onSelectionChange,
  layout = "card",
}: InstallReviewProps) {
  const [openPart, setOpenPart] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<string>("");
  const [groupExpansion, setGroupExpansion] = useState<Map<string, boolean>>(() => new Map());
  const twoPane = useTwoPane(layout === "dialog");
  const listRef = useRef<HTMLDivElement>(null);
  const detailPaneId = `${useId()}-detail-pane`;
  // What a part had checked the last time it was unchecked wholesale. Restoring
  // only the defaults threw away rows the user had deliberately opted into, and
  // a checkbox that quietly forgets is worse than one that does nothing.
  const rememberedRows = useRef(new Map<string, Set<string>>());

  const differential = isDifferentialReview(approval);
  const parts = useMemo(
    () =>
      [...approval.parts].sort((left, right) => compareInstallParts(approval.mode, left, right)),
    [approval.parts, approval.mode]
  );
  const templateParts = useMemo(() => parts.filter((part) => part.section === "template"), [parts]);
  const repairParts = useMemo(() => parts.filter((part) => part.section === "repair"), [parts]);
  // Search and the kind filter share one threshold, because they answer the same
  // question — "where is the one I care about" — and neither is worth its row of
  // chrome on a short list.
  const filtersShown = templateParts.length > SEARCH_THRESHOLD;
  const kinds = useMemo(
    () => [...new Set(templateParts.map((part) => part.label))].sort(),
    [templateParts]
  );
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!filtersShown) return templateParts;
    return templateParts.filter(
      (part) =>
        (kindFilter === "" || part.label === kindFilter) &&
        (needle === "" ||
          part.title.toLowerCase().includes(needle) ||
          part.purpose.toLowerCase().includes(needle))
    );
  }, [templateParts, query, kindFilter, filtersShown]);
  const groups = useMemo(() => groupInstallParts(visible), [visible]);
  const anythingNotable = useMemo(
    () => templateParts.some((part) => part.notableRows.length > 0),
    [templateParts]
  );
  const filtering = filtersShown && (query.trim() !== "" || kindFilter !== "");
  const groupIsOpen = useCallback(
    (group: InstallPartGroup) => {
      if (filtering) return true;
      const explicit = groupExpansion.get(group.key);
      if (explicit !== undefined) return explicit;
      // Quiet categories fold only when another category has something the
      // reviewer should notice. If the whole slate is routine, leave it open:
      // collapsing every category would replace the workspace with headings.
      return !(anythingNotable && !group.hasNotablePart);
    },
    [anythingNotable, filtering, groupExpansion]
  );
  const displayedParts = useMemo(
    () => groups.flatMap((group) => (groupIsOpen(group) ? group.parts : [])),
    [groupIsOpen, groups]
  );

  // Filtering changes what is on screen and nothing else. The hidden parts are
  // still being added and still carrying whatever grants they had, so the list
  // says how many, and how many of them are still allowed now.
  const hidden = templateParts.filter((part) => !visible.includes(part));
  const hiddenAllowed = hidden.filter((part) => (selection.get(part.identityKey)?.size ?? 0) > 0);

  // In two-pane mode the detail column always shows something, so the first part
  // in the sorted list — the one with the most to say — is open on arrival. When
  // a filter hides whatever was open, the pane follows the list rather than
  // showing detail for a part the user can no longer see.
  const openedPart = openPart
    ? displayedParts.find((part) => part.identityKey === openPart)
    : undefined;
  const detailPart = twoPane ? (openedPart ?? displayedParts[0] ?? repairParts[0]) : openedPart;

  const togglePart = (part: InstallReviewPart, checked: boolean) => {
    onSelectionChange((previous) => {
      const next = new Map(previous);
      const offered = clearableRows(part);
      if (!checked) {
        // Deselecting a part deselects its permissions — and remembers them, so
        // that changing your mind twice costs nothing.
        rememberedRows.current.set(part.identityKey, new Set(previous.get(part.identityKey) ?? []));
        next.set(part.identityKey, new Set());
        return next;
      }
      const remembered = rememberedRows.current.get(part.identityKey);
      const restored =
        remembered && remembered.size > 0
          ? offered.filter((row) => remembered.has(row.key))
          : offered.filter((row) => row.selectedByDefault);
      next.set(part.identityKey, new Set(restored.map((row) => row.key)));
      return next;
    });
  };

  const toggleRow = (part: InstallReviewPart, rowKey: string, checked: boolean) => {
    onSelectionChange((previous) => {
      const next = new Map(previous);
      const rows = new Set(next.get(part.identityKey) ?? []);
      if (checked) rows.add(rowKey);
      else rows.delete(rowKey);
      next.set(part.identityKey, rows);
      return next;
    });
  };

  /**
   * Up and down walk the list, and selection follows focus — the ordinary
   * master/detail keyboard, so a part can be read without ever leaving the list.
   *
   * Left and right are deliberately untouched: the card owns them for stepping
   * through the approval queue, and a pane that quietly ate them would strand
   * anyone with more than one approval waiting. Tab is the way into the detail
   * pane, which is why only the selected row is a tab stop in this layout.
   */
  const handleListKeys = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const list = listRef.current;
    if (!list) return;
    const rows = [...list.querySelectorAll<HTMLButtonElement>("button[data-part-row]")];
    if (rows.length === 0) return;
    const active = document.activeElement;
    const current = rows.findIndex((row) => row === active);
    if (current < 0) return;
    const index =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? rows.length - 1
          : event.key === "ArrowDown"
            ? Math.min(rows.length - 1, current + 1)
            : Math.max(0, current - 1);
    event.preventDefault();
    rows[index]?.focus();
    rows[index]?.click();
  }, []);

  // An upgrade that changes no declared authority anywhere is one line and two
  // actions — never a per-part list (§5.4). The card header carries the line and
  // its footer carries the actions, so there is nothing left to render here.
  if (approval.parts.length === 0 && approval.unchangedPartCount > 0) return null;

  const renderPart = (part: InstallReviewPart) => (
    <PartRow
      key={part.identityKey}
      part={part}
      parts={approval.parts}
      differential={differential}
      selected={selection.get(part.identityKey) ?? new Set()}
      active={detailPart?.identityKey === part.identityKey}
      inline={!twoPane}
      detailPaneId={twoPane ? detailPaneId : undefined}
      onOpen={() =>
        setOpenPart((current) =>
          // In two-pane mode the pane never empties: clicking the open part again
          // would blank the column for no reason a person asked for.
          current === part.identityKey && !twoPane ? null : part.identityKey
        )
      }
      onTogglePart={(checked) => togglePart(part, checked)}
      onToggleRow={(rowKey, checked) => toggleRow(part, rowKey, checked)}
    />
  );

  const list = (
    <Flex direction="column" gap="3" className="install-review-column" minWidth="0">
      <Text size="1" color="gray">
        {changeSummary(approval)}
      </Text>

      {filtersShown ? (
        <Flex gap="2" wrap="wrap" className="install-review-filters">
          <input
            className="install-review-search"
            type="search"
            value={query}
            placeholder={COPY.filters.search}
            aria-label={COPY.filters.search}
            onChange={(event) => setQuery(event.target.value)}
          />
          <select
            className="install-review-kind-filter"
            aria-label={COPY.filters.kind}
            value={kindFilter}
            onChange={(event) => setKindFilter(event.target.value)}
          >
            <option value="">{COPY.filters.allKinds}</option>
            {kinds.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </Flex>
      ) : null}

      {/* The list keeps its own scroll so opening a part never shoves the actions
          or the status line off screen — with an adopt-root slate that was the
          difference between a review and a scroll hunt. Vertical only: nothing
          here nests a horizontal scroll inside another (§7.8). */}
      <div className="install-review-list-scroll">
        {visible.length === 0 ? (
          <Text size="1" color="gray">
            {COPY.sections.noMatches}
          </Text>
        ) : (
          <div className="install-review-groups" ref={listRef} onKeyDown={handleListKeys}>
            {groups.map((group) => {
              const open = groupIsOpen(group);
              const groupId = `${detailPaneId}-${group.key}`;
              return (
                <section className="install-review-group" key={group.key}>
                  <button
                    type="button"
                    className="install-review-group-toggle"
                    aria-expanded={open}
                    aria-controls={groupId}
                    aria-disabled={filtering}
                    disabled={filtering}
                    onClick={() =>
                      setGroupExpansion((previous) => {
                        const next = new Map(previous);
                        next.set(group.key, !open);
                        return next;
                      })
                    }
                  >
                    <span className="install-review-group-heading">
                      <span className="install-review-group-title">
                        <Text as="span" size="2" weight="bold">
                          {group.title}
                        </Text>
                        <Badge
                          className="install-review-group-count"
                          size="1"
                          variant="soft"
                          color="gray"
                        >
                          {installPartGroupCount(group)}
                        </Badge>
                      </span>
                      <ChevronDownIcon
                        className={open ? "install-review-chevron open" : "install-review-chevron"}
                        width={14}
                        height={14}
                        aria-hidden="true"
                      />
                    </span>
                    {!open ? (
                      <span className="install-review-group-summary">
                        {foldedGroupSummary(group, differential)}
                      </span>
                    ) : null}
                  </button>
                  {open ? (
                    <ul className="install-review-list" role="list" id={groupId}>
                      {group.parts.map(renderPart)}
                    </ul>
                  ) : null}
                </section>
              );
            })}
          </div>
        )}

        {/* Agent-authored repairs to parts already here. Always shown, never
            folded away: they touch parts this operation does not own. */}
        {repairParts.length > 0 ? (
          <Flex direction="column" gap="2" className="install-review-repairs">
            <Text size="1" weight="medium">
              {COPY.sections.repairs(repairParts.length)}
            </Text>
            <ul className="install-review-list" role="list">
              {repairParts.map(renderPart)}
            </ul>
          </Flex>
        ) : null}
      </div>

      {hidden.length > 0 ? (
        <Text size="1" color="gray" aria-live="polite" className="install-review-hidden-note">
          {COPY.filters.hidden(hidden.length, hiddenAllowed.length)}
        </Text>
      ) : null}

      {approval.unchangedPartCount > 0 ? (
        <Text size="1" color="gray">
          {COPY.summary.unchangedParts(approval.unchangedPartCount)}
        </Text>
      ) : null}

    </Flex>
  );

  if (!twoPane) {
    return (
      <Flex direction="column" gap="3" className="install-review" data-layout={layout}>
        {list}
      </Flex>
    );
  }

  return (
    <div className="install-review install-review-panes" data-layout={layout}>
      {list}
      {/*
        A pane, not a popup: it is a labelled region the keyboard reaches with one
        Tab from the selected row, and it holds still while the list scrolls
        beside it. It scrolls on its own axis only — never sideways, and never
        inside another horizontal scroll (§7.8).
      */}
      <div
        className="install-review-detail-pane"
        id={detailPaneId}
        role="region"
        aria-label={detailPart ? detailPart.title : COPY.sections.pickAPart}
        tabIndex={-1}
      >
        {detailPart ? (
          <>
            <Flex direction="column" gap="1" pb="2">
              <Text size="2" weight="bold">
                {detailPart.title}
              </Text>
              <Text size="1" color="gray">
                {detailPart.label}
                {detailPart.purpose ? ` · ${detailPart.purpose}` : ""}
              </Text>
            </Flex>
            <PartDetail
              key={detailPart.identityKey}
              part={detailPart}
              parts={approval.parts}
              selected={selection.get(detailPart.identityKey) ?? new Set()}
              onToggleRow={(rowKey, checked) => toggleRow(detailPart, rowKey, checked)}
            />
          </>
        ) : (
          <Text size="1" color="gray">
            {COPY.sections.pickAPart}
          </Text>
        )}
      </div>
    </div>
  );
}

/**
 * The review's own actions, rendered by the card into its sticky footer.
 *
 * They used to sit at the bottom of the scrolling body, which put `Add to
 * workspace` below every part in the list — fifty-three of them on a fresh
 * workspace. The decision has to be reachable from the top of the list, not
 * only from the end of it.
 */
export function InstallReviewActions({
  approval,
  selection,
  busy,
  onResolve,
}: {
  approval: PendingUnitInstallReviewApproval;
  selection: InstallSelection;
  busy?: boolean;
  onResolve: (resolution: TemplateInstallResolution) => void;
}) {
  const actions = getInstallReviewActionCopy(approval);
  const statusLine =
    approval.parts.length === 0
      ? null
      : selectionStatusLine({
          parts: approval.parts,
          allowNow: installAcceptanceFrom(approval, selection).allowNow,
        });
  const arriving = approval.parts.filter((part) => part.change !== "removed");
  const singlePart = arriving.length === 1 ? arriving[0] : null;
  const visibleStatusLine =
    statusLine && singlePart
      ? statusLine.replace(/^1 part/u, `${singlePart.title} · ${singlePart.label}`)
      : statusLine;

  return (
    <Flex align="center" justify="between" gap="3" wrap="wrap" width="100%">
      {visibleStatusLine ? (
        <Text size="1" color="gray" aria-live="polite">
          {visibleStatusLine}
        </Text>
      ) : (
        <span />
      )}
      <Flex align="center" gap="2">
        {actions.decline ? (
          <Button
            variant="soft"
            color="gray"
            disabled={busy}
            onClick={() => onResolve({ decision: "cancel" })}
            title={actions.decline.description}
          >
            {actions.decline.label}
          </Button>
        ) : null}
        <Button
          data-approval-action="accept-install-review"
          disabled={busy}
          onClick={() => onResolve(installAcceptanceFrom(approval, selection))}
          title={actions.accept.description}
        >
          {actions.accept.label}
        </Button>
      </Flex>
    </Flex>
  );
}

function PartRow({
  part,
  parts,
  differential,
  selected,
  active,
  inline,
  detailPaneId,
  onOpen,
  onTogglePart,
  onToggleRow,
}: {
  part: InstallReviewPart;
  /** The whole slate, so a dependency can be named by its title where we have one. */
  parts: readonly InstallReviewPart[];
  differential: boolean;
  selected: ReadonlySet<string>;
  /** This part's detail is the one on screen — under the row, or in the pane. */
  active: boolean;
  /** Detail opens under the row instead of in the second pane. */
  inline: boolean;
  /** The pane this row drives, when there is one. */
  detailPaneId?: string;
  onOpen: () => void;
  onTogglePart: (checked: boolean) => void;
  onToggleRow: (rowKey: string, checked: boolean) => void;
}) {
  const clearable = clearableRows(part);
  const allSelected = clearable.length > 0 && clearable.every((row) => selected.has(row.key));
  const noneSelected = clearable.every((row) => !selected.has(row.key));
  const removed = part.change === "removed";
  const askingHint = noneSelected && clearable.length > 0 ? COPY.willAsk : undefined;
  const rowId = useId();
  const detailId = `${rowId}-detail`;
  const toggleId = `${rowId}-toggle`;

  return (
    <li className="install-review-part" data-selected={active ? "" : undefined}>
      <Flex align="start" gap="2" className="install-review-part-main">
        {clearable.length > 0 && !removed ? (
          // The hover copy states what the checkbox does in its current state:
          // checked means allowed on arrival, unchecked means it will ask. The
          // part's purpose is already on the row and says nothing about that.
          <Tooltip content={askingHint ?? COPY.willAllow}>
            <Checkbox
              checked={allSelected ? true : noneSelected ? false : "indeterminate"}
              onCheckedChange={(checked) => onTogglePart(checked === true)}
              aria-label={`Allow ${part.title} now`}
            />
          </Tooltip>
        ) : (
          <span className="install-review-checkbox-spacer" aria-hidden="true" />
        )}
        {/*
          A real button, not a div with a click handler: this is the only way into
          a part's detail, and a review nobody can open from the keyboard is a
          review that did not happen (§7.8). The checkbox stays its own control
          outside it, because "look at this" and "allow this" are different
          decisions and neither may swallow the other.

          Inline, it is a disclosure and says what it expands. In the two-pane
          dialog it selects instead, so it says what it drives and which row is
          current — and only the current row is a tab stop, so one Tab out of a
          fifty-three part list lands in the detail pane rather than in part two.
        */}
        <button
          type="button"
          id={toggleId}
          data-part-row=""
          data-identity-key={part.identityKey}
          className="install-review-part-toggle"
          {...(inline
            ? { "aria-expanded": active, "aria-controls": detailId }
            : {
                "aria-current": active,
                ...(detailPaneId ? { "aria-controls": detailPaneId } : {}),
                tabIndex: active ? 0 : -1,
              })}
          onClick={onOpen}
        >
          <span className="install-review-part-head">
            <span className="install-review-part-icon" aria-hidden="true">
              <PanelIcon
                icon={part.icon}
                source={part.repoPath}
                size={18}
                fallback={part.kind === "panel" ? "panel" : part.kind}
              />
            </span>
            <Text as="span" size="2" weight="medium">
              {part.title}
            </Text>
            <span className="install-review-part-meta">
              {differential && part.change === "added" ? (
                <Badge color="green" variant="soft">
                  new
                </Badge>
              ) : null}
              {removed ? (
                <Badge color="gray" variant="soft">
                  removed
                </Badge>
              ) : null}
              <Text as="span" size="1" color="gray">
                {part.label}
              </Text>
              <ChevronDownIcon
                className={active ? "install-review-chevron open" : "install-review-chevron"}
                width={13}
                height={13}
                aria-hidden="true"
              />
            </span>
          </span>
          {part.purpose ? (
            <Text as="span" size="1" color="gray" className="install-review-purpose">
              {part.purpose}
            </Text>
          ) : null}
          <Text as="span" size="1" className="install-review-notable">
            {differential ? differentialLine(part) : partNotableLine(part)}
          </Text>
          {askingHint ? (
            <Text as="span" size="1" color="gray">
              {askingHint}
            </Text>
          ) : null}
        </button>
      </Flex>
      {inline && active ? (
        <PartDetail
          part={part}
          parts={parts}
          id={detailId}
          labelledBy={toggleId}
          selected={selected}
          onToggleRow={onToggleRow}
        />
      ) : null}
    </li>
  );
}

/**
 * In a differential review the row states what changed about what this part can
 * do — nothing else. Code identity moved for half the workspace; that is not a
 * fact anyone can act on.
 *
 * Three changes fit on a line; a fourth does not, and a line that simply stopped
 * at three hid changes behind a truncation the user could not see. The remainder
 * is counted out loud and lives in full one keypress away, in the detail.
 */
function differentialLine(part: InstallReviewPart): string {
  const changed = [...part.notableRows, ...part.everydayRows].filter((row) => row.change);
  if (changed.length === 0) return COPY.noNewPermissions;
  const shown = changed
    .slice(0, DIFFERENTIAL_LINE_LIMIT)
    .map((row) => `${row.change === "removed" ? "−" : "+"} ${installRowHeadline(row)}`);
  const rest = changed.length - shown.length;
  return [...shown, ...(rest > 0 ? [COPY.moreChanges(rest)] : [])].join(" · ");
}

function PartDetail({
  part,
  parts,
  id,
  labelledBy,
  selected,
  onToggleRow,
}: {
  part: InstallReviewPart;
  parts: readonly InstallReviewPart[];
  id?: string;
  labelledBy?: string;
  selected: ReadonlySet<string>;
  onToggleRow: (rowKey: string, checked: boolean) => void;
}) {
  const [showAllNotable, setShowAllNotable] = useState(false);
  const [showEveryday, setShowEveryday] = useState(false);

  // Worth knowing carries EVERY headline row plus every behavioral fact.
  // Beyond five it folds — expanded by default when any of them always confirms,
  // because that is the one a person must not miss.
  const notable = part.notableRows;
  const hasCritical = notable.some((row) => row.timing === "asks-every-time");
  const collapsed = notable.length > NOTABLE_COLLAPSE_THRESHOLD && !showAllNotable && !hasCritical;
  const shownNotable = collapsed ? notable.slice(0, NOTABLE_COLLAPSE_THRESHOLD) : notable;
  const everydayGroups = useMemo(() => groupRowsByDomain(part.everydayRows), [part.everydayRows]);

  // Dependencies are unit names, which is machinery. Where the same operation is
  // landing the part it needs, say the name the user just read in the list.
  const requires = part.requiredUnitKeys.map(
    (key) => parts.find((candidate) => candidate.name === key)?.title ?? key
  );

  return (
    <Flex
      direction="column"
      gap="2"
      className="install-review-detail"
      pt="2"
      {...(id ? { id } : {})}
      {...(labelledBy ? { role: "group", "aria-labelledby": labelledBy } : {})}
    >
      {notable.length > 0 ? (
        <>
          {shownNotable.map((row) => (
            <ReviewRow
              key={row.key}
              row={row}
              checked={selected.has(row.key)}
              onToggle={(checked) => onToggleRow(row.key, checked)}
            />
          ))}
          {collapsed ? (
            <button
              type="button"
              className="install-review-disclosure"
              onClick={() => setShowAllNotable(true)}
            >
              {COPY.sections.showAllNotable(notable.length)}
            </button>
          ) : null}
        </>
      ) : null}

      {part.everydayRows.length > 0 ? (
        <>
          <button
            type="button"
            className="install-review-disclosure"
            aria-expanded={showEveryday}
            onClick={() => setShowEveryday((open) => !open)}
          >
            {COPY.sections.everyday(part.everydayRows.length)}
          </button>
          {showEveryday ? (
            <Flex direction="column" gap="2">
              <Text size="1" color="gray">
                {COPY.sections.everydayFraming}
              </Text>
              {/* Grouped by domain (§7.2): eight rows in a flat list are eight
                  things to read; the same eight under three headings are three. */}
              {everydayGroups.map((group) => (
                <Flex key={group.label} direction="column" gap="1">
                  <Text size="1" color="gray" weight="medium">
                    {group.label}
                  </Text>
                  {group.rows.map((row) => (
                    <ReviewRow
                      key={row.key}
                      row={row}
                      checked={selected.has(row.key)}
                      onToggle={(checked) => onToggleRow(row.key, checked)}
                    />
                  ))}
                </Flex>
              ))}
            </Flex>
          ) : null}
        </>
      ) : null}

      <Flex direction="column" gap="1" className="install-review-provenance">
        {/* Identity at human scale: the origin URL and the version tag, and
            nothing else. No commit id, no content digest, anywhere. */}
        <Text size="1" color="gray">
          {part.version ? `Version ${part.version}` : part.label}
          {part.origin.url ? (
            <>
              {" · "}
              {/* The domain is emphasized WITHIN the URL, never instead of it:
                  the reader must still see the whole string, and the run that
                  says whose code this is must be the one that stands out. */}
              <OriginText text={part.origin.url} origin={part.origin} />
            </>
          ) : part.origin.originStatus === "multiple-template-contributors" ? (
            <> · Multiple template contributions; inspect file history for exact sources</>
          ) : (
            ""
          )}
        </Text>
        {/* The emphasis above is visual only. This says the same fact in words,
            for a screen reader and for a display that cannot show weight. */}
        {originDomainFact(part.origin) ? (
          <Text size="1" color="gray">
            {originDomainFact(part.origin)}
          </Text>
        ) : null}
        {part.originallyInstalledFrom ? (
          <Text size="1" color="gray">
            Originally installed from {part.originallyInstalledFrom}
          </Text>
        ) : null}
        {/* Two opposite facts, each under its own honest label: what this part
            hosts for everything else, and what it leans on. They were rendered
            as one, and the one shown was the wrong one. */}
        {part.surfaces.length > 0 ? (
          <Text size="1" color="gray">
            {COPY.sections.hostsForWorkspace}:{" "}
            {part.surfaces.map((surface) => surface.name).join(", ")}
          </Text>
        ) : null}
        {requires.length > 0 ? (
          <Text size="1" color="gray">
            {COPY.sections.needsFromWorkspace}: {requires.join(", ")}
          </Text>
        ) : null}
      </Flex>
    </Flex>
  );
}

function ReviewRow({
  row,
  checked,
  onToggle,
}: {
  row: InstallReviewRow;
  checked: boolean;
  onToggle: (checked: boolean) => void;
}) {
  const headline = installRowHeadline(row);
  const detail =
    row.kind === "behavior" ? INSTALL_BEHAVIOR_COPY[row.fact].detail : row.row.resource;
  const binding = row.kind === "permission" ? row.binding : undefined;
  const timing = INSTALL_ROW_TIMING_COPY[row.timing];
  const domainLabel = row.kind === "permission" ? AUTHORITY_DOMAINS[row.row.domain].label : null;

  return (
    <Flex align="start" gap="2" className="install-review-row">
      {row.selectable ? (
        <Checkbox
          checked={checked}
          onCheckedChange={(next) => onToggle(next === true)}
          aria-label={`Allow ${headline} now`}
        />
      ) : (
        // A disclosure, never a checkbox: this decision cannot grant it, and a
        // checkbox would promise something the server would refuse.
        <Tooltip content={timing ?? headline}>
          <span className="install-review-disclosure-marker" aria-hidden="true">
            {row.timing === "asks-every-time" ? <LockClosedIcon /> : <InfoCircledIcon />}
          </span>
        </Tooltip>
      )}
      <Flex direction="column" gap="1" flexGrow="1">
        <Flex align="center" gap="2" wrap="wrap">
          {domainLabel ? (
            <Badge
              color={row.change === "added" ? "green" : row.change === "removed" ? "gray" : "amber"}
              variant="soft"
            >
              {domainLabel}
            </Badge>
          ) : null}
          <Text size="1" weight="medium">
            {row.change === "added" ? "+ " : row.change === "removed" ? "− " : ""}
            {headline}
          </Text>
        </Flex>
        <Text size="1" color="gray">
          {detail}
        </Text>
        {/* The unit's manifest names a protocol, not a provider, so the
            manifest alone cannot say who it talks to. Name the contract and
            the provider currently filling it, in that order: the contract is
            the durable fact, the provider is the current answer. */}
        {binding ? (
          <Text size="1" color="gray">
            {binding.serviceName
              ? `Uses ${binding.protocol} — currently provided by ${binding.serviceName}`
              : `Uses ${binding.protocol} — no provider in this workspace`}
            {binding.availability === "optional" ? " (optional)" : ""}
          </Text>
        ) : null}
        {/* Cleared at install has no second line: it simply works once added. */}
        {timing ? (
          <Text size="1" color="gray">
            {timing}
          </Text>
        ) : null}
      </Flex>
    </Flex>
  );
}

/**
 * How a review ended (§7.2, "Result").
 *
 * There are exactly two ways a review stops being a question, and both are
 * outcomes rather than errors:
 *
 *   `refused` — the call itself did not go through. The review is still pending,
 *     the selection on screen is still there, and the only fact this surface can
 *     see is that the operation did not happen.
 *   `resolved` — the server answered. It says what it observed, in its own
 *     words, including which parts failed and whether the workspace was left
 *     alone. A resolution is not automatically good news: `cancelled` is a
 *     decision, and an accepted one with no `landing` is still under way.
 *
 * They share one presentation because they are one thing to the reader ("what
 * came of that?"), and keeping two would let the two drift into contradicting
 * each other about the same install.
 */
export type InstallReviewOutcome =
  | {
      source: "refused";
      mode: PendingUnitInstallReviewApproval["mode"];
      message: string;
    }
  | { source: "resolved"; resolution: InstallReviewResolution };

/**
 * Copy §7.2 makes normative but `HOST_APPROVAL_COPY.installReview` does not
 * carry yet.
 *
 * Both belong in `hostApprovalCopy.ts` under `installReview.result`, next to
 * `installReview.failure`; that file is host-owned copy and was not editable in
 * this change, so they sit here, named, rather than being spelled inline at the
 * point of use where a copy review would never find them.
 */

/** What the notice renders, resolved from either kind of outcome. */
export interface InstallOutcomeModel {
  /**
   * Success is claimed only on evidence. Accepted-with-no-landing is `neutral`,
   * not `success`: absent landing means "not watched", never "fine".
   */
  tone: "success" | "failure" | "neutral";
  heading: string;
  /** One supporting line — the server's, or the refusal's own message. */
  detail?: string;
  /** The template this was about, when it was about one. */
  subject?: string;
  /** Named, with reasons, never counted. */
  failed: readonly { identityKey: string; title: string; reason: string }[];
  /** The one thing that is safe to say about the aftermath, when it is. */
  aftermath?: string;
  entryPoint?: NonNullable<InstallReviewResolution["entryPoint"]>;
}

/**
 * Read an outcome as the notice will say it — never louder than the evidence.
 *
 * Pure so the honesty rules are testable without a DOM: nothing here invents a
 * fact the outcome did not carry, and every branch that would claim more than
 * was observed falls back to the neutral one.
 */
export function installOutcomeModel(outcome: InstallReviewOutcome): InstallOutcomeModel {
  if (outcome.source === "refused") {
    return {
      tone: "failure",
      heading: COPY.failure.heading[outcome.mode],
      detail: outcome.message,
      failed: [],
      aftermath: COPY.failure.aftermath,
    };
  }
  const { resolution } = outcome;
  const failed = resolution.landing?.failed ?? [];
  const landed = resolution.landing != null;
  // Cancelling is a decision the user made on purpose, so it is never dressed
  // as a failure — but a cancel that still left named casualties says so.
  const tone: InstallOutcomeModel["tone"] =
    failed.length > 0
      ? "failure"
      : resolution.decision === "accepted" && landed
        ? "success"
        : "neutral";
  return {
    tone,
    heading: resolution.heading,
    ...(resolution.detail ? { detail: resolution.detail } : {}),
    ...(resolution.subject ? { subject: resolution.subject } : {}),
    failed,
    ...(resolution.landing?.workspaceUnchanged
      ? { aftermath: COPY.result.workspaceUnchanged }
      : {}),
    ...(resolution.entryPoint ? { entryPoint: resolution.entryPoint } : {}),
  };
}

/**
 * The result, in the review's own voice.
 *
 * `Approval action failed: <server string>` told the user that software broke
 * rather than what is now true of their workspace, and until the server could
 * describe an acceptance there was no success state to show at all — the card
 * simply unmounted when the approval left the queue. This is both halves.
 *
 * `onDismiss` is optional because the two hosts differ, not because the notice
 * is sometimes undismissable: inside the card the outcome belongs to a review
 * that is still on screen and goes away with it, while a host-level result must
 * be closable by hand. The host owns timing because it knows whether the result
 * is a transient success or a persistent failure.
 */
export function InstallReviewOutcomeNotice({
  outcome,
  onOpenEntryPoint,
  onDismiss,
  compact = false,
}: {
  outcome: InstallReviewOutcome;
  onOpenEntryPoint?: (entryPoint: NonNullable<InstallReviewResolution["entryPoint"]>) => void;
  onDismiss?: () => void;
  compact?: boolean;
}) {
  const model = installOutcomeModel(outcome);
  return (
    <Flex
      direction="column"
      gap="1"
      className={`install-review-failure${compact ? " install-review-outcome--compact" : ""}`}
      // A failure interrupts; a result reports. Both are announced, and only one
      // of them is worth cutting the screen reader off mid-sentence for.
      role={model.tone === "failure" ? "alert" : "status"}
      aria-live={model.tone === "failure" ? "assertive" : "polite"}
    >
      <Text size="2" weight="medium">
        {model.heading}
      </Text>
      {model.subject ? (
        <Text size="1" color="gray">
          {model.subject}
        </Text>
      ) : null}
      {model.detail ? <Text size="1">{model.detail}</Text> : null}
      {model.failed.length > 0 ? (
        <Flex direction="column" gap="1" asChild>
          <ul className="install-review-failed-parts">
            {model.failed.map((part) => (
              <li key={part.identityKey}>
                <Text size="1" weight="medium">
                  {part.title}
                </Text>{" "}
                <Text size="1" color="gray">
                  {part.reason}
                </Text>
              </li>
            ))}
          </ul>
        </Flex>
      ) : null}
      {model.aftermath ? (
        <Text size="1" color="gray">
          {model.aftermath}
        </Text>
      ) : null}
      {model.entryPoint || onDismiss ? (
        <Flex align="center" gap="2" mt="1" className="install-review-outcome-actions">
          {model.entryPoint && onOpenEntryPoint ? (
            <Button
              size="1"
              variant="soft"
              onClick={() => onOpenEntryPoint(model.entryPoint!)}
              className="app-touch-target"
            >
              {COPY.result.openEntryPoint(model.entryPoint.title)}
            </Button>
          ) : null}
          {onDismiss ? (
            <Button
              size="1"
              variant="ghost"
              color="gray"
              onClick={onDismiss}
              className="app-touch-target"
            >
              {HOST_APPROVAL_COPY.chrome.dismiss}
            </Button>
          ) : null}
        </Flex>
      ) : null}
    </Flex>
  );
}
