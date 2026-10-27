import { createHash } from "node:crypto";
import type { TemplatesClient, TemplateUpdateReview } from "@vibestudio/service-schemas/templates";
import { normalizeTemplateGitUrl } from "@vibestudio/workspace/templateCoordinates";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";

type InstalledTemplate = Awaited<ReturnType<TemplatesClient["installed"]>>[number];

export interface WorkspaceLaunchUpdateReceipt {
  status: "current" | "published" | "conflicts";
  sourceUrl: string;
  fromCommit: string;
  toCommit: string;
  operationId?: string;
}

export interface WorkspaceLaunchUpdateOutcome {
  sourceUrl: string;
  prior: WorkspaceTemplatePin;
  target: WorkspaceTemplatePin;
  operationId: string;
  status: "published" | "conflicts";
  review: TemplateUpdateReview;
}

function operationId(
  mainEventId: string,
  prior: WorkspaceTemplatePin,
  target: WorkspaceTemplatePin
): string {
  return `workspace-launch-update:${createHash("sha256")
    .update(
      JSON.stringify({
        version: 2,
        mainEventId,
        sourceUrl: normalizeTemplateGitUrl(prior.url),
        prior: { ref: prior.ref, commit: prior.commit },
        target: { ref: target.ref, commit: target.commit },
      })
    )
    .digest("hex")}`;
}

function orderedSources(installed: readonly InstalledTemplate[]): InstalledTemplate[] {
  const rank = { upstream: 0, direct: 1, transitive: 2 };
  return [...installed].sort((left, right) => rank[left.relationship] - rank[right.relationship]);
}

/** A floating dependency follows the launch's selected release, but an exact
 * declaration remains authoritative even when another parent follows a track.
 */
function dependencySelection(
  installed: readonly InstalledTemplate[],
  target: WorkspaceTemplatePin
): { inherited: boolean; blocked: boolean } {
  const byUrl = new Map(
    installed.map((source) => [normalizeTemplateGitUrl(source.pin.url), source])
  );
  const targetUrl = normalizeTemplateGitUrl(target.url);
  const visited = new Set<string>();
  let inherited = false;
  let blocked = false;
  const visit = (source: InstalledTemplate) => {
    const sourceUrl = normalizeTemplateGitUrl(source.pin.url);
    if (visited.has(sourceUrl)) return;
    visited.add(sourceUrl);
    for (const dependency of source.dependencies) {
      const url = normalizeTemplateGitUrl(dependency.url);
      if (url === targetUrl) {
        inherited = true;
        if (dependency.commit && dependency.commit !== target.commit) blocked = true;
      }
      const child = byUrl.get(url);
      if (child) visit(child);
    }
  };
  for (const root of installed.filter((source) => source.relationship !== "transitive"))
    visit(root);
  return { inherited, blocked };
}

/**
 * Reconcile retained workspace source through the ordinary reviewed update
 * lifecycle. This never copies source into main or resolves a local conflict.
 */
export async function reconcileWorkspaceLaunchUpdates(input: {
  client: TemplatesClient;
  /** The immutable protected-main baseline of this update attempt. */
  mainState: () => Promise<{ eventId: string }>;
  targets: readonly WorkspaceTemplatePin[];
  log?: (receipt: WorkspaceLaunchUpdateReceipt) => void;
}): Promise<WorkspaceLaunchUpdateOutcome[]> {
  const { client, log } = input;
  const targets = new Map<string, WorkspaceTemplatePin>();
  for (const target of input.targets) {
    const url = normalizeTemplateGitUrl(target.url);
    const previous = targets.get(url);
    if (previous && (previous.commit !== target.commit || previous.ref !== target.ref)) {
      throw new Error(`Product launch has conflicting target snapshots for ${url}`);
    }
    targets.set(url, target);
  }
  if (!targets.size) return [];

  const remaining = new Set(targets.keys());
  const outcomes: WorkspaceLaunchUpdateOutcome[] = [];
  // Publications share protected main. Re-read the installed graph after each
  // decision: a root update may adopt its dependencies or change their pins.
  while (remaining.size) {
    const inventory = await client.installed();
    const installed = orderedSources(inventory).find((source) =>
      remaining.has(normalizeTemplateGitUrl(source.pin.url))
    );
    if (!installed) break;
    const sourceUrl = normalizeTemplateGitUrl(installed.pin.url);
    remaining.delete(sourceUrl);
    const target = targets.get(sourceUrl)!;
    const selection = dependencySelection(inventory, target);
    if (selection.blocked || (installed.relationship === "transitive" && !selection.inherited))
      continue;
    if (installed.pin.commit === target.commit) {
      log?.({
        status: "current",
        sourceUrl,
        fromCommit: installed.pin.commit,
        toCommit: target.commit,
      });
      continue;
    }

    const { eventId: mainEventId } = await input.mainState();
    const commandId = operationId(mainEventId, installed.pin, target);
    const review = await client.prepareUpdate({ commandId, sourceUrl, target });
    if (review.mainEventId !== mainEventId) {
      throw new Error(
        `Workspace update ${review.operationId} was prepared against main ${review.mainEventId}; ` +
          `the observed launch baseline was ${mainEventId}. Prepare a new review against current main.`
      );
    }
    if (review.conflicts.length) {
      log?.({
        status: "conflicts",
        sourceUrl,
        fromCommit: installed.pin.commit,
        toCommit: target.commit,
        operationId: review.operationId,
      });
      outcomes.push({
        sourceUrl,
        prior: installed.pin,
        target,
        operationId: review.operationId,
        status: "conflicts",
        review,
      });
      // A conflict review belongs to this main baseline. Preserve it rather
      // than advancing main through another source update underneath it.
      return outcomes;
    }
    const published =
      review.status === "published"
        ? review
        : await client.publishUpdate({ operationId: review.operationId });
    if (published.status !== "published") {
      throw new Error(`Workspace update ${published.operationId} was not published`);
    }
    const after = await client.installed();
    const adopted = after.find((source) => normalizeTemplateGitUrl(source.pin.url) === sourceUrl);
    if (adopted?.pin.commit !== target.commit) {
      throw new Error(
        `Workspace update ${published.operationId} returned published but installed ${sourceUrl} ` +
          `is ${adopted?.pin.commit ?? "missing"}; expected ${target.commit}`
      );
    }
    outcomes.push({
      sourceUrl,
      prior: installed.pin,
      target,
      operationId: published.operationId,
      status: "published",
      review: published,
    });
    const previousByUrl = new Map(
      inventory.map((source) => [normalizeTemplateGitUrl(source.pin.url), source.pin])
    );
    for (const source of after) {
      const changedUrl = normalizeTemplateGitUrl(source.pin.url);
      const previous = previousByUrl.get(changedUrl);
      if (!previous || previous.commit === source.pin.commit) continue;
      log?.({
        status: "published",
        sourceUrl: changedUrl,
        fromCommit: previous.commit,
        toCommit: source.pin.commit,
        operationId: published.operationId,
      });
    }
  }
  return outcomes;
}
