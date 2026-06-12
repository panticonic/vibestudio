/**
 * Branch picker for the active vault — dropdown fed by the git
 * controller's branch list. Checkout (incl. the dirty-tree guard and the
 * clean-tree force fallback) lives in GitController.
 */

import { Button, DropdownMenu, Flex, Spinner, Text } from "@radix-ui/themes";
import { ChevronDownIcon, CheckIcon } from "@radix-ui/react-icons";
import { useApp, useAppState } from "../app/context";

export function BranchPicker() {
  const app = useApp();
  const branches = useAppState((s) => s.branches);
  const loading = useAppState((s) => s.branchesLoading);
  const busy = useAppState((s) => s.checkoutBusy);
  const error = useAppState((s) => s.branchError);
  const operation = useAppState((s) => s.gitOperation);

  const current = branches.find((b) => b.current)?.name;

  if (loading && branches.length === 0) return <Spinner size="1" />;
  if (branches.length === 0) {
    return <Text size="1" color={error ? "red" : "gray"}>{error ? `branches unavailable: ${error}` : "no branches"}</Text>;
  }

  return (
    <Flex align="center" gap="2" wrap="wrap">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          <Button size="1" variant="surface" color={error ? "red" : "gray"} disabled={busy} data-testid="spectrolite-branch-trigger">
            {busy ? <Spinner size="1" /> : null}
            {current ?? "detached"} <ChevronDownIcon />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content>
          <DropdownMenu.Label>Branches</DropdownMenu.Label>
          {branches.map((b) => (
            <DropdownMenu.Item
              key={b.name}
              onSelect={() => void app.git.checkout(b.name)}
            >
              <Flex
                align="center"
                gap="2"
                style={{ minWidth: 140 }}
                data-testid={`spectrolite-branch-${b.name}`}
                data-branch-name={b.name}
              >
                {b.current ? <CheckIcon /> : <span style={{ width: 16, display: "inline-block" }} />}
                {b.name}
              </Flex>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
      {error ? (
        <Text size="1" color="red" title={error} data-testid="spectrolite-branch-error">
          {error}
        </Text>
      ) : operation === "flushing" || operation === "checkout" ? (
        <Text size="1" color="gray" data-testid="spectrolite-branch-operation">
          {operation === "flushing" ? "Flushing edits..." : "Switching branch..."}
        </Text>
      ) : null}
    </Flex>
  );
}
