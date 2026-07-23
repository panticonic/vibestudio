import { useEffect, useMemo } from "react";
import { Badge, Box, Button, Flex, Heading, Spinner, Text } from "@radix-ui/themes";
import { LockClosedIcon, ReloadIcon } from "@radix-ui/react-icons";
import type {
  BrowserImportSource,
  ImportHostSummary,
} from "@vibestudio/browser-data/client";
import { browserData, useAsync } from "../useBrowserData";

export interface ImportSourceSelection {
  host: ImportHostSummary;
  source: BrowserImportSource;
}

export function selectionKey(selection: ImportSourceSelection | null): string | null {
  return selection ? `${selection.host.hostId}\0${selection.source.sourceId}` : null;
}

export function ImportSourceRail(props: {
  selected: ImportSourceSelection | null;
  onSelect: (selection: ImportSourceSelection) => void;
}) {
  const hosts = useAsync<ImportHostSummary[]>(() => browserData.listImportHosts(), []);
  const availableHosts = hosts.state.data ?? [];
  const preferredHost = useMemo(
    () =>
      availableHosts.find((host) => host.location === "desktop" && host.connected) ??
      availableHosts.find((host) => host.connected) ??
      availableHosts[0],
    [availableHosts]
  );
  const selectedHost =
    availableHosts.find((host) => host.hostId === props.selected?.host.hostId) ?? preferredHost;
  const sources = useAsync<BrowserImportSource[]>(
    () => (selectedHost ? browserData.listImportSources(selectedHost.hostId) : Promise.resolve([])),
    [selectedHost?.hostId]
  );

  useEffect(() => {
    if (props.selected || !selectedHost || !sources.state.data?.length) return;
    const preferred =
      [...sources.state.data]
        .filter((source) => source.status === "readable")
        .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0] ??
      sources.state.data[0];
    if (preferred) props.onSelect({ host: selectedHost, source: preferred });
  }, [props, selectedHost, sources.state.data]);

  return (
    <Box
      p="3"
      style={{
        width: 280,
        flexShrink: 0,
        borderRight: "1px solid var(--gray-a5)",
        height: "100%",
        overflowY: "auto",
      }}
    >
      <Flex justify="between" align="center" mb="2">
        <Heading size="2">Import from</Heading>
        <Button size="1" variant="ghost" onClick={hosts.reload} aria-label="Refresh devices">
          <ReloadIcon /> Refresh
        </Button>
      </Flex>
      {hosts.state.status === "loading" && <Spinner size="1" />}
      {hosts.state.error && <Text color="red" size="1">{hosts.state.error}</Text>}

      <Flex direction="column" gap="3">
        {availableHosts.map((host) => {
          const active = selectedHost?.hostId === host.hostId;
          return (
            <Box key={host.hostId}>
              <Button
                size="1"
                variant={active ? "soft" : "ghost"}
                disabled={!host.connected}
                onClick={() => {
                  const first = sources.state.data?.[0];
                  if (first && active) props.onSelect({ host, source: first });
                }}
                style={{ width: "100%", justifyContent: "space-between" }}
              >
                {host.displayName}
                <Badge size="1" color={host.connected ? "green" : "gray"}>
                  {host.location === "desktop" ? "This device" : "Server"}
                </Badge>
              </Button>
              {active && (
                <Flex direction="column" gap="1" mt="2">
                  {sources.state.status === "loading" && <Spinner size="1" />}
                  {sources.state.error && <Text color="red" size="1">{sources.state.error}</Text>}
                  {sources.state.data?.map((source) => {
                    const selected = selectionKey(props.selected) === `${host.hostId}\0${source.sourceId}`;
                    return (
                      <Box
                        key={source.sourceId}
                        role="button"
                        tabIndex={0}
                        onClick={() => props.onSelect({ host, source })}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            props.onSelect({ host, source });
                          }
                        }}
                        p="2"
                        style={{
                          cursor: "pointer",
                          borderRadius: "var(--radius-2)",
                          background: selected ? "var(--accent-a4)" : "transparent",
                          border: selected
                            ? "1px solid var(--accent-a7)"
                            : "1px solid transparent",
                        }}
                      >
                        <Flex justify="between" gap="2">
                          <Text size="2" weight={selected ? "bold" : "regular"}>
                            {source.displayName}
                          </Text>
                          {source.status !== "readable" && <LockClosedIcon />}
                        </Flex>
                        <Text size="1" color="gray">
                          {source.localDataSetCount} local data{" "}
                          {source.localDataSetCount === 1 ? "set" : "sets"}
                        </Text>
                      </Box>
                    );
                  })}
                </Flex>
              )}
            </Box>
          );
        })}
      </Flex>
    </Box>
  );
}
