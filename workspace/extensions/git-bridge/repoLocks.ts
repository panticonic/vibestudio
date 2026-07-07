import { normalizeWorkspaceRepoPath } from "@vibestudio/shared/workspace/remotes";

const locks = new Map<string, Promise<unknown>>();

export function withRepoLock<T>(
  repoPath: string,
  fn: (repoPath: string) => Promise<T>
): Promise<T> {
  const repo = normalizeWorkspaceRepoPath(repoPath);
  const prev = locks.get(repo) ?? Promise.resolve();
  const next = prev.then(
    () => fn(repo),
    () => fn(repo)
  );
  const chain = next.then(
    () => undefined,
    () => undefined
  );
  locks.set(repo, chain);
  // Evict the entry once the chain drains, so idle repos don't accumulate
  // map entries for the process lifetime.
  void chain.then(() => {
    if (locks.get(repo) === chain) locks.delete(repo);
  });
  return next;
}
