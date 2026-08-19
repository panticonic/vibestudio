/**
 * Exact root template for the Electron E2E suite.
 *
 * A workspace is no longer a directory of copied files: it is one creation
 * descriptor naming the exact external root it was made from, plus the
 * materialization of that root. The suite therefore resolves the developer's
 * Base checkout into the same immutable pin the product uses (`pnpm dev` takes
 * the identical path through `prepareDevelopmentBaseCheckpoint`), materializes
 * it once per run, and lets every case copy that already-materialized tree.
 *
 * Resolution is asynchronous and Git-bound, so it happens once in
 * `globalSetup`. The result travels to the synchronous per-case workspace
 * creator through the environment, exactly like the other run-scoped paths.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { sha256Hex } from "@vibestudio/content-addressing";
import { GitClient } from "@vibestudio/git";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import {
  canonicalTemplateYaml,
  parseTemplateManifestContent,
  rootRuntimeFromTemplateManifest,
} from "@vibestudio/workspace/templateManifest";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import { resolveDevelopmentBaseSelection } from "../../src/dev/developmentBaseSelection.js";
import {
  inspectRootTemplateCheckout,
  seedRootTemplateSnapshotFromCheckout,
} from "../../src/server/acquireRootTemplateSnapshot.js";
import { WorkspaceRootTemplateBootstrap } from "../../src/server/workspaceRootTemplateBootstrap.js";

export const E2E_ROOT_TEMPLATE_ENV = "VIBESTUDIO_E2E_ROOT_TEMPLATE";
export const DEV_ROOT_TEMPLATE_ENV = "VIBESTUDIO_DEV_ROOT_TEMPLATE";
export const DEV_ROOT_TEMPLATE_CHECKOUT_ENV = "VIBESTUDIO_DEV_ROOT_TEMPLATE_CHECKOUT";
export const DEV_ROOT_TEMPLATE_WRITEBACK_ENV = "VIBESTUDIO_DEV_ROOT_TEMPLATE_WRITEBACK";

export const WORKSPACE_CREATION_DESCRIPTOR_PATH = "workspace-creation/v1.json";
export const WORKSPACE_MATERIALIZATION_RECEIPT_PATH = "workspace-creation/materialization-v1.json";

/** The run-scoped root the suite creates every workspace from. */
export interface E2eRootTemplate {
  /** The exact pin every case records in its creation descriptor. */
  pin: WorkspaceTemplatePin;
  /** Committed checkout the workspace runtime seeds its acquisition from. */
  checkout: string;
  /** Already-materialized source tree, ready to copy into a case workspace. */
  materializedSource: string;
}

// The materialized tree carries no workspace identity, so one placeholder id
// is enough to satisfy manifest parsing while preparing the shared copy.
const TEMPLATE_PREPARATION_WORKSPACE_ID = "e2e-root-template";

/** Content hashes are all the bootstrap needs here; the bytes are not retained. */
const hashOnlySink = {
  async put(bytes: Uint8Array) {
    return { digest: sha256Hex(bytes), size: bytes.byteLength };
  },
};

/**
 * Resolve and materialize the developer's Base checkout once for the whole run.
 * Dirty worktrees are handled the same way `pnpm dev` handles them: a private
 * clone owns a synthetic commit, so the developer's branch is never touched.
 */
export async function prepareE2eRootTemplate(input: {
  projectRoot: string;
  runTempRoot: string;
}): Promise<E2eRootTemplate> {
  const selection = await resolveDevelopmentBaseSelection({
    repoRoot: input.projectRoot,
    checkpointTarget: path.join(input.runTempRoot, "base-checkpoint"),
  });
  if (!selection) {
    throw new Error(
      "The Electron E2E suite needs a development Base checkout; select one with `vibestudio base use <path>`"
    );
  }
  const { pin } = selection;
  const gitClient = new GitClient();

  const templateRoot = path.join(input.runTempRoot, "root-template");
  const sourcePath = path.join(templateRoot, "source");
  await materializeRootTemplateSource({
    pin,
    checkout: selection.checkout,
    templateRoot,
    gitClient,
  });

  return { pin, checkout: selection.checkout, materializedSource: sourcePath };
}

/**
 * Materialize one exact root into `<templateRoot>/source`, the tree per-case
 * workspaces are copied from.
 */
async function materializeRootTemplateSource(input: {
  pin: WorkspaceTemplatePin;
  checkout: string;
  templateRoot: string;
  gitClient: GitClient;
}): Promise<string> {
  const statePath = path.join(input.templateRoot, "state");
  const sourcePath = path.join(input.templateRoot, "source");
  fs.mkdirSync(sourcePath, { recursive: true });
  writeWorkspaceCreationDescriptor(statePath, TEMPLATE_PREPARATION_WORKSPACE_ID, input.pin);
  const bootstrap = new WorkspaceRootTemplateBootstrap({
    workspaceId: TEMPLATE_PREPARATION_WORKSPACE_ID,
    statePath,
    sourcePath,
    expectedSystemEpoch: WORKSPACE_SYSTEM_EPOCH,
    sink: hashOnlySink,
    acquire: (requested) =>
      seedRootTemplateSnapshotFromCheckout({
        statePath,
        checkout: input.checkout,
        pin: requested,
        git: input.gitClient,
        sink: hashOnlySink,
      }),
  });
  await bootstrap.prepareSource();
  return sourcePath;
}

