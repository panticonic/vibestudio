import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import {
  Box,
  Badge,
  Button,
  DropdownMenu,
  Flex,
  Grid,
  Heading,
  IconButton,
  ScrollArea,
  Switch,
  Table,
  Tabs,
  Text,
  Tooltip,
  Theme,
} from "@radix-ui/themes";
import {
  Cross2Icon,
  DotsHorizontalIcon,
  DownloadIcon,
  ExternalLinkIcon,
  LightningBoltIcon,
  ReloadIcon,
  TrashIcon,
  UploadIcon,
} from "@radix-ui/react-icons";
import { blobstore, extensions, gad, rpc, workspace } from "@workspace/runtime";
import {
  formatRelativeTime,
  type GitUpstreamState,
  type GitUpstreamStatusRow,
} from "@vibestudio/shared/gitUpstream";
import { useIsMobile, usePaletteCommands, usePanelTheme, useStateArgs } from "@workspace/react";
import {
  DiffViewer,
  PanelChrome,
  type DiffContentFetcher,
  type DiffReviewEntry,
} from "@workspace/ui";
import { useAppTheme } from "@workspace/ui/panel";
import "@workspace/ui/tokens.css";
import {
  buildCompareEntry,
  describeDiffTarget,
  parseDiffTarget,
  resolveStateLocation,
  rowMatchesDiffTarget,
  shortHash,
  type DiffTarget,
  type StateLocation,
} from "./diffTarget";

interface StateArgs {
  branchId?: string;
  gitRepo?: string;
  /** Diff-review escape-hatch target (open in gad-browser). See `diffTarget.ts`. */
  diffTarget?: unknown;
}

type Row = Record<string, unknown>;
type GitStatusRow = GitUpstreamStatusRow;

interface GitPullPreview {
  behindBy: number;
  aheadBy: number;
  incoming: Array<{ sha: string; summary: string }>;
}

const GIT_BRIDGE_EXTENSION = "@workspace-extensions/git-bridge";

function asText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Governance (WP5) — read-only provenance timeline.
//
// Two halves, unioned read-only (WP5 §7): the GAD agent-tool-approval
// projection (`trajectory_approvals`, owned here in userland) and the host log
// of approval-queue resolutions + membership events (surfaced by the host
// `governance.list` read RPC, WP5a). Neither store writes the other; the panel
// only reads. Failures remain explicit so missing provenance is never mistaken
// for an empty governance history.
// ---------------------------------------------------------------------------

/** The acting/resolving ACCOUNT (userId+handle) the GAD projector hoists onto
 *  an approval provenance row (WP5 §5). Deliberately distinct from the actor's
 *  semantic `kind` (which is never rewritten to "user"): the account is WHO
 *  resolved; the kind is the authoring role. */
interface ApprovalAccount {
  userId: string;
  handle?: string;
}

interface ParsedApprovalActor {
  kind: string;
  id: string;
  account: ApprovalAccount | null;
}

/** Parse a `requested_by_json` / `resolved_by_json` cell into the raw actor
 *  (kind/id) plus the explicit canonical account field. A malformed persisted
 *  row is an invariant violation, not an alternate UI input shape. */
function parseApprovalActor(value: unknown): ParsedApprovalActor | null {
  if (value == null) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("approval actor row must be canonical JSON");
  }
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("approval actor row must be an object");
  }
  const record = parsed as Record<string, unknown>;
  const kind = record["kind"];
  const id = record["id"];
  if (typeof kind !== "string" || kind.length === 0 || typeof id !== "string" || id.length === 0) {
    throw new Error("approval actor row requires kind and id");
  }
  if (!("account" in record)) throw new Error("approval actor row requires account");
  if (record["account"] == null) return { kind, id, account: null };
  if (typeof record["account"] !== "object" || Array.isArray(record["account"])) {
    throw new Error("approval actor account must be an object or null");
  }
  const rawAccount = record["account"] as Record<string, unknown>;
  const userId = rawAccount["userId"];
  const handle = rawAccount["handle"];
  if (typeof userId !== "string" || userId.length === 0) {
    throw new Error("approval actor account requires userId");
  }
  if (handle !== undefined && typeof handle !== "string") {
    throw new Error("approval actor account handle must be a string");
  }
  return { kind, id, account: { userId, ...(handle ? { handle } : {}) } };
}

/** Primary "who" label — prefers the account handle, then userId, then the raw
 *  actor `kind:id` for canonical system resolutions. */
function formatApprovalWho(actor: ParsedApprovalActor | null): string {
  if (!actor) return "—";
  if (actor.account?.handle) return `@${actor.account.handle}`;
  if (actor.account?.userId) return actor.account.userId;
  return `${actor.kind}:${actor.id}`;
}

function approvalStatusColor(status: string): ComponentProps<typeof Badge>["color"] {
  if (status === "granted") return "green";
  if (status === "denied") return "red";
  return "gray";
}

/** Render either a millisecond epoch (host records) or an ISO string (GAD
 *  `updated_at`) as a relative time. */
function formatWhen(value: unknown): string {
  if (typeof value === "number") return formatRelativeTime(value);
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? value : formatRelativeTime(ms);
  }
  return "—";
}

/** A record from the host-owned governance log (WP5 §5/§5.1): an approval
 *  provenance record or a membership-governance record. The canonical types
 *  live host-side with the `governance.list` RPC — the panel only reads them,
 *  so the shape stays loose here. */
type HostGovernanceRow = Record<string, unknown>;

interface HostGovernanceEntry {
  when: unknown;
  category: string;
  summary: string;
  actor: string;
}

function accountLabel(value: unknown): string {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record["handle"] === "string") return `@${record["handle"]}`;
    if (typeof record["userId"] === "string") return record["userId"];
  }
  return "—";
}

