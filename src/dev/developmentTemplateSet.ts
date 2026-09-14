import * as fs from "node:fs";
import * as path from "node:path";
import type { DefaultWorkspaceTemplates } from "@vibestudio/workspace/templateRelease";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import { inspectWorkspaceSources } from "../workspaceTemplateSource.js";
import {
  DEPENDENCY_TEMPLATE_URLS,
  selectDevelopmentTemplateCheckouts,
} from "./developmentTemplateConfig.js";

export interface DevelopmentTemplateSet {
  pins: DefaultWorkspaceTemplates;
  checkouts: Record<keyof DefaultWorkspaceTemplates, string>;
  sourceCheckouts: Record<keyof DefaultWorkspaceTemplates, string>;
  /**
   * Templates Personal and System declare here but not in any release: the
   * acceptance harness, so a development instance can run the suite in either
   * workspace against whatever units that workspace installs.
   */
  dependencies: Array<{ pin: WorkspaceTemplatePin; checkout: string }>;
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
  // A dependency template is not a root, so it is declared by the workspaces
  // that install it rather than selected as one of them.
  const dependencyCheckouts = Object.entries(selected.dependencies).map(([name, checkout]) => ({
    name,
    checkout: fs.realpathSync(path.resolve(checkout)),
    url: DEPENDENCY_TEMPLATE_URLS[name as keyof typeof DEPENDENCY_TEMPLATE_URLS],
  }));
  const declareDependencies = new Map<string, string[]>(
    dependencyCheckouts.length === 0
      ? []
      : (["personal", "system"] as const).map((name) => [
          fs.realpathSync(path.resolve(selected.checkouts[name])),
          dependencyCheckouts.map((dependency) => dependency.url),
        ])
  );
  const inspected = await inspectWorkspaceSources({
    checkouts: [
      ...names.map((name) => selected.checkouts[name]),
      ...dependencyCheckouts.map((dependency) => dependency.checkout),
    ],
    checkpointRoot: input.checkpointRoot,
    declareDependencies,
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
  const dependencies = dependencyCheckouts.map((dependency) => {
    const source = byCheckout.get(dependency.checkout);
    if (!source) throw new Error(`Development ${dependency.name} template was not inspected`);
    return { pin: source.pin, checkout: source.checkout };
  });
  return { pins, checkouts, sourceCheckouts: selected.checkouts, dependencies };
}

export function developmentTemplateSetSources(selection: DevelopmentTemplateSet): Array<{
  pin: WorkspaceTemplatePin;
  checkout: string;
}> {
  return [
    ...(["base", "personal", "system"] as const).map((name) => ({
      pin: selection.pins[name],
      checkout: selection.checkouts[name],
    })),
    ...selection.dependencies,
  ];
}

export function developmentTemplateSetEnv(selection: DevelopmentTemplateSet): NodeJS.ProcessEnv {
  const sources = developmentTemplateSetSources(selection);
  return {
    VIBESTUDIO_DEFAULT_WORKSPACE_TEMPLATES: JSON.stringify(selection.pins),
    VIBESTUDIO_INITIAL_WORKSPACE_TEMPLATE: JSON.stringify(selection.pins.system),
    VIBESTUDIO_WORKSPACE_SOURCES: JSON.stringify(sources),
  };
}
