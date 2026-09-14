import * as fs from "node:fs";
import * as path from "node:path";
import type { DefaultWorkspaceTemplates } from "@vibestudio/workspace/templateRelease";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import { inspectWorkspaceSources } from "../workspaceTemplateSource.js";
import { selectDevelopmentTemplateCheckouts } from "./developmentTemplateConfig.js";

export interface DevelopmentTemplateSet {
  pins: DefaultWorkspaceTemplates;
  checkouts: Record<string, string> & Record<keyof DefaultWorkspaceTemplates, string>;
  sourceCheckouts: Record<string, string> & Record<keyof DefaultWorkspaceTemplates, string>;
  sourcePins: Record<string, WorkspaceTemplatePin>;
  sources: Array<{
    id: string;
    role: keyof DefaultWorkspaceTemplates | "development" | "catalog";
    url: string;
    consumers?: Array<keyof DefaultWorkspaceTemplates>;
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
}): Promise<DevelopmentTemplateSet | null> {
  const selected = selectDevelopmentTemplateCheckouts(input.repoRoot, {
    ...(input.explicitRoot ? { explicitRoot: input.explicitRoot } : {}),
    productionTemplates: input.productionTemplates ?? false,
  });
  if (!selected) return null;

  fs.mkdirSync(input.checkpointRoot, { recursive: true });
  const declareDependencies = new Map<string, string[]>();
  for (const source of selected.sources) {
    if (source.role !== "development") continue;
    for (const consumer of source.consumers ?? []) {
      const checkout = fs.realpathSync(path.resolve(selected.checkouts[consumer]));
      declareDependencies.set(checkout, [...(declareDependencies.get(checkout) ?? []), source.url]);
    }
  }
  const inspected = await inspectWorkspaceSources({
    checkouts: selected.sources.map((source) =>
      requiredEntry(selected.checkouts, source.id, "checkout")
    ),
    checkpointRoot: input.checkpointRoot,
    declareDependencies,
  });
  const byCheckout = new Map(inspected.map((source) => [source.sourceCheckout, source]));
  const pins = {} as Record<keyof DefaultWorkspaceTemplates, WorkspaceTemplatePin>;
  const sourcePins: Record<string, WorkspaceTemplatePin> = {};
  const checkouts = {} as Record<string, string> & Record<keyof DefaultWorkspaceTemplates, string>;
  for (const catalogSource of selected.sources) {
    const sourceCheckout = fs.realpathSync(
      path.resolve(requiredEntry(selected.checkouts, catalogSource.id, "checkout"))
    );
    const source = byCheckout.get(sourceCheckout);
    if (!source) throw new Error(`Development ${catalogSource.id} template was not inspected`);
    checkouts[catalogSource.id] = source.checkout;
    sourcePins[catalogSource.id] = source.pin;
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
    checkouts,
    sourceCheckouts: selected.checkouts,
    sourcePins,
    sources: selected.sources,
  };
}

export function developmentTemplateSetSources(selection: DevelopmentTemplateSet): Array<{
  pin: WorkspaceTemplatePin;
  checkout: string;
}> {
  return selection.sources.map((source) => ({
    pin: requiredEntry(selection.sourcePins, source.id, "pin"),
    checkout: requiredEntry(selection.checkouts, source.id, "checkpoint"),
  }));
}

export function developmentTemplateSetEnv(selection: DevelopmentTemplateSet): NodeJS.ProcessEnv {
  const sources = developmentTemplateSetSources(selection);
  return {
    VIBESTUDIO_DEFAULT_WORKSPACE_TEMPLATES: JSON.stringify(selection.pins),
    VIBESTUDIO_INITIAL_WORKSPACE_TEMPLATE: JSON.stringify(selection.pins.system),
    VIBESTUDIO_WORKSPACE_SOURCES: JSON.stringify(sources),
  };
}
