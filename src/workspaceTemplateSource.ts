import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { sha256Hex } from "@vibestudio/content-addressing";
import { GitClient, readExactGitSnapshot } from "@vibestudio/git";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import { validateRootTemplateSource } from "@vibestudio/workspace/rootTemplate";
import { normalizeTemplateGitUrl } from "@vibestudio/workspace/templateCoordinates";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import { WorkspaceTemplatePinSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import type { WorkspaceSource } from "@vibestudio/workspace/workspaceSources";
import { checkpointWorkspaceSource } from "./workspaceTemplateCheckpoint.js";
import { enumerateRootTemplateRepositories } from "./server/workspaceRootTemplateBootstrap.js";

export interface WorkspaceSourceInspection extends WorkspaceSource {
  sourceCheckout: string;
  changedPaths: readonly string[];
}

function git(checkout: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", checkout, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function canonicalTemplateUrlFromCheckout(checkout: string): string {
  const remote = git(checkout, ["remote", "get-url", "origin"]);
  const scp = /^git@([^:]+):(.+)$/u.exec(remote);
  const ssh = /^ssh:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/u.exec(remote);
  const transport = scp
    ? `https://${scp[1]}/${scp[2]}`
    : ssh
      ? `https://${ssh[1]}/${ssh[2]}`
      : remote;
  try {
    return normalizeTemplateGitUrl(transport);
  } catch (error) {
    throw new Error(
      `Template checkout ${checkout} origin must identify its canonical HTTP(S) remote; got ${remote}`,
      { cause: error }
    );
  }
}

/**
 * Declare one more template dependency on a checkpointed checkout.
 *
 * A checkpoint is already an instance-owned commit of the developer's live
 * worktree, so composing there keeps the developer's own repository clean: the
 * acceptance harness is a dependency of the workspace a development instance
 * installs, and of nothing that ships.
 */
function declareCheckpointDependency(checkout: string, url: string): void {
  const manifestPath = path.join(checkout, "meta", "vibestudio.yml");
  const manifest = fs.readFileSync(manifestPath, "utf8");
  const document = YAML.parse(manifest) as {
    template?: { dependencies?: Array<{ url?: string }> };
  };
  const template = document.template;
  if (!template) {
    throw new Error(`Template checkpoint ${checkout} has no template block to extend`);
  }
  const dependencies = template.dependencies ?? [];
  if (dependencies.some((dependency) => dependency?.url === url)) return;
  template.dependencies = [...dependencies, { url }];
  fs.writeFileSync(manifestPath, YAML.stringify(document));
  execFileSync("git", ["-C", checkout, "add", "meta/vibestudio.yml"], { stdio: "ignore" });
  execFileSync(
    "git",
    ["-C", checkout, "commit", "--no-gpg-sign", "-m", "Declare development template dependency"],
    {
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Vibestudio Development",
        GIT_AUTHOR_EMAIL: "development@vibestudio.invalid",
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_NAME: "Vibestudio Development",
        GIT_COMMITTER_EMAIL: "development@vibestudio.invalid",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      },
    }
  );
}

export async function inspectWorkspaceSources(input: {
  checkouts: readonly string[];
  checkpointRoot: string;
  /** Template URLs to declare as dependencies of the named source checkouts. */
  declareDependencies?: ReadonlyMap<string, readonly string[]>;
}): Promise<WorkspaceSourceInspection[]> {
  const gitClient = new GitClient();
  const selections: WorkspaceSourceInspection[] = [];
  const selectedUrls = new Set<string>();
  for (const [index, requested] of input.checkouts.entries()) {
    const sourceCheckout = fs.realpathSync(path.resolve(requested));
    const url = canonicalTemplateUrlFromCheckout(sourceCheckout);
    if (selectedUrls.has(url)) {
      throw new Error(`Template checkout selected more than once for ${url}`);
    }
    selectedUrls.add(url);
    const checkpoint = await checkpointWorkspaceSource({
      checkout: sourceCheckout,
      target: path.join(input.checkpointRoot, String(index)),
    });
    for (const dependencyUrl of input.declareDependencies?.get(sourceCheckout) ?? []) {
      declareCheckpointDependency(checkpoint.checkout, dependencyUrl);
    }
    const status = await gitClient.status(checkpoint.checkout);
    if (!status.commit || !status.branch) {
      throw new Error(`Development template checkpoint ${checkpoint.checkout} has no named commit`);
    }
    const snapshot = await readExactGitSnapshot({
      git: gitClient,
      dir: checkpoint.checkout,
      commit: status.commit,
      label: `development template ${url}`,
      sink: {
        async put(bytes) {
          return { digest: sha256Hex(bytes), size: bytes.byteLength };
        },
      },
      reservedPaths: "exclude",
    });
    const manifest = validateRootTemplateSource({
      workspaceId: "development-template",
      expectedSystemEpoch: WORKSPACE_SYSTEM_EPOCH,
      readFile: snapshot.readFile,
      snapshotPaths: snapshot.files.map((file) => file.path),
      repositories: enumerateRootTemplateRepositories(snapshot),
    });
    const pin = WorkspaceTemplatePinSchema.parse({
      url,
      ref: `refs/heads/${status.branch}`,
      commit: snapshot.commit,
    }) as WorkspaceTemplatePin;
    selections.push({
      ...checkpoint,
      pin,
      review: {
        ...(manifest.presentation
          ? {
              presentation: {
                name: manifest.presentation.name,
                description: manifest.presentation.description,
              },
            }
          : {}),
        ...manifest.inventory,
      },
    });
  }
  return selections;
}
