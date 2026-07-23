import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Flex, Heading, Progress, Text, Theme } from "@radix-ui/themes";
import type { BrowserDownloadRecord } from "@vibestudio/browser-data/client";
import { usePanelTheme } from "@workspace/react";
import { browserData } from "@workspace/runtime";
import "@radix-ui/themes/styles.css";
import "@workspace/ui/tokens.css";

export default function DownloadsPanel() {
  const theme = usePanelTheme();
  const [downloads, setDownloads] = useState<BrowserDownloadRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    void browserData
      .listDownloads()
      .then(setDownloads)
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 1_000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <Theme appearance={theme} accentColor="iris">
      <Flex direction="column" gap="3" p="4" style={{ minHeight: "100vh" }}>
        <Heading size="5">Downloads</Heading>
        {error && <Text color="red">{error}</Text>}
        {downloads.length === 0 && <Text color="gray">No browser downloads yet.</Text>}
        {downloads.map((download) => (
          <Card key={download.id}>
            <Flex justify="between" align="center" gap="3">
              <Flex direction="column" style={{ minWidth: 0, flex: 1 }}>
                <Text weight="bold" truncate>{download.filename}</Text>
                <Text size="1" color="gray" truncate>{download.origin ?? download.url}</Text>
                {download.totalBytes > 0 && (
                  <Progress
                    mt="2"
                    value={Math.min(100, (download.receivedBytes / download.totalBytes) * 100)}
                  />
                )}
              </Flex>
              <Badge color={download.state === "completed" ? "green" : download.state === "interrupted" ? "red" : "gray"}>
                {download.state}
              </Badge>
            </Flex>
            <Flex gap="2" mt="3">
              {download.state === "progressing" && (
                <Button size="1" variant="soft" onClick={() => void browserData.pauseDownload(download.id).then(refresh)}>
                  Pause
                </Button>
              )}
              {download.state === "paused" && (
                <Button size="1" variant="soft" onClick={() => void browserData.resumeDownload(download.id).then(refresh)}>
                  Resume
                </Button>
              )}
              {(download.state === "progressing" || download.state === "paused") && (
                <Button size="1" color="red" variant="soft" onClick={() => void browserData.cancelDownload(download.id).then(refresh)}>
                  Cancel
                </Button>
              )}
              {download.state === "completed" && (
                <>
                  <Button size="1" onClick={() => void browserData.openDownload(download.id)}>Open</Button>
                  <Button size="1" variant="soft" onClick={() => void browserData.revealDownload(download.id)}>
                    Show in folder
                  </Button>
                </>
              )}
            </Flex>
          </Card>
        ))}
      </Flex>
    </Theme>
  );
}
