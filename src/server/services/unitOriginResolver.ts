import YAML from "yaml";
import {
  hostBuildOrigin,
  templateOrigin,
  unresolvedOrigin,
} from "@vibestudio/shared/authority/reviewedUnitParts";
import type { InstallReviewOrigin } from "@vibestudio/shared/authority/unitInstallReview";
import { assertTemplateLockIntegrityForRead } from "@vibestudio/workspace/templateLock";
import { sanitizeTemplateDisplayText } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import type { UnitSourceOrigin } from "./unitAdmissionStore.js";

/**
 * Where a unit's bytes came from (docs/template-install-unit-approval-ux-plan.md
 * §7.6.3).
 *
 * The gate's organizing axis is origin, and origin is the one fact in this
 * system nobody asserts about themselves — so it may only ever be derived from
 * workspace state the server reads itself. Two records answer it, in this order:
 *
 *   `meta/templates.lock.yml` maps every repository the composer imported to the
 *     template node that owns it, and every node to its exact pin. A unit that
 *     arrived with an installed template belongs to that template's URL and its
 *     human ref. The lock's fingerprint is checked before it is believed.
 *   the source recorded when the unit was admitted, for a repository the lock no
 *     longer claims. Removing a template severs a relationship and deletes
 *     nothing (§U2): the parts stay, and their history of where they came from
 *     stays with them. Without this step the lock's disappearance would silently
 *     re-attribute every one of them to whatever answers next — for most
 *     workspaces, to the host's own build — so a part would go from
 *     `Originally installed from News 1.2.0` to `Part of Vibestudio` purely
 *     because the user ended a relationship.
 *   the workspace creation descriptor names the root this workspace was built
 *     from, when it was built from someone else's code. Anything the lock does
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
const TEMPLATE_LOCK_PATH = "meta/templates.lock.yml";
/** Same bound the manifest schema applies; restated where the string is read. */
const TEMPLATE_NAME_MAX = 60;

export interface UnitOriginResolverDeps {
  /** Reads a path from the workspace's current published state. */
  readWorkspaceFile(filePath: string): Promise<string | null>;
  /**
   * The source recorded alongside this repository's admission, for a repository
   * no live lock claims.
   *
   * A durable answer to a question the workspace's current composition can no
   * longer answer. It is a record the server wrote itself at the moment of a
   * decision, never a claim by anything under review, so it carries the same
   * weight as the lock and simply outlives it.
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

interface OwnedRepository {
  url: string;
  /** Human ref (`v2.1`, `main`) — the version a person reads. */
  ref: string | null;
  /** The owning template's self-given name. A title, never identity. */
  selfName: string | null;
  isWorkspaceRoot: boolean;
}

export class UnitOriginResolver {
  private ownership = new Map<string, OwnedRepository>();
  private bootstrapRepositories = new Set<string>();
  private ownershipLoaded = false;

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

  /** Re-read ownership. Cheap enough to do per review, and always current. */
  async refresh(): Promise<void> {
    let content: string | null = null;
    try {
      content = await this.deps.readWorkspaceFile(TEMPLATE_LOCK_PATH);
    } catch (error) {
      this.ownership = new Map();
      this.ownershipLoaded = false;
      this.warn(`Could not read ${TEMPLATE_LOCK_PATH}: ${message(error)}`);
      return;
    }
    if (content === null) {
      // No composition. Bootstrap membership still decides which repositories
      // came with the root; absence from a lock proves nothing by itself.
      this.ownership = new Map();
      this.ownershipLoaded = true;
      return;
    }
    try {
      const lock = assertTemplateLockIntegrityForRead(YAML.parse(content) as unknown);
      const nodesById = new Map(lock.nodes.map((node) => [node.nodeId, node] as const));
      const rootUrls = new Set(lock.roots.map((root) => root.url));
      const ownership = new Map<string, OwnedRepository>();
      for (const [repoPath, repository] of Object.entries(lock.repositories)) {
        const node = nodesById.get(repository.nodeId);
        const pin = node?.pin;
        if (!pin) continue;
        ownership.set(repoPath, {
          url: pin.url,
          ref: pin.ref ?? null,
          // Re-sanitized here for the same reason the gate re-sanitizes it: the
          // fingerprint proves who wrote these bytes, not that what a template
          // said about itself is fit to print.
          selfName: sanitizeTemplateDisplayText(node.presentation?.name, TEMPLATE_NAME_MAX) ?? null,
          isWorkspaceRoot: rootUrls.has(pin.url),
        });
      }
      this.ownership = ownership;
      this.ownershipLoaded = true;
    } catch (error) {
      // A lock we cannot verify is not evidence of anything. Clear the last
      // snapshot instead of retaining stale ownership, and make the review say
      // the source is unavailable — never let an old template claim survive a
      // failed read as if it described the current workspace.
      this.ownership = new Map();
      this.ownershipLoaded = false;
      this.warn(`${TEMPLATE_LOCK_PATH} failed integrity checks: ${message(error)}`);
    }
  }

  /**
   * The source recorded alongside an admission, without re-reading anything.
   *
   * Admission is written synchronously inside an accepted decision, so this
   * answers from the ownership the review that produced that decision already
   * loaded. Nothing is guessed: before any review has run there is no ownership
   * to consult and the record simply carries no source.
   */
  recordedOriginFor(repoPath: string): UnitSourceOrigin | null {
    if (!this.ownershipLoaded) return null;
    const origin = this.originFor(repoPath, EMPTY);
    return {
      originKey: origin.originKey,
      url: origin.url,
      // Carried into the record, not left to be looked up later: after a
      // removal the lock that holds the name and the ref is gone, and a URL on
      // its own cannot say `News 1.2.0` (§U2, §7.7).
      version: origin.version,
      ...(origin.selfName ? { selfName: origin.selfName } : {}),
      ...(origin.isWorkspaceRoot ? { isWorkspaceRoot: true } : {}),
    };
  }

  /**
   * `News 1.2.0` — where a part came from, for a part nothing owns any more.
   *
   * Null whenever the live lock still claims the repository, because then the
   * question has a present-tense answer and the review already shows it: current
   * ownership and historical origin are different facts, and printing both for
   * the same relationship would say a live template is also a past one.
   *
   * Answered from the same `originFor` every other surface uses — this adds a
   * rendering, never a second resolution order — and reads the ownership map the
   * last `refresh()` established, which every review request site loads
   * immediately beforehand when it resolves origins.
   *
   * A version but no name renders as the URL stem plus the version. No version
   * renders as the name alone. Never a commit, never a digest.
   */
  originallyInstalledFrom(repoPath: string): string | null {
    if (!this.ownershipLoaded) return null;
    if (this.ownership.has(repoPath)) return null;
    const recorded = this.deps.recordedSourceFor?.(repoPath);
    if (!recorded?.url) return null;
    const origin = this.originFor(repoPath, EMPTY);
    if (origin.isHostBuild) return null;
    const name = origin.selfName ?? urlStem(origin.url) ?? origin.originKey;
    return origin.version ? `${name} ${origin.version}` : name;
  }

  private originFor(repoPath: string, admitted: ReadonlySet<string>): InstallReviewOrigin {
    if (!this.ownershipLoaded) return unresolvedOrigin();
    const owner = this.ownership.get(repoPath);
    if (owner) {
      return templateOrigin({
        url: owner.url,
        version: owner.ref,
        ...(owner.selfName ? { selfName: owner.selfName } : {}),
        admittedOriginKeys: admitted,
        isWorkspaceRoot: owner.isWorkspaceRoot,
      });
    }
    // No live template owns this repository. Before concluding it is ours, ask
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
