/**
 * Repo taxonomy — the USERLAND twin of the host's section taxonomy
 * (`@vibez1/shared/runtime/entitySpec`; consumed host-side through
 * `src/server/vcsHost/repoDiscovery.ts`). Kept semantically identical, like
 * the edit-boundary path policy in `./paths.ts`: workspace code never imports
 * host packages, so the classification is declared twice and pinned by the
 * shared understanding that a drift here mis-partitions the workspace into
 * repos.
 *
 * - **Container sections**: each immediate subdir `section/<name>` is a repo.
 * - **Flat sections** (today only `meta`): the section dir itself is one repo
 *   (single-segment repoPath).
 * - `agents` is a source dir but NOT a repo section (host NON_REPO_SECTIONS).
 */

/** Flat sections: the section dir itself is one repo. */
export const VCS_FLAT_SECTIONS: ReadonlySet<string> = new Set(["meta"]);

/** Container sections: each immediate subdir `section/<name>` is a repo. */
export const VCS_CONTAINER_SECTIONS: ReadonlySet<string> = new Set([
  "panels",
  "apps",
  "packages",
  "workers",
  "extensions",
  "skills",
  "about",
  "templates",
  "projects",
]);

const SAFE_REPO_SEGMENT = /^[A-Za-z0-9._@-]+$/;
const MAX_REPO_PATH_LENGTH = 256;

export function normalizeWorkspaceRepoPath(repoPath: string): string {
  if (typeof repoPath !== "string" || repoPath.length === 0) {
    throw new Error("Invalid workspace repo path: empty");
  }
  if (repoPath.length > MAX_REPO_PATH_LENGTH) {
    throw new Error(`Invalid workspace repo path: exceeds ${MAX_REPO_PATH_LENGTH} characters`);
  }
  if (repoPath.includes("\\") || repoPath.includes("\0")) {
    throw new Error(`Invalid workspace repo path: ${JSON.stringify(repoPath)}`);
  }
  const segments = repoPath.split("/");
  if (
    segments.some(
      (segment) =>
        segment === "" || segment === "." || segment === ".." || !SAFE_REPO_SEGMENT.test(segment)
    )
  ) {
    throw new Error(`Invalid workspace repo path: ${JSON.stringify(repoPath)}`);
  }
  if (segments.length === 1) {
    if (VCS_FLAT_SECTIONS.has(segments[0]!)) return segments[0]!;
    throw new Error(`Invalid workspace repo path: ${JSON.stringify(repoPath)} is not a flat repo`);
  }
  if (segments.length === 2) {
    const [section, name] = segments as [string, string];
    if (VCS_CONTAINER_SECTIONS.has(section)) return `${section}/${name}`;
  }
  throw new Error(
    `Invalid workspace repo path: ${JSON.stringify(
      repoPath
    )} (expected "meta" or "<container-section>/<name>")`
  );
}

export function isWorkspaceRepoPath(repoPath: string): boolean {
  try {
    normalizeWorkspaceRepoPath(repoPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Discover the repo set from a workspace-rooted file-path list (the file
 * paths of a composed workspace/base view). Pure function of tracked paths —
 * no disk walk. Sorted by repo path.
 */
export function discoverRepoPaths(filePaths: Iterable<string>): string[] {
  const repos = new Set<string>();
  for (const filePath of filePaths) {
    const segments = filePath.split("/");
    const section = segments[0];
    if (!section) continue;
    if (VCS_FLAT_SECTIONS.has(section)) {
      repos.add(section);
      continue;
    }
    if (VCS_CONTAINER_SECTIONS.has(section) && segments.length >= 2 && segments[1]) {
      repos.add(`${section}/${segments[1]}`);
    }
  }
  return [...repos].sort();
}
