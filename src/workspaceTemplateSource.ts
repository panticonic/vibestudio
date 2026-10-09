import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { sha256Hex } from "@vibestudio/content-addressing";
import { GitClient, readExactGitSnapshot } from "@vibestudio/git";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import { templateRepositories } from "@vibestudio/workspace/templateManifest";
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

/** Discover the address of a freely selected local repository. */
export function workspaceSourceFromCheckout(checkout: string): { checkout: string; url: string } {
  return { checkout, url: canonicalTemplateUrlFromCheckout(checkout) };
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
  sources: readonly { checkout: string; url: string }[];
  checkpointRoot: string;
  /** Template URLs to declare as dependencies of the named source checkouts. */
  declareDependencies?: ReadonlyMap<string, readonly string[]>;
}): Promise<WorkspaceSourceInspection[]> {
  const gitClient = new GitClient();
  const selections = new Array<WorkspaceSourceInspection>(input.sources.length);
  const selectedUrls = new Set<string>();
  const checkouts = input.sources.map((requested) => {
    const sourceCheckout = fs.realpathSync(path.resolve(requested.checkout));
    const url = normalizeTemplateGitUrl(requested.url);
    if (selectedUrls.has(url)) {
      throw new Error(`Template checkout selected more than once for ${url}`);
    }
    selectedUrls.add(url);
    return { sourceCheckout, url };
  });
  const inspect = async (index: number): Promise<void> => {
    const { sourceCheckout, url } = checkouts[index]!;
    const checkpoint = await checkpointWorkspaceSource({
      checkout: sourceCheckout,
      target: path.join(input.checkpointRoot, String(index)),
    });
    for (const dependencyUrl of input.declareDependencies?.get(sourceCheckout) ?? []) {
      declareCheckpointDependency(checkpoint.checkout, dependencyUrl);
    }
    // The checkpoint already sealed the visible worktree. Read its identity,
    // then admit the immutable commit tree below; a second whole-worktree
    // status walk adds no evidence to that snapshot boundary.
    const [commit, branch] = await Promise.all([
      gitClient.getCurrentCommit(checkpoint.checkout),
      gitClient.getCurrentBranch(checkpoint.checkout),
    ]);
    if (!commit || !branch) {
      throw new Error(`Development template checkpoint ${checkpoint.checkout} has no named commit`);
    }
    const snapshot = await readExactGitSnapshot({
      git: gitClient,
      dir: checkpoint.checkout,
      commit,
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
      ref: `refs/heads/${branch}`,
      commit: snapshot.commit,
    }) as WorkspaceTemplatePin;
    selections[index] = {
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
        repositories: templateRepositories(snapshot.files.map((file) => file.path)),
        dependencies: manifest.dependencies,
      },
    };
  };
  // Each checkpoint and snapshot has its own immutable repository. Bound the
  // independent I/O, preserve source order, and join every started inspection
  // before propagating its original failure to the owner of checkpointRoot.
  let next = 0;
  const workers = Array.from({ length: Math.min(4, checkouts.length) }, async () => {
    while (next < checkouts.length) await inspect(next++);
  });
  const results = await Promise.allSettled(workers);
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
  return selections;
}
