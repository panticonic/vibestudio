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
  IconButton,
  Progress,
  Separator,
  Spinner,
  Text,
  TextField,
  Tooltip,
} from "@radix-ui/themes";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DownloadIcon,
  DrawingPinFilledIcon,
  MagnifyingGlassIcon,
  OpenInNewWindowIcon,
  StopIcon,
} from "@radix-ui/react-icons";
import type {
  BrowserImportSelection,
  ImportCategoryBreakdown,
  ImportedBrowserOpenTab,
  ImportJobSnapshot,
} from "@vibestudio/browser-data/client";
import type { ImportSourceSelection } from "./ImportSourceRail";
import {
  browserData,
  classifyError,
  DATA_TYPES,
  hueFor,
  initialsFor,
  plural,
  prettyHost,
  prettyPath,
  relativeTime,
  useAsync,
} from "../useBrowserData";

const TERMINAL_PHASES = new Set(["complete", "cancelled", "failed", "partial"]);

/** Transient RPC hiccups are common; a persistent failure is not. */
const POLL_FAILURES_BEFORE_GIVING_UP = 3;

/** Above this many tabs the window groups start collapsed. */
const AUTO_COLLAPSE_TABS = 25;

const PHASE_COLOR: Record<string, "green" | "red" | "amber" | "blue"> = {
  complete: "green",
  failed: "red",
  cancelled: "amber",
  partial: "amber",
};

