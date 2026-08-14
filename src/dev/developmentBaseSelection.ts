import * as fs from "node:fs";
import * as path from "node:path";
import { sha256Hex } from "@vibestudio/content-addressing";
import { GitClient } from "@vibestudio/git";
import { readBaseTemplateRelease } from "@vibestudio/workspace/baseTemplateRelease";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import { inspectRootTemplateCheckout } from "../server/acquireRootTemplateSnapshot.js";
import { prepareDevelopmentBaseCheckpoint } from "./developmentBaseCheckpoint.js";
import { selectDevelopmentBaseCheckout } from "./developmentBaseConfig.js";

export interface DevelopmentBaseSelection {
  /** The exact pin the workspace runtime records and acquires. */
  pin: WorkspaceTemplatePin;
  /** Committed checkout the acquisition is seeded from. */
  checkout: string;
  /** The developer's visible worktree the checkpoint was taken from. */
  sourceCheckout: string;
  /** True when `checkout` is a private clone holding a synthetic commit. */
  temporary: boolean;
  changedPaths: readonly string[];
  untrackedPaths: readonly string[];
}

/**
 * Resolve the developer's Base worktree into the same immutable pin production
 * acquisition consumes.
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

  const gitClient = new GitClient();
  const checkpoint = await prepareDevelopmentBaseCheckpoint({
    checkout: fs.realpathSync(path.resolve(selected)),
    target: input.checkpointTarget,
    gitClient,
  });
  const inspected = await inspectRootTemplateCheckout({
    checkout: checkpoint.checkout,
    url: readBaseTemplateRelease(input.repoRoot).baseTemplate.url,
    git: gitClient,
    // Only content hashes are needed to name the pin; the bytes are read again
    // by whichever process actually acquires the snapshot.
    sink: {
      async put(bytes: Uint8Array) {
        return { digest: sha256Hex(bytes), size: bytes.byteLength };
      },
    },
  });
  return { ...checkpoint, ...inspected };
}

/**
 * The environment a child process needs to acquire `selection` locally.
 *
 * Write-back is deliberately absent: only the source development instance may
 * publish back into the developer's Base checkout, and it sets that itself.
 */
export function developmentBaseSelectionEnv(
  selection: DevelopmentBaseSelection
): Record<string, string> {
  return {
    VIBESTUDIO_DEV_ROOT_TEMPLATE: JSON.stringify(selection.pin),
    VIBESTUDIO_DEV_ROOT_TEMPLATE_CHECKOUT: selection.checkout,
  };
}
