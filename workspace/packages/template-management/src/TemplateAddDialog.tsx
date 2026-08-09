import { useRef, useState } from "react";
import { Box, Button, Callout, Dialog, Flex, Spinner, Text } from "@radix-ui/themes";
import type {
  TemplateAddPreparation,
  TemplateAddRequest,
  TemplateOperation,
} from "@vibestudio/service-schemas/templates";
import type { TemplateManagementClient } from "./index";

export type TemplateAddClient = Pick<TemplateManagementClient, "prepareAdd" | "add">;

export interface TemplateAddDialogProps {
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

export function TemplateAddDialog({
  client,
  request,
  triggerLabel,
  triggerVariant = "soft",
  disabled = false,
  onCompleted,
}: TemplateAddDialogProps) {
  const [open, setOpen] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [preparation, setPreparation] = useState<TemplateAddPreparation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TemplateOperation | null>(null);
  const preparationGeneration = useRef(0);

  const prepare = async () => {
    const generation = ++preparationGeneration.current;
    setPreparing(true);
    setPreparation(null);
    setResult(null);
    setError(null);
    try {
      const nextPreparation = await client.prepareAdd(request);
      if (preparationGeneration.current === generation) setPreparation(nextPreparation);
    } catch (failure) {
      if (preparationGeneration.current === generation) {
        setError(`Couldn't prepare this template. Nothing was changed. ${failureMessage(failure)}`);
      }
    } finally {
      if (preparationGeneration.current === generation) setPreparing(false);
    }
  };

  const add = async () => {
    if (!preparation) return;
    setAdding(true);
    setError(null);
    let operation: TemplateOperation;
    try {
      operation = await client.add({
        commandId: crypto.randomUUID(),
        pin: preparation.inspection.pin,
      });
    } catch (failure) {
      setError(`Couldn't add this template. Nothing was changed. ${failureMessage(failure)}`);
      setAdding(false);
      return;
    }
    setResult(operation);
    try {
      await onCompleted?.(operation);
    } catch (failure) {
      setError(
        `The template operation succeeded, but this view couldn't refresh. ${failureMessage(failure)}`
      );
    } finally {
      setAdding(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          void prepare();
        } else {
          // A closed dialog no longer owns an in-flight preparation. This also
          // prevents an older address from winning after the trigger is reused.
          preparationGeneration.current += 1;
          setPreparing(false);
        }
      }}
    >
      <Dialog.Trigger>
        <Button size="1" variant={triggerVariant} disabled={disabled}>
          {triggerLabel}
        </Button>
      </Dialog.Trigger>
      <Dialog.Content maxWidth="560px">
        <Dialog.Title>Add a template</Dialog.Title>
        <Dialog.Description size="2" color="gray">
          Review the repositories this template would affect. Overlapping contributions are merged
          through the ordinary workspace review flow after you approve the operation.
        </Dialog.Description>

        <Flex direction="column" gap="3" mt="4">
          {preparing ? (
            <Flex align="center" gap="2" role="status" aria-live="polite">
              <Spinner />
              <Text size="2">Fetching and verifying the template…</Text>
            </Flex>
          ) : null}

          {preparation ? (
            <Flex direction="column" gap="3">
              <Box>
                <Text as="div" weight="medium">
                  {preparation.name}
                </Text>
                {preparation.description ? (
                  <Text as="div" size="2" color="gray">
                    {preparation.description}
                  </Text>
                ) : null}
              </Box>

              <Box>
                <Text as="div" size="2" weight="medium">
                  Repositories affected ({preparation.inspection.affectedParts.length})
                </Text>
                <Text as="div" size="2" color="gray">
                  {preparation.inspection.affectedParts.length > 0
                    ? preparation.inspection.affectedParts.join(", ")
                    : "This exact contribution set is already present."}
                </Text>
              </Box>
            </Flex>
          ) : null}

          {result ? (
            <Callout.Root color={result.state === "applied" ? "green" : "blue"} size="1">
              <Callout.Text>
                {result.state === "applied"
                  ? "The template is connected."
                  : (result.blocker?.message ??
                    "The approved changes are prepared. Review the incoming workspace changes to finish.")}
              </Callout.Text>
            </Callout.Root>
          ) : null}

          {error ? (
            <Text role="alert" size="2" color="red">
              {error}
            </Text>
          ) : null}

          <Flex gap="2" justify="end">
            <Dialog.Close>
              <Button variant="soft" color="gray" disabled={adding}>
                {result ? "Done" : "Not now"}
              </Button>
            </Dialog.Close>
            {preparation && !result ? (
              <Button disabled={adding} onClick={() => void add()}>
                {adding ? "Adding…" : "Add template"}
              </Button>
            ) : null}
            {error && !preparation ? (
              <Button disabled={preparing} onClick={() => void prepare()}>
                Try again
              </Button>
            ) : null}
          </Flex>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
