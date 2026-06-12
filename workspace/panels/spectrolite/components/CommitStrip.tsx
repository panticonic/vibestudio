/**
 * Commit bar — git status + commit message + commit button.
 *
 * Reads git state from the app store (refreshed by the controllers on
 * flush/commit/branch changes — no polling, no nonce plumbing). The
 * "Suggest message" button asks the resident agent for a draft; the reply
 * lands in the channel dock with a "Use as commit msg" action that fills
 * the shared `commitMessage` store field.
 */

import { useCallback, useState } from "react";
import { Badge, Button, Callout, Code, Flex, Text, TextArea } from "@radix-ui/themes";
import { CommitIcon, MagicWandIcon } from "@radix-ui/react-icons";
import { useApp, useAppState } from "../app/context";

function commitSubject(message: string): string {
  return message.split("\n", 1)[0]?.trim() ?? "";
}

export function CommitStrip({ mobile = false, onCommitted }: { mobile?: boolean; onCommitted?: (sha: string) => void }) {
  const app = useApp();
  const branch = useAppState((s) => s.gitBranch);
  const dirty = useAppState((s) => s.gitDirty);
  const statusError = useAppState((s) => s.gitStatusError);
  const message = useAppState((s) => s.commitMessage);
  const clientReady = useAppState((s) => s.client !== null);
  const agentHandle = useAppState((s) => s.installedAgents[0]?.handle ?? s.roster[0]?.handle);
  const repoRoot = useAppState((s) => s.repoRoot);
  const gitOperation = useAppState((s) => s.gitOperation);
  const [commitError, setCommitError] = useState<string | null>(null);

  const setMessage = useCallback((next: string) => {
    app.store.setState({ commitMessage: next });
  }, [app]);

  const handleSuggest = useCallback(async () => {
    const handle = agentHandle ?? "agent";
    const filesList = dirty.length > 0 ? dirty.join(", ") : "(no dirty files)";
    const prompt = [
      `@${handle} Please look at the staged + unstaged changes in \`${repoRoot}\``,
      `(files: ${filesList}) and propose a concise commit message. Reply with`,
      `the subject line, then a blank line, then the body. No preamble.`,
    ].join(" ");
    try {
      await app.session.send(prompt, { mentions: [handle] });
      app.session.openDock();
    } catch (err) {
      console.warn("[Spectrolite] suggest send failed:", err);
    }
  }, [app, agentHandle, dirty, repoRoot]);

  const handleCommit = useCallback(async () => {
    setCommitError(null);
    const result = await app.git.commit();
    if ("error" in result) {
      setCommitError(result.error);
    } else {
      onCommitted?.(result.sha);
    }
  }, [app, onCommitted]);

  const subject = commitSubject(message);
  const operationLabel = gitOperation === "flushing"
    ? "Flushing..."
    : gitOperation === "committing"
      ? "Committing..."
      : gitOperation === "checkout"
        ? "Switching..."
        : null;
  const busy = gitOperation !== null;
  const canCommit = Boolean(subject) && !busy && dirty.length > 0;

  if (mobile) {
    return (
      <Flex direction="column" gap="3">
        {statusError ? <InlineGitError kind="status" message={`Git status failed: ${statusError}`} /> : null}
        {commitError ? <InlineGitError kind="commit" message={`Commit failed: ${commitError}`} /> : null}
        <Flex align="center" gap="2" wrap="wrap">
          <Code size="2" variant="ghost">{branch ?? "(no branch)"}</Code>
          <Text size="2" color={dirty.length > 0 ? "amber" : "gray"} data-testid="spectrolite-dirty-count">
            {dirty.length} dirty file{dirty.length === 1 ? "" : "s"}
          </Text>
        </Flex>
        <TextArea
          size="3"
          placeholder="commit subject — blank line + body optional"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={4}
          aria-label="Commit message"
        />
        <Flex gap="2" wrap="wrap">
          <Button
            size="3"
            variant="soft"
            color="gray"
            onClick={() => void handleSuggest()}
            disabled={!clientReady || dirty.length === 0 || busy}
            style={{ flex: 1, minHeight: 44 }}
          >
            <MagicWandIcon /> Suggest message
          </Button>
          <Button
            size="3"
            variant="solid"
            disabled={!canCommit}
            onClick={() => void handleCommit()}
            data-testid="spectrolite-commit-button"
            style={{ flex: 1, minHeight: 44 }}
          >
            <CommitIcon /> {operationLabel ?? "Commit"}
          </Button>
        </Flex>
      </Flex>
    );
  }

  return (
    <Flex direction="column" gap="1" px="3" py="2" className="spectrolite-commit-bar">
      {statusError ? <InlineGitError kind="status" message={`Git status failed: ${statusError}`} /> : null}
      {commitError ? <InlineGitError kind="commit" message={`Commit failed: ${commitError}`} /> : null}
      <Flex align="center" gap="2">
        <Code size="1" variant="ghost" color="gray">{branch ?? "(no branch)"}</Code>
        {dirty.length > 0 ? (
          <Badge color="amber" variant="soft" size="1" data-testid="spectrolite-dirty-count">
            {dirty.length} dirty
          </Badge>
        ) : (
          <Text size="1" color="gray" data-testid="spectrolite-dirty-count">0 dirty</Text>
        )}
        {operationLabel ? <Text size="1" color="gray">{operationLabel}</Text> : null}
        <Button size="1" variant="ghost" color="gray" onClick={() => void handleSuggest()} disabled={!clientReady || dirty.length === 0 || busy}>
          <MagicWandIcon /> Suggest message
        </Button>
        <TextArea
          size="1"
          placeholder="commit subject — newline + body optional"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={1}
          style={{ flex: 1 }}
          aria-label="Commit message"
        />
        <Button size="1" variant="soft" disabled={!canCommit} onClick={() => void handleCommit()} data-testid="spectrolite-commit-button">
          <CommitIcon /> {operationLabel ?? "Commit"}
        </Button>
      </Flex>
    </Flex>
  );
}

function InlineGitError({ kind, message }: { kind: string; message: string }) {
  return (
    <Callout.Root size="1" color="red" variant="soft" data-testid={`spectrolite-${kind}-error`}>
      <Callout.Text size="1">{message}</Callout.Text>
    </Callout.Root>
  );
}
