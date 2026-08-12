import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Callout,
  Code,
  Dialog,
  Flex,
  Grid,
  Select,
  Separator,
  Spinner,
  Text,
  TextArea,
  TextField,
} from "@radix-ui/themes";
import {
  CheckCircledIcon,
  ClockIcon,
  CrossCircledIcon,
  ExclamationTriangleIcon,
  LightningBoltIcon,
  PauseIcon,
  Pencil2Icon,
  PlayIcon,
} from "@radix-ui/react-icons";
import type {
  AutomationActivityPayload,
  AutomationActivitySnapshot,
} from "@workspace/agentic-core";
import type {
  MissionCharter,
  MissionRecord,
  MissionRunRecord,
} from "@vibestudio/shared/authority/mission";

export interface AutomationUiClient {
  get(missionId: string): Promise<MissionRecord | null>;
  getRun(runId: string): Promise<MissionRunRecord | null>;
  edit(
    missionId: string,
    patch: { name?: string; charter?: MissionCharter }
  ): Promise<MissionRecord>;
  requestReview(missionId: string): Promise<MissionRecord>;
  pause(missionId: string): Promise<MissionRecord>;
  resume(missionId: string): Promise<MissionRecord>;
  runNow(missionId: string): Promise<MissionRunRecord>;
  openConversation?(run: MissionRunRecord): void;
}

export interface AutomationUiRpc {
  call(target: string, method: string, args: unknown[]): Promise<unknown>;
}

const resolvedTargetByRpc = new WeakMap<AutomationUiRpc, Promise<string>>();
const clientByRpc = new WeakMap<AutomationUiRpc, AutomationUiClient>();

export function createAutomationUiClient(
  rpc: AutomationUiRpc,
  openConversation?: (run: MissionRunRecord) => void
): AutomationUiClient {
  if (!openConversation) {
    const existing = clientByRpc.get(rpc);
    if (existing) return existing;
  }
  const target = () => {
    let targetPromise = resolvedTargetByRpc.get(rpc);
    if (targetPromise) return targetPromise;
    targetPromise = rpc
      .call("main", "workers.resolveService", ["vibestudio.missions.v1"])
      .then((value) => {
        const service = value as { kind?: unknown; targetId?: unknown };
        if (service.kind !== "durable-object" || !service.targetId) {
          throw new Error("The Automations service is unavailable");
        }
        return String(service.targetId);
      })
      .catch((error) => {
        resolvedTargetByRpc.delete(rpc);
        throw error;
      });
    resolvedTargetByRpc.set(rpc, targetPromise);
    return targetPromise;
  };
  const call = async <T,>(method: string, args: unknown[]) =>
    (await rpc.call(await target(), method, args)) as T;
  const client: AutomationUiClient = {
    get: (missionId) => call("get", [missionId]),
    getRun: (runId) => call("getRun", [runId]),
    edit: (missionId, patch) => call("edit", [missionId, patch]),
    requestReview: (missionId) => call("requestReview", [missionId]),
    pause: (missionId) => call("pause", [missionId]),
    resume: (missionId) => call("resume", [missionId]),
    runNow: (missionId) => call("runNow", [missionId]),
    ...(openConversation ? { openConversation } : {}),
  };
  if (!openConversation) clientByRpc.set(rpc, client);
  return client;
}

export interface AutomationActivityProps {
  activity: AutomationActivityPayload;
  client: AutomationUiClient;
  automation?: MissionRecord | null;
  run?: MissionRunRecord | null;
  display?: "pill" | "row";
  onChanged?(automation: MissionRecord): void;
}

const definitionCaches = new WeakMap<
  AutomationUiClient,
  Map<string, Promise<MissionRecord | null>>
>();
const runCaches = new WeakMap<AutomationUiClient, Map<string, Promise<MissionRunRecord | null>>>();

function cacheFor<T>(
  owner: WeakMap<AutomationUiClient, Map<string, T>>,
  client: AutomationUiClient
) {
  let cache = owner.get(client);
  if (!cache) {
    cache = new Map();
    owner.set(client, cache);
  }
  return cache;
}

