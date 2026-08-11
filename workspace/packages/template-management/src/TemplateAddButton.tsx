import { useRef, useState } from "react";
import { Button, Flex, Text } from "@radix-ui/themes";
import type { TemplateAddRequest, TemplateOperation } from "@vibestudio/service-schemas/templates";
import type { TemplateManagementClient } from "./index";

export type TemplateAddClient = Pick<TemplateManagementClient, "add">;

export interface TemplateAddButtonProps {
  client: TemplateAddClient;
  request: TemplateAddRequest;
  triggerLabel: string;
  triggerVariant?: "solid" | "soft" | "outline" | "ghost";
  disabled?: boolean;
  onCompleted?: (operation: TemplateOperation) => void | Promise<void>;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Starts the one canonical install transaction. The protected-main approval
 * surface owns review of the exact merged diff, so this control must not fetch,
 * inspect, or ask the user to approve the same template first.
 */
export function TemplateAddButton({
  client,
  request,
  triggerLabel,
  triggerVariant = "soft",
  disabled = false,
  onCompleted,
}: TemplateAddButtonProps) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestKey = JSON.stringify(request);
  const transactionRef = useRef<{ requestKey: string; commandId: string } | null>(null);
  if (transactionRef.current?.requestKey !== requestKey) {
    transactionRef.current = { requestKey, commandId: crypto.randomUUID() };
  }

  const add = async () => {
    setAdding(true);
    setError(null);
    try {
      const operation = await client.add({
        commandId: transactionRef.current!.commandId,
        source: request,
      });
      await onCompleted?.(operation);
      transactionRef.current = { requestKey, commandId: crypto.randomUUID() };
    } catch (failure) {
      setError(`Couldn't add this template. ${failureMessage(failure)}`);
    } finally {
      setAdding(false);
    }
  };

  return (
    <Flex direction="column" align="end" gap="1">
      <Button
        size="1"
        variant={triggerVariant}
        disabled={disabled || adding}
        loading={adding}
        onClick={() => void add()}
      >
        {adding ? "Preparing…" : triggerLabel}
      </Button>
      {error ? (
        <Text role="alert" size="1" color="red">
          {error}
        </Text>
      ) : null}
    </Flex>
  );
}
