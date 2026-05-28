/**
 * Mobile commit affordance — a single button in the bottom strip that
 * opens the full commit UI in a bottom sheet. Surfaces just enough
 * info inline (dirty count + branch) so the user knows the state
 * without opening the sheet.
 */

import { useEffect, useState } from "react";
import { Badge, Button, Code, Flex, Text } from "@radix-ui/themes";
import { CommitIcon } from "@radix-ui/react-icons";
import { git as runtimeGit } from "@workspace/runtime";

export interface MobileCommitButtonProps {
  repoRoot: string;
  /** Bumped after each commit so we refresh the badge. */
  refreshNonce: number;
  onClick: () => void;
}

export function MobileCommitButton({ repoRoot, refreshNonce, onClick }: MobileCommitButtonProps) {
  const [dirtyCount, setDirtyCount] = useState(0);
  const [branch, setBranch] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const git = runtimeGit.client();
    (async () => {
      try {
        const s = await git.status(repoRoot);
        if (cancelled) return;
        const dirty = (s.files ?? []).filter(
          (f) => f.status !== "unmodified" && f.status !== "ignored",
        ).length;
        setDirtyCount(dirty);
        setBranch(s.branch ?? null);
      } catch {
        // Failed to read status — don't leave the old values stuck on
        // screen. The button still works; user can open the sheet for
        // a real error from the underlying GitClient.
        if (!cancelled) {
          setDirtyCount(0);
          setBranch(null);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [repoRoot, refreshNonce]);

  return (
    <Button size="3" variant={dirtyCount > 0 ? "solid" : "soft"} color={dirtyCount > 0 ? "amber" : "gray"} onClick={onClick} style={{ flex: 1, minHeight: 44 }}>
      <CommitIcon />
      <Flex align="center" gap="2">
        <Text>Commit</Text>
        {branch ? <Code variant="ghost" size="1">{branch}</Code> : null}
        {dirtyCount > 0 ? <Badge color="amber" variant="solid">{dirtyCount}</Badge> : null}
      </Flex>
    </Button>
  );
}
