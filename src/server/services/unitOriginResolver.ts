import YAML from "yaml";
import {
  hostBuildOrigin,
  multipleTemplateContributorsOrigin,
  unresolvedOrigin,
} from "@vibestudio/shared/authority/reviewedUnitParts";
import { templateOrigin } from "@vibestudio/origin-identity";
import type { InstallReviewOrigin } from "@vibestudio/shared/authority/unitInstallReview";
import { parseTemplateState } from "@vibestudio/workspace/templateState";
import { sanitizeTemplateDisplayText } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import type { UnitSourceOrigin } from "./unitAdmissionStore.js";

/**
 * Where a unit's bytes came from (docs/template-install-unit-approval-ux-plan.md
 * §7.6.3).
 *
 * The gate's organizing axis is origin. Current relationship state supplies
 * present-tense attribution; the host-written admission record preserves the
 * historical answer after that relationship ends.
 *
 *   `meta/templates.state.yml` records every template contribution. When exactly
 *     one template contributes to a repository, its URL and human ref are a
 *     useful coarse origin. Multiple contributors deliberately produce no
 *     single-template origin; file-level VCS provenance is the honest source.
 *   the source recorded when the unit was admitted, for a repository the state no
 *     longer claims but whose merged content remains. Without this step the
 *     state's disappearance would silently
 *     re-attribute every one of them to whatever answers next — for most
 *     workspaces, to the host's own build — so a part would go from
 *     `Originally installed from News 1.2.0` to `Part of Vibestudio` purely
 *     because the user ended a relationship.
 *   the workspace creation descriptor names the root this workspace was built
 *     from, when it was built from someone else's code. Anything the state does
 *     not claim came in with that root.
 *
 * A repository can inherit the root origin only when its path is also proven to
 * exist in the immutable bootstrap snapshot. If that root has no external pin,
 * it is the host's own build — the one origin allowed to name itself. This
 * positive proof is the LAST answer, never a default: an unclaimed local
 * extension remains unresolved instead of printing as Vibestudio.
 *
 * Versions here are the human ref (`v2.1`), never the commit: no commit id or
 * content digest reaches a review surface at any disclosure level.
 */
const TEMPLATE_STATE_PATH = "meta/templates.state.yml";
/** Same bound the manifest schema applies; restated where the string is read. */
const TEMPLATE_NAME_MAX = 60;

export interface UnitOriginResolverDeps {
  /** Reads a path from the workspace's current published state. */
  readWorkspaceFile(filePath: string): Promise<string | null>;
  /**
   * The source recorded alongside this repository's admission, for a repository
   * no live state claims.
   *
   * A durable answer to a question the workspace's current composition can no
   * longer answer. It is a record the server wrote itself at the moment of a
   * decision and simply outlives descriptive relationship state.
   */
  recordedSourceFor?(repoPath: string): RecordedUnitSource | null;
  /** The pin this workspace was created from, when it was not our own base. */
  rootTemplatePin(): { url: string | null; ref: string | null; version: string | null } | null;
  /** Positive proof that the repository existed in the immutable bootstrap. */
  isBootstrapRepository(repoPath: string): Promise<boolean>;
  /** The host build's own version, for the origin that may name itself. */
  hostBuildVersion(): string | null;
  /** Sources the user has already run code from, for first encounter. */
  admittedOriginKeys(): ReadonlySet<string>;
  onWarning?(message: string): void;
}

/** What an admission durably recorded about where a unit's bytes came from. */
export interface RecordedUnitSource {
  url: string | null;
  /** Human ref, when the record kept one; origin renders without it otherwise. */
  version?: string | null;
  /** The template's self-given name at admission, if recorded. Title only. */
  selfName?: string | null;
  isWorkspaceRoot?: boolean;
}

interface SoleTemplateContribution {
  url: string;
  /** Human ref (`v2.1`, `main`) — the version a person reads. */
  ref: string | null;
  /** The contributing template's self-given name. A title, never identity. */
  selfName: string | null;
  isWorkspaceRoot: boolean;
}

