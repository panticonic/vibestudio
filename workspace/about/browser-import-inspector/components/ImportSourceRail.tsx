import { useEffect, useMemo, useState } from "react";
import { Badge, Box, Button, Flex, Heading, Select, Spinner, Text } from "@radix-ui/themes";
import { LockClosedIcon, ReloadIcon } from "@radix-ui/react-icons";
import type { BrowserImportSource, ImportHostSummary } from "@vibestudio/browser-data/client";
import { browserData, useAsync } from "../useBrowserData";
import { useIsMobile } from "@workspace/react/responsive";

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
  const isMobile = useIsMobile();
  const [requestedHostId, setRequestedHostId] = useState<string | null>(null);
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
    availableHosts.find((host) => host.hostId === requestedHostId) ??
    availableHosts.find((host) => host.hostId === props.selected?.host.hostId) ??
    preferredHost;
  const sources = useAsync<BrowserImportSource[]>(
    () => (selectedHost ? browserData.listImportSources(selectedHost.hostId) : Promise.resolve([])),
    [selectedHost?.hostId]
  );
  const availableSources = sources.state.status === "ready" ? (sources.state.data ?? []) : [];

  useEffect(() => {
    if (!selectedHost || availableSources.length === 0) return;
    const selectedSourceStillMatches =
      props.selected?.host.hostId === selectedHost.hostId &&
      availableSources.some((source) => source.sourceId === props.selected?.source.sourceId);
    if (selectedSourceStillMatches) return;
    const preferred =
      [...availableSources]
        .filter((source) => source.status === "readable")
        .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0] ??
      availableSources[0];
    if (preferred) props.onSelect({ host: selectedHost, source: preferred });
  }, [availableSources, props, selectedHost]);

  const selectSource = (sourceId: string) => {
    const source = availableSources.find((candidate) => candidate.sourceId === sourceId);
    if (selectedHost && source) props.onSelect({ host: selectedHost, source });
  };

  return (
    <Box
      p="3"
      style={{
        width: isMobile ? "100%" : 280,
        flexShrink: 0,
        borderRight: isMobile ? undefined : "1px solid var(--gray-a5)",
        borderBottom: isMobile ? "1px solid var(--gray-a5)" : undefined,
        height: isMobile ? "auto" : "100%",
        overflowY: "auto",
        boxSizing: "border-box",
      }}
    >
      <Flex justify="between" align="center" mb="2">
        <Heading size="2">Import from</Heading>
        <Button size="1" variant="ghost" onClick={hosts.reload} aria-label="Refresh devices">
          <ReloadIcon /> Refresh
        </Button>
      </Flex>
      {hosts.state.status === "loading" && <Spinner size="1" />}
      {hosts.state.error && (
        <Text color="red" size="1">
          {hosts.state.error}
        </Text>
      )}

      {isMobile ? (
        <Flex gap="2" wrap="wrap">
          <Select.Root
            value={selectedHost?.hostId}
            onValueChange={setRequestedHostId}
            disabled={availableHosts.length === 0}
          >
            <Select.Trigger
              aria-label="Import device"
              placeholder="Choose a device"
              style={{ flex: "1 1 9rem" }}
            />
            <Select.Content>
              {availableHosts.map((host) => (
                <Select.Item key={host.hostId} value={host.hostId} disabled={!host.connected}>
                  {host.displayName} · {host.location === "desktop" ? "This device" : "Server"}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
          <Select.Root
            value={
              props.selected?.host.hostId === selectedHost?.hostId
                ? props.selected?.source.sourceId
                : undefined
            }
            onValueChange={selectSource}
            disabled={!selectedHost || sources.state.status === "loading"}
          >
            <Select.Trigger
              aria-label="Source browser"
              placeholder={sources.state.status === "loading" ? "Loading browsers…" : "Browser"}
              style={{ flex: "2 1 12rem" }}
            />
            <Select.Content>
              {availableSources.map((source) => (
                <Select.Item key={source.sourceId} value={source.sourceId}>
                  {source.displayName} · {source.localDataSetCount} data{" "}
                  {source.localDataSetCount === 1 ? "set" : "sets"}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
          {sources.state.error && (
            <Text color="red" size="1" style={{ flexBasis: "100%" }}>
              {sources.state.error}
            </Text>
          )}
        </Flex>
      ) : (
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
                    setRequestedHostId(host.hostId);
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
                    {sources.state.error && (
                      <Text color="red" size="1">
                        {sources.state.error}
                      </Text>
                    )}
                    {availableSources.map((source) => {
                      const selected =
                        selectionKey(props.selected) === `${host.hostId}\0${source.sourceId}`;
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
      )}
    </Box>
  );
}
