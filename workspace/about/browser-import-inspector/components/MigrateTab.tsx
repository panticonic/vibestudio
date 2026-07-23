import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Checkbox,
  Flex,
  Grid,
  Heading,
  Spinner,
  Table,
  Text,
} from "@radix-ui/themes";
import {
  DownloadIcon,
  MagnifyingGlassIcon,
  OpenInNewWindowIcon,
  StopIcon,
} from "@radix-ui/react-icons";
import type {
  BrowserImportSelection,
  ImportedBrowserOpenTab,
  ImportJobSnapshot,
} from "@vibestudio/browser-data/client";
import type { ImportSourceSelection } from "./ImportSourceRail";
import { browserData, classifyError, DATA_TYPES, relativeTime, useAsync } from "../useBrowserData";

const TERMINAL_PHASES = new Set(["complete", "cancelled", "failed", "partial"]);

export function MigrateTab(props: { selection: ImportSourceSelection; now: number }) {
  const selectionKey = `${props.selection.host.hostId}\0${props.selection.source.sourceId}`;
  const supported = props.selection.source.supportedDataTypes;
  const [types, setTypes] = useState<Set<string>>(() => new Set(supported));
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof browserData.previewImport>> | null>(
    null
  );
  const [job, setJob] = useState<ImportJobSnapshot | null>(null);
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTypes(new Set(supported));
    setPreview(null);
    setJob(null);
    setError(null);
    setBusy(null);
  }, [selectionKey]);

  useEffect(() => {
    if (!job || TERMINAL_PHASES.has(job.phase)) return;
    const timer = setInterval(() => {
      void browserData.getImportJob(job.jobId).then((next) => {
        if (next) setJob(next);
      });
    }, 500);
    return () => clearInterval(timer);
  }, [job?.jobId, job?.phase]);

  const request = (): BrowserImportSelection => ({
    hostId: props.selection.host.hostId,
    sourceId: props.selection.source.sourceId,
    dataTypes: [...types] as BrowserImportSelection["dataTypes"],
  });

  const runPreview = async () => {
    setBusy("preview");
    setError(null);
    try {
      setPreview(await browserData.previewImport(request()));
    } catch (cause) {
      setError(classifyError(cause).message);
    } finally {
      setBusy(null);
    }
  };

  const startImport = async () => {
    setBusy("import");
    setError(null);
    try {
      const next = await browserData.startImport(request());
      setJob(next);
      setPreview(null);
    } catch (cause) {
      setError(classifyError(cause).message);
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    if (!job) return;
    await browserData.cancelImport(job.jobId);
    const next = await browserData.getImportJob(job.jobId);
    if (next) setJob(next);
  };

  return (
    <Flex direction="column" gap="4" p="4" style={{ overflowY: "auto", height: "100%" }}>
      <Card>
        <Heading size="3">{props.selection.source.displayName}</Heading>
        <Text size="2" color="gray">
          On {props.selection.host.displayName} · {props.selection.source.localDataSetCount} readable
          local data {props.selection.source.localDataSetCount === 1 ? "set" : "sets"}
        </Text>
        {props.selection.source.warnings.map((warning) => (
          <Callout.Root key={warning} color="amber" size="1" mt="2">
            <Callout.Text>{warning}</Callout.Text>
          </Callout.Root>
        ))}
      </Card>

      <Card>
        <Heading size="2" mb="2">Choose what to import</Heading>
        <Grid columns="2" gap="2">
          {DATA_TYPES.filter((item) => supported.includes(item.key as never)).map((item) => (
            <Text as="label" size="2" key={item.key}>
              <Flex gap="2" align="center">
                <Checkbox
                  checked={types.has(item.key)}
                  onCheckedChange={() =>
                    setTypes((current) => {
                      const next = new Set(current);
                      next.has(item.key) ? next.delete(item.key) : next.add(item.key);
                      return next;
                    })
                  }
                />
                {item.label}
              </Flex>
            </Text>
          ))}
        </Grid>
        <Flex gap="2" mt="3" align="center">
          <Button variant="soft" disabled={busy !== null || types.size === 0} onClick={runPreview}>
            {busy === "preview" ? <Spinner size="1" /> : <MagnifyingGlassIcon />} Review
          </Button>
          <Button disabled={busy !== null || types.size === 0} onClick={startImport}>
            {busy === "import" ? <Spinner size="1" /> : <DownloadIcon />} Import
          </Button>
          {job && !TERMINAL_PHASES.has(job.phase) && (
            <Button color="red" variant="soft" onClick={cancel}>
              <StopIcon /> Cancel
            </Button>
          )}
        </Flex>
        {error && <Callout.Root color="red" mt="3"><Callout.Text>{error}</Callout.Text></Callout.Root>}
      </Card>

      {preview && (
        <ProgressCard
          title="Review"
          job={preview.job}
          detail={`${preview.openTabCount} open tabs available · ${preview.localDataSetCount} local data sets`}
        />
      )}
      {job && <ProgressCard title="Import" job={job} />}
      <OpenTabs selection={props.selection} />
      <ImportHistory now={props.now} selectionKey={selectionKey} latest={job} />
    </Flex>
  );
}