export class UnitOriginResolver {
  private soleContributions = new Map<string, SoleTemplateContribution>();
  private overlappingContributions = new Set<string>();
  private bootstrapRepositories = new Set<string>();
  private contributionsLoaded = false;

  constructor(private readonly deps: UnitOriginResolverDeps) {}

  /**
   * Resolve every repo path an install review is about, in one read.
   *
   * Called by every unit-install-review request site, because a review that
   * omits origins is not a weaker review — it is a wrong one: every part would
   * claim to come from the host build and the whole surface would collapse to a
   * single source labelled Vibestudio.
   */
  async originsFor(repoPaths: Iterable<string>): Promise<ReadonlyMap<string, InstallReviewOrigin>> {
    await this.refresh();
    const uniqueRepoPaths = [...new Set(repoPaths)];
    const bootstrapChecks = await Promise.all(
      uniqueRepoPaths.map(
        async (repoPath) => [repoPath, await this.deps.isBootstrapRepository(repoPath)] as const
      )
    );
    for (const [repoPath, present] of bootstrapChecks) {
      if (present) this.bootstrapRepositories.add(repoPath);
      else this.bootstrapRepositories.delete(repoPath);
    }
    const admitted = this.deps.admittedOriginKeys();
    const origins = new Map<string, InstallReviewOrigin>();
    for (const repoPath of uniqueRepoPaths) {
      origins.set(repoPath, this.originFor(repoPath, admitted));
    }
    return origins;
  }

  /** Re-read contribution attribution. Cheap enough to do per review. */
  async refresh(): Promise<void> {
    let content: string | null = null;
    try {
      content = await this.deps.readWorkspaceFile(TEMPLATE_STATE_PATH);
    } catch (error) {
      this.soleContributions = new Map();
      this.overlappingContributions = new Set();
      this.contributionsLoaded = false;
      this.warn(`Could not read ${TEMPLATE_STATE_PATH}: ${message(error)}`);
      return;
    }
    if (content === null) {
      // No composition. Bootstrap membership still decides which repositories
      // came with the root; absence from a state proves nothing by itself.
      this.soleContributions = new Map();
      this.overlappingContributions = new Set();
      this.contributionsLoaded = true;
      return;
    }
    try {
      const state = parseTemplateState(YAML.parse(content) as unknown);
      const nodesById = new Map(state.nodes.map((node) => [node.nodeId, node] as const));
      const rootUrls = new Set(state.roots.map((root) => root.url));
      const soleContributions = new Map<string, SoleTemplateContribution>();
      const overlappingContributions = new Set<string>();
      for (const [repoPath, repository] of Object.entries(state.repositories)) {
        if (repository.contributions.length !== 1) {
          overlappingContributions.add(repoPath);
          continue;
        }
        const node = nodesById.get(repository.contributions[0]!.nodeId);
        const pin = node?.pin;
        if (!pin) continue;
        soleContributions.set(repoPath, {
          url: pin.url,
          ref: pin.ref ?? null,
          // Relationship state is descriptive and workspace-owned, so
          // self-authored display text is always sanitized at the host boundary.
          selfName: sanitizeTemplateDisplayText(node.presentation?.name, TEMPLATE_NAME_MAX) ?? null,
          isWorkspaceRoot: rootUrls.has(pin.url),
        });
      }
      this.soleContributions = soleContributions;
      this.overlappingContributions = overlappingContributions;
      this.contributionsLoaded = true;
    } catch (error) {
      // Malformed descriptive state cannot supply attribution. Clear the last
      // snapshot instead of retaining stale display data.
      this.soleContributions = new Map();
      this.overlappingContributions = new Set();
      this.contributionsLoaded = false;
      this.warn(`Could not parse ${TEMPLATE_STATE_PATH}: ${message(error)}`);
    }
  }

