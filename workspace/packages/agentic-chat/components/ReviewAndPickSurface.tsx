import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Button, Callout, Dialog, Flex, Text } from "@radix-ui/themes";
import { DiffViewer } from "@workspace/ui";
import type { DiffChangedFile, DiffContentFetcher, DiffReviewEntry } from "@workspace/ui";
import { createVcsUserlandClient } from "@vibez1/shared/userlandServiceRpc";
import type { ReviewTarget } from "../types";

/**
 * ReviewAndPickSurface — hosts the shared DiffViewer against a fork/subagent
 * context's working diff (`vcs.contextDiff`), with per-file/per-commit PICK
 * actions and a take-everything MERGE, all routed through the WS-2 vcs service.
 *
 * The same overlay serves SubagentRunCards and fork-switcher/tree entries — a
 * fix salvaged from an abandoned fork is the same op as picking a subagent's
 * change. File bytes are fetched lazily by content hash via `blobstore.getText`.
 *
 * Per-commit picks read the source context's commit log the way `inspect_subagent`
 * does: `vcs.contextStatus` enumerates the touched repos, then the userland `vcs`
 * service's `vcsLog` reads each repo's log at the child's `ctx:<contextId>` head.
 * Each entry's `envelopeId` is the commit's pick `eventId`.
 */

interface ReviewRpc {
  call<R = unknown>(targetId: string, method: string, args: unknown[]): Promise<R>;
}

/** Mirror of the host TreeDiff returned by `vcs.contextDiff`. */
interface TreeDiff {
  added: Array<{ path: string; contentHash: string; mode: number }>;
  removed: Array<{ path: string; contentHash: string; mode: number }>;
  changed: Array<{ path: string; fromContentHash: string; toContentHash: string }>;
}

/** Mirror of the `VcsLogEntry` rows returned by the userland `vcsLog` read. */
interface CommitLogEntry {
  seq: number;
  envelopeId: string;
  summary: string | null;
  appendedAt: string;
}

/** One repo's commit, flattened for the per-commit pick strip. */
interface RepoCommit {
  repoPath: string;
  entry: CommitLogEntry;
}

export interface ReviewAndPickSurfaceProps {
  rpc: ReviewRpc;
  target: ReviewTarget;
  appearance?: "light" | "dark";
  open: boolean;
  onClose: () => void;
}

function treeDiffToEntry(target: ReviewTarget, diff: TreeDiff): DiffReviewEntry {
  const changedFiles: DiffChangedFile[] = [
    ...diff.added.map((f): DiffChangedFile => ({ path: f.path, kind: "added", newHash: f.contentHash })),
    ...diff.removed.map((f): DiffChangedFile => ({ path: f.path, kind: "removed", oldHash: f.contentHash })),
    ...diff.changed.map(
      (f): DiffChangedFile => ({
        path: f.path,
        kind: "changed",
        oldHash: f.fromContentHash,
        newHash: f.toContentHash,
      })
    ),
  ].sort((a, b) => a.path.localeCompare(b.path));
  return {
    repoPath: target.label,
    oldState: "fork-base",
    newState: target.contextId,
    diffStat: { filesChanged: changedFiles.length },
    changedFiles,
  };
}

