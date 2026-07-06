import { Badge, Box, Code, Flex, Text } from "@radix-ui/themes";
import { MagnifyingGlassIcon } from "@radix-ui/react-icons";

// Loosely typed — the panel compiles this renderer in its sandbox; the worker
// (findings-card.ts) is the authoritative shape.
interface FindingEntry {
  id: string;
  ts?: string;
  cls: "BUG" | "DOC-MISMATCH" | "SURPRISING";
  surface: string;
  title: string;
  severity: "low" | "medium" | "high";
}
interface FindingsState {
  runId?: string;
  updatedAt?: string;
  filePath?: string;
  total?: number;
  counts?: Record<string, number>;
  findings?: FindingEntry[];
}

const CLASS_COLOR: Record<string, "red" | "amber" | "blue" | "gray"> = {
  BUG: "red",
  "DOC-MISMATCH": "amber",
  SURPRISING: "blue",
};

export function Pill({ state }: { state: Partial<FindingsState> }) {
  const bugs = state.counts?.["BUG"] ?? 0;
  return (
    <Flex align="center" gap="1">
      <MagnifyingGlassIcon />
      <Text size="1" weight="medium">
        Explorer findings
      </Text>
      {bugs > 0 ? <Badge color="red">{bugs} bug</Badge> : null}
      <Badge color="gray">{state.total ?? state.findings?.length ?? 0}</Badge>
    </Flex>
  );
}

export default function FindingsCard({
  state,
  expanded,
}: {
  state: Partial<FindingsState>;
  expanded: boolean;
}) {
  if (!expanded) return <Pill state={state} />;
  const findings = state.findings ?? [];
  return (
    <Flex direction="column" gap="2">
      <Flex align="center" gap="2" wrap="wrap">
        <MagnifyingGlassIcon />
        <Text weight="bold">Explorer findings · {state.runId ?? "run"}</Text>
        <Badge color="red">{state.counts?.["BUG"] ?? 0} bug</Badge>
        <Badge color="amber">{state.counts?.["DOC-MISMATCH"] ?? 0} doc</Badge>
        <Badge color="blue">{state.counts?.["SURPRISING"] ?? 0} surprising</Badge>
        <Text size="1" color="gray">
          {state.total ?? findings.length} total
        </Text>
      </Flex>
      {findings.length === 0 ? (
        <Text size="1" color="gray">
          No findings yet this run.
        </Text>
      ) : (
        findings.map((f) => (
          <Box
            key={f.id}
            style={{ borderTop: "1px solid var(--gray-4)", paddingTop: 6 }}
          >
            <Flex align="center" gap="2" wrap="wrap">
              <Badge color={CLASS_COLOR[f.cls] ?? "gray"}>{f.cls}</Badge>
              <Text size="2" weight="medium">
                {f.title}
              </Text>
              <Badge color="gray">{f.severity}</Badge>
            </Flex>
            <Code size="1" variant="ghost" color="gray">
              {f.surface}
            </Code>
          </Box>
        ))
      )}
      {state.filePath ? (
        <Text size="1" color="gray">
          Full log: <Code size="1">{state.filePath}</Code>
        </Text>
      ) : null}
    </Flex>
  );
}
