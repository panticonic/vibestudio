/**
 * Custom message renderer: `system-testing.stage-report`.
 *
 * A full-width report card posted after each test category/stage. Header (title
 * + pass/fail/errored badges + duration) and the agent's prose summary are
 * always visible; the per-test table and per-failure diagnostics live behind
 * in-card disclosures. The detail views are designed UI — a chat-styled
 * transcript, a status-badged invocation table, participant chips, and bulleted
 * event lists — never a raw JSON dump.
 */

import { useState, type ReactNode } from "react";
import { Badge, Box, Callout, Card, Code, Flex, Heading, Separator, Text } from "@radix-ui/themes";
import {
  CheckCircledIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClipboardCopyIcon,
  CrossCircledIcon,
  ExclamationTriangleIcon,
} from "@radix-ui/react-icons";

// Shared types come from the sibling `report-types.ts`. This is a type-only
// import, so the sandbox compiler erases it — `report-types.ts` is never
// fetched into the panel context.
import type {
  FailureDiagnostic,
  StageReportCounts,
  StageReportState,
  StageTestRow,
} from "./report-types.js";

type RadixColor = "green" | "red" | "amber" | "blue" | "gray";

// ---------------------------------------------------------------------------
// Schema (dogfoods the custom-message schema-validation feature)
// ---------------------------------------------------------------------------