function cachedDefinition(client: AutomationUiClient, missionId: string) {
  const cache = cacheFor(definitionCaches, client);
  let pending = cache.get(missionId);
  if (!pending) {
    pending = client.get(missionId).catch((error) => {
      cache.delete(missionId);
      throw error;
    });
    cache.set(missionId, pending);
  }
  return pending;
}

function cachedRun(client: AutomationUiClient, runId: string) {
  const cache = cacheFor(runCaches, client);
  let pending = cache.get(runId);
  if (!pending) {
    pending = client.getRun(runId).catch((error) => {
      cache.delete(runId);
      throw error;
    });
    cache.set(runId, pending);
  }
  return pending;
}

function formatAbsolute(value: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    value
  );
}

export function formatAutomationInterval(value: number): string {
  if (value % 86_400_000 === 0)
    return `${value / 86_400_000} day${value === 86_400_000 ? "" : "s"}`;
  if (value % 3_600_000 === 0) return `${value / 3_600_000} hour${value === 3_600_000 ? "" : "s"}`;
  if (value % 60_000 === 0) return `${value / 60_000} minute${value === 60_000 ? "" : "s"}`;
  return `${Math.round(value / 1_000)} seconds`;
}

function scheduleSummary(snapshot: AutomationActivitySnapshot): string {
  return snapshot.schedule
    ? `Every ${formatAutomationInterval(snapshot.schedule.everyMs)}`
    : "Manual";
}

function activityStatus(activity: AutomationActivityPayload) {
  if (activity.status === "succeeded") {
    return { label: "Completed", color: "green" as const, icon: <CheckCircledIcon /> };
  }
  if (activity.status === "failed") {
    return { label: "Failed", color: "red" as const, icon: <CrossCircledIcon /> };
  }
  if (activity.status === "skipped") {
    return { label: "Skipped", color: "amber" as const, icon: <ExclamationTriangleIcon /> };
  }
  return { label: "Running", color: "blue" as const, icon: <Spinner size="1" /> };
}

function durationLabel(startedAt: number, finishedAt?: number): string {
  if (finishedAt === undefined) return "In progress";
  const elapsed = Math.max(0, finishedAt - startedAt);
  if (elapsed < 1_000) return "<1s";
  if (elapsed < 60_000) return `${Math.round(elapsed / 1_000)}s`;
  return `${Math.floor(elapsed / 60_000)}m ${Math.round((elapsed % 60_000) / 1_000)}s`;
}

function editableInterval(trigger: MissionCharter["trigger"]): { amount: string; unit: string } {
  if (trigger.kind === "manual") return { amount: "1", unit: "day" };
  if (trigger.everyMs % 86_400_000 === 0)
    return { amount: String(trigger.everyMs / 86_400_000), unit: "day" };
  if (trigger.everyMs % 3_600_000 === 0)
    return { amount: String(trigger.everyMs / 3_600_000), unit: "hour" };
  return { amount: String(trigger.everyMs / 60_000), unit: "minute" };
}

const UNIT_MS: Record<string, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

