import type { WorkspaceTemplateDependency } from "@vibestudio/workspace-contracts/types";
import { normalizeTemplateGitUrl } from "./templateCoordinates.js";

/**
 * Resolving a template's dependencies into the layers a workspace is built from.
 *
 * Two rules carry the whole design, and both exist because this system repairs
 * itself. A dependency normally floats, so two templates that want the same
 * upstream agree by construction: the address resolves once and both get that
 * answer, which is why an ordinary diamond needs no arbitration at all. An
 * exact `commit` is the deliberate exception, and it is the only way a diamond
 * can disagree — so that is exactly where resolution stops and says so, rather
 * than quietly picking a winner and handing someone a workspace they did not
 * ask for.
 */

/**
 * What a dependency follows when it names nothing: the source's releases.
 *
 * A branch tip would float too, but it floats over whatever was last pushed. A
 * release track floats over what was deliberately published, and two templates
 * that both follow it agree without either having to pin.
 */
export const DEFAULT_TEMPLATE_DEPENDENCY_TRACK = "refs/tags/v*";

export interface ResolvedTemplateDependency {
  /** Canonical credential-free source URL. */
  url: string;
  /** What was followed to get here — the declared track, or its default. */
  track: string;
  /** The canonical ref the track selected. */
  ref: string;
  commit: string;
  credential?: string;
  /** True when an exact `commit` decided this, rather than following the track. */
  pinned: boolean;
  /** Labels of the templates that asked for this, for diagnostics. */
  requestedBy: readonly string[];
}

export interface TemplateDependencyGraph {
  /**
   * Dependency-first order: every entry precedes every template that depends on
   * it, so applying the list in order lays a base down before what extends it.
   */
  layers: readonly ResolvedTemplateDependency[];
}

interface Constraint {
  tracks: Set<string>;
  commits: Set<string>;
  requestedBy: string[];
  credential?: string;
}

export interface ResolveTemplateDependenciesInput {
  /** The workspace or template whose dependencies these are. */
  root: { label: string; dependencies: readonly WorkspaceTemplateDependency[] };
  /** Read one resolved template's own dependency declarations. */
  readDependencies: (
    layer: ResolvedTemplateDependency
  ) => Promise<readonly WorkspaceTemplateDependency[]>;
  /**
   * Resolve one track to what it selects right now. A `refs/tags/*` glob picks
   * the highest version-sorted tag; a canonical ref resolves directly.
   */
  resolveTrack: (address: {
    url: string;
    track: string;
    credential?: string;
  }) => Promise<{ ref: string; commit: string }>;
}

/** Resolve one template's transitive dependencies into ordered exact layers. */
export async function resolveTemplateDependencies(
  input: ResolveTemplateDependenciesInput
): Promise<TemplateDependencyGraph> {
  const constraints = new Map<string, Constraint>();
  const resolved = new Map<string, ResolvedTemplateDependency>();
  const edges = new Map<string, string[]>();
  const queue: string[] = [];

  const declare = (from: string, dependency: WorkspaceTemplateDependency): string => {
    const url = normalizeTemplateGitUrl(dependency.url);
    if (url === from) {
      throw new Error(`Template ${url} declares itself as a dependency`);
    }
    let constraint = constraints.get(url);
    if (!constraint) {
      constraint = { tracks: new Set(), commits: new Set(), requestedBy: [] };
      constraints.set(url, constraint);
      queue.push(url);
    }
    constraint.requestedBy.push(from);
    if (dependency.credential) constraint.credential = dependency.credential;
    if (dependency.commit) constraint.commits.add(dependency.commit.toLowerCase());
    else constraint.tracks.add(dependency.track ?? DEFAULT_TEMPLATE_DEPENDENCY_TRACK);
    const existing = resolved.get(url);
    if (existing) {
      // This address was already answered, so a declaration arriving now can
      // only agree or conflict. Re-resolving would invalidate whatever was
      // already built on the first answer, so name both sides and let the root
      // settle it rather than silently preferring one.
      if (dependency.commit) {
        if (existing.commit !== dependency.commit.toLowerCase()) {
          throw new Error(
            `Template dependency ${url} resolved to ${existing.commit} for ` +
              `${existing.requestedBy.join(", ")} before ${from} required ` +
              `${dependency.commit}; pin it once at the root to settle it`
          );
        }
      } else if (!existing.pinned) {
        // An exact pin already decided this, so a float simply yields to it;
        // two floats naming different refs are a genuine disagreement.
        const track = dependency.track ?? DEFAULT_TEMPLATE_DEPENDENCY_TRACK;
        if (track !== existing.track) {
          throw new Error(
            `Template dependency ${url} is followed at ${existing.track} and ${track} by ` +
              `${existing.requestedBy.join(", ")} and ${from}; a shared dependency may ` +
              `follow only one track`
          );
        }
      }
    }
    const outgoing = edges.get(from);
    if (outgoing) outgoing.push(url);
    else edges.set(from, [url]);
    return url;
  };

  for (const dependency of input.root.dependencies) declare(input.root.label, dependency);

  while (queue.length) {
    const url = queue.shift()!;
    const constraint = constraints.get(url)!;
    if (constraint.commits.size > 1) {
      throw new Error(
        `Template dependency ${url} is pinned to ${[...constraint.commits].sort().join(" and ")} ` +
          `by ${constraint.requestedBy.join(", ")}; a shared dependency may carry only one ` +
          `exact commit`
      );
    }
    const [pinned] = constraint.commits;
    if (!pinned && constraint.tracks.size > 1) {
      throw new Error(
        `Template dependency ${url} follows ${[...constraint.tracks].sort().join(" and ")} ` +
          `by ${constraint.requestedBy.join(", ")}; a shared dependency may follow only one track`
      );
    }
    const track = [...constraint.tracks][0] ?? DEFAULT_TEMPLATE_DEPENDENCY_TRACK;
    const credential = constraint.credential ? { credential: constraint.credential } : {};
    // A pin already names the commit, so nothing asks the remote what the track
    // selects today — that is the whole point of pinning one.
    const selected = pinned
      ? { ref: track, commit: pinned }
      : await input.resolveTrack({ url, track, ...credential });
    const layer: ResolvedTemplateDependency = {
      url,
      track,
      ref: selected.ref,
      commit: selected.commit.toLowerCase(),
      ...credential,
      pinned: Boolean(pinned),
      requestedBy: [...constraint.requestedBy],
    };
    resolved.set(url, layer);
    for (const dependency of await input.readDependencies(layer)) declare(url, dependency);
  }

  // Depth-first post-order over the resolved graph puts a base ahead of
  // everything built on it. A repeated address is already placed, and a cycle
  // has no valid order at all, so it stops here rather than at overlay time.
  const layers: ResolvedTemplateDependency[] = [];
  const placed = new Set<string>();
  const active = new Set<string>();
  const visit = (url: string, trail: readonly string[]): void => {
    if (placed.has(url)) return;
    if (active.has(url)) {
      throw new Error(`Template dependency cycle: ${[...trail, url].join(" -> ")}`);
    }
    active.add(url);
    for (const next of edges.get(url) ?? []) visit(next, [...trail, url]);
    active.delete(url);
    placed.add(url);
    const layer = resolved.get(url);
    if (layer) layers.push(layer);
  };
  visit(input.root.label, []);
  return { layers };
}
