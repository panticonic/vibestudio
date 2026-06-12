/**
 * Mobile commit affordance — a single button in the bottom strip that
 * opens the full commit UI in a bottom sheet. Shows dirty count + branch
 * inline so the user knows the state without opening the sheet.
 */

import { Badge, Button, Code, Flex, Text } from "@radix-ui/themes";
import { CommitIcon } from "@radix-ui/react-icons";
import { useAppState } from "../../app/context";

export function MobileCommitButton({ onClick }: { onClick: () => void }) {
  const dirtyCount = useAppState((s) => s.gitDirty.length);
  const branch = useAppState((s) => s.gitBranch);
  const operation = useAppState((s) => s.gitOperation);
  const label = operation === "flushing"
    ? "Flushing"
    : operation === "committing"
      ? "Committing"
      : operation === "checkout"
        ? "Switching"
        : "Commit";

  return (
    <Button
      size="3"
      variant={dirtyCount > 0 ? "solid" : "soft"}
      color={dirtyCount > 0 ? "amber" : "gray"}
      onClick={onClick}
      style={{ flex: 1, minHeight: 44 }}
    >
      <CommitIcon />
      <Flex align="center" gap="2">
        <Text>{label}</Text>
        {branch ? <Code variant="ghost" size="1">{branch}</Code> : null}
        {dirtyCount > 0 ? <Badge color="amber" variant="solid">{dirtyCount}</Badge> : null}
      </Flex>
    </Button>
  );
}
