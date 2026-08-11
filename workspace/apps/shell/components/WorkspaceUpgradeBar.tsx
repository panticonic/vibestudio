import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Flex, Text } from "@radix-ui/themes";
import { UpdateIcon } from "@radix-ui/react-icons";
import { events, templates } from "../shell/client";
import { useShellEvent } from "../shell/useShellEvent";
import type { TemplatePendingOperation } from "@workspace/template-management";

const OPERATIONS_CHANGED_EVENT =
  "extensions:@workspace-extensions/template-composer::operations.changed" as const;

/** Passive launch-cut signal backed only by durable Composer operations. */
export function WorkspaceUpgradeBar() {
  const [operations, setOperations] = useState<TemplatePendingOperation[]>([]);
  const requestVersion = useRef(0);

  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      const pending = await templates.operations();
      if (requestVersion.current !== version) return;
      setOperations(pending.filter((operation) => operation.migration));
    } catch {
      // Composer may still be starting. Connection and operation events retry;
      // this passive indicator must never become another startup gate.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const off = events.on(OPERATIONS_CHANGED_EVENT, () => void refresh());
    void events.subscribe(OPERATIONS_CHANGED_EVENT);
    return () => {
      requestVersion.current += 1;
      off();
      void events.unsubscribe(OPERATIONS_CHANGED_EVENT);
    };
  }, [refresh]);

  useShellEvent(
    "server-connection-changed",
    useCallback(
      ({ status }: { status: "connected" | "connecting" | "disconnected" }) => {
        if (status === "connected") void refresh();
      },
      [refresh]
    )
  );

  if (operations.length === 0) return null;
  const facets = [...new Set(operations.flatMap((operation) => operation.migration?.facets ?? []))];

  return (
    <Flex
      role="status"
      aria-live="polite"
      align="center"
      gap="2"
      px="3"
      py="1"
      style={{
        minHeight: 32,
        background: "var(--amber-a3)",
        borderBottom: "1px solid var(--amber-a6)",
      }}
    >
      <UpdateIcon aria-hidden />
      <Badge color="amber" variant="soft" radius="full">
        Workspace upgrading
      </Badge>
      <Text size="1" color="gray" style={{ flex: 1 }}>
        Incoming contract notes for {facets.join(", ")} are waiting in the template repair session.
      </Text>
    </Flex>
  );
}
