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
