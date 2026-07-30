/**
 * About Page - Shell panel showing application information.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Card,
  Flex,
  Heading,
  Text,
  Box,
  Link,
  Badge,
  Separator,
  DataList,
  Button,
  Callout,
  Spinner,
} from "@radix-ui/themes";
import { rpc } from "@workspace/runtime";
import { useIsMobile, usePaletteCommands } from "@workspace/react";
import { AboutThemeRoot, BrandMark } from "@workspace/about-shared/ui";
import type { AppInfo } from "@workspace/about-shared/types";

function ConnectionBadge({ info }: { info: AppInfo }) {
  if (info.connectionMode === "remote") {
    const connected = info.connectionStatus === "connected";
    return (
      <Badge color={connected ? "green" : "orange"} variant="soft">
        Remote{info.remoteHost ? ` · ${info.remoteHost}` : ""}
        {connected ? "" : ` (${info.connectionStatus ?? "disconnected"})`}
      </Badge>
    );
  }
  return (
    <Badge color="gray" variant="soft">
      Local
    </Badge>
  );
}

function AboutPage() {
  const isMobile = useIsMobile();
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [infoError, setInfoError] = useState<string | null>(null);

  const loadInfo = useCallback(() => {
    setLoading(true);
    setInfoError(null);
    rpc
      .call<AppInfo>("main", "app.getInfo", [])
      .then(setAppInfo)
      .catch((err) => setInfoError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadInfo();
  }, [loadInfo]);

  // Contribute a single action to the app-level command palette (Cmd/Ctrl+K).
  const paletteCommands = useMemo(
    () => [{ id: "about-reload-info", label: "Reload app info", section: "About" }],
    []
  );
  usePaletteCommands(paletteCommands, (id) => {
    if (id === "about-reload-info") loadInfo();
  });

  return (
    <Flex
      align="center"
      justify="center"
      p={isMobile ? "3" : "4"}
      style={{ minHeight: "100dvh", boxSizing: "border-box" }}
    >
      <Card size={isMobile ? "2" : "4"} style={{ width: "100%", maxWidth: "420px" }}>
        <Flex direction="column" align="center" gap="4" py="2">
          <BrandMark size={84} />

          <Flex direction="column" align="center" gap="1">
            <Heading size="7">Vibestudio</Heading>
            <Text color="gray" size="2" align="center">
              Your personal vibe computer
            </Text>
          </Flex>

          {appInfo && (
            <Flex gap="2" align="center" wrap="wrap" justify="center">
              <Badge variant="soft">v{appInfo.version}</Badge>
              <ConnectionBadge info={appInfo} />
            </Flex>
          )}
          {loading && !appInfo ? (
            <Flex align="center" gap="2">
              <Spinner size="1" />
              <Text size="2" color="gray">
                Loading version and connection…
              </Text>
            </Flex>
          ) : null}
          {infoError ? (
            <Callout.Root color="red" role="alert" style={{ width: "100%" }}>
              <Callout.Text>
                <Flex direction="column" gap="2">
                  <Text size="2">Couldn't load version and connection details: {infoError}</Text>
                  <Button size="1" variant="soft" color="red" onClick={loadInfo}>
                    Retry
                  </Button>
                </Flex>
              </Callout.Text>
            </Callout.Root>
          ) : null}

          <Separator size="4" />

          <DataList.Root size="2" style={{ width: "100%" }}>
            <DataList.Item>
              <DataList.Label>Runtime</DataList.Label>
              <DataList.Value>
                <Link href="https://electronjs.org" target="_blank">
                  Electron
                </Link>
              </DataList.Value>
            </DataList.Item>
            <DataList.Item>
              <DataList.Label>UI</DataList.Label>
              <DataList.Value>
                <Flex gap="2">
                  <Link href="https://react.dev" target="_blank">
                    React
                  </Link>
                  <Text color="gray">·</Text>
                  <Link href="https://radix-ui.com" target="_blank">
                    Radix UI
                  </Link>
                </Flex>
              </DataList.Value>
            </DataList.Item>
          </DataList.Root>

          <Text size="1" color="gray">
            Copyright 2024–{new Date().getFullYear()} Vibestudio Contributors
          </Text>
        </Flex>
      </Card>
    </Flex>
  );
}

export default function AboutPanelRoot() {
  return (
    <AboutThemeRoot>
      <AboutPage />
    </AboutThemeRoot>
  );
}
