/** Compact status and explicit sync/publish controls for one vault repository. */

import { useSyncExternalStore, type ReactNode } from "react";
import { Button, Flex, Text } from "@radix-ui/themes";
import { UpdateIcon, UploadIcon } from "@radix-ui/react-icons";
import { useApp, useAppState } from "../app/context";
import { getPublishPresentation } from "./publishPresentation";

export function PublishBar({
  mobile = false,
  trailing,
}: {
  mobile?: boolean;
  trailing?: ReactNode;
}) {
  const app = useApp();
  const snapshot = useSyncExternalStore(
    (cb) => app.publish.subscribe(cb),
    () => app.publish.getSnapshot(),
    () => app.publish.getSnapshot()
  );
  const dirtyCount = useAppState((state) => state.dirtyPaths.length);
  const presentation = getPublishPresentation(snapshot, dirtyCount);

  return (
    <Flex
      direction="column"
      gap="2"
      px="3"
      py="2"
      className="spectrolite-publish-bar"
      data-testid="spectrolite-publish-bar"
      style={{
        borderTop: "1px solid var(--gray-4)",
        minHeight: mobile ? 52 : undefined,
        width: "100%",
        maxWidth: "100%",
        boxSizing: "border-box",
      }}
    >
      <Flex align="center" justify="between" gap="2" style={{ width: "100%" }}>
        <Flex align="center" gap="2" style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden" }}>
          <span
            aria-hidden
            style={{
              color: presentation.hasChanges ? "var(--iris-9)" : "var(--gray-7)",
              fontSize: 10,
              lineHeight: 1,
            }}
          >
            ●
          </span>
          <Text size="1" color="gray" truncate data-testid="spectrolite-publish-status">
            {presentation.statusLabel}
          </Text>
          {snapshot.lastError ? (
            <Text size="1" color="red" truncate title={snapshot.lastError}>
              · {snapshot.lastError}
            </Text>
          ) : null}
        </Flex>
        <Flex align="center" gap="2" style={{ flex: "0 0 auto", minWidth: 0 }}>
          {trailing}
          {snapshot.relationship === "behind" || snapshot.relationship === "diverged" ? (
            <Button
              size={mobile ? "2" : "1"}
              variant="soft"
              color="amber"
              disabled={snapshot.publishing || presentation.syncBlockedByUncommitted}
              onClick={() => void app.publish.sync()}
              data-testid="spectrolite-sync-button"
              title={
                presentation.syncBlockedByUncommitted
                  ? "Commit local edits before syncing"
                  : "Integrate published changes as local semantic steps"
              }
              style={mobile ? { minHeight: 40 } : undefined}
            >
              <UpdateIcon /> Sync
            </Button>
          ) : null}
          <Button
            size={mobile ? "2" : "1"}
            variant={presentation.hasChanges ? "solid" : "soft"}
            color={presentation.hasChanges ? "iris" : "gray"}
            disabled={
              !presentation.hasChanges || snapshot.publishing || snapshot.conflicts.length > 0
            }
            onClick={() => void app.publish.publish()}
            data-testid="spectrolite-publish-button"
            style={mobile ? { minHeight: 40 } : undefined}
          >
            <UploadIcon /> {snapshot.publishing ? "Publishing…" : "Publish"}
          </Button>
        </Flex>
      </Flex>
      {snapshot.conflicts.length > 0 ? (
        <Flex
          direction="column"
          gap="1"
          px="2"
          py="1"
          data-testid="spectrolite-publish-conflicts"
          style={{ width: "100%", borderTop: "1px solid var(--amber-6)" }}
        >
          <Text size="1" color="amber">
            Published changes conflict with this vault. Review the summaries, edit the document to
            reconcile them, or explicitly keep the local result.
          </Text>
          {snapshot.conflicts.map((conflict) => (
            <Flex key={conflict.changeId} align="center" justify="between" gap="2">
              <Text size="1" truncate title={`${conflict.kind}: ${conflict.summary}`}>
                {conflict.summary}
              </Text>
              <Button
                size="1"
                variant="soft"
                color="amber"
                disabled={snapshot.publishing}
                onClick={() => void app.publish.keepLocal([conflict.changeId])}
                data-testid={`spectrolite-keep-local-${conflict.changeId}`}
              >
                Keep local
              </Button>
            </Flex>
          ))}
        </Flex>
      ) : null}
    </Flex>
  );
}
