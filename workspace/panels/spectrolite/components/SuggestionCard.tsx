/**
 * SuggestionCard — the live same-block collision resolver.
 *
 * When the scribe edits a block the user is actively typing in, the change is
 * NOT applied over theirs; the {@link DocController} surfaces a {@link Collision}
 * and the user picks accept (take the scribe's text), keep mine (discard the
 * suggestion), or merge (both, for the user to reconcile). The chosen text is
 * applied to the live block as a normal edit (and then committed).
 *
 * Uses `computeBlockDiff` / `resolveSuggestion` for a small inline word-diff.
 * Rendered as a quiet overlay stack so it never yanks the
 * editor; dismissing leaves the user's text + caret intact.
 */

import { useMemo } from "react";
import { Box, Button, Card, Flex, Text } from "@radix-ui/themes";
import { CheckIcon, Cross2Icon, MixIcon } from "@radix-ui/react-icons";
import { computeBlockDiff, resolveSuggestion } from "../coedit/blockDiff";
import type { Collision } from "../coedit/blockReconcile";
import { useApp, useAppState } from "../app/context";
import type { SuggestionResolution } from "../app/createApp";

function userText(collision: Collision): string {
  return collision.oldTexts.join("\n\n");
}

function scribeText(collision: Collision): string {
  return collision.newTexts.join("\n\n");
}

function DiffView({ collision }: { collision: Collision }) {
  const segments = useMemo(
    () => computeBlockDiff(userText(collision), scribeText(collision)),
    [collision]
  );
  return (
    <Box
      className="spectrolite-suggestion-diff"
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "var(--font-size-1)",
        lineHeight: 1.5,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        maxHeight: 160,
        overflow: "auto",
        padding: "var(--space-2)",
        borderRadius: "var(--radius-2)",
        background: "var(--gray-2)",
      }}
    >
      {segments.map((seg, i) => (
        <span
          key={i}
          style={
            seg.type === "insert"
              ? { background: "var(--grass-4)", color: "var(--grass-11)" }
              : seg.type === "delete"
                ? {
                    background: "var(--red-4)",
                    color: "var(--red-11)",
                    textDecoration: "line-through",
                  }
                : undefined
          }
        >
          {seg.value}
        </span>
      ))}
    </Box>
  );
}

function SuggestionRow({ id, collision }: { id: string; collision: Collision }) {
  const app = useApp();

  const resolve = (choice: "accept" | "keep" | "merge") => {
    if (choice === "keep") {
      app.resolveSuggestion(id, null);
      return;
    }
    const text = resolveSuggestion(choice, userText(collision), scribeText(collision));
    // The live blocks are `liveIds`; anchor the replacement before the first
    // block after the run (the next live id is its own anchor on removal).
    const resolution: SuggestionResolution = {
      oldIds: collision.oldIds,
      beforeId: collision.oldIds[0] ?? null,
      text,
    };
    app.resolveSuggestion(id, resolution);
  };

  return (
    <Card
      size="1"
      data-testid="spectrolite-suggestion-card"
      className="spectrolite-suggestion-card"
    >
      <Flex direction="column" gap="2">
        <Flex align="center" justify="between" gap="2">
          <Text size="1" weight="medium" color="iris">
            @scribe suggested a change here
          </Text>
          <Button
            size="1"
            variant="ghost"
            color="gray"
            onClick={() => resolve("keep")}
            aria-label="Keep my version"
            data-testid="spectrolite-suggestion-keep"
          >
            <Cross2Icon /> Keep mine
          </Button>
        </Flex>
        <DiffView collision={collision} />
        <Flex gap="2">
          <Button
            size="1"
            variant="solid"
            color="iris"
            onClick={() => resolve("accept")}
            data-testid="spectrolite-suggestion-accept"
          >
            <CheckIcon /> Accept
          </Button>
          <Button
            size="1"
            variant="soft"
            color="gray"
            onClick={() => resolve("merge")}
            data-testid="spectrolite-suggestion-merge"
          >
            <MixIcon /> Merge both
          </Button>
        </Flex>
      </Flex>
    </Card>
  );
}

export function SuggestionStack() {
  const suggestions = useAppState((s) => s.pendingSuggestions);
  const activePath = useAppState((s) => s.activePath);
  const app = useApp();
  const activeVcsPath = activePath ? app.vault.mapping().toVcsPath(activePath) : null;
  const visible = suggestions.filter((s) => s.vcsPath === activeVcsPath);
  if (visible.length === 0) return null;
  return (
    <Box
      className="spectrolite-suggestion-stack"
      data-testid="spectrolite-suggestion-stack"
      style={{
        position: "absolute",
        right: "var(--space-3)",
        bottom: "var(--space-3)",
        width: "min(92vw, 360px)",
        zIndex: 40,
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        pointerEvents: "auto",
      }}
    >
      {visible.map((s) => (
        <SuggestionRow key={s.id} id={s.id} collision={s.collision} />
      ))}
    </Box>
  );
}
