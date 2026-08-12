import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertDialog,
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Code,
  Dialog,
  Flex,
  Grid,
  Heading,
  IconButton,
  SegmentedControl,
  Spinner,
  Text,
  TextField,
  Tooltip,
} from "@radix-ui/themes";
import {
  ChatBubbleIcon,
  CheckCircledIcon,
  ClockIcon,
  CrossCircledIcon,
  ExclamationTriangleIcon,
  LightningBoltIcon,
  MagnifyingGlassIcon,
  PauseIcon,
  Pencil2Icon,
  PlayIcon,
  ReloadIcon,
  RocketIcon,
  TrashIcon,
} from "@radix-ui/react-icons";
import { openPanel, panel, rpc, workers } from "@workspace/runtime";
import {
  AutomationActivity,
  AutomationParametersEditor,
  CronScheduleDisplay,
  createAutomationUiClient,
  type AutomationUiClient,
} from "@workspace/agentic-chat";
import type {
  MissionPermission,
  MissionRecord,
  MissionRunRecord,
} from "@vibestudio/shared/authority/mission";
import { AboutPage, AboutThemeRoot } from "../../packages/about-shared/ui";

type Filter = "all" | "attention" | "active" | "paused" | "completed" | "drafts";
type AutomationRecord = MissionRecord;
type RunRecord = MissionRunRecord;
type AutomationState = MissionRecord["state"];
type RunStatus = MissionRunRecord["status"];
type OverviewItem = {
  automation: AutomationRecord;
  recentRuns: RunRecord[];
  totalRuns: number;
  activeRuns: number;
  failedRunsSince: number;
};
type Overview = {
  generatedAt: number;
  stats: {
    total: number;
    active: number;
    running: number;
    failedLast24Hours: number;
    awaitingReview: number;
    completed: number;
  };
  items: OverviewItem[];
  nextCursor?: OverviewCursor;
  attention: Array<{ missionId: string; missionName: string; run: RunRecord }>;
};
type RunCursor = { startedAt: number; runId: string };
type OverviewCursor = { updatedAt: number; missionId: string };
type RunPage = { items: RunRecord[]; nextCursor?: RunCursor };

let targetPromise: Promise<string> | null = null;

function callAutomations<T>(method: string, args: unknown[]): Promise<T> {
  targetPromise ??= workers
    .resolveService("vibestudio.missions.v1")
    .then((service) => {
      if (service.kind !== "durable-object") {
        throw new Error("The automation service must be a Durable Object");
      }
      return service.targetId;
    })
    .catch((error) => {
      targetPromise = null;
      throw error;
    });
  return targetPromise.then((target) => rpc.call<T>(target, method, args));
}

const automationUiClient: AutomationUiClient = createAutomationUiClient(rpc, (run) => {
  if (!run.channelId || !run.contextId) return;
  void openPanel("panels/chat", {
    focus: true,
    contextId: run.contextId,
    stateArgs: { channelName: run.channelId },
  });
});

function absoluteTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

function relativeTime(value: number, now = Date.now()): string {
  const delta = value - now;
  const units = [
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
  ] as const;
  const [unitMs, unit] = units.find(([size]) => Math.abs(delta) >= size) ?? [1_000, "second"];
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
    Math.round(delta / unitMs),
    unit
  );
}

