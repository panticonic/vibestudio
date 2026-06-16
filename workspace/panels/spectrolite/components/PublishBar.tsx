/**
 * PublishBar — the VCS-native publish indicator + one-click Publish.
 *
 * The vault lives on a durable per-vault context head; `main` / `/projects`
 * move only on an explicit Publish. This bar shows "● N unpublished changes"
 * (from {@link PublishController}, a ctx-head-vs-`main` diff) and a Publish
 * button (pull-main-then-publish). A conflicted pull parks on the panel's own
 * head and is surfaced inline with Abort.
 *
 * Subtle by design: when there is nothing to publish and no pending merge, the
 * bar collapses to a quiet "Published" line.
 */

import { useSyncExternalStore, type ReactNode } from "react";
import { Badge, Button, Flex, Text } from "@radix-ui/themes";
import { UploadIcon, ExclamationTriangleIcon, Cross1Icon, FileTextIcon } from "@radix-ui/react-icons";
import { useApp } from "../app/context";
import type { PublishSnapshot } from "../app/publishController";

export function PublishBar({ mobile = false, trailing }: { mobile?: boolean; trailing?: ReactNode }) {
  const app = useApp();
  const snapshot = useSyncExternalStore(
    (cb) => app.publish.subscribe(cb),
    () => app.publish.getSnapshot(),
    () => app.publish.getSnapshot(),
  );

  if (snapshot.pending) {
    return <PendingMergeBar snapshot={snapshot} />;
  }

  const count = snapshot.ahead;
  const hasChanges = count > 0;

  return (
    <Flex
      align="center"
      justify="between"
      gap="2"
      px="3"
      py="2"
      className="spectrolite-publish-bar"
      data-testid="spectrolite-publish-bar"
      style={{ borderTop: "1px solid var(--gray-4)", minHeight: mobile ? 52 : undefined }}
    >
      <Flex align="center" gap="2" style={{ minWidth: 0 }}>
        <span
          aria-hidden
          style={{
            color: hasChanges ? "var(--iris-9)" : "var(--gray-7)",
            fontSize: 10,
            lineHeight: 1,
          }}
        >
          ●
        </span>
        <Text size="1" color="gray" truncate data-testid="spectrolite-publish-status">
          {hasChanges
            ? `${count} unpublished change${count === 1 ? "" : "s"}`
            : "Published"}
        </Text>
        {snapshot.lastError ? (
          <Text size="1" color="red" truncate title={snapshot.lastError}>
            · {snapshot.lastError}
          </Text>
        ) : null}
      </Flex>
      {/* On mobile the Send action lives here (one action bar, not a separate
          strip), so the editor keeps maximum vertical room. */}
      <Flex align="center" gap="2" style={{ flexShrink: 0 }}>
        {trailing}
        <Button
          size={mobile ? "2" : "1"}
          variant={hasChanges ? "solid" : "soft"}
          color={hasChanges ? "iris" : "gray"}
          disabled={!hasChanges || snapshot.publishing}
          onClick={() => void app.publish.publish()}
          data-testid="spectrolite-publish-button"
          style={mobile ? { minHeight: 40 } : undefined}
        >
          <UploadIcon /> {snapshot.publishing ? "Publishing…" : "Publish"}
        </Button>
      </Flex>
    </Flex>
  );
}

function PendingMergeBar({ snapshot }: { snapshot: PublishSnapshot }) {
  const app = useApp();
  const conflicts = snapshot.pending?.conflicts ?? [];
  const mapping = app.vault.mapping();
  const conflictItems = conflicts.map((conflict) => {
    const vaultRelPath = mapping.toVaultRelPath(conflict.path);
    return {
      ...conflict,
      displayPath: vaultRelPath ?? conflict.path,
      vaultRelPath,
    };
  });
  const firstOpenable = conflictItems.find((conflict) => conflict.vaultRelPath !== null);
  const openConflict = (path: string) => {
    app.openFile(path);
  };

  return (
    <Flex
      direction="column"
      gap="1"
      px="3"
      py="2"
      className="spectrolite-publish-bar"
      data-testid="spectrolite-publish-pending"
      style={{ borderTop: "1px solid var(--amber-6)", background: "var(--amber-2)" }}
    >
      <Flex align="center" justify="between" gap="2">
        <Flex align="center" gap="2" style={{ minWidth: 0 }}>
          <ExclamationTriangleIcon color="var(--amber-11)" />
          <Text size="1" color="amber" truncate>
            Pull from main needs resolving ({conflicts.length} file{conflicts.length === 1 ? "" : "s"})
          </Text>
        </Flex>
        <Flex align="center" gap="1" style={{ flexShrink: 0 }}>
          {firstOpenable?.vaultRelPath ? (
            <Button
              size="1"
              variant="solid"
              color="amber"
              onClick={() => openConflict(firstOpenable.vaultRelPath!)}
              data-testid="spectrolite-publish-resolve"
            >
              <FileTextIcon /> Resolve
            </Button>
          ) : null}
          <Button
            size="1"
            variant="soft"
            color="gray"
            onClick={() => void app.publish.abort()}
            data-testid="spectrolite-publish-abort"
          >
            <Cross1Icon /> Abort
          </Button>
        </Flex>
      </Flex>
      {conflictItems.length > 0 ? (
        <Flex
          direction="column"
          gap="1"
          className="spectrolite-publish-conflicts"
          data-testid="spectrolite-publish-conflicts"
        >
          {conflictItems.map((conflict, index) => (
            <Flex
              key={`${conflict.path}:${conflict.kind}:${index}`}
              align="center"
              gap="2"
              className="spectrolite-publish-conflict-row"
              data-testid={`spectrolite-publish-conflict-${index}`}
            >
              <Badge size="1" color="amber" variant="soft" data-testid={`spectrolite-publish-conflict-kind-${index}`}>
                {conflict.kind}
              </Badge>
              <Flex direction="column" gap="1" style={{ minWidth: 0, flex: 1 }}>
                <Text size="1" weight="medium" truncate title={conflict.displayPath}>
                  {conflict.displayPath}
                </Text>
                {conflict.vaultRelPath === null ? (
                  <Text size="1" color="gray" truncate title={conflict.path}>
                    Outside this vault: {conflict.path}
                  </Text>
                ) : conflict.displayPath !== conflict.path ? (
                  <Text size="1" color="gray" truncate title={conflict.path}>
                    {conflict.path}
                  </Text>
                ) : null}
              </Flex>
              {conflict.vaultRelPath ? (
                <Button
                  size="1"
                  variant="soft"
                  color="amber"
                  onClick={() => openConflict(conflict.vaultRelPath!)}
                  data-testid={`spectrolite-publish-open-${index}`}
                >
                  <FileTextIcon /> Open
                </Button>
              ) : (
                <Text size="1" color="gray" style={{ flexShrink: 0 }}>
                  Not openable
                </Text>
              )}
            </Flex>
          ))}
        </Flex>
      ) : null}
    </Flex>
  );
}
