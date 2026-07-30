import { useCallback, useEffect, useState } from "react";
import { Button, Card, Flex, Heading, Select, Spinner, Text, TextField } from "@radix-ui/themes";
import { ClockIcon, ReloadIcon, TrashIcon } from "@radix-ui/react-icons";
import type { StoredHistory } from "@vibestudio/browser-data";
import { browserData, openPanel } from "@workspace/runtime";
import { AboutPage, AboutThemeRoot, Section } from "../../packages/about-shared/ui";

function HistoryPage() {
  const [history, setHistory] = useState<StoredHistory[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [clearRange, setClearRange] = useState("day");
  const load = useCallback(async (search = query) => {
    setLoading(true);
    setError(null);
    try {
      setHistory(await browserData.getHistory({ search: search.trim() || undefined, limit: 500 }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [query]);
  useEffect(() => void load(""), []);

  const clearSelectedRange = useCallback(async () => {
    const durations: Record<string, number> = {
      hour: 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
      week: 7 * 24 * 60 * 60 * 1000,
      month: 28 * 24 * 60 * 60 * 1000,
    };
    const label = clearRange === "all" ? "all browsing history" : `history from the selected range`;
    if (!window.confirm(`Clear ${label}? This cannot be undone.`)) return;
    try {
      if (clearRange === "all") {
        await browserData.clearAllHistory();
      } else {
        await browserData.deleteHistoryRange(Date.now() - durations[clearRange]!, Date.now());
      }
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [clearRange, load]);

  return (
    <AboutPage
      icon={<ClockIcon />}
      title="History"
      subtitle="Pages visited in this browser environment"
      maxWidth={900}
      actions={
        <Flex gap="2">
          <Button variant="soft" disabled={loading} onClick={() => void load()}>
            <ReloadIcon /> Refresh
          </Button>
          <Select.Root value={clearRange} onValueChange={setClearRange}>
            <Select.Trigger aria-label="History clear range" />
            <Select.Content>
              <Select.Item value="hour">Last hour</Select.Item>
              <Select.Item value="day">Last 24 hours</Select.Item>
              <Select.Item value="week">Last 7 days</Select.Item>
              <Select.Item value="month">Last 4 weeks</Select.Item>
              <Select.Item value="all">All time</Select.Item>
            </Select.Content>
          </Select.Root>
          <Button color="red" variant="soft" onClick={() => void clearSelectedRange()}>
            Clear
          </Button>
        </Flex>
      }
    >
      <Section>
        <TextField.Root
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void load();
          }}
          placeholder="Search history"
          aria-label="Search history"
        />
      </Section>
      {loading && history.length === 0 ? <Spinner /> : null}
      {error ? <Text color="red">{error}</Text> : null}
      {!loading && history.length === 0 ? <Text color="gray">No history found.</Text> : null}
      <Flex direction="column" gap="2">
        {history.map((entry) => (
          <Card key={entry.id}>
            <Flex justify="between" align="center" gap="3">
              <Flex direction="column" style={{ minWidth: 0 }}>
                <Heading size="3">{entry.title || entry.url}</Heading>
                <Text size="1" color="gray" truncate>{entry.url}</Text>
                <Text size="1" color="gray">
                  {new Date(entry.last_visit).toLocaleString()}
                </Text>
              </Flex>
              <Flex gap="2">
                <Button
                  size="1"
                  onClick={() => void openPanel(entry.url, { focus: true })}
                >
                  Open
                </Button>
                <Button
                  size="1"
                  color="red"
                  variant="soft"
                  onClick={() =>
                    void browserData
                      .deleteHistoryEntry(entry.id)
                      .then(() =>
                        setHistory((current) =>
                          current.filter((item) => item.id !== entry.id)
                        )
                      )
                  }
                >
                  <TrashIcon />
                </Button>
              </Flex>
            </Flex>
          </Card>
        ))}
      </Flex>
    </AboutPage>
  );
}

export default function AboutPanelRoot() {
  return (
    <AboutThemeRoot>
      <HistoryPage />
    </AboutThemeRoot>
  );
}
