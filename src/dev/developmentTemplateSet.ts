import * as fs from "node:fs";
import * as path from "node:path";
import type { DefaultWorkspaceTemplates } from "@vibestudio/workspace/templateRelease";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import { inspectWorkspaceSources } from "../workspaceTemplateSource.js";
import { selectDevelopmentTemplateCheckouts } from "./developmentTemplateConfig.js";

export interface DevelopmentTemplateSet {
  pins: DefaultWorkspaceTemplates;
  checkouts: Record<keyof DefaultWorkspaceTemplates, string>;
  sourceCheckouts: Record<keyof DefaultWorkspaceTemplates, string>;
}

/**
 * Snapshot the three canonical template repositories exactly as authored.
 *
 * There is no source superset and no role-specific projection: every checkout
 * already is the independently publishable template named by its origin and
 * its own meta/vibestudio.yml. Personal and System declare Base through the
 * same dependency mechanism every other template uses.
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
  const names = ["base", "personal", "system"] as const;
  const inspected = await inspectWorkspaceSources({
    checkouts: names.map((name) => selected.checkouts[name]),
    checkpointRoot: input.checkpointRoot,
  });
  const byCheckout = new Map(inspected.map((source) => [source.sourceCheckout, source]));
  const pins = {} as Record<(typeof names)[number], WorkspaceTemplatePin>;
  const checkouts = {} as Record<(typeof names)[number], string>;
  for (const name of names) {
    const sourceCheckout = fs.realpathSync(path.resolve(selected.checkouts[name]));
    const source = byCheckout.get(sourceCheckout);
    if (!source) throw new Error(`Development ${name} template was not inspected`);
    pins[name] = source.pin;
    checkouts[name] = source.checkout;
  }
  return { pins, checkouts, sourceCheckouts: selected.checkouts };
}

export function developmentTemplateSetSources(selection: DevelopmentTemplateSet): Array<{
  pin: WorkspaceTemplatePin;
  checkout: string;
}> {
  return (["base", "personal", "system"] as const).map((name) => ({
    pin: selection.pins[name],
    checkout: selection.checkouts[name],
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