  /**
   * The source recorded alongside an admission, without re-reading anything.
   *
   * Admission is written synchronously inside an accepted decision, so this
   * answers from the contribution attribution the review that produced that
   * decision already loaded. Nothing is guessed: before any review has run
   * there is no contribution attribution
   * to consult and the record simply carries no source.
   */
  recordedOriginFor(repoPath: string): UnitSourceOrigin | null {
    if (!this.contributionsLoaded) return null;
    const origin = this.originFor(repoPath, EMPTY);
    return {
      originKey: origin.originKey,
      url: origin.url,
      // Carried into the record, not left to be looked up later: after a
      // removal the state that holds the name and the ref is gone, and a URL on
      // its own cannot say `News 1.2.0` (§U2, §7.7).
      version: origin.version,
      ...(origin.selfName ? { selfName: origin.selfName } : {}),
      ...(origin.isWorkspaceRoot ? { isWorkspaceRoot: true } : {}),
    };
  }

  /**
   * `News 1.2.0` — where a part came from, for a part nothing owns any more.
   *
   * Null whenever one live template solely contributes the repository, because then the
   * question has a present-tense answer and the review already shows it: current
   * current contribution and historical origin are different facts, and printing both for
   * the same relationship would say a live template is also a past one.
   *
   * Answered from the same `originFor` every other surface uses — this adds a
   * rendering, never a second resolution order — and reads the contribution map the
   * last `refresh()` established, which every review request site loads
   * immediately beforehand when it resolves origins.
   *
   * A version but no name renders as the URL stem plus the version. No version
   * renders as the name alone. Never a commit, never a digest.
   */
  originallyInstalledFrom(repoPath: string): string | null {
    if (!this.contributionsLoaded) return null;
    if (this.soleContributions.has(repoPath)) return null;
    const recorded = this.deps.recordedSourceFor?.(repoPath);
    if (!recorded?.url) return null;
    const origin = this.originFor(repoPath, EMPTY);
    if (origin.isHostBuild) return null;
    const name = origin.selfName ?? urlStem(origin.url) ?? origin.originKey;
    return origin.version ? `${name} ${origin.version}` : name;
  }

  private originFor(repoPath: string, admitted: ReadonlySet<string>): InstallReviewOrigin {
    if (!this.contributionsLoaded) return unresolvedOrigin();
    if (this.overlappingContributions.has(repoPath)) {
      return multipleTemplateContributorsOrigin();
    }
    const contributor = this.soleContributions.get(repoPath);
    if (contributor) {
      return templateOrigin({
        url: contributor.url,
        version: contributor.ref,
        ...(contributor.selfName ? { selfName: contributor.selfName } : {}),
        admittedOriginKeys: admitted,
        isWorkspaceRoot: contributor.isWorkspaceRoot,
      });
    }
    // No single live template accounts for this repository. Before concluding it is ours, ask
    // what was true when it was admitted: a removed template's parts are still
    // that template's code, and saying otherwise would erase the only audit
    // trail explaining the grants they hold (§7.7).
    const recorded = this.deps.recordedSourceFor?.(repoPath);
    if (recorded?.url) {
      const selfName = sanitizeTemplateDisplayText(recorded.selfName, TEMPLATE_NAME_MAX);
      return templateOrigin({
        url: recorded.url,
        version: recorded.version ?? null,
        ...(selfName ? { selfName } : {}),
        admittedOriginKeys: admitted,
        isWorkspaceRoot: recorded.isWorkspaceRoot === true,
      });
    }
    if (this.bootstrapRepositories.has(repoPath)) {
      const root = this.deps.rootTemplatePin();
      if (root?.url) {
        return templateOrigin({
          url: root.url,
          version: root.version ?? root.ref,
          admittedOriginKeys: admitted,
          isWorkspaceRoot: true,
        });
      }
      return hostBuildOrigin(this.deps.hostBuildVersion());
    }
    return unresolvedOrigin();
  }

  private warn(text: string): void {
    (this.deps.onWarning ?? ((line: string) => console.warn(`[Units] ${line}`)))(text);
  }
}

const EMPTY: ReadonlySet<string> = new Set<string>();

/**
 * The last path segment of a source URL, as a stand-in title.
 *
 * Only reached when a template never gave itself a name. It is a fallback for a
 * label, not for identity: the URL itself is still what the origin line shows.
 */
function urlStem(url: string | null): string | null {
  if (!url) return null;
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    return last ? last.replace(/\.git$/u, "") : null;
  } catch {
    return null;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
