import * as fs from "node:fs";
import * as path from "node:path";
import { sha256Hex } from "@vibestudio/content-addressing";
import {
  GitClient,
  SYSTEM_GIT_AUTHOR,
  readExactGitSnapshot,
  type ExactGitSnapshot,
} from "@vibestudio/git";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import {
  prepareWorkspaceDistribution,
  type PreparedWorkspaceDistribution,
} from "@vibestudio/workspace/distribution";
import { validateRootTemplateSource } from "@vibestudio/workspace/rootTemplate";
import {
  normalizeTemplateGitUrl,
  templateGitTransportUrl,
} from "@vibestudio/workspace/templateCoordinates";
import { WorkspaceTemplatePinSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import { enumerateRootTemplateRepositories } from "../server/workspaceRootTemplateBootstrap.js";
import { checkpointWorkspaceSource } from "../workspaceTemplateCheckpoint.js";

export interface BuiltWorkspaceDistribution {
  checkout: string;
  pin: WorkspaceTemplatePin;
  snapshot: ExactGitSnapshot;
  repositories: readonly string[];
}

export const DEVELOPMENT_WORKSPACE_DISTRIBUTIONS = ["base", "personal", "system"] as const;
export type DevelopmentWorkspaceDistribution = (typeof DEVELOPMENT_WORKSPACE_DISTRIBUTIONS)[number];

export interface PreparedDevelopmentWorkspaceDistributions {
  pins: Record<DevelopmentWorkspaceDistribution, WorkspaceTemplatePin>;
  checkouts: Record<DevelopmentWorkspaceDistribution, string>;
}

function nestedWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readManifest(checkout: string, manifestPathInput: string): string {
  const manifestPath = manifestPathInput.replace(/\\/gu, "/");
  if (
    !manifestPath ||
    manifestPath.startsWith("/") ||
    manifestPath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Distribution manifest path is invalid: ${JSON.stringify(manifestPathInput)}`);
  }
  return fs.readFileSync(path.join(checkout, ...manifestPath.split("/")), "utf8");
}

function writeDistribution(checkout: string, prepared: PreparedWorkspaceDistribution): void {
  for (const file of prepared.files) {
    const target = path.join(checkout, ...file.path.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if ("bytes" in file) fs.writeFileSync(target, file.bytes, { mode: file.mode, flag: "wx" });
    else {
      fs.copyFileSync(file.sourcePath, target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, file.mode);
    }
  }
}

/** Build one isolated, committed root checkout from an explicit distribution manifest. */
export async function buildWorkspaceDistribution(input: {
  sourceRoot: string;
  manifestPath: string;
  outputRoot: string;
  url: string;
  ref?: string;
  /**
   * Read `sourceRoot` directly because the caller already sealed it.
   *
   * Every distribution built from one sealed state reads the same bytes, so
   * re-sealing per role copies the whole workspace again for nothing — and
   * nests that copy a directory deeper each time, which is what pushed the
   * longest paths in it past what Windows Git will create.
   */
  sourceSealed?: boolean;
  /** Repositories this distribution's declared dependencies already supply. */
  providedRepositories?: ReadonlySet<string>;
}): Promise<BuiltWorkspaceDistribution> {
  const sourceRoot = fs.realpathSync(path.resolve(input.sourceRoot));
  const outputRoot = path.resolve(input.outputRoot);
  if (nestedWithin(sourceRoot, outputRoot) || nestedWithin(outputRoot, sourceRoot)) {
    throw new Error("Distribution output and source roots must be separate trees");
  }
  if (fs.existsSync(outputRoot)) {
    throw new Error(`Distribution output already exists: ${outputRoot}`);
  }
  const ref = input.ref ?? "refs/heads/main";
  const branch = /^refs\/heads\/(.+)$/u.exec(ref)?.[1];
  if (!branch) throw new Error("Distribution ref must be a canonical refs/heads/* ref");
  const url = normalizeTemplateGitUrl(input.url);
  const outputParent = path.dirname(outputRoot);
  fs.mkdirSync(outputParent, { recursive: true });
  const temporaryRoot = fs.mkdtempSync(
    path.join(outputParent, `.${path.basename(outputRoot)}.distribution-`)
  );
  const stagedCheckout = path.join(temporaryRoot, "checkout");
  const sourceCheckpoint = path.join(temporaryRoot, "source-checkpoint");
  const git = new GitClient();
  try {
    const sealed = input.sourceSealed
      ? sourceRoot
      : (
          await checkpointWorkspaceSource({
            checkout: sourceRoot,
            target: sourceCheckpoint,
          })
        ).checkout;
    const prepared = prepareWorkspaceDistribution({
      sourceRoot: sealed,
      manifestContent: readManifest(sealed, input.manifestPath),
      expectedSystemEpoch: WORKSPACE_SYSTEM_EPOCH,
      ...(input.providedRepositories ? { providedRepositories: input.providedRepositories } : {}),
    });
    fs.mkdirSync(stagedCheckout);
    writeDistribution(stagedCheckout, prepared);
    await git.init(stagedCheckout, branch);
    await git.addAll(stagedCheckout);
    const commit = await git.commit({
      dir: stagedCheckout,
      message: "Build self-contained Vibestudio workspace distribution",
      author: SYSTEM_GIT_AUTHOR,
    });
    await git.addRemote(stagedCheckout, "origin", templateGitTransportUrl(url));
    const snapshot = await readExactGitSnapshot({
      git,
      dir: stagedCheckout,
      commit,
      label: `workspace distribution ${url}`,
      sink: {
        async put(bytes) {
          return { digest: sha256Hex(bytes), size: bytes.byteLength };
        },
      },
    });
    const pin = WorkspaceTemplatePinSchema.parse({
      url,
      ref,
      commit: snapshot.commit,
    }) as WorkspaceTemplatePin;
    validateRootTemplateSource({
      workspaceId: "distribution-validation",
      expectedSystemEpoch: WORKSPACE_SYSTEM_EPOCH,
      readFile: (filePath) => snapshot.readFile(filePath),
      snapshotPaths: snapshot.files.map((file) => file.path),
      repositories: enumerateRootTemplateRepositories(snapshot),
    });
    fs.renameSync(stagedCheckout, outputRoot);
    return {
      checkout: outputRoot,
      pin,
      snapshot,
      repositories: prepared.repositories,
    };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

/** Build the three development root distributions from one sealed source state. */
export async function prepareDevelopmentWorkspaceDistributions(input: {
  sourceRoot: string;
  outputRoot: string;
  /**
   * Where each distribution is published, one repository each.
   *
   * That is what publication produces: a template is committed to `main` and
   * the version tagged, so two distributions cannot share a repository without
   * fighting over it. A development build stands in for the published address,
   * so it has to use the same one.
   */
  urls: Record<DevelopmentWorkspaceDistribution, string>;
}): Promise<PreparedDevelopmentWorkspaceDistributions> {
  const sourceRoot = fs.realpathSync(path.resolve(input.sourceRoot));
  const outputRoot = path.resolve(input.outputRoot);
  if (nestedWithin(sourceRoot, outputRoot) || nestedWithin(outputRoot, sourceRoot)) {
    throw new Error("Distribution output and source roots must be separate trees");
  }
  if (fs.existsSync(outputRoot)) {
    throw new Error(`Distribution output already exists: ${outputRoot}`);
  }

  const outputParent = path.dirname(outputRoot);
  fs.mkdirSync(outputParent, { recursive: true });
  const temporaryRoot = fs.mkdtempSync(
    path.join(outputParent, `.${path.basename(outputRoot)}.workspace-distributions-`)
  );
  const stagedOutput = path.join(temporaryRoot, "distributions");
  const sourceCheckpoint = path.join(temporaryRoot, "source-checkpoint");
  try {
    const checkpoint = await checkpointWorkspaceSource({
      checkout: sourceRoot,
      target: sourceCheckpoint,
    });
    fs.mkdirSync(stagedOutput);
    const built = {} as Record<DevelopmentWorkspaceDistribution, BuiltWorkspaceDistribution>;
    // Base is first because the other two are built on it: a distribution that
    // declares a dependency gets Base's repositories as already provided, so
    // its own closure stops where Base's begins. Development resolves every
    // declared dependency to the Base it just built from this same checkout,
    // which is the point of building all three from one sealed state.
    for (const name of DEVELOPMENT_WORKSPACE_DISTRIBUTIONS) {
      const declaresDependency = /^\s*(-\s*)?dependencies:/mu.test(
        fs.readFileSync(
          path.join(checkpoint.checkout, "meta", "distributions", `${name}.yml`),
          "utf8"
        )
      );
      const provided =
        declaresDependency && built.base
          ? new Set(built.base.repositories.filter((repoPath) => repoPath !== "meta"))
          : undefined;
      built[name] = await buildWorkspaceDistribution({
        sourceRoot: checkpoint.checkout,
        ...(provided ? { providedRepositories: provided } : {}),
        // One sealed state for all three, which is the invariant this function
        // exists to hold; re-sealing it per role would copy it three more times.
        sourceSealed: true,
        manifestPath: `meta/distributions/${name}.yml`,
        outputRoot: path.join(stagedOutput, name),
        url: input.urls[name],
        ref: "refs/heads/main",
      });
    }
    fs.renameSync(stagedOutput, outputRoot);
    return {
      pins: Object.fromEntries(
        DEVELOPMENT_WORKSPACE_DISTRIBUTIONS.map((name) => [name, built[name].pin])
      ) as Record<DevelopmentWorkspaceDistribution, WorkspaceTemplatePin>,
      checkouts: Object.fromEntries(
        DEVELOPMENT_WORKSPACE_DISTRIBUTIONS.map((name) => [name, path.join(outputRoot, name)])
      ) as Record<DevelopmentWorkspaceDistribution, string>,
    };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