export function schema(state: unknown): string[] | null {
  if (!state || typeof state !== "object") return ["stage report state must be an object"];
  const s = state as Partial<StageReportState>;
  const errors: string[] = [];
  if (!s.runId) errors.push("missing runId");
  if (!s.category) errors.push("missing category");
  if (!s.counts || typeof s.counts !== "object") errors.push("missing counts");
  if (!Array.isArray(s.tests)) errors.push("tests must be an array");
  return errors.length ? errors : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (!ms || ms < 0) return "0s";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

/** Prefix-based mapping for `likelyIssue` (values may carry a `:names` suffix). */
function classifyIssue(likelyIssue: string): { prefix: string; suffix: string; color: RadixColor } {
  const [prefix, ...rest] = (likelyIssue ?? "").split(":");
  const suffix = rest.join(":");
  let color: RadixColor = "gray";
  if (prefix === "session-error" || prefix === "tool-error") color = "red";
  else if (prefix === "cleanup-error" || prefix === "incomplete-invocation") color = "amber";
  else if (prefix === "no-final-agent-message" || prefix === "validation-mismatch") color = "blue";
  return { prefix: prefix || "unknown", suffix, color };
}

function copyRaw(value: unknown): void {
  try {
    const text = JSON.stringify(value, null, 2);
    void (globalThis as { navigator?: { clipboard?: { writeText?: (t: string) => unknown } } })
      .navigator?.clipboard?.writeText?.(text);
  } catch {
    /* clipboard best-effort */
  }
}

// ---------------------------------------------------------------------------
// Generic disclosure
// ---------------------------------------------------------------------------

function Disclosure({
  label,
  count,
  defaultOpen = false,
  color = "gray",
  children,
}: {
  label: string;
  count?: number;
  defaultOpen?: boolean;
  color?: RadixColor;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Box>
      <Flex
        align="center"
        gap="1"
        onClick={() => setOpen((v) => !v)}
        style={{ cursor: "pointer", userSelect: "none", padding: "2px 0" }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
        <Text size="2" weight="medium" color={color === "gray" ? undefined : color}>
          {label}
        </Text>
        {typeof count === "number" && (
          <Badge size="1" color={color} variant="soft">{count}</Badge>
        )}
      </Flex>
      {open && <Box mt="2" ml="3">{children}</Box>}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function StatusBadges({ counts }: { counts: StageReportCounts }) {
  return (
    <Flex align="center" gap="2" wrap="wrap">
      <Badge color="green" variant="soft">
        <CheckCircledIcon /> {counts.passed}
      </Badge>
      <Badge color={counts.failed ? "red" : "gray"} variant="soft">
        <CrossCircledIcon /> {counts.failed}
      </Badge>
      <Badge color={counts.errored ? "amber" : "gray"} variant="soft">
        <ExclamationTriangleIcon /> {counts.errored}
      </Badge>
      <Text size="1" color="gray">{formatDuration(counts.durationMs)}</Text>
    </Flex>
  );
}

// ---------------------------------------------------------------------------
// Test table
// ---------------------------------------------------------------------------

function statusColor(status: StageTestRow["status"]): RadixColor {
  if (status === "passed") return "green";
  if (status === "errored") return "amber";
  return "red";
}

function StatusIcon({ status }: { status: StageTestRow["status"] }) {
  if (status === "passed") return <CheckCircledIcon color="var(--green-9)" />;
  if (status === "errored") return <ExclamationTriangleIcon color="var(--amber-9)" />;
  return <CrossCircledIcon color="var(--red-9)" />;
}

function TestRow({ test, defaultOpen = false }: { test: StageTestRow; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const turns = test.detail?.conversation?.length ?? 0;
  const calls = test.detail?.invocations?.length ?? 0;
  return (
    <Box style={{ borderBottom: "1px solid var(--gray-a3)" }}>
      <Flex
        align="center"
        gap="2"
        py="1"
        onClick={() => setOpen((v) => !v)}
        style={{ cursor: "pointer" }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
        <StatusIcon status={test.status} />
        <Code size="2" variant="ghost" style={{ flex: 1, minWidth: 0 }}>{test.name}</Code>
        {turns > 0 && <Text size="1" color="gray">{turns} msg</Text>}
        {calls > 0 && <Text size="1" color="gray">{calls} calls</Text>}
        <Text size="1" color="gray">{formatDuration(test.durationMs)}</Text>
      </Flex>
      {!open && test.reason && test.status !== "passed" && (
        <Box ml="6" pb="1">
          <Text size="1" color={statusColor(test.status)} style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
            {test.reason}
          </Text>
        </Box>
      )}
      {open && (
        <Box ml="6" pb="2">
          {test.detail ? <TestDetail diagnostic={test.detail} /> : (
            <Text size="1" color="gray">No diagnostics captured for this test.</Text>
          )}
        </Box>
      )}
    </Box>
  );
}

function TestTable({ tests }: { tests: StageTestRow[] }) {
  return (
    <Box>
      {tests.map((test) => (
        <TestRow key={test.name} test={test} />
      ))}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Failure detail (designed views — no JSON barf)
// ---------------------------------------------------------------------------

function LabeledCallout({ label, color, children }: { label: string; color: RadixColor; children: ReactNode }) {
  return (
    <Callout.Root color={color} size="1" my="1">
      <Callout.Text>
        <Text size="1" weight="medium">{label}: </Text>
        <Text size="1" style={{ whiteSpace: "pre-wrap" }}>{children}</Text>
      </Callout.Text>
    </Callout.Root>
  );
}

function Transcript({ conversation }: { conversation: FailureDiagnostic["conversation"] }) {
  return (
    <Flex direction="column" gap="2">
      {conversation.map((turn, i) => {
        const isAgent = turn.who === "agent";
        return (
          <Box
            key={i}
            style={{
              borderLeft: turn.error ? "2px solid var(--red-7)" : "2px solid var(--gray-a5)",
              paddingLeft: 8,
              background: isAgent ? "var(--gray-a2)" : "transparent",
              borderRadius: 4,
            }}
            p="1"
          >
            <Flex align="center" gap="2" mb="1">
              <Badge size="1" color={isAgent ? "blue" : "gray"} variant="soft">{turn.who}</Badge>
              <Text size="1" color="gray">{turn.type}</Text>
              {turn.pending && <Badge size="1" color="amber" variant="surface">pending</Badge>}
              {turn.complete === false && <Badge size="1" color="amber" variant="surface">incomplete</Badge>}
            </Flex>
            {turn.text && (
              <Text size="1" style={{ whiteSpace: "pre-wrap", display: "block" }}>{turn.text}</Text>
            )}
            {turn.error && <Text size="1" color="red" style={{ whiteSpace: "pre-wrap" }}>{turn.error}</Text>}
          </Box>
        );
      })}
    </Flex>
  );
}

function InvocationRow({ inv }: { inv: FailureDiagnostic["invocations"][number] }) {
  const [open, setOpen] = useState(false);
  const color: RadixColor = inv.status === "complete" && !inv.error && !inv.isError ? "green" : inv.error || inv.isError ? "red" : "gray";
  const hasDetail = Boolean(inv.argumentSummary || inv.resultSummary || inv.error);
  return (
    <Box style={{ borderBottom: "1px solid var(--gray-a3)" }} py="1">
      <Flex align="center" gap="2" onClick={hasDetail ? () => setOpen((v) => !v) : undefined} style={{ cursor: hasDetail ? "pointer" : "default" }}>
        {hasDetail ? (open ? <ChevronDownIcon /> : <ChevronRightIcon />) : <Box style={{ width: 15 }} />}
        <Code size="1" variant="ghost" style={{ flex: 1, minWidth: 0 }}>{inv.name}</Code>
        <Badge size="1" color={color} variant="soft">{inv.status}</Badge>
      </Flex>
      {inv.error && !open && (
        <Box ml="6"><Text size="1" color="red" style={{ display: "-webkit-box", WebkitLineClamp: 1, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{inv.error}</Text></Box>
      )}
      {open && (
        <Box ml="6" mt="1">
          {inv.argumentSummary && <LabeledCallout label="args" color="gray">{inv.argumentSummary}</LabeledCallout>}
          {inv.resultSummary && <LabeledCallout label="result" color="gray">{inv.resultSummary}</LabeledCallout>}
          {inv.error && <LabeledCallout label="error" color="red">{inv.error}</LabeledCallout>}
        </Box>
      )}
    </Box>
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <Flex direction="column" gap="1">
      {items.map((item, i) => (
        <Code key={i} size="1" variant="soft" style={{ whiteSpace: "pre-wrap" }}>{item}</Code>
      ))}
    </Flex>
  );
}

function Participants({ participants }: { participants: FailureDiagnostic["participants"] }) {
  return (
    <Flex gap="2" wrap="wrap">
      {participants.map((p) => (
        <Badge key={p.id} variant="soft" color={p.connected === false ? "red" : "green"}>
          <Box style={{ width: 6, height: 6, borderRadius: "50%", background: p.connected === false ? "var(--red-9)" : "var(--green-9)" }} />
          {p.name ?? p.id}{p.type ? ` · ${p.type}` : ""}
        </Badge>
      ))}
    </Flex>
  );
}

function TestDetail({ diagnostic, defaultOpenTranscript = false }: { diagnostic: FailureDiagnostic; defaultOpenTranscript?: boolean }) {
  const issue = classifyIssue(diagnostic.likelyIssue);
  return (
    <Card variant="surface" my="1">
      <Flex direction="column" gap="2">
        <Flex align="center" justify="between" gap="2" wrap="wrap">
          <Flex align="center" gap="2">
            <Code size="2">{diagnostic.name}</Code>
            {diagnostic.passed ? (
              <Badge color="green" variant="soft"><CheckCircledIcon /> passed</Badge>
            ) : (
              <Badge color={issue.color} variant="solid">
                {issue.prefix}{issue.suffix ? <Text size="1" style={{ opacity: 0.8 }}>&nbsp;{issue.suffix}</Text> : null}
              </Badge>
            )}
          </Flex>
          <Flex align="center" gap="2">
            <Text size="1" color="gray">{formatDuration(diagnostic.durationMs)}</Text>
            <Box onClick={() => copyRaw(diagnostic)} style={{ cursor: "pointer" }} title="Copy raw diagnostics JSON">
              <ClipboardCopyIcon />
            </Box>
          </Flex>
        </Flex>

        <Text size="1" color="gray" style={{ whiteSpace: "pre-wrap" }}>{diagnostic.prompt}</Text>

        {diagnostic.validationReason && <LabeledCallout label="Validation" color="red">{diagnostic.validationReason}</LabeledCallout>}
        {diagnostic.sessionError && <LabeledCallout label="Session error" color="red">{diagnostic.sessionError}</LabeledCallout>}
        {diagnostic.finalAgentMessage && <LabeledCallout label="Final agent message" color="gray">{diagnostic.finalAgentMessage}</LabeledCallout>}

        {diagnostic.conversation.length > 0 && (
          <Disclosure label="Transcript" count={diagnostic.conversation.length} defaultOpen={defaultOpenTranscript}>
            <Transcript conversation={diagnostic.conversation} />
          </Disclosure>
        )}
        {diagnostic.invocations.length > 0 && (
          <Disclosure label="Tool calls" count={diagnostic.invocations.length}>
            <Box>{diagnostic.invocations.map((inv, i) => <InvocationRow key={i} inv={inv} />)}</Box>
          </Disclosure>
        )}
        {diagnostic.debugEvents.length > 0 && (
          <Disclosure label="Debug events" count={diagnostic.debugEvents.length}>
            <BulletList items={diagnostic.debugEvents} />
          </Disclosure>
        )}
        {diagnostic.cleanupErrors.length > 0 && (
          <Disclosure label="Cleanup errors" count={diagnostic.cleanupErrors.length} color="amber">
            <BulletList items={diagnostic.cleanupErrors} />
          </Disclosure>
        )}
        {diagnostic.participants.length > 0 && (
          <Disclosure label="Participants" count={diagnostic.participants.length}>
            <Participants participants={diagnostic.participants} />
          </Disclosure>
        )}
      </Flex>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export default function StageReport({ state }: { state: StageReportState }) {
  if (!state || !state.category) {
    return (
      <Card><Text size="1" color="gray">(empty stage report)</Text></Card>
    );
  }
  const anyFail = state.counts.failed > 0 || state.counts.errored > 0;
  const failing = state.tests.filter((t) => !t.passed);
  return (
    <Card
      className="message-card"
      style={{ borderLeft: `3px solid var(--${anyFail ? "red" : "green"}-9)` }}
    >
      <Flex direction="column" gap="3">
        <Flex align="center" justify="between" gap="3" wrap="wrap">
          <Flex align="center" gap="2">
            {anyFail ? <CrossCircledIcon color="var(--red-9)" /> : <CheckCircledIcon color="var(--green-9)" />}
            <Heading size="3">{state.title}</Heading>
            <Text size="1" color="gray">stage</Text>
          </Flex>
          <StatusBadges counts={state.counts} />
        </Flex>

        {state.prose && (
          <Text size="2" style={{ whiteSpace: "pre-wrap" }}>{state.prose}</Text>
        )}

        <Separator size="4" />

        {failing.length > 0 && (
          <Disclosure label="Failures" count={failing.length} color="red" defaultOpen={failing.length <= 3}>
            <Flex direction="column" gap="2">
              {failing.map((test) => (
                <TestDetail key={test.name} diagnostic={test.detail} defaultOpenTranscript={failing.length === 1} />
              ))}
            </Flex>
          </Disclosure>
        )}

        <Disclosure label="All tests" count={state.counts.total} defaultOpen={!anyFail}>
          <TestTable tests={state.tests} />
        </Disclosure>
      </Flex>
    </Card>
  );
}