export function ReviewAndPickSurface({ rpc, target, appearance, open, onClose }: ReviewAndPickSurfaceProps) {
  const [entry, setEntry] = useState<DiffReviewEntry | null>(null);
  const [commits, setCommits] = useState<RepoCommit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Enumerate the source context's per-repo commit log (the same read
  // `inspect_subagent` performs): touched repos via `vcs.contextStatus`, then
  // each repo's log at the child's `ctx:<contextId>` head via userland `vcsLog`.
  // Best-effort — a log failure leaves the path-picks + merge fully usable.
  const loadCommits = useCallback(async () => {
    try {
      const repos = await rpc.call<Array<{ repoPath: string }>>("main", "vcs.contextStatus", [
        { contextId: target.contextId },
      ]);
      const userland = createVcsUserlandClient(rpc);
      const head = `ctx:${target.contextId}`;
      const perRepo = await Promise.all(
        repos.map(async (r) => {
          const log = await userland.call<CommitLogEntry[]>("vcsLog", r.repoPath, null, head);
          return log.map((e): RepoCommit => ({ repoPath: r.repoPath, entry: e }));
        })
      );
      setCommits(perRepo.flat());
    } catch (err) {
      console.debug("[ReviewAndPickSurface] commit log unavailable:", err);
      setCommits([]);
    }
  }, [rpc, target]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setCommits([]);
    try {
      const diff = await rpc.call<TreeDiff>("main", "vcs.contextDiff", [
        { contextId: target.contextId, against: "fork-base" },
      ]);
      setEntry(treeDiffToEntry(target, diff));
      void loadCommits();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [rpc, target, loadCommits]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const fetchContent = useCallback<DiffContentFetcher>(
    async (hash) => {
      const text = await rpc.call<string | null>("main", "blobstore.getText", [hash]);
      return text ?? "";
    },
    [rpc]
  );

  const pickPaths = useCallback(
    async (paths: string[]) => {
      setBusyPath(paths[0] ?? null);
      setNotice(null);
      try {
        await rpc.call("main", "vcs.pick", [
          { source: { contextId: target.contextId }, picks: [{ kind: "paths", paths }] },
        ]);
        setNotice(`Picked ${paths.length} file${paths.length === 1 ? "" : "s"} into your context (uncommitted).`);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyPath(null);
      }
    },
    [rpc, target]
  );

  const pickCommit = useCallback(
    async (repoPath: string, commit: CommitLogEntry) => {
      setBusyPath(`commit:${commit.envelopeId}`);
      setNotice(null);
      try {
        await rpc.call("main", "vcs.pick", [
          {
            source: { contextId: target.contextId },
            picks: [{ kind: "commit", repoPath, eventId: commit.envelopeId }],
          },
        ]);
        setNotice(`Picked commit ${commit.envelopeId.slice(0, 8)} into your context (uncommitted).`);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyPath(null);
      }
    },
    [rpc, target]
  );

  const mergeEverything = useCallback(async () => {
    setBusyPath("__all__");
    setNotice(null);
    try {
      const res = await rpc.call<{ status?: string }[] | { status?: string }>("main", "vcs.merge", [
        { source: { contextId: target.contextId } },
      ]);
      const status = Array.isArray(res) ? res.map((r) => r.status).join(", ") : res.status;
      setNotice(`Merge: ${status ?? "done"}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyPath(null);
    }
  }, [rpc, target]);

  const allPaths = useMemo(() => entry?.changedFiles.map((f) => f.path) ?? [], [entry]);

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Content maxWidth="900px" style={{ maxHeight: "85vh", overflow: "auto" }}>
        <Dialog.Title>Review &amp; pick — {target.label}</Dialog.Title>
        <Dialog.Description size="1" color="gray">
          Changes this {target.kind === "subagent" ? "subagent" : "fork"} introduced over its fork base.
          Pick individual files or whole commits (as uncommitted edits), or merge everything.
        </Dialog.Description>

        {error && (
          <Callout.Root color="red" size="1" mt="3">
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        )}
        {notice && (
          <Callout.Root color="green" size="1" mt="3">
            <Callout.Text>{notice}</Callout.Text>
          </Callout.Root>
        )}

        {loading && (
          <Text size="2" color="gray" mt="3" as="p">
            Loading diff…
          </Text>
        )}

        {entry && (
          <Box mt="3">
            <Flex align="center" justify="between" gap="2" mb="2" wrap="wrap">
              <Text size="1" color="gray">
                {entry.changedFiles.length} file{entry.changedFiles.length === 1 ? "" : "s"} changed
              </Text>
              <Flex gap="2">
                <Button
                  size="1"
                  variant="soft"
                  disabled={allPaths.length === 0 || busyPath !== null}
                  onClick={() => void pickPaths(allPaths)}
                >
                  Pick all files
                </Button>
                <Button
                  size="1"
                  disabled={busyPath !== null}
                  onClick={() => void mergeEverything()}
                >
                  Merge everything
                </Button>
              </Flex>
            </Flex>
            {/* Per-file pick strip (DiffViewer renders no decision controls). */}
            <Flex direction="column" gap="1" mb="2">
              {entry.changedFiles.map((file) => (
                <Flex key={file.path} align="center" justify="between" gap="2">
                  <Text size="1" truncate style={{ minWidth: 0 }}>
                    {file.path}
                  </Text>
                  <Button
                    size="1"
                    variant="ghost"
                    disabled={busyPath !== null}
                    onClick={() => void pickPaths([file.path])}
                  >
                    {busyPath === file.path ? "Picking…" : "Pick"}
                  </Button>
                </Flex>
              ))}
            </Flex>
            {/* Per-commit pick strip — each commit's patch is 3-way applied. */}
            {commits.length > 0 && (
              <Box mb="2">
                <Text size="1" color="gray" as="p" mb="1">
                  {commits.length} commit{commits.length === 1 ? "" : "s"}
                </Text>
                <Flex direction="column" gap="1">
                  {commits.map((commit) => (
                    <Flex
                      key={`${commit.repoPath}:${commit.entry.envelopeId}`}
                      align="center"
                      justify="between"
                      gap="2"
                    >
                      <Flex direction="column" style={{ minWidth: 0 }}>
                        <Text size="1" truncate style={{ minWidth: 0 }}>
                          {commit.entry.summary || commit.entry.envelopeId.slice(0, 8)}
                        </Text>
                        <Text size="1" color="gray" truncate style={{ minWidth: 0 }}>
                          {commit.repoPath}
                        </Text>
                      </Flex>
                      <Button
                        size="1"
                        variant="ghost"
                        disabled={busyPath !== null}
                        onClick={() => void pickCommit(commit.repoPath, commit.entry)}
                      >
                        {busyPath === `commit:${commit.entry.envelopeId}` ? "Picking…" : "Pick commit"}
                      </Button>
                    </Flex>
                  ))}
                </Flex>
              </Box>
            )}
            <DiffViewer entry={entry} fetchContent={fetchContent} appearance={appearance} />
          </Box>
        )}

        <Flex justify="end" mt="3">
          <Dialog.Close>
            <Button variant="soft" color="gray">
              Close
            </Button>
          </Dialog.Close>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