/** Flatten either host record kind into one timeline row. */
function describeHostGovernanceRow(row: HostGovernanceRow): HostGovernanceEntry {
  if (row["kind"] === "membership") {
    const role = typeof row["role"] === "string" ? ` as ${row["role"]}` : "";
    return {
      when: row["at"],
      category: "membership",
      summary: `${String(row["op"] ?? "membership")} → ${accountLabel(row["target"])}${role}`,
      actor: accountLabel(row["actor"]),
    };
  }
  const decision =
    typeof row["decision"] === "string"
      ? row["decision"]
      : row["granted"] === true
        ? "granted"
        : "resolved";
  const approvalKind = String(row["approvalKind"] ?? "approval");
  const resource =
    row["resource"] && typeof row["resource"] === "object"
      ? (row["resource"] as Record<string, unknown>)
      : undefined;
  const resourceDetail = resource
    ? ["capability", "key", "value", "credentialId", "subjectId"]
        .map((key) => resource[key])
        .find((value): value is string => typeof value === "string" && value.length > 0)
    : undefined;
  const requestedBy =
    row["requestedBy"] && typeof row["requestedBy"] === "object"
      ? (row["requestedBy"] as Record<string, unknown>)
      : undefined;
  const requester =
    typeof requestedBy?.["callerId"] === "string" ? ` for ${requestedBy["callerId"]}` : "";
  return {
    when: row["resolvedAt"],
    category: approvalKind,
    summary: `${approvalKind} · ${decision}${resourceDetail ? ` · ${resourceDetail}` : ""}${requester}`,
    actor: accountLabel(row["resolvedBy"]),
  };
}

function hostGovernanceRowKey(row: HostGovernanceRow, index: number): string {
  if (row["kind"] === "membership") {
    return `membership:${asText(row["workspaceId"])}:${asText(row["op"])}:${asText(row["at"])}:${accountLabel(row["target"])}`;
  }
  const approvalId = asText(row["approvalId"]);
  return approvalId
    ? `approval:${approvalId}`
    : `approval:${asText(row["workspaceId"])}:${asText(row["resolvedAt"])}:${index}`;
}

/**
 * Host-log half of the unified governance timeline (WP5 §7). The query is
 * always scoped to the active workspace and bounded. Read-only (INV-2).
 */
async function fetchHostGovernance(workspaceId: string): Promise<HostGovernanceRow[]> {
  const result = await rpc.call<unknown>("main", "governance.list", [
    { filter: { workspaceId }, limit: 200 },
  ]);
  if (Array.isArray(result)) return result as HostGovernanceRow[];
  if (typeof result === "object" && Array.isArray((result as { records?: unknown }).records)) {
    return (result as { records: HostGovernanceRow[] }).records;
  }
  throw new Error("governance.list returned an invalid response");
}

function DataTable({ rows, columns }: { rows: Row[]; columns: string[] }) {
  if (rows.length === 0) {
    return (
      <Text color="gray" size="2">
        No rows
      </Text>
    );
  }
  return (
    <Table.Root size="1" variant="surface">
      <Table.Header>
        <Table.Row>
          {columns.map((column) => (
            <Table.ColumnHeaderCell key={column}>{column}</Table.ColumnHeaderCell>
          ))}
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {rows.map((row, index) => (
          <Table.Row key={index}>
            {columns.map((column) => (
              <Table.Cell key={column}>
                <Text size="1" style={{ fontFamily: "monospace", whiteSpace: "nowrap" }}>
                  {asText(row[column])}
                </Text>
              </Table.Cell>
            ))}
          </Table.Row>
        ))}
      </Table.Body>
    </Table.Root>
  );
}

function gitStateColor(state: GitUpstreamState): ComponentProps<typeof Badge>["color"] {
  if (state === "in-sync") return "green";
  if (state === "ahead" || state === "exporting" || state === "pushing") return "blue";
  if (state === "behind") return "amber";
  if (state === "diverged" || state === "auth-failed" || state === "error") return "red";
  return "gray";
}

function formatGitState(row: GitStatusRow): string {
  if (row.state === "ahead") return `ahead ${row.aheadBy}`;
  if (row.state === "behind") return `behind ${row.behindBy}`;
  if (row.state === "diverged") return `diverged +${row.aheadBy}/+${row.behindBy}`;
  return row.state;
}

