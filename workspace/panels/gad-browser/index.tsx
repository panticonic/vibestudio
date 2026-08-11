import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import {
  Box,
  Badge,
  Button,
  Callout,
  DropdownMenu,
  Flex,
  Grid,
  Heading,
  IconButton,
  ScrollArea,
  Spinner,
  Switch,
  Table,
  Tabs,
  Text,
  TextField,
  Tooltip,
  Theme,
} from "@radix-ui/themes";
import {
  ActivityLogIcon,
  CheckCircledIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Cross2Icon,
  DotsHorizontalIcon,
  DownloadIcon,
  ExclamationTriangleIcon,
  ExternalLinkIcon,
  FileIcon,
  GearIcon,
  LightningBoltIcon,
  MagnifyingGlassIcon,
  ReloadIcon,
  TrashIcon,
  UploadIcon,
} from "@radix-ui/react-icons";
import {
  blobstore,
  contextId,
  gad,
  git,
  rpc,
  vcs,
  workspace,
  type VcsSemanticNodeRef,
  type VcsStateNodeRef,
} from "@workspace/runtime";
import type {
  GitPullUpstreamResult,
  GitUpstreamState,
  GitUpstreamStatusRow,
} from "@vibestudio/service-schemas/gitInterop";
import { formatRelativeTime } from "@vibestudio/git/formatting";
import {
  useIsMobile,
  usePaletteCommands,
  usePanelTheme,
  usePanelThemeConfig,
  useStateArgs,
} from "@workspace/react";
import { DiffViewer, type DiffContentFetcher, type DiffReviewEntry } from "@workspace/ui/diff";
import { PanelChrome } from "@workspace/ui/layout";
import "@workspace/ui/foundation.css";
import "@workspace/ui/themes/vibestudio.css";
import {
  buildCompareEntry,
  describeDiffTarget,
  parseDiffTarget,
  rowMatchesDiffTarget,
  shortHash,
  type DiffTarget,
} from "./diffTarget";

interface StateArgs {
  branchId?: string;
  gitRepo?: string;
  /** Diff-review escape-hatch target (open in gad-browser). See `diffTarget.ts`. */
  diffTarget?: unknown;
}

type Row = Record<string, unknown>;

