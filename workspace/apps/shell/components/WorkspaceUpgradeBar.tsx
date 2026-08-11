import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Flex, Text } from "@radix-ui/themes";
import { UpdateIcon } from "@radix-ui/react-icons";
import { events, panel, templates } from "../shell/client";
import { useShellEvent } from "../shell/useShellEvent";
import {
  templateMigrationPrompt,
  templateOperationStage,
  templateOperationTitle,
  type TemplatePendingOperation,
} from "@workspace/template-management";

const OPERATIONS_CHANGED_EVENT =
  "extensions:@workspace-extensions/template-composer::operations.changed" as const;

/** Passive launch-cut signal backed only by durable Composer operations. */
export function WorkspaceUpgradeBar() {
  const [operations, setOperations] = useState<TemplatePendingOperation[]>([]);
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
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
  const operation = [...operations].sort(
    (left, right) =>
      Number(right.initiator === "host-release") - Number(left.initiator === "host-release")
  )[0]!;
  const noteCount = operation.migration?.notes.length ?? 0;
  const noteTitles = operation.migration?.notes.map((note) => note.title).join(", ") ?? "";
  const mayBeIncompatible = operation.migration?.notes.some((note) => !note.degradedOk) ?? false;

  const continueUpgrade = async () => {
    setOpening(operation.operationId);
    setOpenError(null);
    try {
      await panel.createPanel("panels/chat", {
        contextId: operation.contextId,
        title: `Upgrade ${templateOperationTitle(operation)}`,
        stateArgs: { initialPrompt: templateMigrationPrompt(operation) },
      });
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error));
    } finally {
      setOpening(null);
    }
  };

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
        {templateOperationStage(operation)}
      </Badge>
      <Text size="1" color="gray" style={{ flex: 1 }}>
        {templateOperationTitle(operation)} has {noteCount || "incoming"}{" "}
        {noteCount === 1 ? "contract note" : "contract notes"} waiting for repair.
        {noteTitles ? ` ${noteCount === 1 ? "Contract" : "Contracts"}: ${noteTitles}.` : ""}
        {mayBeIncompatible ? " This workspace may be incompatible until the repair finishes." : ""}
      </Text>
      {openError ? (
        <Text size="1" color="red" role="alert">
          {openError}
        </Text>
      ) : null}
      <Button
        size="1"
        variant="soft"
        disabled={opening === operation.operationId}
        onClick={() => void continueUpgrade()}
      >
        {opening === operation.operationId ? "Opening…" : "Continue upgrade"}
      </Button>
    </Flex>
  );
}
