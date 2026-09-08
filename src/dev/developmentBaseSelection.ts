import * as fs from "node:fs";
import * as path from "node:path";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import {
  DEFAULT_WORKSPACE_TEMPLATES_ENV,
  INITIAL_WORKSPACE_TEMPLATE_ENV,
  readBaseTemplateRelease,
} from "@vibestudio/workspace/baseTemplateRelease";
import { WORKSPACE_SOURCES_ENV } from "@vibestudio/workspace/workspaceSources";
import { parseTemplateManifestContent } from "@vibestudio/workspace/templateManifest";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import { selectDevelopmentBaseCheckout } from "./developmentBaseConfig.js";
import {
  DEVELOPMENT_WORKSPACE_DISTRIBUTIONS,
  prepareDevelopmentWorkspaceDistributions,
  type DevelopmentWorkspaceDistribution,
} from "./workspaceDistributionBuilder.js";

export interface DevelopmentBaseSelection {
  pins: Record<DevelopmentWorkspaceDistribution, WorkspaceTemplatePin>;
  checkouts: Record<DevelopmentWorkspaceDistribution, string>;
  /** The developer's visible worktree the checkpoint was taken from. */
  sourceCheckout: string;
  /** Semantic repositories whose protected publications may write back here. */
  writebackRepositories: readonly string[];
}

/**
 * Export the linked authoring checkout as three independent root distributions.
 *
 * Every development loop that starts a workspace goes through here — instance
 * launches, the Electron E2E suite, and the mobile device smoke — so none of
 * them can drift onto a stale released Base while the phone, the host, and the
 * userland typecheck are all built from the current checkout.
 *
 * Returns null when no development Base is selected, which means the caller
 * should let the workspace runtime use the canonical pinned release.
 */
export async function resolveDevelopmentBaseSelection(input: {
  repoRoot: string;
  /** Private location for the synthetic checkpoint clone of a dirty worktree. */
  checkpointTarget: string;
  explicitCheckout?: string;
  productionBase?: boolean;
}): Promise<DevelopmentBaseSelection | null> {
  const selected = selectDevelopmentBaseCheckout(input.repoRoot, {
    ...(input.explicitCheckout ? { explicitCheckout: input.explicitCheckout } : {}),
    productionBase: input.productionBase ?? false,
  });
  if (!selected) return null;

  const sourceCheckout = fs.realpathSync(path.resolve(selected));
  const templateManifest = parseTemplateManifestContent(
    fs.readFileSync(path.join(sourceCheckout, "meta/vibestudio.yml"), "utf8"),
    WORKSPACE_SYSTEM_EPOCH
  );
  const distributions = await prepareDevelopmentWorkspaceDistributions({
    sourceRoot: sourceCheckout,
    outputRoot: input.checkpointTarget,
    url: readBaseTemplateRelease(input.repoRoot).baseTemplate.url,
  });
  return {
    ...distributions,
    sourceCheckout,
    writebackRepositories: ["meta", ...templateManifest.inventory.repositories],
  };
}

/**
 * The environment a child process needs to acquire `selection` locally.
 *
 * Write-back is deliberately absent: only the source development instance may
 * publish back into the developer's Base checkout, and it sets that itself.
 */
export function developmentBaseSelectionSources(selection: DevelopmentBaseSelection): Array<{
  pin: WorkspaceTemplatePin;
  checkout: string;
}> {
  return DEVELOPMENT_WORKSPACE_DISTRIBUTIONS.map((name) => ({
    pin: selection.pins[name],
    checkout: selection.checkouts[name],
  }));
}

/** Host acquisition and bootstrap selection for the three exported roots. */
export function developmentBaseSelectionEnv(
  selection: DevelopmentBaseSelection
): Record<string, string> {
  return {
    [DEFAULT_WORKSPACE_TEMPLATES_ENV]: JSON.stringify(selection.pins),
    [INITIAL_WORKSPACE_TEMPLATE_ENV]: JSON.stringify(selection.pins.system),
    [WORKSPACE_SOURCES_ENV]: JSON.stringify(developmentBaseSelectionSources(selection)),
  };
}