function git(dir: string, args: readonly string[], env?: NodeJS.ProcessEnv): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore", ...(env ? { env } : {}) });
}

/**
 * Republish `meta/vibestudio.yml` from the authored template manifest.
 *
 * In a root checkout the runtime manifest is generated, not authored: the root
 * bootstrap refuses any tree whose `meta/vibestudio.yml` is not the canonical
 * flattening of `meta/template.yml`. A case therefore edits the authored
 * manifest and the generated one is republished from it, exactly as the
 * template tooling does.
 */
function regenerateRootRuntimeManifest(checkout: string): void {
  const manifestPath = path.join(checkout, "meta", "template.yml");
  const manifest = parseTemplateManifestContent(
    fs.readFileSync(manifestPath, "utf8"),
    WORKSPACE_SYSTEM_EPOCH
  );
  fs.writeFileSync(
    path.join(checkout, "meta", "vibestudio.yml"),
    canonicalTemplateYaml(rootRuntimeFromTemplateManifest(manifest)),
    "utf8"
  );
}

/**
 * Derive a per-case root from the run's root by committing the case's source
 * customization into it.
 *
 * A workspace is the exact root it names plus what happened to it since, and
 * its semantic state is imported from that root's content — not from the bytes
 * on disk. Editing the materialized copy after creation therefore changes
 * nothing the runtime reads: the import republishes the pinned tree and the
 * edit disappears. A case that wants different source must name a different
 * root, so the customization becomes an ordinary commit and the pin follows.
 */
export async function deriveE2eRootTemplate(input: {
  base: E2eRootTemplate;
  workRoot: string;
  configureSource: (sourceRoot: string) => void;
}): Promise<E2eRootTemplate> {
  const checkout = path.join(input.workRoot, "checkout");
  fs.mkdirSync(path.dirname(checkout), { recursive: true, mode: 0o700 });
  execFileSync(
    "git",
    ["clone", "--local", "--no-checkout", input.base.checkout, checkout],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  git(checkout, ["checkout", "-B", "vibestudio-e2e-case", input.base.pin.commit]);
  input.configureSource(checkout);
  regenerateRootRuntimeManifest(checkout);
  git(checkout, ["add", "-A"]);
  git(checkout, [
    "-c",
    "user.name=Vibestudio E2E",
    "-c",
    "user.email=e2e@vibestudio.invalid",
    "commit",
    "--allow-empty",
    "--no-gpg-sign",
    "-m",
    "E2E case source customization",
  ]);

  const gitClient = new GitClient();
  const { pin } = await inspectRootTemplateCheckout({
    checkout,
    url: input.base.pin.url,
    git: gitClient,
    sink: hashOnlySink,
  });
  const materializedSource = await materializeRootTemplateSource({
    pin,
    checkout,
    templateRoot: path.join(input.workRoot, "root-template"),
    gitClient,
  });
  return { pin, checkout, materializedSource };
}

/**
 * Publish the resolved root to worker processes and to the workspace runtime.
 *
 * The runtime reads the ordinary development selectors, so an E2E workspace
 * acquires its root through exactly the code path a developer launch uses.
 */
export function publishE2eRootTemplate(template: E2eRootTemplate): void {
  process.env[E2E_ROOT_TEMPLATE_ENV] = JSON.stringify(template);
  process.env[DEV_ROOT_TEMPLATE_ENV] = JSON.stringify(template.pin);
  process.env[DEV_ROOT_TEMPLATE_CHECKOUT_ENV] = template.checkout;
  // Write-back belongs to the source development instance alone; an E2E run
  // must never publish back into the developer's Base checkout.
  delete process.env[DEV_ROOT_TEMPLATE_WRITEBACK_ENV];
}

export function requireE2eRootTemplate(): E2eRootTemplate {
  const raw = process.env[E2E_ROOT_TEMPLATE_ENV];
  if (!raw) {
    throw new Error(
      `${E2E_ROOT_TEMPLATE_ENV} is not set; the Playwright global setup resolves the exact root template`
    );
  }
  return JSON.parse(raw) as E2eRootTemplate;
}

export function writeWorkspaceCreationDescriptor(
  statePath: string,
  workspaceId: string,
  pin: WorkspaceTemplatePin
): void {
  const descriptorPath = path.join(statePath, WORKSPACE_CREATION_DESCRIPTOR_PATH);
  fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
  fs.writeFileSync(
    descriptorPath,
    `${JSON.stringify({ version: 1, workspaceId, rootTemplate: pin }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
}

/**
 * Record that this workspace's source already holds the pinned tree.
 *
 * Without the receipt the runtime would re-materialize, discarding the
 * per-case source customization the fixture just applied.
 */
export function writeWorkspaceMaterializationReceipt(
  statePath: string,
  pin: WorkspaceTemplatePin
): void {
  const receiptPath = path.join(statePath, WORKSPACE_MATERIALIZATION_RECEIPT_PATH);
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(
    receiptPath,
    `${JSON.stringify({ version: 1, commit: pin.commit, snapshot: pin.snapshot }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
}