async function listSemanticFiles(state: VcsStateNodeRef): Promise<Row[]> {
  const repositoryRefs = new Map<string, Extract<VcsSemanticNodeRef, { kind: "repository" }>>();
  let cursor: string | undefined;
  do {
    const page = await vcs.neighbors({ root: state, limit: 500, ...(cursor ? { cursor } : {}) });
    for (const edge of page.edges) {
      if (edge.kind !== "contains-repository") continue;
      for (const node of [edge.from, edge.to]) {
        if (node.kind === "repository") repositoryRefs.set(node.repositoryId, node);
      }
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  const repositories = await Promise.all(
    [...repositoryRefs.values()].map(async (node) => {
      const inspected = await vcs.inspect({ node, edgeLimit: 1 });
      return inspected.node.kind === "repository" && inspected.node.value.kind === "present"
        ? inspected.node.value
        : null;
    })
  );

  const rows: Row[] = [];
  for (const repository of repositories) {
    if (!repository) continue;
    cursor = undefined;
    do {
      const page = await vcs.listFiles({
        state,
        repositoryId: repository.repositoryId,
        limit: 500,
        ...(cursor ? { cursor } : {}),
      });
      rows.push(
        ...page.files.map((file) => ({
          repositoryId: repository.repositoryId,
          repoPath: repository.repoPath,
          ...file,
        }))
      );
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }
  return rows;
}
type GitStatusRow = GitUpstreamStatusRow;
type GitPullPreview = GitPullUpstreamResult;

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

function formatBytes(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (value < 1_000) return `${value} B`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} KB`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)} MB`;
}

function splitFilePath(path: string): { directory: string; name: string } {
  const slash = path.lastIndexOf("/");
  return slash < 0
    ? { directory: "", name: path }
    : { directory: path.slice(0, slash), name: path.slice(slash + 1) };
}

function shortId(value: unknown): string {
  const text = asText(value);
  if (!text) return "—";
  const suffix = text.includes(":") ? text.slice(text.lastIndexOf(":") + 1) : text;
  return suffix.length > 10 ? suffix.slice(0, 10) : suffix;
}

function humanize(value: unknown, fallback: string): string {
  const text = asText(value).trim();
  if (!text) return fallback;
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLocaleLowerCase();
  return words.charAt(0).toLocaleUpperCase() + words.slice(1);
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <Flex
      align="center"
      justify="center"
      direction="column"
      gap="2"
      style={{ minHeight: 180, color: "var(--gray-10)", textAlign: "center" }}
    >
      <FileIcon width="24" height="24" />
      <Text size="2" color="gray">
        {children}
      </Text>
    </Flex>
  );
}

function InitialLoadingState() {
  return (
    <Flex
      align="center"
      justify="center"
      direction="column"
      gap="3"
      role="status"
      aria-live="polite"
      style={{ minHeight: 320 }}
    >
      <Spinner size="3" />
      <Flex direction="column" gap="1" align="center">
        <Text size="3" weight="medium">
          Loading workspace history…
        </Text>
        <Text size="2" color="gray">
          Reading repositories, files, and agent activity
        </Text>
      </Flex>
    </Flex>
  );
}

function SummaryCard({ value, label, detail }: { value: number; label: string; detail: string }) {
  return (
    <Box
      style={{
        border: "1px solid var(--gray-a5)",
        borderRadius: 8,
        background: "var(--gray-a2)",
        padding: "14px 16px",
      }}
    >
      <Text size="6" weight="bold" as="div">
        {value.toLocaleString()}
      </Text>
      <Text size="2" weight="medium" as="div">
        {label}
      </Text>
      <Text size="1" color="gray" as="div" mt="1">
        {detail}
      </Text>
    </Box>
  );
}

function OverviewTab({
  branches,
  files,
  events,
  invocations,
  onNavigate,
}: {
  branches: Row[];
  files: Row[];
  events: Row[];
  invocations: Row[];
  onNavigate: (tab: string) => void;
}) {
  const repositories = new Set(files.map((row) => asText(row["repoPath"]))).size;
  return (
    <Flex direction="column" gap="5" style={{ maxWidth: 960 }}>
      <Flex direction="column" gap="1">
        <Heading size="5">Workspace history</Heading>
        <Text size="2" color="gray">
          See what is in the workspace, how agents changed it, and whether its recorded history is
          healthy.
        </Text>
      </Flex>
      <Grid columns={{ initial: "2", md: "4" }} gap="3">
        <SummaryCard value={repositories} label="Repositories" detail="Tracked in this workspace" />
        <SummaryCard value={files.length} label="Files" detail="In the current workspace state" />
        <SummaryCard
          value={branches.length}
          label="Conversations"
          detail="Recorded agent branches"
        />
        <SummaryCard
          value={events.length}
          label="Recent events"
          detail="On the selected conversation"
        />
      </Grid>
      <Grid columns={{ initial: "1", md: "2" }} gap="3">
        <Button
          variant="soft"
          color="gray"
          size="3"
          onClick={() => onNavigate("files")}
          style={{ height: "auto", padding: 16, justifyContent: "flex-start" }}
        >
          <FileIcon />
          <Flex direction="column" align="start">
            <Text weight="medium">Browse workspace files</Text>
            <Text size="1" color="gray">
              Find files by repository, folder, or name
            </Text>
          </Flex>
        </Button>
        <Button
          variant="soft"
          color="gray"
          size="3"
          onClick={() => onNavigate("activity")}
          style={{ height: "auto", padding: 16, justifyContent: "flex-start" }}
        >
          <ActivityLogIcon />
          <Flex direction="column" align="start">
            <Text weight="medium">Review agent activity</Text>
            <Text size="1" color="gray">
              {invocations.length} recorded agent run{invocations.length === 1 ? "" : "s"}
            </Text>
          </Flex>
        </Button>
      </Grid>
    </Flex>
  );
}

function WorkspaceFilesTab({
  rows,
  loading,
  focusedPath,
}: {
  rows: Row[];
  loading: boolean;
  focusedPath?: string;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<Row | null>(null);
  const matchingRows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle
      ? rows.filter((row) =>
          `${asText(row["repoPath"])} ${asText(row["path"])}`.toLocaleLowerCase().includes(needle)
        )
      : rows;
  }, [query, rows]);
  const repositories = useMemo(() => {
    const grouped = new Map<string, Row[]>();
    for (const row of matchingRows) {
      const repo = asText(row["repoPath"]) || "Workspace root";
      const current = grouped.get(repo);
      if (current) current.push(row);
      else grouped.set(repo, [row]);
    }
    return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [matchingRows]);

  if (loading && rows.length === 0) return <InitialLoadingState />;
  return (
    <Flex direction="column" gap="3" style={{ minWidth: 0 }}>
      <Flex align="center" justify="between" gap="3" wrap="wrap">
        <Flex direction="column" gap="1">
          <Heading size="4">Workspace files</Heading>
          <Text size="2" color="gray">
            {rows.length.toLocaleString()} file{rows.length === 1 ? "" : "s"} across{" "}
            {new Set(rows.map((row) => asText(row["repoPath"]))).size} repositories
          </Text>
        </Flex>
        <TextField.Root
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search files…"
          aria-label="Search workspace files"
          style={{ width: "min(320px, 100%)" }}
        >
          <TextField.Slot>
            <MagnifyingGlassIcon />
          </TextField.Slot>
          {query ? (
            <TextField.Slot side="right">
              <IconButton
                size="1"
                variant="ghost"
                color="gray"
                aria-label="Clear search"
                onClick={() => setQuery("")}
              >
                <Cross2Icon />
              </IconButton>
            </TextField.Slot>
          ) : null}
        </TextField.Root>
      </Flex>
      {focusedPath && rows.length === 0 ? (
        <EmptyState>
          No current file matches “{focusedPath}”. Clear the focus filter above.
        </EmptyState>
      ) : matchingRows.length === 0 ? (
        <EmptyState>
          {query ? `No files match “${query}”.` : "This workspace has no files."}
        </EmptyState>
      ) : (
        <Grid
          columns={{
            initial: "1",
            md: selectedFile ? "minmax(360px, 1fr) minmax(320px, 0.8fr)" : "1",
          }}
          gap="4"
        >
          <Flex direction="column" gap="4" style={{ minWidth: 0 }}>
            {repositories.map(([repo, repoRows]) => (
              <Box key={repo} style={{ minWidth: 0 }}>
                <Flex align="center" gap="2" mb="2">
                  <Heading size="2" style={{ fontFamily: "var(--code-font-family, monospace)" }}>
                    {repo}
                  </Heading>
                  <Badge color="gray" variant="soft">
                    {repoRows.length}
                  </Badge>
                </Flex>
                <Table.Root size="1" variant="surface">
                  <Table.Header>
                    <Table.Row>
                      <Table.ColumnHeaderCell>File</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell style={{ width: 90 }}>Size</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell style={{ width: 44 }} aria-label="Details" />
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {repoRows.map((row) => {
                      const path = asText(row["path"]);
                      const { name, directory } = splitFilePath(path);
                      const key = `${asText(row["repositoryId"])}:${path}`;
                      const isExpanded = expanded.has(key);
                      return (
                        <Table.Row
                          key={key}
                          style={{
                            background: selectedFile === row ? "var(--accent-a3)" : undefined,
                          }}
                        >
                          <Table.Cell>
                            <button
                              type="button"
                              onClick={() => setSelectedFile(row)}
                              aria-label={`Preview ${path}`}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                                width: "100%",
                                padding: 0,
                                border: 0,
                                background: "transparent",
                                color: "inherit",
                                textAlign: "left",
                                cursor: "pointer",
                                minWidth: 0,
                              }}
                            >
                              <FileIcon style={{ flexShrink: 0, color: "var(--gray-9)" }} />
                              <Flex direction="column" style={{ minWidth: 0 }}>
                                <Text size="2" weight="medium" truncate>
                                  {name || path}
                                </Text>
                                {directory ? (
                                  <Text size="1" color="gray" truncate>
                                    {directory}
                                  </Text>
                                ) : null}
                                {isExpanded ? (
                                  <Text
                                    size="1"
                                    color="gray"
                                    style={{ fontFamily: "monospace", overflowWrap: "anywhere" }}
                                  >
                                    content {shortId(row["contentHash"])} · mode{" "}
                                    {asText(row["mode"]) || "—"}
                                    {row["binary"] === true ? " · binary" : ""}
                                  </Text>
                                ) : null}
                              </Flex>
                            </button>
                          </Table.Cell>
                          <Table.Cell>
                            <Text size="1" color="gray" style={{ whiteSpace: "nowrap" }}>
                              {formatBytes(row["size"])}
                            </Text>
                          </Table.Cell>
                          <Table.Cell>
                            <IconButton
                              size="1"
                              variant="ghost"
                              color="gray"
                              aria-label={`${isExpanded ? "Hide" : "Show"} details for ${path}`}
                              onClick={() =>
                                setExpanded((current) => {
                                  const next = new Set(current);
                                  if (next.has(key)) next.delete(key);
                                  else next.add(key);
                                  return next;
                                })
                              }
                            >
                              {isExpanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
                            </IconButton>
                          </Table.Cell>
                        </Table.Row>
                      );
                    })}
                  </Table.Body>
                </Table.Root>
              </Box>
            ))}
          </Flex>
          {selectedFile ? (
            <FilePreview row={selectedFile} onClose={() => setSelectedFile(null)} />
          ) : null}
        </Grid>
      )}
    </Flex>
  );
}