function GitTab({
  rows,
  loading,
  pendingRepo,
  pullPreview,
  onRefresh,
  onPush,
  onForcePush,
  onPullPreview,
  onConfirmPull,
  onCancelPull,
  onToggleAutoPush,
  onDetach,
  onViewDiff,
}: {
  rows: GitStatusRow[];
  loading: boolean;
  pendingRepo: string | null;
  pullPreview: { repoPath: string; preview: GitPullPreview } | null;
  onRefresh: () => void;
  onPush: (repoPath: string) => void;
  onForcePush: (repoPath: string) => void;
  onPullPreview: (repoPath: string) => void;
  onConfirmPull: () => void;
  onCancelPull: () => void;
  onToggleAutoPush: (repoPath: string, enabled: boolean) => void;
  onDetach: (repoPath: string) => void;
  onViewDiff: (repoPath: string) => void;
}) {
  return (
    <Flex direction="column" gap="3" style={{ minWidth: 0 }}>
      <Flex align="center" justify="between" gap="2" wrap="wrap">
        <Text size="2" color="gray">
          {rows.length} tracked repo{rows.length === 1 ? "" : "s"}
        </Text>
        <Button size="1" variant="soft" color="gray" onClick={onRefresh} disabled={loading}>
          <ReloadIcon /> Refresh
        </Button>
      </Flex>
      {pullPreview ? (
        <Box
          style={{
            border: "1px solid var(--amber-a6)",
            borderRadius: 6,
            background: "var(--amber-a2)",
            padding: "10px 12px",
          }}
        >
          <Flex direction="column" gap="2">
            <Flex align="center" justify="between" gap="2" wrap="wrap">
              <Text size="2" weight="medium">
                {pullPreview.repoPath} incoming {pullPreview.preview.incoming.length} commit(s)
              </Text>
              <Flex gap="2">
                <Button size="1" variant="solid" onClick={onConfirmPull} disabled={loading}>
                  Import
                </Button>
                <Button size="1" variant="soft" color="gray" onClick={onCancelPull}>
                  Cancel
                </Button>
              </Flex>
            </Flex>
            {pullPreview.preview.incoming.length === 0 ? (
              <Text size="2" color="gray">
                No incoming commits.
              </Text>
            ) : (
              <Flex direction="column" gap="1">
                {pullPreview.preview.incoming.slice(0, 8).map((commit) => (
                  <Text key={commit.sha} size="1" style={{ fontFamily: "monospace" }}>
                    {commit.sha.slice(0, 7)} {commit.summary}
                  </Text>
                ))}
              </Flex>
            )}
          </Flex>
        </Box>
      ) : null}
      {rows.length === 0 ? (
        <Text color="gray" size="2">
          No upstreams configured.
        </Text>
      ) : (
        <Table.Root size="1" variant="surface">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeaderCell>Repo</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>State</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Remote</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Ahead</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Behind</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Last push</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Auto</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Actions</Table.ColumnHeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {rows.map((row) => {
              const busy =
                pendingRepo === row.repoPath ||
                row.state === "exporting" ||
                row.state === "pushing";
              const hasUpstream = row.state !== "local-only" && row.remote;
              return (
                <Table.Row key={row.repoPath}>
                  <Table.Cell>
                    <Text size="1" style={{ fontFamily: "monospace", whiteSpace: "nowrap" }}>
                      {row.repoPath}
                    </Text>
                    {row.lastError ? (
                      <Text size="1" color="red" truncate as="div">
                        {row.lastError}
                      </Text>
                    ) : null}
                  </Table.Cell>
                  <Table.Cell>
                    <Badge color={gitStateColor(row.state)}>{formatGitState(row)}</Badge>
                  </Table.Cell>
                  <Table.Cell>
                    <Text size="1" style={{ fontFamily: "monospace", whiteSpace: "nowrap" }}>
                      {row.remote && row.branch ? `${row.remote}/${row.branch}` : "-"}
                    </Text>
                  </Table.Cell>
                  <Table.Cell>{row.aheadBy}</Table.Cell>
                  <Table.Cell>{row.behindBy}</Table.Cell>
                  <Table.Cell>{formatRelativeTime(row.lastPushedAt)}</Table.Cell>
                  <Table.Cell>
                    <Switch
                      size="1"
                      checked={row.autoPush}
                      disabled={!hasUpstream || busy}
                      onCheckedChange={(checked) => onToggleAutoPush(row.repoPath, checked)}
                    />
                  </Table.Cell>
                  <Table.Cell>
                    <Flex align="center" gap="1" wrap="nowrap">
                      <Tooltip content="Push upstream">
                        <IconButton
                          size="1"
                          variant={row.state === "ahead" ? "solid" : "soft"}
                          disabled={!hasUpstream || busy}
                          onClick={() => onPush(row.repoPath)}
                        >
                          <UploadIcon />
                        </IconButton>
                      </Tooltip>
                      <Tooltip content="Preview pull">
                        <IconButton
                          size="1"
                          variant={
                            row.state === "behind" || row.state === "diverged" ? "solid" : "soft"
                          }
                          color={row.state === "diverged" ? "amber" : undefined}
                          disabled={!hasUpstream || busy}
                          onClick={() => onPullPreview(row.repoPath)}
                        >
                          <DownloadIcon />
                        </IconButton>
                      </Tooltip>
                      <DropdownMenu.Root>
                        <DropdownMenu.Trigger>
                          <IconButton size="1" variant="ghost" color="gray">
                            <DotsHorizontalIcon />
                          </IconButton>
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Content>
                          <DropdownMenu.Item onClick={() => onViewDiff(row.repoPath)}>
                            View diff
                          </DropdownMenu.Item>
                          <DropdownMenu.Item
                            color="red"
                            disabled={!hasUpstream || busy}
                            onClick={() => onForcePush(row.repoPath)}
                          >
                            <LightningBoltIcon /> Force push
                          </DropdownMenu.Item>
                          <DropdownMenu.Separator />
                          <DropdownMenu.Item
                            color="red"
                            disabled={busy}
                            onClick={() => onDetach(row.repoPath)}
                          >
                            <TrashIcon /> Detach
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Root>
                    </Flex>
                  </Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table.Root>
      )}
    </Flex>
  );
}

/**
 * Banner shown when the panel is deep-linked from the approval card's "open in
 * gad-browser" escape hatch. Names the repo/path and both tree states. The
 * Compare tab renders a real two-state diff of the target; this banner also
 * offers the Files-tab focus filter as the fallback for browsing the file in
 * its tree context (and when content can't be fetched for the diff).
 */
function DiffTargetBanner({
  target,
  filterActive,
  onToggleFilter,
}: {
  target: DiffTarget;
  filterActive: boolean;
  onToggleFilter: () => void;
}) {
  return (
    <Box
      style={{
        flexShrink: 0,
        border: "1px solid var(--gray-a6)",
        borderRadius: 8,
        background: "var(--color-panel-translucent)",
        padding: "8px 12px",
      }}
    >
      <Flex align="center" gap="3" wrap="wrap">
        <ExternalLinkIcon />
        <Flex direction="column" style={{ minWidth: 0, flex: 1 }}>
          <Text size="2" weight="medium" truncate>
            {describeDiffTarget(target)}
          </Text>
          <Text size="1" color="gray" truncate as="div">
            {target.newState === null
              ? "File removed at the new state · see the Compare tab for the removed content"
              : `old ${shortHash(target.oldState)} → new ${shortHash(target.newState)} · open the Compare tab for the two-state diff`}
          </Text>
        </Flex>
        <Button size="1" variant="soft" color="gray" onClick={onToggleFilter}>
          {filterActive ? (
            <>
              <Cross2Icon /> Clear filter
            </>
          ) : (
            "Focus target file"
          )}
        </Button>
      </Flex>
    </Box>
  );
}

/** Per-side "where this state lives" links: jump to the head's Files/Events. */
function StateLocationLinks({
  label,
  location,
  onGoToBranch,
}: {
  label: string;
  location: StateLocation | null;
  onGoToBranch: (branchId: string, tab: "files" | "events") => void;
}) {
  if (!location) {
    return (
      <Text size="1" color="gray">
        {label}: removed (no state)
      </Text>
    );
  }
  return (
    <Flex align="center" gap="2" wrap="wrap">
      <Text size="1" color="gray">
        {label} {shortHash(location.stateHash)}
      </Text>
      {location.branchIds.length > 0 ? (
        location.branchIds.map((branchId) => (
          <Flex key={branchId} align="center" gap="1">
            <Button
              size="1"
              variant="soft"
              color="gray"
              onClick={() => onGoToBranch(branchId, "files")}
            >
              {branchId} · Files
            </Button>
            <Button
              size="1"
              variant="ghost"
              color="gray"
              onClick={() => onGoToBranch(branchId, "events")}
            >
              Events
            </Button>
          </Flex>
        ))
      ) : (
        <Text size="1" color="gray">
          not a current head
          {location.commitEventId
            ? ` · produced by event ${shortHash(location.commitEventId)}`
            : ""}
        </Text>
      )}
    </Flex>
  );
}

/**
 * Two-state compare view for a diff-review target. Reuses the shared
 * `@workspace/ui` `DiffViewer` — the exact renderer the approval card uses — so
 * gad-browser inherits its client-side line diffing, best-effort shiki
 * highlighting, and binary/oversized degradation for free. File contents are
 * fetched lazily by content hash through the panel's `blobstore` client (the
 * same read surface the shell's approval card uses). Above the diff, per-side
 * links resolve each tree state to the worktree head(s) it lives on.
 */
function CompareView({
  target,
  entry,
  fetchContent,
  appearance,
  oldLocation,
  newLocation,
  onGoToBranch,
}: {
  target: DiffTarget;
  entry: DiffReviewEntry;
  fetchContent: DiffContentFetcher;
  appearance: "light" | "dark";
  oldLocation: StateLocation | null;
  newLocation: StateLocation | null;
  onGoToBranch: (branchId: string, tab: "files" | "events") => void;
}) {
  return (
    <Flex direction="column" gap="3" style={{ minWidth: 0 }}>
      <Box
        style={{
          border: "1px solid var(--gray-a5)",
          borderRadius: 6,
          background: "var(--gray-a2)",
          padding: "8px 10px",
        }}
      >
        <Flex direction="column" gap="1">
          <StateLocationLinks label="old" location={oldLocation} onGoToBranch={onGoToBranch} />
          <StateLocationLinks label="new" location={newLocation} onGoToBranch={onGoToBranch} />
        </Flex>
      </Box>
      <DiffViewer
        entry={entry}
        fetchContent={fetchContent}
        appearance={appearance}
        initialExpanded={[target.path]}
      />
    </Flex>
  );
}

/** One approval actor cell: the account handle/userId on top, the semantic
 *  actor kind (and id when an account is also present) below — surfacing the
 *  WP5 §5 distinction that the account is not the same as `actor.kind`. */
function ActorCell({ actor }: { actor: ParsedApprovalActor | null }) {
  if (!actor) {
    return (
      <Text size="1" color="gray">
        —
      </Text>
    );
  }
  return (
    <Flex direction="column" style={{ minWidth: 0 }}>
      <Text size="1" style={{ fontFamily: "monospace", whiteSpace: "nowrap" }}>
        {formatApprovalWho(actor)}
      </Text>
      {actor.kind ? (
        <Text size="1" color="gray" style={{ whiteSpace: "nowrap" }}>
          {actor.kind}
          {actor.account && actor.id ? ` · ${actor.id}` : ""}
        </Text>
      ) : null}
    </Flex>
  );
}

/**
 * Read-only Governance timeline (WP5 §7). Top section is the GAD agent-tool
 * approval projection (owned in this DO); bottom section is the host log of
 * approval-queue resolutions + membership events, unioned in from the host
 * `governance.list` RPC. Each source reports its own failure so a partial or
 * unavailable timeline can never look like a genuinely empty history.
 */
function GovernanceTab({
  approvals,
  hostRecords,
  loading,
  loaded,
  gadError,
  hostError,
  onRefresh,
}: {
  approvals: Row[];
  hostRecords: HostGovernanceRow[];
  loading: boolean;
  loaded: boolean;
  gadError: string | null;
  hostError: string | null;
  onRefresh: () => void;
}) {
  return (
    <Flex direction="column" gap="4" style={{ minWidth: 0 }}>
      <Flex align="center" justify="between" gap="2" wrap="wrap">
        <Text size="2" color="gray">
          Read-only provenance — who approved what, and who changed membership.
        </Text>
        <Button
          size="1"
          variant="soft"
          color="gray"
          onClick={onRefresh}
          disabled={loading}
          aria-busy={loading}
        >
          <ReloadIcon /> {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </Flex>

      {loading && !loaded ? (
        <Text size="2" color="gray">
          Loading governance history…
        </Text>
      ) : null}

      <Flex direction="column" gap="2" style={{ minWidth: 0 }}>
        <Heading size="2">Agent tool-call approvals</Heading>
        <Text size="1" color="gray">
          GAD trajectory projection ({approvals.length}).
        </Text>
        {gadError ? (
          <Box
            role="alert"
            style={{
              border: "1px solid var(--red-a7)",
              borderRadius: 6,
              background: "var(--red-a2)",
              padding: "10px 12px",
            }}
          >
            <Text size="2" color="red">
              Could not load agent approval provenance: {gadError}
              {approvals.length > 0 ? " Showing the last loaded records." : ""}
            </Text>
          </Box>
        ) : null}
        {approvals.length === 0 && loaded && !gadError ? (
          <Text color="gray" size="2">
            No agent approvals recorded.
          </Text>
        ) : approvals.length > 0 ? (
          <Table.Root size="1" variant="surface">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeaderCell>Branch</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Approval</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Requested by</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Resolved by</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Updated</Table.ColumnHeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {approvals.map((row) => {
                const status = asText(row["status"]);
                return (
                  <Table.Row
                    key={`${asText(row["log_id"])}:${asText(row["head"])}:${asText(row["approval_id"])}`}
                  >
                    <Table.Cell>
                      <Flex direction="column">
                        <Text size="1" style={{ fontFamily: "monospace", whiteSpace: "nowrap" }}>
                          {asText(row["head"]) || "—"}
                        </Text>
                        <Text size="1" color="gray" style={{ whiteSpace: "nowrap" }}>
                          {asText(row["log_id"]) || "—"}
                        </Text>
                      </Flex>
                    </Table.Cell>
                    <Table.Cell>
                      <Flex direction="column">
                        <Text size="1" style={{ fontFamily: "monospace", whiteSpace: "nowrap" }}>
                          {asText(row["approval_id"])}
                        </Text>
                        {row["invocation_id"] ? (
                          <Text size="1" color="gray" style={{ whiteSpace: "nowrap" }}>
                            invocation {asText(row["invocation_id"])}
                          </Text>
                        ) : null}
                      </Flex>
                    </Table.Cell>
                    <Table.Cell>
                      <Badge color={approvalStatusColor(status)}>{status || "—"}</Badge>
                    </Table.Cell>
                    <Table.Cell>
                      <ActorCell actor={parseApprovalActor(row["requested_by_json"])} />
                    </Table.Cell>
                    <Table.Cell>
                      <ActorCell actor={parseApprovalActor(row["resolved_by_json"])} />
                    </Table.Cell>
                    <Table.Cell>
                      <Text size="1" color="gray" style={{ whiteSpace: "nowrap" }}>
                        {formatWhen(row["updated_at"])}
                      </Text>
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table.Root>
        ) : null}
      </Flex>

      <Flex direction="column" gap="2" style={{ minWidth: 0 }}>
        <Heading size="2">Host approvals &amp; membership</Heading>
        {hostError ? (
          <Box
            role="alert"
            style={{
              border: "1px solid var(--red-a7)",
              borderRadius: 6,
              background: "var(--red-a2)",
              padding: "10px 12px",
            }}
          >
            <Text size="2" color="red">
              Could not load workspace approval and membership provenance: {hostError}
              {hostRecords.length > 0 ? " Showing the last loaded records." : ""}
            </Text>
          </Box>
        ) : null}
        {hostRecords.length === 0 && loaded && !hostError ? (
          <Text color="gray" size="2">
            No host governance records.
          </Text>
        ) : hostRecords.length > 0 ? (
          <Table.Root size="1" variant="surface">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeaderCell>Category</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Event</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Actor</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>When</Table.ColumnHeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {hostRecords.map((row, index) => {
                const entry = describeHostGovernanceRow(row);
                return (
                  <Table.Row key={hostGovernanceRowKey(row, index)}>
                    <Table.Cell>
                      <Badge color="gray">{entry.category}</Badge>
                    </Table.Cell>
                    <Table.Cell>
                      <Text size="1" style={{ whiteSpace: "nowrap" }}>
                        {entry.summary}
                      </Text>
                    </Table.Cell>
                    <Table.Cell>
                      <Text size="1" style={{ fontFamily: "monospace", whiteSpace: "nowrap" }}>
                        {entry.actor}
                      </Text>
                    </Table.Cell>
                    <Table.Cell>
                      <Text size="1" color="gray" style={{ whiteSpace: "nowrap" }}>
                        {formatWhen(entry.when)}
                      </Text>
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table.Root>
        ) : null}
      </Flex>
    </Flex>
  );
}

function App() {
  const appearance = usePanelTheme();
  const appTheme = useAppTheme();
  const isMobile = useIsMobile();
  const stateArgs = useStateArgs<StateArgs>();
  // Diff-review deep link (approval card → "open in gad-browser"). gad-browser
  // has no two-state compare view; the deepest link it supports is landing on
  // the Files tab filtered to the target path at the new state, plus a banner
  // naming both states. A real side-by-side compare is a noted follow-up.
  const diffTarget = useMemo<DiffTarget | null>(
    () => parseDiffTarget(stateArgs.diffTarget),
    [stateArgs.diffTarget]
  );
  // The shared DiffViewer entry + a lazy content fetcher by content hash. The
  // panel's `blobstore` client forwards to the host read surface — the same
  // trusted `get(hash)` path the approval card uses; a rejected/missing blob
  // degrades to a per-file notice in the viewer (never blocks the panel).
  const compareEntry = useMemo<DiffReviewEntry | null>(
    () => (diffTarget ? buildCompareEntry(diffTarget) : null),
    [diffTarget]
  );
  const fetchContent = useMemo<DiffContentFetcher>(
    () => async (hash: string) => {
      const text = await blobstore.getText(hash);
      // A missing blob degrades to the viewer's per-file "could not render"
      // notice; the Files-tab focus filter remains as the browse fallback.
      if (text == null) throw new Error(`blob ${shortHash(hash)} is unavailable`);
      return text;
    },
    []
  );
  const highlightAppearance = appearance === "dark" ? "dark" : "light";
  const [focusActive, setFocusActive] = useState(true);
  const [activeTab, setActiveTab] = useState("files");
  const [worktreeHeads, setWorktreeHeads] = useState<Row[]>([]);
  const oldLocation = useMemo<StateLocation | null>(
    () => resolveStateLocation(worktreeHeads, diffTarget?.oldState),
    [worktreeHeads, diffTarget]
  );
  const newLocation = useMemo<StateLocation | null>(
    () => resolveStateLocation(worktreeHeads, diffTarget?.newState ?? undefined),
    [worktreeHeads, diffTarget]
  );
  const [branches, setBranches] = useState<Row[]>([]);
  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(
    stateArgs.branchId ?? null
  );
  const [events, setEvents] = useState<Row[]>([]);
  const [envelopes, setEnvelopes] = useState<Row[]>([]);
  const [files, setFiles] = useState<Row[]>([]);
  const [invocations, setInvocations] = useState<Row[]>([]);
  const [status, setStatus] = useState<Row[]>([]);
  const [integrity, setIntegrity] = useState<Row[]>([]);
  const [govApprovals, setGovApprovals] = useState<Row[]>([]);
  const [hostGovernance, setHostGovernance] = useState<HostGovernanceRow[]>([]);
  const [govLoading, setGovLoading] = useState(false);
  const [govLoaded, setGovLoaded] = useState(false);
  const [govGadError, setGovGadError] = useState<string | null>(null);
  const [govHostError, setGovHostError] = useState<string | null>(null);
  const governanceLoadSeq = useRef(0);
  const [gitRows, setGitRows] = useState<GitStatusRow[]>([]);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitPendingRepo, setGitPendingRepo] = useState<string | null>(null);
  const [gitPullPreview, setGitPullPreview] = useState<{
    repoPath: string;
    preview: GitPullPreview;
  } | null>(null);
  const [operationStatus, setOperationStatus] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const selectedBranch = useMemo(
    () => branches.find((branch) => asText(branch["branch_id"]) === selectedBranchId) ?? null,
    [branches, selectedBranchId]
  );

  async function refresh() {
    setLoading(true);
    try {
      const [nextStatus, nextBranches] = await Promise.all([
        gad.status(),
        gad.query("SELECT * FROM trajectory_branches ORDER BY updated_at DESC"),
      ]);
      setStatus(nextStatus as unknown as Row[]);
      setBranches(nextBranches.rows);
      const branchId = (selectedBranchId ?? asText(nextBranches.rows[0]?.["branch_id"])) || null;
      setSelectedBranchId(branchId);
      if (branchId) {
        const [nextEvents, nextFiles, nextInvocations, nextEnvelopes] = await Promise.all([
          gad.listTrajectoryEvents({ branchId, limit: 200 }),
          gad.listGadBranchFiles({ branchId }),
          gad.query(
            "SELECT * FROM trajectory_invocations WHERE branch_id = ? ORDER BY updated_at DESC",
            [branchId]
          ),
          gad.query("SELECT * FROM channel_envelopes ORDER BY channel_id, seq LIMIT 200"),
        ]);
        setEvents(nextEvents as unknown as Row[]);
        setFiles(nextFiles);
        setInvocations(nextInvocations.rows);
        setEnvelopes(nextEnvelopes.rows);
      } else {
        setEvents([]);
        setFiles([]);
        setInvocations([]);
        setEnvelopes([]);
      }
    } finally {
      setLoading(false);
    }
  }

  async function invokeGitBridge<T>(method: string, args: unknown[] = []): Promise<T> {
    return (await extensions.invoke(GIT_BRIDGE_EXTENSION, method, args)) as T;
  }

  // Governance timeline (WP5 §7): the GAD agent-approval projection plus the
  // host log half (approval-queue resolutions + membership) via the host RPC
  // seam. Loaded lazily when the tab is opened (see effect below) and on the
  // tab's own Refresh — it is workspace-wide provenance, not branch-scoped.
  async function loadGovernance() {
    const seq = ++governanceLoadSeq.current;
    setGovLoading(true);
    setGovGadError(null);
    setGovHostError(null);
    const [approvalsResult, hostResult] = await Promise.allSettled([
      Promise.resolve().then(() =>
        gad.query(
          `SELECT approval_id, invocation_id, status, requested_by_json, resolved_by_json,
                log_id, head, requested_event_id, resolved_event_id, updated_at
           FROM trajectory_approvals
          ORDER BY updated_at DESC
          LIMIT 200`
        )
      ),
      Promise.resolve()
        .then(() => workspace.getInfo())
        .then((info) => fetchHostGovernance(info.config.id)),
    ]);
    if (seq !== governanceLoadSeq.current) return;

    if (approvalsResult.status === "fulfilled") {
      setGovApprovals(approvalsResult.value.rows);
    } else {
      setGovGadError(
        approvalsResult.reason instanceof Error
          ? approvalsResult.reason.message
          : String(approvalsResult.reason)
      );
    }
    if (hostResult.status === "fulfilled") {
      setHostGovernance(hostResult.value);
    } else {
      setGovHostError(
        hostResult.reason instanceof Error ? hostResult.reason.message : String(hostResult.reason)
      );
    }
    setGovLoaded(true);
    setGovLoading(false);
  }

  // fetchRemote only for the explicit Refresh action — after a push/pull the
  // remote state is already known, and background reloads must stay local.
  async function refreshGitStatus(showLoading = false, fetchRemote = false) {
    if (showLoading) setGitLoading(true);
    try {
      const rows = await invokeGitBridge<GitStatusRow[]>("upstreamStatus", [
        stateArgs.gitRepo ? [stateArgs.gitRepo] : null,
        { fetch: fetchRemote },
      ]);
      setGitRows(rows);
    } catch (err) {
      setOperationStatus(`Git status failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (showLoading) setGitLoading(false);
    }
  }

  async function runGitAction(repoPath: string, success: string, action: () => Promise<unknown>) {
    setGitPendingRepo(repoPath);
    setGitLoading(true);
    try {
      await action();
      setOperationStatus(success);
      await refreshGitStatus(false);
    } catch (err) {
      setOperationStatus(`Git action failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setGitPendingRepo(null);
      setGitLoading(false);
    }
  }

  function pushGit(repoPath: string) {
    void runGitAction(repoPath, `Pushed ${repoPath}`, () =>
      invokeGitBridge("pushUpstream", [repoPath, {}])
    );
  }

  function forcePushGit(repoPath: string) {
    void runGitAction(repoPath, `Force pushed ${repoPath}`, () =>
      invokeGitBridge("pushUpstream", [repoPath, { force: true }])
    );
  }

  function previewPullGit(repoPath: string) {
    setGitPendingRepo(repoPath);
    setGitLoading(true);
    void invokeGitBridge<GitPullPreview>("pullUpstream", [repoPath, { dryRun: true }])
      .then((preview) => {
        setGitPullPreview({ repoPath, preview });
        setOperationStatus("");
      })
      .catch((err) => {
        setOperationStatus(
          `Pull preview failed: ${err instanceof Error ? err.message : String(err)}`
        );
      })
      .finally(() => {
        setGitPendingRepo(null);
        setGitLoading(false);
      });
  }

  function confirmPullGit() {
    const target = gitPullPreview;
    if (!target) return;
    setGitPullPreview(null);
    void runGitAction(target.repoPath, `Imported upstream changes for ${target.repoPath}`, () =>
      invokeGitBridge("pullUpstream", [target.repoPath, {}])
    );
  }

  function toggleAutoPush(repoPath: string, enabled: boolean) {
    void runGitAction(
      repoPath,
      `Auto-push ${enabled ? "enabled" : "disabled"} for ${repoPath}`,
      () => invokeGitBridge("setAutoPush", [repoPath, enabled])
    );
  }

  function detachUpstream(repoPath: string) {
    void runGitAction(repoPath, `Detached upstream for ${repoPath}`, () =>
      invokeGitBridge("removeUpstream", [repoPath])
    );
  }

  function viewGitDiff(repoPath: string) {
    const row = gitRows.find((entry) => entry.repoPath === repoPath);
    if (row?.behindBy) {
      previewPullGit(repoPath);
      return;
    }
    setOperationStatus(`No incoming upstream diff preview is available for ${repoPath}`);
  }

  async function checkIntegrity() {
    setLoading(true);
    try {
      const result = await gad.checkGadIntegrity({});
      setIntegrity(result.errors);
      setOperationStatus(result.ok ? "Integrity OK" : `${result.errors.length} integrity issue(s)`);
    } finally {
      setLoading(false);
    }
  }

  async function validateHashes() {
    setLoading(true);
    try {
      const result = await gad.validateGadHashes({});
      setIntegrity(result.errors.map((message) => ({ message })));
      setOperationStatus(result.ok ? "Hashes OK" : `${result.errors.length} hash issue(s)`);
    } finally {
      setLoading(false);
    }
  }

  async function replayEvents() {
    setLoading(true);
    try {
      const result = await gad.rebuildTrajectoryProjections({});
      setOperationStatus(`Replayed ${result.replayed} event(s)`);
      await refresh();
      await checkIntegrity();
    } finally {
      setLoading(false);
    }
  }

  // Contribute GAD actions to the app-level command palette (Cmd/Ctrl+K).
  const paletteCommands = useMemo(
    () => [
      { id: "gad-refresh", label: "Refresh", section: "GAD Browser" },
      { id: "gad-git-refresh", label: "Refresh Git Upstreams", section: "GAD Browser" },
      { id: "gad-check-integrity", label: "Check integrity", section: "GAD Browser" },
      { id: "gad-validate-hashes", label: "Validate hashes", section: "GAD Browser" },
      { id: "gad-replay-events", label: "Replay events", section: "GAD Browser" },
    ],
    []
  );
  usePaletteCommands(paletteCommands, (id) => {
    if (id === "gad-refresh") void refresh();
    else if (id === "gad-git-refresh") void refreshGitStatus(true, true);
    else if (id === "gad-check-integrity") void checkIntegrity();
    else if (id === "gad-validate-hashes") void validateHashes();
    else if (id === "gad-replay-events") void replayEvents();
  });

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(
    () => () => {
      governanceLoadSeq.current += 1;
    },
    []
  );

  // Lazily load the governance timeline the first time (and whenever) the tab is
  // opened, so the panel's default view never pays for the extra queries.
  useEffect(() => {
    if (activeTab !== "governance") return;
    void loadGovernance();
  }, [activeTab]);

  useEffect(() => {
    let cancelled = false;
    // Fetch the remote once when the tab opens; the 10s poll stays local-only
    // so an open panel never turns into steady network traffic.
    const load = async (showLoading = false, fetchRemote = false) => {
      if (showLoading) setGitLoading(true);
      try {
        const rows = await invokeGitBridge<GitStatusRow[]>("upstreamStatus", [
          stateArgs.gitRepo ? [stateArgs.gitRepo] : null,
          { fetch: fetchRemote },
        ]);
        if (!cancelled) setGitRows(rows);
      } catch (err) {
        if (!cancelled) {
          setOperationStatus(
            `Git status failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      } finally {
        if (showLoading && !cancelled) setGitLoading(false);
      }
    };
    void load(true, true);
    const timer = window.setInterval(() => void load(false), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [stateArgs.gitRepo]);

  // A newly-arrived diff-review target opens the Compare tab (the two-state
  // diff) and re-arms the Files-tab focus filter for the fallback path (also
  // handles live state-arg updates on a reused panel). The worktree-head
  // projection is (re)loaded so both states can be resolved to their branches.
  useEffect(() => {
    if (!diffTarget) return;
    setFocusActive(true);
    setActiveTab("compare");
    void gad
      .query("SELECT log_id, head, state_hash, commit_event_id FROM gad_worktree_heads")
      .then((result) => setWorktreeHeads(result.rows))
      .catch(() => setWorktreeHeads([]));
  }, [diffTarget]);

  useEffect(() => {
    if (!stateArgs.gitRepo) return;
    setActiveTab("git");
  }, [stateArgs.gitRepo]);

  // Jump to a resolved branch: select its head and switch to Files or Events.
  function goToBranch(branchId: string, tab: "files" | "events") {
    setSelectedBranchId(branchId);
    setFocusActive(false);
    setActiveTab(tab);
  }

  useEffect(() => {
    if (!selectedBranchId) return;
    void Promise.all([
      gad
        .listTrajectoryEvents({ branchId: selectedBranchId, limit: 200 })
        .then((rows) => setEvents(rows as unknown as Row[])),
      gad.listGadBranchFiles({ branchId: selectedBranchId }).then(setFiles),
      gad
        .query(
          "SELECT * FROM trajectory_invocations WHERE branch_id = ? ORDER BY updated_at DESC",
          [selectedBranchId]
        )
        .then((result) => setInvocations(result.rows)),
      gad
        .query("SELECT * FROM channel_envelopes ORDER BY channel_id, seq LIMIT 200")
        .then((result) => setEnvelopes(result.rows)),
    ]);
  }, [selectedBranchId]);

  // When a diff-review target is active, the Files tab is filtered to the
  // target row(s) so the reviewer lands directly on the file they came for.
  const visibleFiles = useMemo(
    () =>
      diffTarget && focusActive
        ? files.filter((row) => rowMatchesDiffTarget(row, diffTarget))
        : files,
    [diffTarget, focusActive, files]
  );

  const actionButtons = (
    <>
      {operationStatus ? (
        <Text color="gray" size="2">
          {operationStatus}
        </Text>
      ) : null}
      <Button size="2" variant="soft" onClick={() => void checkIntegrity()} disabled={loading}>
        {isMobile ? "Integrity" : "Check Integrity"}
      </Button>
      <Button size="2" variant="soft" onClick={() => void validateHashes()} disabled={loading}>
        {isMobile ? "Hashes" : "Validate Hashes"}
      </Button>
      <Button size="2" variant="soft" onClick={() => void replayEvents()} disabled={loading}>
        Replay
      </Button>
      <Button
        size="2"
        variant="soft"
        onClick={() => void refresh()}
        disabled={loading}
        title="Refresh"
      >
        <ReloadIcon /> Refresh
      </Button>
    </>
  );

  return (
    <Theme appearance={appearance} {...appTheme}>
      <Box
        style={{
          height: "100dvh",
          boxSizing: "border-box",
          background: "var(--surface-panel)",
        }}
      >
        <PanelChrome
          bodyPadding={isMobile ? "2" : "4"}
          header={
            <Box style={{ minWidth: 0 }}>
              <Heading size={isMobile ? "3" : "4"} truncate>
                gad Browser
              </Heading>
              <Text color="gray" size="2" truncate as="div">
                {selectedBranch ? asText(selectedBranch["name"]) : "Workspace provenance"}
              </Text>
            </Box>
          }
          // On narrow viewports the actions move into the body (a wrapping row)
          // so the chrome header stays a calm title strip and nothing overflows.
          headerActions={isMobile ? undefined : actionButtons}
        >
          <Flex direction="column" gap="3" style={{ height: "100%", minHeight: 0 }}>
            {isMobile ? (
              <Flex align="center" gap="2" wrap="wrap" justify="end" style={{ flexShrink: 0 }}>
                {actionButtons}
              </Flex>
            ) : null}
            {diffTarget ? (
              <DiffTargetBanner
                target={diffTarget}
                filterActive={focusActive}
                onToggleFilter={() => setFocusActive((active) => !active)}
              />
            ) : null}
            <Grid
              columns={{ initial: "1", md: "260px 1fr" }}
              gap="3"
              style={{ minHeight: 0, flex: 1 }}
            >
              <ScrollArea
                type="auto"
                scrollbars={isMobile ? "horizontal" : "vertical"}
                style={{ maxHeight: isMobile ? 112 : undefined }}
              >
                <Flex direction="column" gap="2" pr="2">
                  {branches.map((branch) => {
                    const id = asText(branch["branch_id"]);
                    return (
                      <Button
                        key={id}
                        variant={id === selectedBranchId ? "solid" : "soft"}
                        color={id === selectedBranchId ? "blue" : "gray"}
                        onClick={() => setSelectedBranchId(id)}
                        style={{ justifyContent: "flex-start" }}
                      >
                        {asText(branch["name"] || branch["branch_id"])}
                      </Button>
                    );
                  })}
                </Flex>
              </ScrollArea>

              <Tabs.Root
                value={activeTab}
                onValueChange={setActiveTab}
                style={{ minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}
              >
                <Tabs.List
                  style={{
                    overflowX: isMobile ? "hidden" : "auto",
                    flexWrap: isMobile ? "wrap" : "nowrap",
                  }}
                >
                  {diffTarget ? <Tabs.Trigger value="compare">Compare</Tabs.Trigger> : null}
                  <Tabs.Trigger value="branches">Branches</Tabs.Trigger>
                  <Tabs.Trigger value="events">
                    {isMobile ? "Events" : "Trajectory Events"}
                  </Tabs.Trigger>
                  <Tabs.Trigger value="envelopes">
                    {isMobile ? "Envelopes" : "Channel Envelopes"}
                  </Tabs.Trigger>
                  <Tabs.Trigger value="files">Files</Tabs.Trigger>
                  <Tabs.Trigger value="git">Git</Tabs.Trigger>
                  <Tabs.Trigger value="invocations">Invocations</Tabs.Trigger>
                  <Tabs.Trigger value="governance">Governance</Tabs.Trigger>
                  <Tabs.Trigger value="integrity">Integrity</Tabs.Trigger>
                  <Tabs.Trigger value="status">Status</Tabs.Trigger>
                </Tabs.List>
                <Box pt="3" style={{ flex: 1, minHeight: 0 }}>
                  <ScrollArea type="auto" scrollbars="both" style={{ height: "100%" }}>
                    {diffTarget && compareEntry ? (
                      <Tabs.Content value="compare">
                        <CompareView
                          target={diffTarget}
                          entry={compareEntry}
                          fetchContent={fetchContent}
                          appearance={highlightAppearance}
                          oldLocation={oldLocation}
                          newLocation={newLocation}
                          onGoToBranch={goToBranch}
                        />
                      </Tabs.Content>
                    ) : null}
                    <Tabs.Content value="branches">
                      <DataTable
                        rows={branches}
                        columns={[
                          "trajectory_id",
                          "branch_id",
                          "head_event_id",
                          "head_event_hash",
                          "head_state_hash",
                          "updated_at",
                        ]}
                      />
                    </Tabs.Content>
                    <Tabs.Content value="events">
                      <DataTable
                        rows={events}
                        columns={[
                          "seq",
                          "eventId",
                          "eventHash",
                          "prevEventHash",
                          "kind",
                          "turnId",
                          "createdAt",
                        ]}
                      />
                    </Tabs.Content>
                    <Tabs.Content value="envelopes">
                      <DataTable
                        rows={envelopes}
                        columns={[
                          "channel_id",
                          "seq",
                          "envelope_id",
                          "payload_kind",
                          "published_at",
                        ]}
                      />
                    </Tabs.Content>
                    <Tabs.Content value="files">
                      {diffTarget && focusActive && visibleFiles.length === 0 ? (
                        <Text color="gray" size="2">
                          No file matching “{diffTarget.path}” on this branch. It may live on a
                          different branch — clear the filter above to browse all files.
                        </Text>
                      ) : (
                        <DataTable
                          rows={visibleFiles}
                          columns={["path", "content_hash", "mode", "file_version_id"]}
                        />
                      )}
                    </Tabs.Content>
                    <Tabs.Content value="git">
                      <GitTab
                        rows={gitRows}
                        loading={gitLoading}
                        pendingRepo={gitPendingRepo}
                        pullPreview={gitPullPreview}
                        onRefresh={() => void refreshGitStatus(true, true)}
                        onPush={pushGit}
                        onForcePush={forcePushGit}
                        onPullPreview={previewPullGit}
                        onConfirmPull={confirmPullGit}
                        onCancelPull={() => setGitPullPreview(null)}
                        onToggleAutoPush={toggleAutoPush}
                        onDetach={detachUpstream}
                        onViewDiff={viewGitDiff}
                      />
                    </Tabs.Content>
                    <Tabs.Content value="invocations">
                      <DataTable
                        rows={invocations}
                        columns={[
                          "invocation_id",
                          "kind",
                          "status",
                          "started_event_id",
                          "completed_event_id",
                          "updated_at",
                        ]}
                      />
                    </Tabs.Content>
                    <Tabs.Content value="governance">
                      <GovernanceTab
                        approvals={govApprovals}
                        hostRecords={hostGovernance}
                        loading={govLoading}
                        loaded={govLoaded}
                        gadError={govGadError}
                        hostError={govHostError}
                        onRefresh={() => void loadGovernance()}
                      />
                    </Tabs.Content>
                    <Tabs.Content value="integrity">
                      <DataTable
                        rows={integrity}
                        columns={[
                          "type",
                          "message",
                          "entryId",
                          "eventId",
                          "stateHash",
                          "manifestRootHash",
                        ]}
                      />
                    </Tabs.Content>
                    <Tabs.Content value="status">
                      <DataTable rows={status} columns={["metric", "value"]} />
                    </Tabs.Content>
                  </ScrollArea>
                </Box>
              </Tabs.Root>
            </Grid>
          </Flex>
        </PanelChrome>
      </Box>
    </Theme>
  );
}

const rootElement = document.getElementById("root");
if (rootElement) {
  createRoot(rootElement).render(<App />);
}