function ProgressCard(props: { title: string; job: ImportJobSnapshot; detail?: string }) {
  return (
    <Card>
      <Flex justify="between" align="center">
        <Heading size="2">{props.title}</Heading>
        <Badge color={props.job.phase === "complete" ? "green" : props.job.phase === "failed" ? "red" : "blue"}>
          {props.job.phase}
        </Badge>
      </Flex>
      <Text size="1" color="gray">Job {props.job.jobId}</Text>
      {props.detail && <Text size="2" as="div" mt="1">{props.detail}</Text>}
      <Table.Root size="1" mt="3">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeaderCell>Category</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Processed</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Stored</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Skipped</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Errors</Table.ColumnHeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {props.job.progress.map((progress) => (
            <Table.Row key={progress.dataType}>
              <Table.RowHeaderCell>{progress.dataType}</Table.RowHeaderCell>
              <Table.Cell>{progress.itemsProcessed}</Table.Cell>
              <Table.Cell>{progress.stored}</Table.Cell>
              <Table.Cell>{progress.skipped}</Table.Cell>
              <Table.Cell>{progress.errors}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {props.job.error && <Callout.Root color="red" mt="2"><Callout.Text>{props.job.error}</Callout.Text></Callout.Root>}
      {props.job.warnings.map((warning) => (
        <Callout.Root key={warning} color="amber" mt="2"><Callout.Text>{warning}</Callout.Text></Callout.Root>
      ))}
    </Card>
  );
}

function OpenTabs(props: { selection: ImportSourceSelection }) {
  const sourceKey = `${props.selection.host.hostId}\0${props.selection.source.sourceId}`;
  const tabs = useAsync<ImportedBrowserOpenTab[]>(
    () => browserData.listOpenTabs(props.selection.host.hostId, props.selection.source.sourceId),
    [sourceKey]
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    setSelected(new Set());
    setMessage(null);
  }, [sourceKey]);

  const rows = tabs.state.data ?? [];
  const open = async () => {
    const result = await browserData.openTabsAsPanels({
      hostId: props.selection.host.hostId,
      sourceId: props.selection.source.sourceId,
      selection: [...selected],
    });
    setMessage(`Opened ${result.panelsOpened} ${result.panelsOpened === 1 ? "panel" : "panels"}.`);
  };

  return (
    <Card>
      <Flex justify="between" align="center">
        <Heading size="2">Open tabs</Heading>
        <Button size="1" variant="soft" disabled={rows.length === 0} onClick={open}>
          <OpenInNewWindowIcon /> {selected.size ? `Open ${selected.size}` : "Open all"}
        </Button>
      </Flex>
      <Text size="1" color="gray">Opening tabs is a separate action and creates ordinary panels.</Text>
      {tabs.state.status === "loading" && <Spinner size="1" />}
      {tabs.state.error && <Text color="red" size="1">{tabs.state.error}</Text>}
      <Flex direction="column" gap="1" mt="2">
        {rows.map((tab) => (
          <Text as="label" size="2" key={tab.tabId}>
            <Flex gap="2" align="center">
              <Checkbox
                checked={selected.has(tab.tabId)}
                onCheckedChange={() =>
                  setSelected((current) => {
                    const next = new Set(current);
                    next.has(tab.tabId) ? next.delete(tab.tabId) : next.add(tab.tabId);
                    return next;
                  })
                }
              />
              <Box style={{ minWidth: 0 }}>
                <Text truncate as="div">{tab.title || tab.url}</Text>
                <Text truncate as="div" size="1" color="gray">{tab.url}</Text>
              </Box>
            </Flex>
          </Text>
        ))}
      </Flex>
      {message && <Text color="green" size="1">{message}</Text>}
    </Card>
  );
}

function ImportHistory(props: { now: number; selectionKey: string; latest: ImportJobSnapshot | null }) {
  const jobs = useAsync<ImportJobSnapshot[]>(() => browserData.listImportJobs(), [props.selectionKey, props.latest?.updatedAt]);
  const visible = useMemo(() => (jobs.state.data ?? []).slice(0, 8), [jobs.state.data]);
  if (!visible.length) return null;
  return (
    <Card>
      <Heading size="2" mb="2">Import history</Heading>
      {visible.map((job) => (
        <Flex key={job.jobId} justify="between" gap="2">
          <Text size="1">{job.requestedDataTypes.join(", ")}</Text>
          <Text size="1" color="gray">{job.phase} · {relativeTime(job.finishedAt ?? job.updatedAt, props.now)}</Text>
        </Flex>
      ))}
    </Card>
  );
}