function FilePreview({ row, onClose }: { row: Row; onClose: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const path = asText(row["path"]);
  const hash = asText(row["contentHash"]);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setContentError(null);
    if (row["binary"] === true)
      return () => {
        cancelled = true;
      };
    if (typeof row["size"] === "number" && row["size"] > 1_000_000) {
      setContentError("This file is too large to preview here.");
      return () => {
        cancelled = true;
      };
    }
    if (!hash) {
      setContentError("This file has no readable content reference.");
      return () => {
        cancelled = true;
      };
    }
    setContentLoading(true);
    void blobstore
      .getText(hash)
      .then((text) => {
        if (cancelled) return;
        if (text == null) setContentError("The stored content is unavailable.");
        else setContent(text);
      })
      .catch((error) => {
        if (!cancelled) setContentError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setContentLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hash, row]);

  return (
    <Box
      style={{
        minWidth: 0,
        alignSelf: "start",
        position: "sticky",
        top: 0,
        border: "1px solid var(--gray-a5)",
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      <Flex align="center" justify="between" gap="2" p="3" style={{ background: "var(--gray-a2)" }}>
        <Flex direction="column" style={{ minWidth: 0 }}>
          <Text size="2" weight="medium" truncate>
            {splitFilePath(path).name || path}
          </Text>
          <Text size="1" color="gray" truncate>
            {asText(row["repoPath"])} · {path}
          </Text>
        </Flex>
        <IconButton
          size="1"
          variant="ghost"
          color="gray"
          aria-label="Close file preview"
          onClick={onClose}
        >
          <Cross2Icon />
        </IconButton>
      </Flex>
      <Box style={{ maxHeight: "min(65vh, 720px)", overflow: "auto", background: "var(--gray-1)" }}>
        {contentLoading ? (
          <Flex align="center" justify="center" gap="2" p="6" role="status">
            <Spinner />
            <Text size="2" color="gray">
              Loading file…
            </Text>
          </Flex>
        ) : row["binary"] === true ? (
          <EmptyState>Binary preview is not available.</EmptyState>
        ) : contentError ? (
          <Callout.Root size="1" color="red" m="3">
            <Callout.Icon>
              <ExclamationTriangleIcon />
            </Callout.Icon>
            <Callout.Text>{contentError}</Callout.Text>
          </Callout.Root>
        ) : (
          <pre
            style={{
              margin: 0,
              padding: 16,
              fontFamily: "var(--code-font-family, monospace)",
              fontSize: "var(--font-size-1)",
              color: "var(--gray-12)",
              lineHeight: 1.55,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {content ?? ""}
          </pre>
        )}
      </Box>
    </Box>
  );
}

function ActivityTab({
  branches,
  selectedBranchId,
  onSelectBranch,
  events,
  invocations,
  envelopes,
}: {
  branches: Row[];
  selectedBranchId: string | null;
  onSelectBranch: (id: string) => void;
  events: Row[];
  invocations: Row[];
  envelopes: Row[];
}) {
  const [section, setSection] = useState("events");
  return (
    <Flex direction="column" gap="4" style={{ minWidth: 0 }}>
      <Flex direction="column" gap="1">
        <Heading size="4">Agent activity</Heading>
        <Text size="2" color="gray">
          Follow what happened in a conversation without reading the underlying provenance records.
        </Text>
      </Flex>
      {branches.length === 0 ? (
        <EmptyState>No agent conversations have been recorded yet.</EmptyState>
      ) : (
        <>
          <Box>
            <Text
              size="1"
              weight="bold"
              color="gray"
              as="div"
              mb="2"
              style={{ letterSpacing: "0.06em" }}
            >
              CONVERSATION
            </Text>
            <ScrollArea type="auto" scrollbars="horizontal">
              <Flex gap="2" pb="2">
                {branches.map((branch) => {
                  const id = asText(branch["branch_id"]);
                  return (
                    <Button
                      key={id}
                      size="1"
                      variant={id === selectedBranchId ? "solid" : "soft"}
                      color={id === selectedBranchId ? undefined : "gray"}
                      onClick={() => onSelectBranch(id)}
                      style={{ flexShrink: 0 }}
                    >
                      {asText(branch["name"]) || `Conversation ${shortId(id)}`}
                    </Button>
                  );
                })}
              </Flex>
            </ScrollArea>
          </Box>
          <Tabs.Root value={section} onValueChange={setSection}>
            <Tabs.List>
              <Tabs.Trigger value="events">Timeline ({events.length})</Tabs.Trigger>
              <Tabs.Trigger value="runs">Agent runs ({invocations.length})</Tabs.Trigger>
              <Tabs.Trigger value="messages">Workspace messages ({envelopes.length})</Tabs.Trigger>
            </Tabs.List>
            <Box pt="3">
              <Tabs.Content value="events">
                {events.length === 0 ? (
                  <EmptyState>No activity in this conversation.</EmptyState>
                ) : (
                  <Table.Root size="1" variant="surface">
                    <Table.Header>
                      <Table.Row>
                        <Table.ColumnHeaderCell>Event</Table.ColumnHeaderCell>
                        <Table.ColumnHeaderCell>Turn</Table.ColumnHeaderCell>
                        <Table.ColumnHeaderCell>When</Table.ColumnHeaderCell>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {events.map((row, index) => (
                        <Table.Row key={asText(row["eventId"]) || index}>
                          <Table.Cell>
                            <Flex align="center" gap="2">
                              <ActivityLogIcon color="var(--gray-9)" />
                              <Text size="2" weight="medium">
                                {humanize(row["kind"], "Activity")}
                              </Text>
                            </Flex>
                          </Table.Cell>
                          <Table.Cell>
                            <Text size="1" color="gray">
                              {shortId(row["turnId"])}
                            </Text>
                          </Table.Cell>
                          <Table.Cell>
                            <Text size="1" color="gray" style={{ whiteSpace: "nowrap" }}>
                              {formatWhen(row["createdAt"])}
                            </Text>
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table.Root>
                )}
              </Tabs.Content>
              <Tabs.Content value="runs">
                {invocations.length === 0 ? (
                  <EmptyState>No agent runs in this conversation.</EmptyState>
                ) : (
                  <Table.Root size="1" variant="surface">
                    <Table.Header>
                      <Table.Row>
                        <Table.ColumnHeaderCell>Run</Table.ColumnHeaderCell>
                        <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
                        <Table.ColumnHeaderCell>Updated</Table.ColumnHeaderCell>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {invocations.map((row, index) => (
                        <Table.Row key={asText(row["invocation_id"]) || index}>
                          <Table.Cell>
                            <Text size="2" weight="medium">
                              {humanize(row["kind"], "Agent run")}
                            </Text>
                          </Table.Cell>
                          <Table.Cell>
                            <Badge color={asText(row["status"]) === "completed" ? "green" : "gray"}>
                              {humanize(row["status"], "Unknown")}
                            </Badge>
                          </Table.Cell>
                          <Table.Cell>
                            <Text size="1" color="gray" style={{ whiteSpace: "nowrap" }}>
                              {formatWhen(row["updated_at"])}
                            </Text>
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table.Root>
                )}
              </Tabs.Content>
              <Tabs.Content value="messages">
                {envelopes.length === 0 ? (
                  <EmptyState>No messages have been published in this workspace.</EmptyState>
                ) : (
                  <Table.Root size="1" variant="surface">
                    <Table.Header>
                      <Table.Row>
                        <Table.ColumnHeaderCell>Message</Table.ColumnHeaderCell>
                        <Table.ColumnHeaderCell>Channel</Table.ColumnHeaderCell>
                        <Table.ColumnHeaderCell>Published</Table.ColumnHeaderCell>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {envelopes.map((row, index) => (
                        <Table.Row key={asText(row["envelope_id"]) || index}>
                          <Table.Cell>
                            <Text size="2" weight="medium">
                              {humanize(row["payload_kind"], "Message")}
                            </Text>
                          </Table.Cell>
                          <Table.Cell>
                            <Text size="1" color="gray">
                              {shortId(row["channel_id"])}
                            </Text>
                          </Table.Cell>
                          <Table.Cell>
                            <Text size="1" color="gray" style={{ whiteSpace: "nowrap" }}>
                              {formatWhen(row["published_at"])}
                            </Text>
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table.Root>
                )}
              </Tabs.Content>
            </Box>
          </Tabs.Root>
        </>
      )}
    </Flex>
  );
}

function DiagnosticsTab({
  status,
  integrity,
  loading,
  onCheckIntegrity,
  onValidateHashes,
  onReplay,
}: {
  status: Row[];
  integrity: Row[];
  loading: boolean;
  onCheckIntegrity: () => void;
  onValidateHashes: () => void;
  onReplay: () => void;
}) {
  return (
    <Flex direction="column" gap="5" style={{ maxWidth: 960 }}>
      <Flex direction="column" gap="1">
        <Heading size="4">Workspace health</Heading>
        <Text size="2" color="gray">
          Verify recorded history when something looks wrong. These checks do not change workspace
          content.
        </Text>
      </Flex>
      <Flex align="center" gap="2" wrap="wrap">
        <Button size="2" variant="soft" onClick={onCheckIntegrity} disabled={loading}>
          <CheckCircledIcon /> Check history
        </Button>
        <Button size="2" variant="soft" color="gray" onClick={onValidateHashes} disabled={loading}>
          Validate stored data
        </Button>
      </Flex>
      {integrity.length === 0 ? (
        <Callout.Root size="1" color="gray">
          <Callout.Icon>
            <CheckCircledIcon />
          </Callout.Icon>
          <Callout.Text>
            Run a check to verify that workspace history is complete and internally consistent.
          </Callout.Text>
        </Callout.Root>
      ) : (
        <Callout.Root size="1" color="red">
          <Callout.Icon>
            <ExclamationTriangleIcon />
          </Callout.Icon>
          <Callout.Text>
            {integrity.length} issue{integrity.length === 1 ? "" : "s"} found. Expand the technical
            details below for the recorded identifiers.
          </Callout.Text>
        </Callout.Root>
      )}
      {integrity.length > 0 ? (
        <DataTable
          rows={integrity}
          columns={["type", "message", "entryId", "eventId", "stateHash"]}
        />
      ) : null}
      <details>
        <summary style={{ cursor: "pointer", color: "var(--gray-11)", fontSize: 13 }}>
          Technical workspace counters
        </summary>
        <Box pt="3">
          <DataTable rows={status} columns={["metric", "value"]} />
        </Box>
      </details>
      <Box
        style={{
          borderTop: "1px solid var(--gray-a5)",
          paddingTop: 20,
        }}
      >
        <Flex direction="column" gap="2" align="start">
          <Heading size="2">Repair recorded projections</Heading>
          <Text size="2" color="gray">
            Rebuild the derived activity views from canonical history. Use this only when a health
            check reports stale projections; it does not rewrite the canonical event log.
          </Text>
          <Button size="1" variant="soft" color="amber" onClick={onReplay} disabled={loading}>
            <GearIcon /> Rebuild activity views
          </Button>
        </Flex>
      </Box>
    </Flex>
  );
}

function gitStateColor(state: GitUpstreamState): ComponentProps<typeof Badge>["color"] {
  if (state === "in-sync") return "green";
  if (state === "ahead" || state === "exporting" || state === "pushing") return "blue";
  if (state === "behind" || state === "integration-required") return "amber";
  if (state === "diverged" || state === "auth-failed" || state === "error") return "red";
  return "gray";
}

function formatGitState(row: GitStatusRow): string {
  if (row.state === "ahead") return `ahead ${row.aheadBy}`;
  if (row.state === "behind") return `behind ${row.behindBy}`;
  if (row.state === "diverged") return `diverged +${row.aheadBy}/+${row.behindBy}`;
  if (row.state === "integration-required") return "integration required";
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
              const requiresIntegration = row.state === "integration-required";
              return (
                <Table.Row key={row.repoPath}>
                  <Table.Cell>
                    <Text size="1" style={{ fontFamily: "monospace", whiteSpace: "nowrap" }}>
                      {row.repoPath}
                    </Text>
                    {(row.error ?? row.lastFailureReason) ? (
                      <Text size="1" color="red" truncate as="div">
                        {row.error ?? row.lastFailureReason}
                      </Text>
                    ) : null}
                    {row.candidate ? (
                      <Text size="1" color="amber" truncate as="div">
                        Candidate {row.candidate.eventId} in {row.candidate.contextId}
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
                  <Table.Cell>{row.aheadBy ?? "-"}</Table.Cell>
                  <Table.Cell>{row.behindBy ?? "-"}</Table.Cell>
                  <Table.Cell>{formatRelativeTime(row.lastSuccessfulPushAt)}</Table.Cell>
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
                          disabled={!hasUpstream || busy || requiresIntegration}
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
                          disabled={!hasUpstream || busy || requiresIntegration}
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
                          <DropdownMenu.Item
                            disabled={!row.behindBy || busy}
                            onClick={() => onViewDiff(row.repoPath)}
                          >
                            Preview incoming changes
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
}: {
  target: DiffTarget;
  entry: DiffReviewEntry;
  fetchContent: DiffContentFetcher;
  appearance: "light" | "dark";
}) {
  return (
    <Flex direction="column" gap="3" style={{ minWidth: 0 }}>
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
          A read-only record of who approved agent actions and who changed workspace access.
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
        <Heading size="2">Agent action approvals</Heading>
        <Text size="1" color="gray">
          {approvals.length} recorded approval{approvals.length === 1 ? "" : "s"}.
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
        <Heading size="2">Workspace access &amp; approvals</Heading>
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

export function App() {
  const appearance = usePanelTheme();
  const appTheme = usePanelThemeConfig();
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
  const [activeTab, setActiveTab] = useState("overview");
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
  const [gitPollError, setGitPollError] = useState<string | null>(null);
  const [gitPendingRepo, setGitPendingRepo] = useState<string | null>(null);
  const [gitPullPreview, setGitPullPreview] = useState<{
    repoPath: string;
    preview: GitPullPreview;
  } | null>(null);
  const [operationStatus, setOperationStatus] = useState<string>("");
  const [operationFailed, setOperationFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);

  async function refresh() {
    setLoading(true);
    setOperationFailed(false);
    setOperationStatus("");
    try {
      const [nextStatus, nextBranches] = await Promise.all([
        gad.status(),
        gad.listTrajectoryBranches({ limit: 200 }),
      ]);
      const semanticStatus = await vcs.status({ contextId });
      const nextFiles = await listSemanticFiles(semanticStatus.workingHead);
      setStatus(nextStatus as unknown as Row[]);
      setBranches(nextBranches);
      setFiles(nextFiles);
      const branchId = (selectedBranchId ?? asText(nextBranches[0]?.["branch_id"])) || null;
      setSelectedBranchId(branchId);
      if (branchId) {
        const [nextEvents, nextInvocations, nextEnvelopes] = await Promise.all([
          gad.listTrajectoryEvents({ branchId, limit: 200 }),
          gad.listTrajectoryInvocations({ branchId, limit: 200 }),
          gad.listChannelEnvelopes({ limit: 200 }),
        ]);
        setEvents(nextEvents as unknown as Row[]);
        setInvocations(nextInvocations);
        setEnvelopes(nextEnvelopes);
      } else {
        setEvents([]);
        setInvocations([]);
        setEnvelopes([]);
      }
    } catch (err) {
      setOperationFailed(true);
      setOperationStatus(
        `Couldn't load repository data: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setHasLoaded(true);
      setLoading(false);
    }
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
      Promise.resolve().then(() => gad.listTrajectoryApprovals({ limit: 200 })),
      Promise.resolve()
        .then(() => workspace.getInfo())
        .then((info) => fetchHostGovernance(info.config.id)),
    ]);
    if (seq !== governanceLoadSeq.current) return;

    if (approvalsResult.status === "fulfilled") {
      setGovApprovals(approvalsResult.value);
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

  async function refreshGitStatus(showLoading = false) {
    if (showLoading) setGitLoading(true);
    try {
      const rows = await git.upstreamStatus(stateArgs.gitRepo ? [stateArgs.gitRepo] : []);
      setGitRows(rows);
    } catch (err) {
      setOperationFailed(true);
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
      setOperationFailed(false);
      setOperationStatus(success);
      window.setTimeout(
        () => setOperationStatus((current) => (current === success ? "" : current)),
        5_000
      );
      await refreshGitStatus(false);
    } catch (err) {
      setOperationFailed(true);
      setOperationStatus(`Git action failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setGitPendingRepo(null);
      setGitLoading(false);
    }
  }

  function pushGit(repoPath: string) {
    void runGitAction(repoPath, `Pushed ${repoPath}`, () => git.pushUpstream(repoPath));
  }

  function forcePushGit(repoPath: string) {
    void runGitAction(repoPath, `Force pushed ${repoPath}`, () =>
      git.pushUpstream(repoPath, { force: true })
    );
  }

  function previewPullGit(repoPath: string) {
    setGitPendingRepo(repoPath);
    setGitLoading(true);
    void git
      .pullUpstream(repoPath, { dryRun: true })
      .then((preview) => {
        setGitPullPreview({ repoPath, preview });
        setOperationFailed(false);
        setOperationStatus("");
      })
      .catch((err) => {
        setOperationFailed(true);
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
      git.pullUpstream(target.repoPath)
    );
  }

  function toggleAutoPush(repoPath: string, enabled: boolean) {
    void runGitAction(
      repoPath,
      `Auto-push ${enabled ? "enabled" : "disabled"} for ${repoPath}`,
      () => git.setAutoPush(repoPath, enabled)
    );
  }

  function detachUpstream(repoPath: string) {
    void runGitAction(repoPath, `Detached upstream for ${repoPath}`, () =>
      git.removeUpstream(repoPath)
    );
  }

  function viewGitDiff(repoPath: string) {
    const row = gitRows.find((entry) => entry.repoPath === repoPath);
    if (row?.behindBy) {
      previewPullGit(repoPath);
      return;
    }
    setOperationFailed(true);
    setOperationStatus(`No incoming changes are available to preview for ${repoPath}`);
  }

  async function checkIntegrity() {
    setLoading(true);
    try {
      const result = await gad.checkGadIntegrity({});
      setIntegrity(result.errors);
      setOperationFailed(!result.ok);
      setOperationStatus(result.ok ? "Integrity OK" : `${result.errors.length} integrity issue(s)`);
    } catch (err) {
      setOperationFailed(true);
      setOperationStatus(
        `Integrity check failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setLoading(false);
    }
  }

  async function validateHashes() {
    setLoading(true);
    try {
      const result = await gad.validateGadHashes({});
      setIntegrity(result.errors.map((message) => ({ message })));
      setOperationFailed(!result.ok);
      setOperationStatus(result.ok ? "Hashes OK" : `${result.errors.length} hash issue(s)`);
    } catch (err) {
      setOperationFailed(true);
      setOperationStatus(
        `Hash validation failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setLoading(false);
    }
  }

  async function replayEvents() {
    setLoading(true);
    try {
      const result = await gad.rebuildTrajectoryProjections({});
      setOperationFailed(false);
      setOperationStatus(`Replayed ${result.replayed} event(s)`);
      await refresh();
      await checkIntegrity();
    } catch (err) {
      setOperationFailed(true);
      setOperationStatus(`Replay failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  // Contribute GAD actions to the app-level command palette (Cmd/Ctrl+K).
  const paletteCommands = useMemo(
    () => [
      { id: "gad-refresh", label: "Refresh workspace history", section: "Workspace History" },
      { id: "gad-git-refresh", label: "Refresh repository sync", section: "Workspace History" },
      { id: "gad-check-integrity", label: "Check workspace history", section: "Workspace History" },
      { id: "gad-validate-hashes", label: "Validate stored data", section: "Workspace History" },
      { id: "gad-replay-events", label: "Rebuild activity views", section: "Workspace History" },
    ],
    []
  );
  usePaletteCommands(paletteCommands, (id) => {
    if (id === "gad-refresh") void refresh();
    else if (id === "gad-git-refresh") void refreshGitStatus(true);
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
    if (activeTab !== "access") return;
    void loadGovernance();
  }, [activeTab]);

  useEffect(() => {
    let cancelled = false;
    const load = async (showLoading = false) => {
      if (showLoading) setGitLoading(true);
      try {
        const rows = await git.upstreamStatus(stateArgs.gitRepo ? [stateArgs.gitRepo] : []);
        if (!cancelled) {
          setGitRows(rows);
          setGitPollError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setGitPollError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (showLoading && !cancelled) setGitLoading(false);
      }
    };
    void load(true);
    const timer = window.setInterval(() => void load(false), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [stateArgs.gitRepo]);

  // A newly-arrived diff-review target opens the Compare tab and re-arms the
  // semantic Files-tab focus filter. Trajectory branches do not own file trees,
  // so this never joins them to a private worktree projection.
  useEffect(() => {
    if (!diffTarget) return;
    setFocusActive(true);
    setActiveTab("compare");
  }, [diffTarget]);

  useEffect(() => {
    if (!stateArgs.gitRepo) return;
    setActiveTab("git");
  }, [stateArgs.gitRepo]);

  useEffect(() => {
    if (!selectedBranchId) return;
    void Promise.all([
      gad
        .listTrajectoryEvents({ branchId: selectedBranchId, limit: 200 })
        .then((rows) => setEvents(rows as unknown as Row[])),
      gad
        .listTrajectoryInvocations({ branchId: selectedBranchId, limit: 200 })
        .then(setInvocations),
      gad.listChannelEnvelopes({ limit: 200 }).then(setEnvelopes),
    ]).catch((err) => {
      setOperationFailed(true);
      setOperationStatus(
        `Couldn't load the selected branch: ${err instanceof Error ? err.message : String(err)}`
      );
    });
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

  const refreshButton = (
    <Button size="2" variant="soft" color="gray" onClick={() => void refresh()} disabled={loading}>
      {loading ? <Spinner /> : <ReloadIcon />} {loading ? "Refreshing…" : "Refresh"}
    </Button>
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
                Workspace History
              </Heading>
              <Text color="gray" size="2" truncate as="div">
                Files, agent activity, access, and repository sync
              </Text>
            </Box>
          }
          headerActions={isMobile ? undefined : refreshButton}
        >
          <Flex direction="column" gap="3" style={{ height: "100%", minHeight: 0 }}>
            {isMobile ? (
              <Flex align="center" gap="2" wrap="wrap" justify="end" style={{ flexShrink: 0 }}>
                {refreshButton}
              </Flex>
            ) : null}
            {operationStatus ? (
              <Callout.Root
                size="1"
                color={operationFailed ? "red" : "gray"}
                role={operationFailed ? "alert" : "status"}
              >
                <Callout.Icon>
                  {operationFailed ? <ExclamationTriangleIcon /> : <CheckCircledIcon />}
                </Callout.Icon>
                <Callout.Text>{operationStatus}</Callout.Text>
              </Callout.Root>
            ) : null}
            {diffTarget ? (
              <DiffTargetBanner
                target={diffTarget}
                filterActive={focusActive}
                onToggleFilter={() => setFocusActive((active) => !active)}
              />
            ) : null}
            {!hasLoaded && loading ? (
              <InitialLoadingState />
            ) : (
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
                  <Tabs.Trigger value="overview">Overview</Tabs.Trigger>
                  <Tabs.Trigger value="files">Files</Tabs.Trigger>
                  <Tabs.Trigger value="activity">Activity</Tabs.Trigger>
                  <Tabs.Trigger value="git">Sync</Tabs.Trigger>
                  <Tabs.Trigger value="access">Access history</Tabs.Trigger>
                  <Tabs.Trigger value="diagnostics">Diagnostics</Tabs.Trigger>
                </Tabs.List>
                <Box pt="3" style={{ flex: 1, minHeight: 0 }}>
                  <ScrollArea type="auto" scrollbars="vertical" style={{ height: "100%" }}>
                    {diffTarget && compareEntry ? (
                      <Tabs.Content value="compare">
                        <CompareView
                          target={diffTarget}
                          entry={compareEntry}
                          fetchContent={fetchContent}
                          appearance={highlightAppearance}
                        />
                      </Tabs.Content>
                    ) : null}
                    <Tabs.Content value="overview">
                      <OverviewTab
                        branches={branches}
                        files={files}
                        events={events}
                        invocations={invocations}
                        onNavigate={setActiveTab}
                      />
                    </Tabs.Content>
                    <Tabs.Content value="files">
                      <WorkspaceFilesTab
                        rows={visibleFiles}
                        loading={loading}
                        focusedPath={diffTarget && focusActive ? diffTarget.path : undefined}
                      />
                    </Tabs.Content>
                    <Tabs.Content value="activity">
                      <ActivityTab
                        branches={branches}
                        selectedBranchId={selectedBranchId}
                        onSelectBranch={setSelectedBranchId}
                        events={events}
                        invocations={invocations}
                        envelopes={envelopes}
                      />
                    </Tabs.Content>
                    <Tabs.Content value="git">
                      {gitPollError ? (
                        <Callout.Root size="1" color="red" mb="3">
                          <Callout.Icon>
                            <ExclamationTriangleIcon />
                          </Callout.Icon>
                          <Callout.Text>
                            Repository sync status is unavailable: {gitPollError}
                          </Callout.Text>
                        </Callout.Root>
                      ) : null}
                      <GitTab
                        rows={gitRows}
                        loading={gitLoading}
                        pendingRepo={gitPendingRepo}
                        pullPreview={gitPullPreview}
                        onRefresh={() => void refreshGitStatus(true)}
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
                    <Tabs.Content value="access">
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
                    <Tabs.Content value="diagnostics">
                      <DiagnosticsTab
                        status={status}
                        integrity={integrity}
                        loading={loading}
                        onCheckIntegrity={() => void checkIntegrity()}
                        onValidateHashes={() => void validateHashes()}
                        onReplay={() => void replayEvents()}
                      />
                    </Tabs.Content>
                  </ScrollArea>
                </Box>
              </Tabs.Root>
            )}
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
