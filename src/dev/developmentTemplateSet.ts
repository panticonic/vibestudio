import * as fs from "node:fs";
import * as path from "node:path";
import type { DefaultWorkspaceTemplates } from "@vibestudio/workspace/templateRelease";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
export {
  developmentTemplateSetEnv,
  developmentTemplateSetSources,
} from "../../scripts/lib/development-template-set.mjs";
import {
  inspectWorkspaceSources,
  type WorkspaceSourceInspection,
} from "../workspaceTemplateSource.js";
import type { WorkspaceSource } from "@vibestudio/workspace/workspaceSources";
import { selectDevelopmentTemplateCheckouts } from "./developmentTemplateConfig.js";

export interface DevelopmentTemplateSet {
  pins: DefaultWorkspaceTemplates;
  baseline?: WorkspaceSourceInspection;
  checkouts: Record<string, string> & Record<keyof DefaultWorkspaceTemplates, string>;
  sourceCheckouts: Record<string, string> & Record<keyof DefaultWorkspaceTemplates, string>;
  sourcePins: Record<string, WorkspaceTemplatePin>;
  reviews: Record<string, NonNullable<WorkspaceSource["review"]>>;
  sources: Array<{
    id: string;
    role: keyof DefaultWorkspaceTemplates | "development" | "catalog";
    url: string;
    consumers?: string[];
  }>;
}

function requiredEntry<T>(record: Record<string, T>, id: string, kind: string): T {
  const value = record[id];
  if (!value) throw new Error(`Development ${id} template has no ${kind}`);
  return value;
}

/**
 * Snapshot the complete official template universe exactly as authored.
 *
 * There is no source superset and no role-specific projection: every checkout
 * already is the independently publishable template named by its origin and
 * its own meta/vibestudio.yml. Local mode is deliberately complete: an
 * official source can never fall through to the network merely because its
 * checkout was omitted from one launch command.
 */
export async function resolveDevelopmentTemplateSet(input: {
  repoRoot: string;
  checkpointRoot: string;
  explicitRoot?: string;
  productionTemplates?: boolean;
  includeDevelopmentAddons?: boolean;
  baseline?: { id: string; commit: string };
}): Promise<DevelopmentTemplateSet | null> {
  const selected = selectDevelopmentTemplateCheckouts(input.repoRoot, {
    ...(input.explicitRoot ? { explicitRoot: input.explicitRoot } : {}),
    productionTemplates: input.productionTemplates ?? false,
  });
  if (!selected) return null;

  fs.mkdirSync(input.checkpointRoot, { recursive: true });
  const declareDependencies = new Map<string, string[]>();
  for (const source of selected.sources) {
    if (source.role !== "development" || input.includeDevelopmentAddons === false) continue;
    for (const consumer of source.consumers ?? []) {
      const checkout = fs.realpathSync(
        path.resolve(requiredEntry(selected.checkouts, consumer, "checkout"))
      );
      declareDependencies.set(checkout, [...(declareDependencies.get(checkout) ?? []), source.url]);
    }
  }
  const inspected = await inspectWorkspaceSources({
    sources: selected.sources.map((source) => ({
      checkout: requiredEntry(selected.checkouts, source.id, "checkout"),
      url: source.url,
    })),
    checkpointRoot: input.checkpointRoot,
    declareDependencies,
  });
  let baseline: WorkspaceSourceInspection | undefined;
  const requestedBaseline = input.baseline;
  if (requestedBaseline) {
    const source = selected.sources.find(({ id }) => id === requestedBaseline.id);
    if (source?.role !== "catalog")
      throw new Error("Historical baselines require a managed catalog workspace");
    const checkout = requiredEntry(selected.checkouts, source.id, "checkout");
    if (!declareDependencies.has(fs.realpathSync(checkout)))
      throw new Error("The historical baseline workspace must install the development harness");
    const [snapshot] = await inspectWorkspaceSources({
      sources: [{ checkout, url: source.url, commit: requestedBaseline.commit }],
      checkpointRoot: path.join(input.checkpointRoot, "baseline"),
      declareDependencies,
    });
    if (
      !snapshot ||
      inspected.some(
        ({ pin }) => pin.url === snapshot.pin.url && pin.commit === snapshot.pin.commit
      )
    )
      throw new Error("The historical baseline must differ from the current template");
    baseline = snapshot;
  }
  const byCheckout = new Map(inspected.map((source) => [source.sourceCheckout, source]));
  const pins = {} as Record<keyof DefaultWorkspaceTemplates, WorkspaceTemplatePin>;
  const sourcePins: Record<string, WorkspaceTemplatePin> = {};
  const reviews: DevelopmentTemplateSet["reviews"] = {};
  const checkouts = {} as Record<string, string> & Record<keyof DefaultWorkspaceTemplates, string>;
  for (const catalogSource of selected.sources) {
    const sourceCheckout = fs.realpathSync(
      path.resolve(requiredEntry(selected.checkouts, catalogSource.id, "checkout"))
    );
    const source = byCheckout.get(sourceCheckout);
    if (!source) throw new Error(`Development ${catalogSource.id} template was not inspected`);
    checkouts[catalogSource.id] = source.checkout;
    sourcePins[catalogSource.id] = source.pin;
    if (!source.review) throw new Error(`Development ${catalogSource.id} template has no review`);
    reviews[catalogSource.id] = source.review;
    if (
      catalogSource.role === "base" ||
      catalogSource.role === "personal" ||
      catalogSource.role === "system"
    ) {
      pins[catalogSource.role] = source.pin;
    }
  }
  return {
    pins,
    ...(baseline ? { baseline } : {}),
    checkouts,
    sourceCheckouts: selected.checkouts,
    sourcePins,
    reviews,
    sources: selected.sources,
  };
}
