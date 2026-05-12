import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Box, Button, Flex, Grid, Heading, ScrollArea, Table, Tabs, Text, Theme } from "@radix-ui/themes";
import { ReloadIcon } from "@radix-ui/react-icons";
import { gad, useStateArgs } from "@workspace/runtime";
import { usePanelTheme } from "@workspace/react";

interface StateArgs {
  branchId?: string;
}

type Row = Record<string, unknown>;

function asText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function DataTable({ rows, columns }: { rows: Row[]; columns: string[] }) {
  if (rows.length === 0) {
    return <Text color="gray" size="2">No rows</Text>;
  }
  return (
    <Table.Root size="1" variant="surface">
      <Table.Header>
        <Table.Row>
          {columns.map((column) => <Table.ColumnHeaderCell key={column}>{column}</Table.ColumnHeaderCell>)}
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

function App() {
  const appearance = usePanelTheme();
  const stateArgs = useStateArgs<StateArgs>();
  const [branches, setBranches] = useState<Row[]>([]);
  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(stateArgs.branchId ?? null);
  const [files, setFiles] = useState<Row[]>([]);
  const [snapshots, setSnapshots] = useState<Row[]>([]);
  const [plans, setPlans] = useState<Row[]>([]);
  const [chunks, setChunks] = useState<Row[]>([]);
  const [status, setStatus] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const selectedBranch = useMemo(
    () => branches.find((branch) => asText(branch["id"]) === selectedBranchId) ?? null,
    [branches, selectedBranchId],
  );

  async function refresh() {
    setLoading(true);
    try {
      const [nextStatus, nextBranches, nextPlans, nextChunks] = await Promise.all([
        gad.status(),
        gad.listBranches(),
        gad.listPlans({ activeOnly: true }),
        gad.listChunks(),
      ]);
      setStatus(nextStatus as unknown as Row[]);
      setBranches(nextBranches);
      setPlans(nextPlans.slice(0, 100));
      setChunks(nextChunks.slice(0, 100));
      const branchId = (selectedBranchId ?? asText(nextBranches[0]?.["id"])) || null;
      setSelectedBranchId(branchId);
      if (branchId) {
        const [nextFiles, nextSnapshots] = await Promise.all([
          gad.listBranchFiles(branchId),
          gad.listBranchSnapshots(branchId),
        ]);
        setFiles(nextFiles);
        setSnapshots(nextSnapshots);
      } else {
        setFiles([]);
        setSnapshots([]);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!selectedBranchId) return;
    void Promise.all([
      gad.listBranchFiles(selectedBranchId).then(setFiles),
      gad.listBranchSnapshots(selectedBranchId).then(setSnapshots),
    ]);
  }, [selectedBranchId]);

  return (
    <Theme appearance={appearance}>
      <Box p="4" style={{ height: "100vh", boxSizing: "border-box" }}>
        <Flex direction="column" gap="3" height="100%">
          <Flex align="center" justify="between" gap="3">
            <Box>
              <Heading size="4">gad Browser</Heading>
              <Text color="gray" size="2">{selectedBranch ? asText(selectedBranch["name"]) : "Workspace provenance"}</Text>
            </Box>
            <Button size="2" variant="soft" onClick={() => void refresh()} disabled={loading} title="Refresh">
              <ReloadIcon /> Refresh
            </Button>
          </Flex>

          <Grid columns={{ initial: "1", md: "260px 1fr" }} gap="3" style={{ minHeight: 0, flex: 1 }}>
            <ScrollArea type="auto" scrollbars="vertical">
              <Flex direction="column" gap="2" pr="2">
                {branches.map((branch) => {
                  const id = asText(branch["id"]);
                  return (
                    <Button
                      key={id}
                      variant={id === selectedBranchId ? "solid" : "soft"}
                      color={id === selectedBranchId ? "blue" : "gray"}
                      onClick={() => setSelectedBranchId(id)}
                      style={{ justifyContent: "flex-start" }}
                    >
                      {asText(branch["name"] || branch["id"])}
                    </Button>
                  );
                })}
              </Flex>
            </ScrollArea>

            <Tabs.Root defaultValue="files" style={{ minWidth: 0 }}>
              <Tabs.List>
                <Tabs.Trigger value="files">Files</Tabs.Trigger>
                <Tabs.Trigger value="snapshots">Snapshots</Tabs.Trigger>
                <Tabs.Trigger value="plans">Plans</Tabs.Trigger>
                <Tabs.Trigger value="chunks">Chunks</Tabs.Trigger>
                <Tabs.Trigger value="status">Status</Tabs.Trigger>
              </Tabs.List>
              <Box pt="3" style={{ height: "calc(100vh - 130px)" }}>
                <ScrollArea type="auto" scrollbars="both" style={{ height: "100%" }}>
                  <Tabs.Content value="files">
                    <DataTable rows={files} columns={["path", "current_hash", "is_deleted", "updated_at"]} />
                  </Tabs.Content>
                  <Tabs.Content value="snapshots">
                    <DataTable rows={snapshots} columns={["id", "branch_id", "parent_snapshot_id", "session_id", "turn_id", "summary", "created_at"]} />
                  </Tabs.Content>
                  <Tabs.Content value="plans">
                    <DataTable rows={plans} columns={["id", "title", "source_path", "branch_id", "session_id", "created_at", "superseded_by"]} />
                  </Tabs.Content>
                  <Tabs.Content value="chunks">
                    <DataTable rows={chunks} columns={["content_hash", "topic_label", "content", "first_seen_at"]} />
                  </Tabs.Content>
                  <Tabs.Content value="status">
                    <DataTable rows={status} columns={["metric", "value"]} />
                  </Tabs.Content>
                </ScrollArea>
              </Box>
            </Tabs.Root>
          </Grid>
        </Flex>
      </Box>
    </Theme>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