export function MigrateTab(props: { selection: ImportSourceSelection; now: number }) {
  const selectionKey = `${props.selection.host.hostId}\0${props.selection.source.sourceId}`;
  const supported = props.selection.source.supportedDataTypes;
  const selectableTypes = useMemo(
    () => DATA_TYPES.filter((item) => supported.includes(item.key as never)),
    [supported]
  );
  const [types, setTypes] = useState<Set<string>>(() => new Set(supported));
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof browserData.previewImport>> | null>(
    null
  );
  const [job, setJob] = useState<ImportJobSnapshot | null>(null);
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("data");

  useEffect(() => {
    setTypes(new Set(supported));
    setPreview(null);
    setJob(null);
    setError(null);
    setBusy(null);
    setStep("data");
  }, [selectionKey]);

  useEffect(() => {
    if (!job || TERMINAL_PHASES.has(job.phase)) return;
    // A poll that throws must not become an unhandled rejection every 500ms.
    // Losing the extension mid-import is exactly when the panel has to stay
    // legible, so report the failure and stop asking rather than spinning.
    let consecutiveFailures = 0;
    const timer = setInterval(() => {
      void browserData
        .getImportJob(job.jobId)
        .then((next) => {
          consecutiveFailures = 0;
          if (next) setJob(next);
        })
        .catch((cause) => {
          consecutiveFailures += 1;
          if (consecutiveFailures < POLL_FAILURES_BEFORE_GIVING_UP) return;
          clearInterval(timer);
          setError(
            `Lost contact with the import while it was running: ${classifyError(cause).message}`
          );
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

  const allSelected = types.size === selectableTypes.length && selectableTypes.length > 0;
  // Whether this source has ever been imported, not merely whether it was
  // imported in this mount: the panel is routinely revisited, and a footer that
  // forgets would offer "Skip import" to someone who already imported.
  const history = useAsync<ImportJobSnapshot[]>(
    () => browserData.listImportJobs(),
    [selectionKey, job?.updatedAt]
  );
  const importedBefore = (history.state.data ?? []).some(
    (entry) =>
      entry.sourceId === props.selection.source.sourceId &&
      entry.hostId === props.selection.host.hostId &&
      (entry.phase === "complete" || entry.phase === "partial")
  );
  const imported = job?.phase === "complete" || job?.phase === "partial" || importedBefore;

  return (
    <Flex direction="column" gap="4" p="4" style={{ overflowY: "auto", height: "100%" }}>
      <SourceHeader selection={props.selection} />
      <Stepper
        step={step}
        onStep={setStep}
        dataDone={imported}
        busy={busy !== null || (job !== null && !TERMINAL_PHASES.has(job.phase))}
      />

      {step === "tabs" ? (
        <>
          <OpenTabs selection={props.selection} />
          <Flex justify="start">
            <Button variant="ghost" onClick={() => setStep("data")}>
              <ArrowLeftIcon /> Back to data
            </Button>
          </Flex>
        </>
      ) : (
        <>
      <Card style={{ flexShrink: 0 }}>
        <Flex justify="between" align="center" mb="1" gap="2">
          <Heading size="2">Choose what to import</Heading>
          <Button
            size="1"
            variant="ghost"
            onClick={() =>
              setTypes(allSelected ? new Set() : new Set(selectableTypes.map((item) => item.key)))
            }
          >
            {allSelected ? "Clear all" : "Select all"}
          </Button>
        </Flex>
        <Text size="1" color="gray" as="div" mb="3">
          Copies the data into Vibestudio's own store. Review first to see the counts without writing
          anything.
        </Text>

        <Grid columns={{ initial: "1", sm: "2", lg: "3" }} gap="2">
          {selectableTypes.map((item) => (
            <TypeTile
              key={item.key}
              label={item.label}
              hint={item.hint}
              checked={types.has(item.key)}
              onToggle={() =>
                setTypes((current) => {
                  const next = new Set(current);
                  next.has(item.key) ? next.delete(item.key) : next.add(item.key);
                  return next;
                })
              }
            />
          ))}
        </Grid>

        {types.size === 0 && (
          <Text size="1" color="gray" as="div" mt="3">
            Pick at least one category, or skip importing entirely.
          </Text>
        )}
        {error && (
          <Callout.Root color="red" mt="3">
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        )}
      </Card>

      {preview && (
        <ProgressCard
          title="Review"
          job={preview.job}
          detail={`${plural(preview.openTabCount, "open tab")} available · ${plural(
            preview.localDataSetCount,
            "local data set"
          )}`}
        />
      )}
      {preview && <BreakdownCard breakdowns={preview.breakdowns} />}
      {job && <ProgressCard title="Import" job={job} />}
      <ImportHistory now={props.now} jobs={history.state.data ?? []} />

      <DataStepFooter
        busy={busy}
        running={job !== null && !TERMINAL_PHASES.has(job.phase)}
        imported={imported}
        selectedCount={types.size}
        allSelected={allSelected}
        onReview={runPreview}
        onImport={startImport}
        onCancel={cancel}
        onContinue={() => setStep("tabs")}
      />
        </>
      )}
    </Flex>
  );
}

type Step = "data" | "tabs";

/**
 * The one action bar for step 1. Its rightmost button is always the thing that
 * moves you forward: import while there is data to copy, then — once an import
 * has finished — on to opening tabs. "Skip" is the honest exit for someone who
 * only wants tabs, rather than a "Next" that quietly abandons the import.
 */
function DataStepFooter(props: {
  busy: "preview" | "import" | null;
  running: boolean;
  imported: boolean;
  selectedCount: number;
  allSelected: boolean;
  onReview: () => void;
  onImport: () => void;
  onCancel: () => void;
  onContinue: () => void;
}) {
  const blocked = props.busy !== null || props.selectedCount === 0;
  const importLabel = props.allSelected
    ? "Import everything"
    : `Import ${plural(props.selectedCount, "category", "categories")}`;

  return (
    <Flex justify="between" align="center" gap="2" wrap="wrap" style={{ flexShrink: 0 }}>
      <Button variant="ghost" disabled={blocked} onClick={props.onReview}>
        {props.busy === "preview" ? <Spinner size="1" /> : <MagnifyingGlassIcon />} Review without
        importing
      </Button>

      <Flex align="center" gap="2">
        {props.running ? (
          <Button color="red" variant="soft" onClick={props.onCancel}>
            <StopIcon /> Cancel import
          </Button>
        ) : props.imported ? (
          <>
            <Button variant="soft" disabled={blocked} onClick={props.onImport}>
              <DownloadIcon /> Import again
            </Button>
            <Button onClick={props.onContinue}>
              Open tabs as panels <ArrowRightIcon />
            </Button>
          </>
        ) : (
          <>
            <Button variant="soft" onClick={props.onContinue}>
              Skip import <ArrowRightIcon />
            </Button>
            <Button disabled={blocked} onClick={props.onImport}>
              {props.busy === "import" ? <Spinner size="1" /> : <DownloadIcon />} {importLabel}
            </Button>
          </>
        )}
      </Flex>
    </Flex>
  );
}

function Stepper(props: {
  step: Step;
  onStep: (step: Step) => void;
  dataDone: boolean;
  busy: boolean;
}) {
  const steps: Array<{ key: Step; label: string; hint: string }> = [
    { key: "data", label: "Browser data", hint: "Cookies, passwords, history — copied into Vibestudio" },
    { key: "tabs", label: "Open tabs", hint: "Opened as panels; nothing is copied" },
  ];
  return (
    <Flex gap="2" style={{ flexShrink: 0 }}>
      {steps.map((step, index) => {
        const active = props.step === step.key;
        const done = step.key === "data" && props.dataDone && !active;
        return (
          <Card
            key={step.key}
            asChild
            style={{
              flex: 1,
              cursor: "pointer",
              outline: active ? "1px solid var(--accent-a8)" : undefined,
              background: active ? "var(--accent-a2)" : undefined,
            }}
          >
            <button type="button" onClick={() => props.onStep(step.key)} disabled={props.busy}>
              <Flex align="center" gap="2">
                <Flex
                  align="center"
                  justify="center"
                  style={{
                    width: 22,
                    height: 22,
                    flexShrink: 0,
                    borderRadius: "50%",
                    fontSize: 11,
                    fontWeight: 700,
                    background: active
                      ? "var(--accent-9)"
                      : done
                        ? "var(--green-9)"
                        : "var(--gray-a5)",
                    color: active || done ? "white" : "var(--gray-11)",
                  }}
                >
                  {done ? <CheckIcon /> : index + 1}
                </Flex>
                <Box style={{ minWidth: 0, textAlign: "left" }}>
                  <Text as="div" size="2" weight={active ? "bold" : "regular"}>
                    {step.label}
                  </Text>
                  <Text as="div" size="1" color="gray" truncate>
                    {step.hint}
                  </Text>
                </Box>
              </Flex>
            </button>
          </Card>
        );
      })}
    </Flex>
  );
}

/** Per-category drill-down: which sites/kinds an import would actually bring in. */
function BreakdownCard(props: { breakdowns: readonly ImportCategoryBreakdown[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const withItems = props.breakdowns.filter((breakdown) => breakdown.total > 0);
  if (withItems.length === 0) return null;
  return (
    <Card style={{ flexShrink: 0 }}>
      <Heading size="2">What's inside</Heading>
      <Text size="1" color="gray" as="div" mb="2">
        Counts grouped by site — expand a category to see where the data comes from.
      </Text>
      <Flex direction="column">
        {withItems.map((breakdown, index) => {
          const open = expanded.has(breakdown.dataType);
          const max = breakdown.groups[0]?.count ?? 1;
          return (
            <Box key={breakdown.dataType}>
              {index > 0 && <Separator size="4" />}
              <Flex
                asChild
                align="center"
                gap="2"
                py="2"
                style={{ cursor: "pointer", width: "100%" }}
              >
                <button
                  type="button"
                  onClick={() =>
                    setExpanded((current) => {
                      const next = new Set(current);
                      next.has(breakdown.dataType)
                        ? next.delete(breakdown.dataType)
                        : next.add(breakdown.dataType);
                      return next;
                    })
                  }
                >
                  {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
                  <Text size="2" weight="medium">
                    {labelForType(breakdown.dataType)}
                  </Text>
                  <Box style={{ flex: 1 }} />
                  <Text size="2" color="gray">
                    {breakdown.total.toLocaleString()}
                  </Text>
                </button>
              </Flex>
              {open && (
                <Flex direction="column" gap="1" pb="2" pl="4">
                  {breakdown.groups.map((group) => (
                    <Flex key={group.label} align="center" gap="2">
                      {breakdown.groupedBy === "site" && <SiteMark host={group.label} />}
                      <Text size="1" truncate style={{ flex: 1 }}>
                        {group.label}
                      </Text>
                      <Box
                        style={{
                          width: 90,
                          height: 6,
                          borderRadius: 3,
                          background: "var(--gray-a4)",
                          overflow: "hidden",
                          flexShrink: 0,
                        }}
                      >
                        <Box
                          style={{
                            width: `${Math.max(4, Math.round((group.count / max) * 100))}%`,
                            height: "100%",
                            background: "var(--accent-9)",
                          }}
                        />
                      </Box>
                      <Text size="1" color="gray" style={{ width: 56, textAlign: "right" }}>
                        {group.count.toLocaleString()}
                      </Text>
                    </Flex>
                  ))}
                  {breakdown.otherGroups > 0 && (
                    <Text size="1" color="gray">
                      … {plural(breakdown.otherItems, "more item")} across{" "}
                      {plural(
                        breakdown.otherGroups,
                        breakdown.groupedBy === "site" ? "more site" : "more kind"
                      )}
                    </Text>
                  )}
                </Flex>
              )}
            </Box>
          );
        })}
      </Flex>
    </Card>
  );
}

function SourceHeader(props: { selection: ImportSourceSelection }) {
  const name = props.selection.source.displayName;
  const hue = hueFor(name);
  return (
    <Card style={{ flexShrink: 0 }}>
      <Flex gap="3" align="center">
        <Flex
          align="center"
          justify="center"
          style={{
            width: 44,
            height: 44,
            flexShrink: 0,
            borderRadius: "var(--radius-3)",
            background: `linear-gradient(140deg, hsl(${hue} 70% 52%), hsl(${(hue + 40) % 360} 70% 42%))`,
            color: "white",
            fontWeight: 700,
            fontSize: 17,
            letterSpacing: "-0.02em",
          }}
        >
          {initialsFor(name)}
        </Flex>
        <Box style={{ minWidth: 0 }}>
          <Flex gap="2" align="center">
            <Heading size="4" truncate>
              {name}
            </Heading>
            <Badge color={props.selection.source.status === "readable" ? "green" : "amber"}>
              {props.selection.source.status}
            </Badge>
          </Flex>
          <Text size="2" color="gray" as="div">
            On {props.selection.host.displayName} ·{" "}
            {plural(props.selection.source.localDataSetCount, "readable local data set")}
          </Text>
        </Box>
      </Flex>
      {props.selection.source.warnings.map((warning) => (
        <Callout.Root key={warning} color="amber" size="1" mt="2">
          <Callout.Text>{warning}</Callout.Text>
        </Callout.Root>
      ))}
    </Card>
  );
}

function TypeTile(props: {
  label: string;
  hint: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <Flex
      asChild
      gap="2"
      align="start"
      p="2"
      style={{
        borderRadius: "var(--radius-3)",
        cursor: "pointer",
        border: `1px solid ${props.checked ? "var(--accent-a7)" : "var(--gray-a5)"}`,
        background: props.checked ? "var(--accent-a3)" : "transparent",
        transition: "background 120ms ease, border-color 120ms ease",
      }}
    >
      <label>
        <Checkbox checked={props.checked} onCheckedChange={props.onToggle} mt="1" />
        <Box style={{ minWidth: 0 }}>
          <Text size="2" as="div" weight={props.checked ? "medium" : "regular"}>
            {props.label}
          </Text>
          <Text size="1" color="gray" as="div">
            {props.hint}
          </Text>
        </Box>
      </label>
    </Flex>
  );
}

function ProgressCard(props: { title: string; job: ImportJobSnapshot; detail?: string }) {
  const running = !TERMINAL_PHASES.has(props.job.phase);
  return (
    <Card style={{ flexShrink: 0 }}>
      <Flex justify="between" align="center" gap="2">
        <Flex align="center" gap="2">
          <Heading size="2">{props.title}</Heading>
          {running && <Spinner size="1" />}
        </Flex>
        <Badge color={PHASE_COLOR[props.job.phase] ?? "blue"}>{props.job.phase}</Badge>
      </Flex>
      {props.detail && (
        <Text size="2" as="div" mt="1">
          {props.detail}
        </Text>
      )}

      <Flex direction="column" gap="3" mt="3">
        {props.job.progress.map((progress) => {
          const total = Math.max(progress.itemsProcessed, progress.stored + progress.skipped, 1);
          return (
            <Box key={progress.dataType}>
              <Flex justify="between" align="baseline" gap="2">
                <Text size="2">{labelForType(progress.dataType)}</Text>
                <Flex gap="2" align="center">
                  <Text size="1" color="gray">
                    {progress.stored} stored
                  </Text>
                  {progress.skipped > 0 && (
                    <Text size="1" color="gray">
                      · {progress.skipped} skipped
                    </Text>
                  )}
                  {progress.errors > 0 && (
                    <Badge color="red" size="1">
                      {plural(progress.errors, "error")}
                    </Badge>
                  )}
                </Flex>
              </Flex>
              <Progress
                mt="1"
                size="1"
                value={Math.min(100, Math.round((progress.stored / total) * 100))}
                color={progress.errors > 0 ? "amber" : "iris"}
              />
            </Box>
          );
        })}
        {props.job.progress.length === 0 && (
          <Text size="1" color="gray">
            Waiting for the first counts…
          </Text>
        )}
      </Flex>

      {props.job.error && (
        <Callout.Root color="red" mt="3">
          <Callout.Text>{props.job.error}</Callout.Text>
        </Callout.Root>
      )}
      {props.job.warnings.map((warning) => (
        <Callout.Root key={warning} color="amber" mt="2">
          <Callout.Text>{warning}</Callout.Text>
        </Callout.Root>
      ))}
      <Text size="1" color="gray" as="div" mt="2">
        Job {props.job.jobId}
      </Text>
    </Card>
  );
}

function labelForType(key: string): string {
  return DATA_TYPES.find((item) => item.key === key)?.label ?? key;
}

interface TabWindow {
  windowId: string;
  ordinal: number;
  tabs: ImportedBrowserOpenTab[];
}

/** Group tabs into their source browser windows, preserving window order. */
function groupByWindow(tabs: readonly ImportedBrowserOpenTab[]): TabWindow[] {
  const windows = new Map<string, TabWindow>();
  for (const tab of tabs) {
    const existing = windows.get(tab.windowId);
    if (existing) existing.tabs.push(tab);
    else windows.set(tab.windowId, { windowId: tab.windowId, ordinal: tab.windowOrdinal, tabs: [tab] });
  }
  return [...windows.values()].sort((a, b) => a.ordinal - b.ordinal);
}

function OpenTabs(props: { selection: ImportSourceSelection }) {
  const sourceKey = `${props.selection.host.hostId}\0${props.selection.source.sourceId}`;
  const tabs = useAsync<ImportedBrowserOpenTab[]>(
    () => browserData.listOpenTabs(props.selection.host.hostId, props.selection.source.sourceId),
    [sourceKey]
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collapsedWindows, setCollapsedWindows] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [groupIntoCollections, setGroupIntoCollections] = useState(true);
  const [message, setMessage] = useState<{ tone: "green" | "red"; text: string } | null>(null);

  const [autoCollapsedKey, setAutoCollapsedKey] = useState<string | null>(null);

  useEffect(() => {
    setSelected(new Set());
    setCollapsedWindows(new Set());
    setFilter("");
    setMessage(null);
    setAutoCollapsedKey(null);
  }, [sourceKey]);

  const rows = tabs.state.data ?? [];

  // A long tab list opens as a window overview rather than a wall of rows; the
  // first window stays expanded so the structure is obvious at a glance.
  useEffect(() => {
    if (tabs.state.status !== "ready" || autoCollapsedKey === sourceKey) return;
    setAutoCollapsedKey(sourceKey);
    if (rows.length <= AUTO_COLLAPSE_TABS) return;
    const [, ...rest] = groupByWindow(rows);
    setCollapsedWindows(new Set(rest.map((window) => window.windowId)));
  }, [tabs.state.status, sourceKey, autoCollapsedKey, rows]);

  const needle = filter.trim().toLowerCase();
  const windows = useMemo(() => {
    const matching = needle
      ? rows.filter(
          (tab) =>
            tab.title?.toLowerCase().includes(needle) || tab.url.toLowerCase().includes(needle)
        )
      : rows;
    return groupByWindow(matching);
  }, [rows, needle]);
  const visibleCount = windows.reduce((sum, window) => sum + window.tabs.length, 0);

  // When the browser is closed we still list its stored sessions, so say which
  // of them a launch would actually reopen.
  const closedSummary = useMemo(() => {
    if (rows.length === 0 || rows.some((tab) => tab.sessionState === "open")) return null;
    const name = props.selection.source.displayName;
    const restoring = groupByWindow(rows.filter((tab) => tab.sessionState === "restores"));
    const saved = groupByWindow(rows.filter((tab) => tab.sessionState === "saved"));
    if (restoring.length === 0) {
      return `${name} is not running. None of these ${plural(
        saved.length,
        "window"
      )} would reopen on launch — they are stored sessions from a profile that does not start by default, or restore is switched off.`;
    }
    const head = `${name} is not running. Starting it reopens ${plural(
      restoring.length,
      "window"
    )}, marked “restores on launch”.`;
    return saved.length === 0
      ? head
      : `${head} The other ${plural(saved.length, "window")} are stored sessions that will not come back on their own.`;
  }, [rows, props.selection.source.displayName]);

  const setMany = (ids: string[], on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) (on ? next.add(id) : next.delete(id));
      return next;
    });

  const open = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await browserData.openTabsAsPanels({
        hostId: props.selection.host.hostId,
        sourceId: props.selection.source.sourceId,
        selection: [...selected],
        groupBy: groupIntoCollections ? "window" : "none",
      });
      const collections = result.collections?.length ?? 0;
      const opened = collections
        ? `Opened ${plural(result.panelsOpened, "panel")} in ${plural(collections, "collection")}.`
        : `Opened ${plural(result.panelsOpened, "panel")}.`;
      // Never report a silent zero: if panels did not open, say why.
      const reasons = [...new Set((result.skipped ?? []).map((entry) => entry.reason))];
      setMessage({
        tone: result.panelsOpened === 0 && reasons.length > 0 ? "red" : "green",
        text: reasons.length
          ? `${opened} ${plural(result.skipped.length, "tab")} skipped — ${reasons
              .slice(0, 3)
              .join("; ")}`
          : opened,
      });
      if (result.panelsOpened > 0) setSelected(new Set());
    } catch (cause) {
      setMessage({ tone: "red", text: classifyError(cause).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={{ flexShrink: 0 }}>
      <Flex align="center" gap="2">
        <Heading size="2">Open tabs</Heading>
        {rows.length > 0 && (
          <Badge color="gray">
            {plural(rows.length, "tab")} in {plural(groupByWindow(rows).length, "window")}
          </Badge>
        )}
      </Flex>
      <Text size="1" color="gray" as="div">
        Not part of the import — each tab you pick opens as its own panel.
      </Text>
      {closedSummary && (
        <Callout.Root color="amber" size="1" mt="2">
          <Callout.Text>{closedSummary}</Callout.Text>
        </Callout.Root>
      )}
      <Text as="label" size="2">
        <Flex gap="2" align="center" mt="2">
          <Checkbox
            checked={groupIntoCollections}
            onCheckedChange={() => setGroupIntoCollections((value) => !value)}
          />
          <Box>
            <Text as="div" size="2">
              Group each window into a collection
            </Text>
            <Text as="div" size="1" color="gray">
              Nests the tabs under one collection panel per window — notes and agentic debug
              sessions live there.
            </Text>
          </Box>
        </Flex>
      </Text>

      {tabs.state.status === "loading" && <Spinner size="1" />}
      {tabs.state.error && (
        <Text color="red" size="1" as="div" mt="2">
          {tabs.state.error}
        </Text>
      )}
      {tabs.state.status === "ready" && rows.length === 0 && (
        <Text size="1" color="gray" as="div" mt="2">
          No open tabs found in this browser.
        </Text>
      )}

      {rows.length > 0 && (
        <>
          <Flex gap="2" align="center" mt="3">
            <TextField.Root
              size="1"
              placeholder="Filter by title or URL"
              value={filter}
              onChange={(event) => setFilter(event.currentTarget.value)}
              style={{ flex: 1 }}
            >
              <TextField.Slot>
                <MagnifyingGlassIcon />
              </TextField.Slot>
            </TextField.Root>
            <Button
              size="1"
              variant="ghost"
              disabled={visibleCount === 0}
              onClick={() =>
                setMany(
                  windows.flatMap((window) => window.tabs.map((tab) => tab.tabId)),
                  !windows.every((window) => window.tabs.every((tab) => selected.has(tab.tabId)))
                )
              }
            >
              {visibleCount > 0 &&
              windows.every((window) => window.tabs.every((tab) => selected.has(tab.tabId)))
                ? "Clear"
                : `Select ${visibleCount}`}
            </Button>
          </Flex>

          <Flex
            direction="column"
            gap="3"
            mt="3"
            style={{
              // Grow into the panel instead of stranding the list in a 360px
              // box with empty space below it.
              minHeight: 200,
              maxHeight: "calc(100vh - 360px)",
              overflowY: "auto",
              overscrollBehavior: "contain",
            }}
          >
            {windows.length === 0 && (
              <Text size="1" color="gray">
                No tabs match “{filter}”.
              </Text>
            )}
            {windows.map((window) => (
              <WindowGroup
                key={window.windowId}
                window={window}
                selected={selected}
                collapsed={!needle && collapsedWindows.has(window.windowId)}
                onToggleCollapsed={() =>
                  setCollapsedWindows((current) => {
                    const next = new Set(current);
                    next.has(window.windowId)
                      ? next.delete(window.windowId)
                      : next.add(window.windowId);
                    return next;
                  })
                }
                onToggleTab={(tabId, on) => setMany([tabId], on)}
                onToggleWindow={(on) => setMany(window.tabs.map((tab) => tab.tabId), on)}
              />
            ))}
          </Flex>
        </>
      )}

      {message && (
        <Text color={message.tone} size="1" as="div" mt="2">
          {message.text}
        </Text>
      )}

      <Flex justify="between" align="center" gap="2" wrap="wrap" mt="3">
        <Text size="1" color="gray">
          {selected.size > 0
            ? `${plural(selected.size, "tab")} selected`
            : "Select the tabs you want as panels."}
        </Text>
        <Button disabled={selected.size === 0 || busy} onClick={open}>
          {busy ? <Spinner size="1" /> : <OpenInNewWindowIcon />}
          {selected.size ? `Open ${selected.size} as panels` : "Open as panels"}
        </Button>
      </Flex>
    </Card>
  );
}

function WindowGroup(props: {
  window: TabWindow;
  selected: Set<string>;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onToggleTab: (tabId: string, on: boolean) => void;
  onToggleWindow: (on: boolean) => void;
}) {
  const tabs = props.window.tabs;
  const selectedHere = tabs.filter((tab) => props.selected.has(tab.tabId)).length;
  const allSelected = selectedHere === tabs.length;
  const hosts = useMemo(() => {
    const seen: string[] = [];
    for (const tab of tabs) {
      const host = prettyHost(tab.url);
      if (!seen.includes(host)) seen.push(host);
      if (seen.length === 4) break;
    }
    return seen;
  }, [tabs]);

  return (
    <Box
      style={{
        // Without this the group collapses to a sliver: the scroll column has a
        // bounded height, so flex children shrink instead of overflowing.
        flexShrink: 0,
        border: "1px solid var(--gray-a5)",
        borderRadius: "var(--radius-3)",
        overflow: "hidden",
      }}
    >
      <Flex
        align="center"
        gap="2"
        p="2"
        style={{
          background: selectedHere > 0 ? "var(--accent-a2)" : "var(--gray-a2)",
          transition: "background 120ms ease",
        }}
      >
        <Checkbox
          checked={allSelected ? true : selectedHere > 0 ? "indeterminate" : false}
          onCheckedChange={() => props.onToggleWindow(!allSelected)}
          aria-label={`Select all tabs in window ${props.window.ordinal}`}
        />
        <IconButton
          size="1"
          variant="ghost"
          onClick={props.onToggleCollapsed}
          aria-label={props.collapsed ? "Expand window" : "Collapse window"}
        >
          {props.collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
        </IconButton>
        <Text size="2" weight="medium">
          Window {props.window.ordinal}
        </Text>
        <Badge color="gray" size="1">
          {plural(tabs.length, "tab")}
        </Badge>
        {tabs[0]?.sessionState === "restores" && (
          <Tooltip content="This window reopens when you start the browser">
            <Badge color="blue" size="1" variant="soft">
              restores on launch
            </Badge>
          </Tooltip>
        )}
        {tabs[0]?.sessionState === "saved" && (
          <Tooltip content="A stored session that will not reopen on its own">
            <Badge color="amber" size="1" variant="soft">
              saved session
            </Badge>
          </Tooltip>
        )}
        {selectedHere > 0 && (
          <Badge color="iris" size="1">
            {selectedHere} selected
          </Badge>
        )}
        <Box style={{ flex: 1 }} />
        {props.collapsed && (
          <Flex gap="1" align="center" style={{ minWidth: 0 }}>
            {hosts.map((host) => (
              <SiteMark key={host} host={host} />
            ))}
            {tabs.length > hosts.length && (
              <Text size="1" color="gray">
                +{tabs.length - hosts.length}
              </Text>
            )}
          </Flex>
        )}
      </Flex>

      {!props.collapsed && (
        <Flex direction="column">
          {tabs.map((tab, index) => (
            <Box key={tab.tabId}>
              {index > 0 && <Separator size="4" />}
              <TabRow
                tab={tab}
                checked={props.selected.has(tab.tabId)}
                onToggle={(on) => props.onToggleTab(tab.tabId, on)}
              />
            </Box>
          ))}
        </Flex>
      )}
    </Box>
  );
}

function TabRow(props: {
  tab: ImportedBrowserOpenTab;
  checked: boolean;
  onToggle: (on: boolean) => void;
}) {
  const host = prettyHost(props.tab.url);
  const path = prettyPath(props.tab.url);
  return (
    <Flex
      asChild
      align="center"
      gap="2"
      px="2"
      py="1"
      style={{
        cursor: "pointer",
        background: props.checked ? "var(--accent-a3)" : "transparent",
        transition: "background 120ms ease",
      }}
    >
      <label>
        <Checkbox checked={props.checked} onCheckedChange={() => props.onToggle(!props.checked)} />
        <SiteMark host={host} />
        <Box style={{ minWidth: 0, flex: 1 }}>
          <Flex align="center" gap="1" style={{ minWidth: 0 }}>
            {props.tab.pinned && (
              <Tooltip content="Pinned tab">
                <DrawingPinFilledIcon color="var(--gray-9)" />
              </Tooltip>
            )}
            <Text truncate as="div" size="2">
              {props.tab.title || host}
            </Text>
            {props.tab.active && (
              <Badge size="1" color="green" variant="soft">
                active
              </Badge>
            )}
          </Flex>
          <Text truncate as="div" size="1" color="gray">
            {host}
            {path}
          </Text>
        </Box>
      </label>
    </Flex>
  );
}

/** Letter-mark stand-in for a favicon — deterministic colour, no network fetch. */
function SiteMark(props: { host: string }) {
  const hue = hueFor(props.host);
  return (
    <Flex
      align="center"
      justify="center"
      title={props.host}
      style={{
        width: 18,
        height: 18,
        flexShrink: 0,
        borderRadius: "var(--radius-1)",
        background: `hsl(${hue} 55% 45%)`,
        color: "white",
        fontSize: 9,
        fontWeight: 700,
        lineHeight: 1,
      }}
    >
      {initialsFor(props.host)}
    </Flex>
  );
}

function ImportHistory(props: { now: number; jobs: readonly ImportJobSnapshot[] }) {
  const visible = useMemo(() => props.jobs.slice(0, 8), [props.jobs]);
  if (!visible.length) return null;
  return (
    <Card style={{ flexShrink: 0 }}>
      <Heading size="2" mb="2">
        Import history
      </Heading>
      <Flex direction="column" gap="1">
        {visible.map((job) => (
          <Flex key={job.jobId} justify="between" gap="2" align="center">
            <Text size="1" truncate>
              {job.requestedDataTypes.map(labelForType).join(", ")}
            </Text>
            <Flex gap="2" align="center" style={{ flexShrink: 0 }}>
              <Badge size="1" color={PHASE_COLOR[job.phase] ?? "blue"}>
                {job.phase}
              </Badge>
              <Text size="1" color="gray">
                {relativeTime(job.finishedAt ?? job.updatedAt, props.now)}
              </Text>
            </Flex>
          </Flex>
        ))}
      </Flex>
    </Card>
  );
}