function duration(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1_000)}s`;
}

function stateLabel(state: AutomationState): string {
  if (state === "needs-reapproval") return "Needs review";
  if (state === "draft") return "Draft";
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function statusLabel(status: RunStatus): string {
  if (status === "starting") return "Starting";
  if (status === "running") return "Running";
  if (status === "succeeded") return "Succeeded";
  if (status === "failed") return "Failed";
  return "Skipped";
}

function mergeRuns(primary: RunRecord[], extra: RunRecord[]): RunRecord[] {
  const byId = new Map(extra.map((run) => [run.runId, run]));
  for (const run of primary) byId.set(run.runId, run);
  return [...byId.values()].sort(
    (a, b) => b.startedAt - a.startedAt || b.runId.localeCompare(a.runId)
  );
}

function mergeOverviewItems(primary: OverviewItem[], extra: OverviewItem[]): OverviewItem[] {
  const byId = new Map(primary.map((item) => [item.automation.missionId, item]));
  for (const item of extra) byId.set(item.automation.missionId, item);
  return [...byId.values()];
}

function resourceDescription(resource: MissionPermission["resource"]): string {
  if (resource.kind === "exact") return resource.key;
  if (resource.kind === "prefix") return `${resource.prefix}…`;
  return "Any resource";
}

function Disclosure({
  summary,
  initiallyOpen = false,
  children,
}: {
  summary: ReactNode;
  initiallyOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary style={{ cursor: "pointer", fontWeight: 500 }}>{summary}</summary>
      {open ? children : null}
    </details>
  );
}

function DetailCode({ children }: { children: ReactNode }) {
  return (
    <Code size="1" style={{ overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>
      {children}
    </Code>
  );
}

function MetricCard({
  label,
  value,
  detail,
  tone = "gray",
}: {
  label: string;
  value: number;
  detail: string;
  tone?: "gray" | "blue" | "red" | "green";
}) {
  return (
    <Card size="2" style={{ minHeight: 96 }}>
      <Flex direction="column" justify="between" height="100%" gap="2">
        <Text size="1" weight="medium" color="gray">
          {label}
        </Text>
        <Flex align="end" justify="between" gap="2">
          <Heading size="6" color={tone === "gray" ? undefined : tone}>
            {value}
          </Heading>
          <Text size="1" color="gray" align="right">
            {detail}
          </Text>
        </Flex>
      </Flex>
    </Card>
  );
}

function ConversationButton({ run }: { run: RunRecord }) {
  const openConversation = useCallback(() => {
    if (!run.channelId || !run.contextId) return;
    void openPanel("panels/chat", {
      focus: true,
      contextId: run.contextId,
      stateArgs: { channelName: run.channelId },
    });
  }, [run.channelId, run.contextId]);
  if (!run.channelId || !run.contextId) return null;
  return (
    <Button size="1" variant="soft" onClick={openConversation}>
      <ChatBubbleIcon /> Open conversation
    </Button>
  );
}

function activityFor(automation: AutomationRecord, run: RunRecord) {
  const execution = automation.charter.execution;
  const trigger = automation.charter.trigger;
  return {
    snapshot: {
      missionId: automation.missionId,
      runId: run.runId,
      name: automation.name,
      revision: run.revision,
      action: execution.kind === "method" ? ("method" as const) : execution.action.kind,
      trigger: run.trigger,
      startedAt: run.startedAt,
      createdAt: automation.createdAt,
      ...(automation.activatedAt === undefined ? {} : { activatedAt: automation.activatedAt }),
      ...(run.runNumber === undefined ? {} : { runNumber: run.runNumber }),
      schedule:
        trigger.kind === "schedule"
          ? {
              kind: "interval" as const,
              everyMs: trigger.everyMs,
              ...(trigger.anchorAt === undefined ? {} : { anchorAt: trigger.anchorAt }),
              ...(trigger.jitterMs === undefined ? {} : { jitterMs: trigger.jitterMs }),
              ...(trigger.untilAt === undefined ? {} : { untilAt: trigger.untilAt }),
              ...(trigger.maxRuns === undefined ? {} : { maxRuns: trigger.maxRuns }),
            }
          : trigger.kind === "cron"
            ? {
                kind: "cron" as const,
                expression: trigger.expression,
                timezone: trigger.timezone,
                ...(trigger.untilAt === undefined ? {} : { untilAt: trigger.untilAt }),
                ...(trigger.maxRuns === undefined ? {} : { maxRuns: trigger.maxRuns }),
              }
            : null,
    },
    status:
      run.status === "succeeded"
        ? ("succeeded" as const)
        : run.status === "failed"
          ? ("failed" as const)
          : run.status === "skipped"
            ? ("skipped" as const)
            : ("running" as const),
    openedAt: new Date(run.startedAt).toISOString(),
    ...(run.finishedAt === undefined ? {} : { closedAt: new Date(run.finishedAt).toISOString() }),
    ...(run.finalMessage ? { summary: run.finalMessage } : run.error ? { summary: run.error } : {}),
    ...(run.error ? { reason: "work_failed" } : {}),
  };
}

function RunRow({ run, automation }: { run: RunRecord; automation: AutomationRecord }) {
  return (
    <Box
      py="3"
      style={{ borderTop: "1px solid var(--gray-a5)" }}
      aria-label={`${statusLabel(run.status)} run from ${absoluteTime(run.startedAt)}`}
    >
      <Flex direction="column" gap="2">
        <AutomationActivity
          activity={activityFor(automation, run)}
          automation={automation}
          run={run}
          client={automationUiClient}
          display="row"
        />
        <Flex justify="end">
          <ConversationButton run={run} />
        </Flex>
        {run.error ? (
          <Callout.Root color={run.status === "skipped" ? "amber" : "red"} size="1">
            <Callout.Icon>
              <ExclamationTriangleIcon />
            </Callout.Icon>
            <Callout.Text style={{ overflowWrap: "anywhere" }}>{run.error}</Callout.Text>
          </Callout.Root>
        ) : null}
        {run.completionResponse ? (
          <Callout.Root color="green" size="1">
            <Callout.Icon>
              <CheckCircledIcon />
            </Callout.Icon>
            <Callout.Text>
              <Text as="span" weight="medium" style={{ display: "block" }}>
                Natural completion response
              </Text>
              <Text
                as="span"
                style={{ display: "block", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
              >
                {run.completionResponse}
              </Text>
            </Callout.Text>
          </Callout.Root>
        ) : null}
        {run.finalMessage && run.finalMessage !== run.completionResponse ? (
          <details>
            <summary style={{ cursor: "pointer", color: "var(--gray-11)", fontSize: 13 }}>
              Final message
            </summary>
            <Text
              as="div"
              size="2"
              mt="2"
              style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxWidth: "80ch" }}
            >
              {run.finalMessage}
            </Text>
          </details>
        ) : run.status === "running" || run.status === "starting" ? (
          <Flex align="center" gap="2">
            <Spinner size="1" />
            <Text size="1" color="gray">
              Waiting for a terminal result…
            </Text>
          </Flex>
        ) : null}
      </Flex>
    </Box>
  );
}

function AttentionRow({
  item,
}: {
  item: { missionId: string; missionName: string; run: RunRecord };
}) {
  const focusAutomation = useCallback(() => {
    document.getElementById(`automation-${item.missionId}`)?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }, [item.missionId]);
  return (
    <Flex
      direction={{ initial: "column", sm: "row" }}
      justify="between"
      align={{ initial: "start", sm: "center" }}
      gap="3"
      py="3"
      style={{ borderTop: "1px solid var(--red-a5)" }}
    >
      <Box style={{ minWidth: 0 }}>
        <Flex align="center" gap="2" wrap="wrap">
          <Text weight="medium" size="2">
            {item.missionName}
          </Text>
          <Text size="1" color="gray" title={absoluteTime(item.run.startedAt)}>
            {relativeTime(item.run.startedAt)}
          </Text>
        </Flex>
        <Text as="div" size="2" color="red" truncate style={{ maxWidth: "72ch" }}>
          {item.run.error ?? "The run ended without a final result."}
        </Text>
      </Box>
      <Flex gap="2" style={{ flexShrink: 0 }}>
        <ConversationButton run={item.run} />
        <Button size="1" variant="ghost" onClick={focusAutomation}>
          Details
        </Button>
      </Flex>
    </Flex>
  );
}

function executionDescription(automation: AutomationRecord): string {
  const execution = automation.charter.execution;
  if (execution.kind === "method") {
    return `${execution.target.className}.${execution.method}`;
  }
  const action = execution.action.kind === "eval" ? "Exact eval" : "Agent prompt";
  return execution.conversation.mode === "fresh"
    ? `${action} · new conversation each run`
    : `${action} · continues one conversation`;
}

function scheduleDescription(automation: AutomationRecord): string {
  const trigger = automation.charter.trigger;
  if (trigger.kind === "manual") return "Manual only";
  return trigger.kind === "schedule" ? `Every ${duration(trigger.everyMs)}` : "Calendar schedule";
}

function ScheduleDetails({ automation }: { automation: AutomationRecord }) {
  const trigger = automation.charter.trigger;
  if (trigger.kind === "manual") return null;
  return (
    <Flex direction="column" mt="1">
      {trigger.kind === "schedule" && trigger.anchorAt !== undefined ? (
        <Text size="1" color="gray" title={absoluteTime(trigger.anchorAt)}>
          Aligned to {absoluteTime(trigger.anchorAt)}
        </Text>
      ) : null}
      {trigger.kind === "schedule" && trigger.jitterMs ? (
        <Text size="1" color="gray">
          Up to {duration(trigger.jitterMs)} jitter
        </Text>
      ) : null}
      {automation.nextRunAt ? (
        <Text size="1" color="gray" title={absoluteTime(automation.nextRunAt)}>
          Next {relativeTime(automation.nextRunAt)}
        </Text>
      ) : null}
      {trigger.untilAt !== undefined ? (
        <Text size="1" color="gray" title={absoluteTime(trigger.untilAt)}>
          Stops {absoluteTime(trigger.untilAt)}
        </Text>
      ) : null}
      {trigger.maxRuns !== undefined ? (
        <Text size="1" color="gray">
          {automation.runCount} of {trigger.maxRuns} runs admitted
        </Text>
      ) : (
        <Text size="1" color="gray">
          {automation.runCount} run{automation.runCount === 1 ? "" : "s"} admitted
        </Text>
      )}
    </Flex>
  );
}

function DefinitionDetails({ automation }: { automation: AutomationRecord }) {
  const execution = automation.charter.execution;
  return (
    <Flex direction="column" gap="4" mt="3">
      <Grid columns={{ initial: "1", sm: "2" }} gap="3">
        <Box>
          <Text as="div" size="1" color="gray">
            Exact harness
          </Text>
          <DetailCode>
            {automation.charter.harness.unit}@{automation.charter.harness.ev}
          </DetailCode>
        </Box>
        <Box>
          <Text as="div" size="1" color="gray">
            Target
          </Text>
          <DetailCode>
            {execution.target.source} · {execution.target.className} · {execution.target.objectKey}
          </DetailCode>
        </Box>
        <Box>
          <Text as="div" size="1" color="gray">
            Reviewed revision
          </Text>
          <DetailCode>
            r{automation.revision} · {automation.revisionDigest}
          </DetailCode>
        </Box>
        <Box>
          <Text as="div" size="1" color="gray">
            Automation identity
          </Text>
          <DetailCode>{automation.missionId}</DetailCode>
        </Box>
      </Grid>

      {execution.kind === "method" ? (
        <Box>
          <Text as="div" size="1" color="gray" mb="1">
            Exact method arguments · authority comes from the installed target code
          </Text>
          <Box
            p="3"
            style={{
              background: "var(--gray-a2)",
              borderRadius: "var(--radius-2)",
              maxHeight: 260,
              overflow: "auto",
            }}
          >
            <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
              <Text size="1">{JSON.stringify(execution.args, null, 2)}</Text>
            </pre>
          </Box>
        </Box>
      ) : (
        <>
          <Grid columns={{ initial: "1", sm: "2" }} gap="3">
            <Box>
              <Text as="div" size="1" color="gray">
                Conversation
              </Text>
              <Text size="2">
                {execution.conversation.mode === "fresh"
                  ? "Fresh isolated conversation for every run"
                  : `Continue ${execution.conversation.channelId} in ${execution.conversation.contextId}`}
              </Text>
            </Box>
            <Box>
              <Text as="div" size="1" color="gray">
                Workspace service discovery
              </Text>
              <Text size="2">
                {execution.toolExposure.workspaceServiceDiscovery === "bound"
                  ? "Reviewed bindings only"
                  : "Live declarations"}
              </Text>
            </Box>
            <Box>
              <Text as="div" size="1" color="gray">
                Network
              </Text>
              <Text size="2">
                {execution.toolExposure.evalNetwork === "none"
                  ? "No eval network access"
                  : execution.toolExposure.evalNetwork === "unrestricted"
                    ? "Unrestricted eval network"
                    : execution.toolExposure.declaredOrigins.join(", ")}
              </Text>
            </Box>
            <Box>
              <Text as="div" size="1" color="gray">
                Declared outside-content classes
              </Text>
              <Text size="2">{execution.declaredLineageClasses.join(", ")}</Text>
            </Box>
          </Grid>
          <Box>
            <Text as="div" size="1" color="gray" mb="1">
              Exposed services
            </Text>
            <Flex gap="1" wrap="wrap">
              {execution.toolExposure.services.length ? (
                execution.toolExposure.services.map((service) => (
                  <Badge key={service} variant="soft" color="gray">
                    {service}
                  </Badge>
                ))
              ) : (
                <Text size="2" color="gray">
                  None
                </Text>
              )}
            </Flex>
          </Box>
          {execution.toolExposure.userlandServices.length ? (
            <Box>
              <Text as="div" size="1" color="gray" mb="1">
                Userland service bindings
              </Text>
              <Flex direction="column" gap="1">
                {execution.toolExposure.userlandServices.map((binding) => (
                  <DetailCode key={`${binding.name}:${binding.provider}`}>
                    {binding.name} → {binding.provider}@{binding.providerEv} (
                    {binding.upgradePolicy})
                  </DetailCode>
                ))}
              </Flex>
            </Box>
          ) : null}
          <Box>
            <Text as="div" size="1" color="gray" mb="1">
              {execution.action.kind === "eval" ? "Exact eval code" : "Exact prompt"}
            </Text>
            <Box
              p="3"
              style={{
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                background: "var(--gray-a2)",
                borderRadius: "var(--radius-2)",
                maxHeight: 260,
                overflow: "auto",
              }}
            >
              <Text as="div" size="2">
                {execution.action.kind === "eval" ? execution.action.code : execution.action.text}
              </Text>
            </Box>
          </Box>
        </>
      )}

      <Grid columns={{ initial: "1", sm: "2" }} gap="3">
        <Box>
          <Text as="div" size="1" color="gray" mb="1">
            Standing permissions
          </Text>
          {automation.permissions.length ? (
            <Flex direction="column" gap="1">
              {automation.permissions.map((permission, index) => (
                <Flex key={`${permission.capability}:${index}`} align="center" gap="2" wrap="wrap">
                  <Badge color={permission.tier === "critical" ? "red" : "amber"} variant="soft">
                    {permission.tier}
                  </Badge>
                  <DetailCode>
                    {permission.capability} · {resourceDescription(permission.resource)}
                  </DetailCode>
                </Flex>
              ))}
            </Flex>
          ) : (
            <Text size="2" color="gray">
              None
            </Text>
          )}
        </Box>
        <Box>
          <Text as="div" size="1" color="gray" mb="1">
            Explicit restrictions
          </Text>
          {automation.standingRestrictions.length ? (
            <Flex direction="column" gap="1">
              {automation.standingRestrictions.map((restriction, index) => (
                <DetailCode key={`${restriction.capability}:${index}`}>
                  {restriction.capability} · {restriction.resourceKey}
                </DetailCode>
              ))}
            </Flex>
          ) : (
            <Text size="2" color="gray">
              None
            </Text>
          )}
        </Box>
      </Grid>
    </Flex>
  );
}

function AutomationEditorButton({
  automation,
  disabled,
  onSaved,
}: {
  automation: AutomationRecord;
  disabled: boolean;
  onSaved(): void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger>
        <Button variant="soft" disabled={disabled}>
          <Pencil2Icon /> Edit parameters
        </Button>
      </Dialog.Trigger>
      <Dialog.Content maxWidth="760px" aria-describedby={undefined}>
        <Dialog.Title>Edit {automation.name}</Dialog.Title>
        <Dialog.Description size="2" color="gray" mb="4">
          Change the action or cadence as a new reviewable revision.
        </Dialog.Description>
        <AutomationParametersEditor
          automation={automation}
          client={automationUiClient}
          onSaved={() => {
            setOpen(false);
            onSaved();
          }}
          onCancel={() => setOpen(false)}
        />
      </Dialog.Content>
    </Dialog.Root>
  );
}

function AutomationCard({
  item,
  runs,
  busyAction,
  loadingMore,
  canLoadMore,
  onAction,
  onEdited,
  onLoadMore,
  deepLinked,
}: {
  item: OverviewItem;
  runs: RunRecord[];
  busyAction: string | null;
  loadingMore: boolean;
  canLoadMore: boolean;
  onAction(action: "requestReview" | "runNow" | "pause" | "resume" | "retire"): void;
  onEdited(): void;
  onLoadMore(): void;
  deepLinked?: boolean;
}) {
  const automation = item.automation;
  const execution = automation.charter.execution;
  const hasProblem = item.failedRunsSince > 0 || automation.state === "needs-reapproval";
  const busy = busyAction !== null;
  const schedule = scheduleDescription(automation);
  return (
    <Card
      id={`automation-${automation.missionId}`}
      size="3"
      style={{
        borderColor: deepLinked ? "var(--accent-a8)" : hasProblem ? "var(--amber-a7)" : undefined,
        boxShadow: deepLinked ? "0 0 0 1px var(--accent-a5)" : undefined,
        scrollMargin: 24,
      }}
    >
      <Flex direction="column" gap="4">
        <Flex justify="between" align="start" gap="4" wrap="wrap">
          <Box style={{ minWidth: 0, flex: "1 1 360px" }}>
            <Flex align="center" gap="2" wrap="wrap" mb="1">
              <Heading size="4">{automation.name}</Heading>
              <Badge
                color={
                  automation.state === "active"
                    ? "green"
                    : automation.state === "completed"
                      ? "violet"
                      : automation.state === "needs-reapproval"
                        ? "amber"
                        : automation.state === "paused"
                          ? "blue"
                          : "gray"
                }
                variant="soft"
              >
                {stateLabel(automation.state)}
              </Badge>
              {item.activeRuns > 0 ? (
                <Badge color="blue">
                  <Spinner size="1" /> Running
                </Badge>
              ) : null}
            </Flex>
            <Text as="p" size="2" color="gray" style={{ maxWidth: "76ch" }}>
              {automation.charter.summary}
            </Text>
          </Box>
          <Flex gap="2" wrap="wrap" align="center">
            {automation.state !== "retired" ? (
              <AutomationEditorButton automation={automation} disabled={busy} onSaved={onEdited} />
            ) : null}
            {automation.state === "draft" || automation.state === "needs-reapproval" ? (
              <Button
                disabled={busy}
                onClick={() => onAction("requestReview")}
                aria-label={`Review ${automation.name}`}
              >
                {busyAction === "requestReview" ? <Spinner size="1" /> : <CheckCircledIcon />}
                Review
              </Button>
            ) : null}
            {automation.state === "active" ? (
              <>
                <Button disabled={busy} onClick={() => onAction("runNow")}>
                  {busyAction === "runNow" ? <Spinner size="1" /> : <PlayIcon />}
                  Run now
                </Button>
                <Button
                  color="red"
                  variant="soft"
                  disabled={busy}
                  onClick={() => onAction("pause")}
                  aria-label={`Stop recurring calls for ${automation.name}`}
                >
                  {busyAction === "pause" ? <Spinner size="1" /> : <PauseIcon />}
                  {automation.charter.trigger.kind !== "manual"
                    ? "Stop recurring calls"
                    : "Pause automation"}
                </Button>
              </>
            ) : null}
            {automation.state === "paused" ? (
              <Button variant="soft" disabled={busy} onClick={() => onAction("resume")}>
                {busyAction === "resume" ? <Spinner size="1" /> : <PlayIcon />} Resume
              </Button>
            ) : null}
            {automation.state !== "retired" ? (
              <AlertDialog.Root>
                <AlertDialog.Trigger>
                  <IconButton
                    color="red"
                    variant="ghost"
                    disabled={busy}
                    aria-label={`Retire ${automation.name}`}
                  >
                    <TrashIcon />
                  </IconButton>
                </AlertDialog.Trigger>
                <AlertDialog.Content maxWidth="440px">
                  <AlertDialog.Title>Retire {automation.name}?</AlertDialog.Title>
                  <AlertDialog.Description size="2">
                    This permanently ends its schedule and reviewed identity. Its run history and
                    conversations remain available for inspection.
                  </AlertDialog.Description>
                  <Flex gap="3" mt="4" justify="end">
                    <AlertDialog.Cancel>
                      <Button variant="soft" color="gray">
                        Cancel
                      </Button>
                    </AlertDialog.Cancel>
                    <AlertDialog.Action>
                      <Button color="red" onClick={() => onAction("retire")}>
                        Retire automation
                      </Button>
                    </AlertDialog.Action>
                  </Flex>
                </AlertDialog.Content>
              </AlertDialog.Root>
            ) : null}
          </Flex>
        </Flex>

        <Grid columns={{ initial: "1", sm: "3" }} gap="3">
          <Box>
            <Text as="div" size="1" color="gray">
              Schedule
            </Text>
            <Flex align="start" gap="1">
              <ClockIcon />
              {automation.charter.trigger.kind === "cron" ? (
                <CronScheduleDisplay
                  expression={automation.charter.trigger.expression}
                  timezone={automation.charter.trigger.timezone}
                  technical
                />
              ) : (
                <Text size="2" weight="medium">
                  {schedule}
                </Text>
              )}
            </Flex>
            <ScheduleDetails automation={automation} />
          </Box>
          <Box>
            <Text as="div" size="1" color="gray">
              Action
            </Text>
            <Flex align="center" gap="1">
              {execution.kind === "agent" ? <RocketIcon /> : <LightningBoltIcon />}
              <Text size="2" weight="medium">
                {executionDescription(automation)}
              </Text>
            </Flex>
          </Box>
          <Box>
            <Text as="div" size="1" color="gray">
              Reviewed authority
            </Text>
            <Text as="div" size="2" weight="medium">
              {execution.kind === "method"
                ? "Installed method authority"
                : `${automation.permissions.length} permission${automation.permissions.length === 1 ? "" : "s"}`}
            </Text>
            {automation.standingRestrictions.length > 0 ? (
              <Text size="1" color="gray">
                {automation.standingRestrictions.length} explicit restriction
                {automation.standingRestrictions.length === 1 ? "" : "s"}
              </Text>
            ) : null}
          </Box>
        </Grid>

        {automation.state === "completed" ? (
          <Callout.Root color="green" size="1">
            <Callout.Icon>
              <CheckCircledIcon />
            </Callout.Icon>
            <Callout.Text>
              <Text as="span" weight="medium" style={{ display: "block" }}>
                Completed
                {automation.completedAt === undefined
                  ? ""
                  : ` ${absoluteTime(automation.completedAt)}`}
              </Text>
              <Text as="span" style={{ display: "block" }}>
                {automation.completionReason === "response"
                  ? "The automation reported that its recurring goal was finished."
                  : automation.completionReason === "max-runs"
                    ? "The configured maximum run count was reached."
                    : "The configured end time was reached."}
              </Text>
              {automation.completionResponse ? (
                <Text
                  as="span"
                  mt="1"
                  style={{ display: "block", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                >
                  {automation.completionResponse}
                </Text>
              ) : null}
            </Callout.Text>
          </Callout.Root>
        ) : null}

        <Disclosure
          initiallyOpen={deepLinked || item.activeRuns > 0 || item.failedRunsSince > 0}
          summary={
            <>
              Run history <Text color="gray">({item.totalRuns})</Text>
            </>
          }
        >
          <Box mt="2">
            {runs.length > 0 ? (
              runs.map((run) => <RunRow key={run.runId} run={run} automation={automation} />)
            ) : (
              <Box py="3">
                <Text as="div" size="2" color="gray">
                  No runs yet.{" "}
                  {automation.state === "active" ? "Run it now or wait for its schedule." : ""}
                </Text>
              </Box>
            )}
            {canLoadMore ? (
              <Button mt="2" size="1" variant="soft" disabled={loadingMore} onClick={onLoadMore}>
                {loadingMore ? <Spinner size="1" /> : null} Load older runs
              </Button>
            ) : null}
          </Box>
        </Disclosure>

        <Disclosure
          summary={
            <Text color="gray" size="1">
              Definition and developer details
            </Text>
          }
        >
          <DefinitionDetails automation={automation} />
        </Disclosure>
      </Flex>
    </Card>
  );
}

function AutomationsPage() {
  const initialMissionId = panel.stateArgs.get<{ missionId?: unknown }>().missionId;
  const [deepLinkedMissionId, setDeepLinkedMissionId] = useState<string | null>(
    typeof initialMissionId === "string" && initialMissionId ? initialMissionId : null
  );
  const [overview, setOverview] = useState<Overview | null>(null);
  const [olderRuns, setOlderRuns] = useState<Record<string, RunRecord[]>>({});
  const [exhausted, setExhausted] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMoreId, setLoadingMoreId] = useState<string | null>(null);
  const [loadingMoreAutomations, setLoadingMoreAutomations] = useState(false);
  const [busy, setBusy] = useState<{ id: string; action: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const overviewRequest = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const load = useCallback(
    async (quiet = false, cursor?: OverviewCursor, append = false) => {
      const requestId = ++overviewRequest.current;
      if (append) setLoadingMoreAutomations(true);
      else if (quiet) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const next = await callAutomations<Overview>("overview", [
          {
            limit: 30,
            filter,
            ...(debouncedQuery ? { query: debouncedQuery } : {}),
            ...(deepLinkedMissionId ? { missionId: deepLinkedMissionId } : {}),
            ...(cursor ? { cursor } : {}),
          },
        ]);
        if (overviewRequest.current === requestId) {
          setOverview((current) =>
            append && current
              ? { ...next, items: mergeOverviewItems(current.items, next.items) }
              : next
          );
        }
      } catch (cause) {
        if (overviewRequest.current === requestId) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (overviewRequest.current === requestId) {
          setLoading(false);
          setRefreshing(false);
          setLoadingMoreAutomations(false);
        }
      }
    },
    [debouncedQuery, deepLinkedMissionId, filter]
  );

  useEffect(() => {
    setOlderRuns({});
    setExhausted(new Set());
    void load();
  }, [load]);

  const activeRunCount = overview?.stats.running ?? 0;
  useEffect(() => {
    if (activeRunCount === 0) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [activeRunCount, load]);

  const action = useCallback(
    async (
      automation: AutomationRecord,
      method: "requestReview" | "runNow" | "pause" | "resume" | "retire"
    ) => {
      setBusy({ id: automation.missionId, action: method });
      setError(null);
      try {
        await callAutomations(method, [automation.missionId]);
        await load(true);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(null);
      }
    },
    [load]
  );

  const loadMore = useCallback(
    async (item: OverviewItem) => {
      const id = item.automation.missionId;
      const current = mergeRuns(item.recentRuns, olderRuns[id] ?? []);
      const last = current.at(-1);
      if (!last) return;
      setLoadingMoreId(id);
      setError(null);
      try {
        const page = await callAutomations<RunPage>("listRuns", [
          id,
          { limit: 20, cursor: { startedAt: last.startedAt, runId: last.runId } },
        ]);
        setOlderRuns((value) => ({
          ...value,
          [id]: mergeRuns(value[id] ?? [], page.items),
        }));
        if (!page.nextCursor) {
          setExhausted((value) => new Set(value).add(id));
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setLoadingMoreId(null);
      }
    },
    [olderRuns]
  );

  const items = overview?.items ?? [];
  const counts = overview?.stats ?? {
    total: 0,
    active: 0,
    running: 0,
    failedLast24Hours: 0,
    awaitingReview: 0,
    completed: 0,
  };

  return (
    <AboutPage
      icon={<LightningBoltIcon width={20} height={20} />}
      title="Automations"
      subtitle="Reviewed schedules, unattended runs, results, and conversations"
      maxWidth={1080}
      actions={
        <Flex align="center" gap="2">
          {overview ? (
            <Text size="1" color="gray" title={absoluteTime(overview.generatedAt)}>
              Updated {relativeTime(overview.generatedAt)}
            </Text>
          ) : null}
          <Tooltip content="Refresh overview">
            <IconButton
              size="2"
              variant="soft"
              disabled={loading || refreshing}
              onClick={() => void load(true)}
              aria-label="Refresh automations"
            >
              {refreshing ? <Spinner size="1" /> : <ReloadIcon />}
            </IconButton>
          </Tooltip>
        </Flex>
      }
    >
      <Grid columns={{ initial: "2", sm: "5" }} gap="3">
        <MetricCard
          label="Active"
          value={counts.active}
          detail="reviewed automations"
          tone="green"
        />
        <MetricCard
          label="Running now"
          value={counts.running}
          detail="auto-refreshing"
          tone="blue"
        />
        <MetricCard
          label="Failed"
          value={counts.failedLast24Hours}
          detail="in the last 24h"
          tone="red"
        />
        <MetricCard
          label="Awaiting review"
          value={counts.awaitingReview}
          detail="inert until approved"
        />
        <MetricCard label="Completed" value={counts.completed} detail="ended naturally" />
      </Grid>

      {error ? (
        <Callout.Root color="red" role="alert">
          <Callout.Icon>
            <ExclamationTriangleIcon />
          </Callout.Icon>
          <Callout.Text>
            {error}{" "}
            <Button variant="ghost" size="1" onClick={() => void load(true)}>
              Try again
            </Button>
          </Callout.Text>
        </Callout.Root>
      ) : null}

      {deepLinkedMissionId ? (
        <Callout.Root color="blue" size="1">
          <Callout.Icon>
            <LightningBoltIcon />
          </Callout.Icon>
          <Callout.Text>Showing the automation selected from its processing notice.</Callout.Text>
          <Button
            size="1"
            variant="soft"
            onClick={() => {
              setDeepLinkedMissionId(null);
              void panel.stateArgs.set({ missionId: null });
            }}
          >
            View all automations
          </Button>
        </Callout.Root>
      ) : null}

      {overview?.attention.length ? (
        <Card size="3" style={{ background: "var(--red-a2)", borderColor: "var(--red-a6)" }}>
          <Flex align="center" gap="2" mb="1">
            <CrossCircledIcon color="var(--red-10)" />
            <Heading size="4">Needs attention</Heading>
            <Badge color="red" variant="soft">
              Last 24 hours
            </Badge>
          </Flex>
          <Text as="p" size="2" color="gray" mb="2">
            Recent failures are collected here so unattended work cannot fail silently.
          </Text>
          {overview.attention.map((item) => (
            <AttentionRow key={item.run.runId} item={item} />
          ))}
        </Card>
      ) : items.length > 0 && !loading ? (
        <Callout.Root color="green" size="1">
          <Callout.Icon>
            <CheckCircledIcon />
          </Callout.Icon>
          <Callout.Text>No automation failures in the last 24 hours.</Callout.Text>
        </Callout.Root>
      ) : null}

      <Flex
        direction={{ initial: "column", sm: "row" }}
        justify="between"
        align={{ initial: "stretch", sm: "center" }}
        gap="3"
        style={{ minWidth: 0 }}
      >
        <Box style={{ minWidth: 0, maxWidth: "100%", overflowX: "auto" }}>
          <SegmentedControl.Root
            value={filter}
            onValueChange={(value) => setFilter(value as Filter)}
            aria-label="Filter automations"
            style={{ minWidth: "max-content" }}
          >
            <SegmentedControl.Item value="all">All</SegmentedControl.Item>
            <SegmentedControl.Item value="attention">Attention</SegmentedControl.Item>
            <SegmentedControl.Item value="active">Active</SegmentedControl.Item>
            <SegmentedControl.Item value="paused">Paused</SegmentedControl.Item>
            <SegmentedControl.Item value="completed">Completed</SegmentedControl.Item>
            <SegmentedControl.Item value="drafts">Drafts</SegmentedControl.Item>
          </SegmentedControl.Root>
        </Box>
        <TextField.Root
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search automations"
          aria-label="Search automations"
          style={{ minWidth: 220 }}
        >
          <TextField.Slot>
            <MagnifyingGlassIcon />
          </TextField.Slot>
        </TextField.Root>
      </Flex>

      <Flex direction="column" gap="3" aria-live="polite" aria-busy={loading}>
        {loading && !overview ? (
          <Card size="3">
            <Flex align="center" justify="center" gap="2" py="7">
              <Spinner /> <Text color="gray">Loading automation overview…</Text>
            </Flex>
          </Card>
        ) : counts.total === 0 ? (
          <Card size="3" style={{ textAlign: "center" }}>
            <Flex direction="column" align="center" gap="2" py="6">
              <Box
                p="3"
                style={{
                  borderRadius: 999,
                  background: "var(--accent-a3)",
                  color: "var(--accent-11)",
                }}
              >
                <RocketIcon width={24} height={24} />
              </Box>
              <Heading size="4">No automations yet</Heading>
              <Text as="p" size="2" color="gray" style={{ maxWidth: 520 }}>
                Ask an agent to propose a periodic script or prompt. Its draft remains completely
                inert until you review its exact code, schedule, and authority here.
              </Text>
            </Flex>
          </Card>
        ) : items.length === 0 ? (
          <Card size="3">
            <Flex direction="column" align="center" gap="2" py="5">
              <MagnifyingGlassIcon width={22} height={22} />
              <Heading size="3">No matching automations</Heading>
              <Text size="2" color="gray">
                Change the filter or search phrase.
              </Text>
              <Button
                size="1"
                variant="soft"
                onClick={() => {
                  setFilter("all");
                  setQuery("");
                }}
              >
                Clear filters
              </Button>
            </Flex>
          </Card>
        ) : (
          items.map((item) => {
            const id = item.automation.missionId;
            const runs = mergeRuns(item.recentRuns, olderRuns[id] ?? []);
            return (
              <AutomationCard
                key={id}
                item={item}
                runs={runs}
                busyAction={busy?.id === id ? busy.action : null}
                loadingMore={loadingMoreId === id}
                canLoadMore={!exhausted.has(id) && runs.length < item.totalRuns}
                onAction={(method) => void action(item.automation, method)}
                onEdited={() => void load(true)}
                onLoadMore={() => void loadMore(item)}
                deepLinked={id === deepLinkedMissionId}
              />
            );
          })
        )}
        {overview?.nextCursor ? (
          <Button
            variant="soft"
            disabled={loadingMoreAutomations}
            onClick={() => void load(false, overview.nextCursor, true)}
            style={{ alignSelf: "center" }}
          >
            {loadingMoreAutomations ? <Spinner size="1" /> : null}
            Load more automations
          </Button>
        ) : null}
      </Flex>
    </AboutPage>
  );
}

export default function AutomationsPanelRoot() {
  return (
    <AboutThemeRoot>
      <AutomationsPage />
    </AboutThemeRoot>
  );
}
