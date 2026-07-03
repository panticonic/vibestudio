import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Box,
  Button,
  Flex,
  Grid,
  Heading,
  ScrollArea,
  Table,
  Tabs,
  Text,
  Theme,
} from "@radix-ui/themes";
import { Cross2Icon, ExternalLinkIcon, ReloadIcon } from "@radix-ui/react-icons";
import { gad } from "@workspace/runtime";
import { useIsMobile, usePaletteCommands, usePanelTheme, useStateArgs } from "@workspace/react";
import { PanelChrome } from "@workspace/ui";
import { useAppTheme } from "@workspace/ui/panel";
import "@workspace/ui/tokens.css";
import {
  describeDiffTarget,
  parseDiffTarget,
  rowMatchesDiffTarget,
  shortHash,
  type DiffTarget,
} from "./diffTarget";

interface StateArgs {
  branchId?: string;
  /** Diff-review escape-hatch target (open in gad-browser). See `diffTarget.ts`. */
  diffTarget?: unknown;
}

type Row = Record<string, unknown>;

function asText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
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

/**
 * Banner shown when the panel is deep-linked from the approval card's "open in
 * gad-browser" escape hatch. Names the repo/path and both tree states, and lets
 * the reviewer toggle the Files-tab focus filter on/off. gad-browser has no
 * side-by-side compare view, so this lands them on the file at the new state.
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
              ? "File removed at the new state · no two-state compare available yet"
              : `old ${shortHash(target.oldState)} → new ${shortHash(target.newState)} · showing the file at the new state`}
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
  const [focusActive, setFocusActive] = useState(true);
  const [activeTab, setActiveTab] = useState("files");
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
      { id: "gad-check-integrity", label: "Check integrity", section: "GAD Browser" },
      { id: "gad-validate-hashes", label: "Validate hashes", section: "GAD Browser" },
      { id: "gad-replay-events", label: "Replay events", section: "GAD Browser" },
    ],
    []
  );
  usePaletteCommands(paletteCommands, (id) => {
    if (id === "gad-refresh") void refresh();
    else if (id === "gad-check-integrity") void checkIntegrity();
    else if (id === "gad-validate-hashes") void validateHashes();
    else if (id === "gad-replay-events") void replayEvents();
  });

  useEffect(() => {
    void refresh();
  }, []);

  // A newly-arrived diff-review target re-activates the focus filter and jumps
  // to the Files tab (also handles live state-arg updates on a reused panel).
  useEffect(() => {
    if (!diffTarget) return;
    setFocusActive(true);
    setActiveTab("files");
  }, [diffTarget]);

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
                <Tabs.Trigger value="branches">Branches</Tabs.Trigger>
                <Tabs.Trigger value="events">
                  {isMobile ? "Events" : "Trajectory Events"}
                </Tabs.Trigger>
                <Tabs.Trigger value="envelopes">
                  {isMobile ? "Envelopes" : "Channel Envelopes"}
                </Tabs.Trigger>
                <Tabs.Trigger value="files">Files</Tabs.Trigger>
                <Tabs.Trigger value="invocations">Invocations</Tabs.Trigger>
                <Tabs.Trigger value="integrity">Integrity</Tabs.Trigger>
                <Tabs.Trigger value="status">Status</Tabs.Trigger>
              </Tabs.List>
              <Box pt="3" style={{ flex: 1, minHeight: 0 }}>
                <ScrollArea type="auto" scrollbars="both" style={{ height: "100%" }}>
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
                      columns={["channel_id", "seq", "envelope_id", "payload_kind", "published_at"]}
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