export function AutomationParametersEditor({
  automation,
  client,
  onSaved,
  onCancel,
}: {
  automation: MissionRecord;
  client: AutomationUiClient;
  onSaved(value: MissionRecord): void;
  onCancel(): void;
}) {
  const initialInterval = editableInterval(automation.charter.trigger);
  const [name, setName] = useState(automation.name);
  const [summary, setSummary] = useState(automation.charter.summary);
  const [scheduled, setScheduled] = useState(automation.charter.trigger.kind === "schedule");
  const [amount, setAmount] = useState(initialInterval.amount);
  const [unit, setUnit] = useState(initialInterval.unit);
  const [payload, setPayload] = useState(() => {
    const execution = automation.charter.execution;
    if (execution.kind === "method") return JSON.stringify(execution.args, null, 2);
    return execution.action.kind === "prompt" ? execution.action.text : execution.action.code;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const execution = automation.charter.execution;

  const save = useCallback(async () => {
    const numericAmount = Number(amount);
    const everyMs = Math.round(numericAmount * UNIT_MS[unit]!);
    if (!name.trim() || !summary.trim() || !payload.trim()) {
      setError("Name, purpose, and action are required.");
      return;
    }
    if (scheduled && (!Number.isFinite(everyMs) || everyMs < 60_000)) {
      setError("Recurring schedules must run no more often than once per minute.");
      return;
    }
    let nextExecution: MissionCharter["execution"];
    try {
      nextExecution =
        execution.kind === "method"
          ? { ...execution, args: JSON.parse(payload) as unknown[] }
          : execution.action.kind === "prompt"
            ? { ...execution, action: { kind: "prompt", text: payload } }
            : { ...execution, action: { ...execution.action, code: payload } };
      if (nextExecution.kind === "method" && !Array.isArray(nextExecution.args)) {
        throw new Error("Method arguments must be a JSON array.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const previous = automation.charter.trigger;
      const charter: MissionCharter = {
        ...automation.charter,
        summary: summary.trim(),
        execution: nextExecution,
        trigger: scheduled
          ? {
              kind: "schedule",
              everyMs,
              ...(previous.kind === "schedule" && previous.anchorAt !== undefined
                ? { anchorAt: previous.anchorAt }
                : {}),
              ...(previous.kind === "schedule" &&
              previous.jitterMs !== undefined &&
              previous.jitterMs < everyMs
                ? { jitterMs: previous.jitterMs }
                : {}),
            }
          : { kind: "manual" },
      };
      onSaved(await client.edit(automation.missionId, { name: name.trim(), charter }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [amount, automation, client, execution, name, onSaved, payload, scheduled, summary, unit]);

  return (
    <Flex direction="column" gap="3">
      <Callout.Root color="amber" size="1">
        <Callout.Icon>
          <ExclamationTriangleIcon />
        </Callout.Icon>
        <Callout.Text>
          Saving changes stops the current schedule until you review the new exact revision.
        </Callout.Text>
      </Callout.Root>
      <Grid columns={{ initial: "1", sm: "2" }} gap="3">
        <TextField.Root
          aria-label="Automation name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Automation name"
        />
        <Flex gap="2" align="center">
          <Select.Root
            value={scheduled ? "scheduled" : "manual"}
            onValueChange={(value) => setScheduled(value === "scheduled")}
          >
            <Select.Trigger style={{ flex: 1 }} />
            <Select.Content>
              <Select.Item value="scheduled">Recurring</Select.Item>
              <Select.Item value="manual">Manual only</Select.Item>
            </Select.Content>
          </Select.Root>
          {scheduled ? (
            <>
              <TextField.Root
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                style={{ width: 72 }}
              />
              <Select.Root value={unit} onValueChange={setUnit}>
                <Select.Trigger />
                <Select.Content>
                  <Select.Item value="minute">minutes</Select.Item>
                  <Select.Item value="hour">hours</Select.Item>
                  <Select.Item value="day">days</Select.Item>
                </Select.Content>
              </Select.Root>
            </>
          ) : null}
        </Flex>
      </Grid>
      <TextArea
        aria-label="Automation purpose"
        value={summary}
        onChange={(event) => setSummary(event.target.value)}
        placeholder="What this automation does"
        resize="vertical"
      />
      <Box>
        <Text as="div" size="1" color="gray" mb="1">
          {execution.kind === "method"
            ? "Method arguments (JSON array)"
            : execution.action.kind === "eval"
              ? "Exact eval code"
              : "Prompt text"}
        </Text>
        <TextArea
          aria-label={
            execution.kind === "method"
              ? "Method arguments"
              : execution.action.kind === "eval"
                ? "Eval code"
                : "Prompt text"
          }
          value={payload}
          onChange={(event) => setPayload(event.target.value)}
          resize="vertical"
          style={{
            minHeight: execution.kind === "agent" && execution.action.kind === "eval" ? 220 : 120,
            fontFamily:
              execution.kind === "agent" && execution.action.kind === "eval"
                ? "var(--code-font-family)"
                : undefined,
          }}
        />
      </Box>
      {error ? (
        <Callout.Root color="red" size="1">
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      ) : null}
      <Flex justify="end" gap="2">
        <Button variant="soft" color="gray" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={saving} onClick={() => void save()}>
          {saving ? <Spinner size="1" /> : null}Save as new revision
        </Button>
      </Flex>
    </Flex>
  );
}

function Inspector({
  activity,
  automation,
  run,
  client,
  onChanged,
}: {
  activity: AutomationActivityPayload;
  automation: MissionRecord | null;
  run: MissionRunRecord | null;
  client: AutomationUiClient;
  onChanged?(automation: MissionRecord): void;
}) {
  const [current, setCurrent] = useState(automation);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => setCurrent(automation), [automation]);
  const changed = useCallback(
    (value: MissionRecord) => {
      cacheFor(definitionCaches, client).set(value.missionId, Promise.resolve(value));
      setCurrent(value);
      setEditing(false);
      onChanged?.(value);
    },
    [client, onChanged]
  );
  const action = useCallback(
    async (kind: "pause" | "resume" | "requestReview" | "runNow") => {
      if (!current) return;
      setBusy(kind);
      setError(null);
      setNotice(null);
      try {
        if (kind === "runNow") {
          await client.runNow(current.missionId);
          setNotice("A new tick has started. It will appear in history when its turn opens.");
        } else {
          changed(await client[kind](current.missionId));
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(null);
      }
    },
    [changed, client, current]
  );

  if (!current)
    return (
      <Callout.Root color="amber">
        <Callout.Text>
          This automation definition is no longer available. The tick provenance remains in history.
        </Callout.Text>
      </Callout.Root>
    );
  if (editing)
    return (
      <AutomationParametersEditor
        automation={current}
        client={client}
        onSaved={changed}
        onCancel={() => setEditing(false)}
      />
    );
  const execution = current.charter.execution;
  return (
    <Flex direction="column" gap="4">
      <Flex justify="between" gap="3" wrap="wrap">
        <Box>
          <Text as="div" size="1" color="gray">
            Purpose
          </Text>
          <Text size="2">{current.charter.summary}</Text>
        </Box>
        <Flex gap="2" wrap="wrap">
          {current.state !== "retired" ? (
            <Button size="1" variant="soft" onClick={() => setEditing(true)}>
              <Pencil2Icon />
              Edit parameters
            </Button>
          ) : null}
          {current.state === "active" ? (
            <Button
              size="1"
              variant="soft"
              disabled={busy !== null}
              onClick={() => void action("runNow")}
            >
              {busy === "runNow" ? <Spinner size="1" /> : <LightningBoltIcon />}
              Run now
            </Button>
          ) : null}
          {current.state === "active" ? (
            <Button
              size="1"
              color="red"
              variant="soft"
              disabled={busy !== null}
              onClick={() => void action("pause")}
            >
              <PauseIcon />
              {current.charter.trigger.kind === "schedule"
                ? "Stop recurring calls"
                : "Pause automation"}
            </Button>
          ) : null}
          {current.state === "paused" ? (
            <Button
              size="1"
              variant="soft"
              disabled={busy !== null}
              onClick={() => void action("resume")}
            >
              <PlayIcon />
              Resume
            </Button>
          ) : null}
          {current.state === "draft" || current.state === "needs-reapproval" ? (
            <Button size="1" disabled={busy !== null} onClick={() => void action("requestReview")}>
              <CheckCircledIcon />
              Review changes
            </Button>
          ) : null}
        </Flex>
      </Flex>
      {error ? (
        <Callout.Root color="red" size="1">
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      ) : null}
      {notice ? (
        <Callout.Root color="green" size="1">
          <Callout.Text>{notice}</Callout.Text>
        </Callout.Root>
      ) : null}
      <Grid columns={{ initial: "1", sm: "3" }} gap="3">
        <Box>
          <Text as="div" size="1" color="gray">
            Cadence
          </Text>
          <Text size="2" weight="medium">
            {current.charter.trigger.kind === "schedule"
              ? `Every ${formatAutomationInterval(current.charter.trigger.everyMs)}`
              : "Manual only"}
          </Text>
        </Box>
        <Box>
          <Text as="div" size="1" color="gray">
            First activated
          </Text>
          <Text size="2" weight="medium">
            {current.activatedAt !== undefined
              ? formatAbsolute(current.activatedAt)
              : current.state === "draft"
                ? "Awaiting first activation"
                : "Not recorded"}
          </Text>
        </Box>
        <Box>
          <Text as="div" size="1" color="gray">
            Revision
          </Text>
          <Text size="2" weight="medium">
            r{current.revision} · {current.state}
          </Text>
        </Box>
      </Grid>
      <Separator size="4" />
      <Box>
        <Flex align="center" gap="2" mb="2">
          <LightningBoltIcon />
          <Text weight="medium">This tick</Text>
          <Badge color={activityStatus(activity).color} variant="soft">
            {activityStatus(activity).label}
          </Badge>
        </Flex>
        <Grid columns={{ initial: "1", sm: "3" }} gap="3">
          <Box>
            <Text as="div" size="1" color="gray">
              Started
            </Text>
            <Text size="2">{formatAbsolute(run?.startedAt ?? activity.snapshot.startedAt)}</Text>
          </Box>
          <Box>
            <Text as="div" size="1" color="gray">
              Duration
            </Text>
            <Text size="2">
              {durationLabel(
                run?.startedAt ?? activity.snapshot.startedAt,
                run?.finishedAt ?? (activity.closedAt ? Date.parse(activity.closedAt) : undefined)
              )}
            </Text>
          </Box>
          <Box>
            <Text as="div" size="1" color="gray">
              Trigger
            </Text>
            <Text size="2">
              {activity.snapshot.trigger === "scheduled" ? "Scheduled tick" : "Run now"}
            </Text>
          </Box>
        </Grid>
        {run?.error || (activity.status === "failed" && activity.summary) ? (
          <Callout.Root color={activity.status === "skipped" ? "amber" : "red"} size="1" mt="3">
            <Callout.Icon>
              <CrossCircledIcon />
            </Callout.Icon>
            <Callout.Text>{run?.error ?? activity.summary}</Callout.Text>
          </Callout.Root>
        ) : null}
        {run?.finalMessage || (activity.status === "succeeded" && activity.summary) ? (
          <Box
            mt="3"
            p="3"
            style={{
              borderRadius: "var(--radius-2)",
              background: "var(--gray-a2)",
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              maxHeight: 260,
              overflow: "auto",
            }}
          >
            <Text size="2">{run?.finalMessage ?? activity.summary}</Text>
          </Box>
        ) : null}
        {run && client.openConversation && run.channelId && run.contextId ? (
          <Button size="1" variant="soft" mt="3" onClick={() => client.openConversation?.(run)}>
            Open conversation
          </Button>
        ) : null}
      </Box>
      <details>
        <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--gray-11)" }}>
          Technical provenance
        </summary>
        <Flex direction="column" gap="2" mt="2">
          <Code size="1" style={{ overflowWrap: "anywhere" }}>
            tick revision r{activity.snapshot.revision} · {activity.snapshot.action}
          </Code>
          <Code size="1" style={{ overflowWrap: "anywhere" }}>
            run {activity.snapshot.runId}
          </Code>
          {run ? (
            <Code size="1" style={{ overflowWrap: "anywhere" }}>
              reviewed closure {run.closureDigest}
            </Code>
          ) : null}
          {current.revision === activity.snapshot.revision ? (
            <>
              <Code size="1" style={{ overflowWrap: "anywhere" }}>
                {current.charter.harness.unit}@{current.charter.harness.ev}
              </Code>
              <Code size="1" style={{ overflowWrap: "anywhere" }}>
                {execution.target.className} · {execution.target.objectKey}
              </Code>
            </>
          ) : (
            <Text size="1" color="amber">
              The automation is now at r{current.revision}; edit controls affect the current
              revision, while this tick remains bound to the closure above.
            </Text>
          )}
        </Flex>
      </details>
    </Flex>
  );
}

export const AutomationActivity = React.memo(function AutomationActivity({
  activity,
  client,
  automation: suppliedAutomation,
  run: suppliedRun,
  display = "pill",
  onChanged,
}: AutomationActivityProps) {
  const [open, setOpen] = useState(false);
  const [automation, setAutomation] = useState<MissionRecord | null | undefined>(
    suppliedAutomation
  );
  const [run, setRun] = useState<MissionRunRecord | null | undefined>(suppliedRun);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setAutomation(suppliedAutomation), [suppliedAutomation]);
  useEffect(() => setRun(suppliedRun), [suppliedRun]);
  useEffect(() => {
    if (!open || (automation !== undefined && run !== undefined)) return;
    let cancelled = false;
    setError(null);
    void Promise.all([
      automation === undefined ? cachedDefinition(client, activity.snapshot.missionId) : automation,
      run === undefined ? cachedRun(client, activity.snapshot.runId) : run,
    ])
      .then(([nextAutomation, nextRun]) => {
        if (cancelled) return;
        setAutomation(nextAutomation);
        setRun(nextRun);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [activity.snapshot.missionId, activity.snapshot.runId, automation, client, open, run]);
  const status = useMemo(() => activityStatus(activity), [activity]);
  const since = activity.snapshot.activatedAt ?? activity.snapshot.createdAt;
  const isRunRow = display === "row";
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger>
        <button
          type="button"
          aria-label={`Inspect automation tick ${activity.snapshot.name}`}
          style={{
            border: 0,
            padding: 0,
            background: "transparent",
            cursor: "pointer",
            textAlign: "left",
            maxWidth: "100%",
          }}
        >
          <Flex
            align="center"
            gap="2"
            wrap="wrap"
            px={display === "row" ? "0" : "2"}
            py="1"
            style={
              display === "pill"
                ? {
                    border: "1px solid var(--gray-a6)",
                    borderRadius: 999,
                    background: "var(--gray-a2)",
                  }
                : undefined
            }
          >
            <Badge color={status.color} variant="soft">
              {status.icon}
              {status.label}
            </Badge>
            <Text size="2" weight="medium" truncate>
              {isRunRow
                ? activity.snapshot.trigger === "scheduled"
                  ? "Scheduled tick"
                  : "Run now"
                : activity.snapshot.name}
            </Text>
            <Text size="1" color="gray">
              <ClockIcon />{" "}
              {isRunRow
                ? `${formatAbsolute(activity.snapshot.startedAt)} · ${durationLabel(activity.snapshot.startedAt, activity.closedAt ? Date.parse(activity.closedAt) : undefined)}`
                : `${scheduleSummary(activity.snapshot)} · since ${formatAbsolute(since)}`}
            </Text>
          </Flex>
        </button>
      </Dialog.Trigger>
      <Dialog.Content maxWidth="760px" aria-describedby={undefined}>
        <Dialog.Title>{activity.snapshot.name}</Dialog.Title>
        <Dialog.Description size="2" color="gray" mb="4">
          Reviewed automation and exact tick details
        </Dialog.Description>
        {error ? (
          <Callout.Root color="red">
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        ) : automation === undefined || run === undefined ? (
          <Flex justify="center" py="6">
            <Spinner />
          </Flex>
        ) : (
          <Inspector
            activity={activity}
            automation={automation}
            run={run}
            client={client}
            onChanged={(value) => {
              setAutomation(value);
              onChanged?.(value);
            }}
          />
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
});
