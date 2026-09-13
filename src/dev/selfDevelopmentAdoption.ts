import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeRemoteUrl } from "@vibestudio/workspace/remoteUrl";
import {
  serializeLocalGitMirrors,
  LOCAL_GIT_MIRRORS_ENV,
  type LocalGitMirror,
} from "../server/services/localGitMirrors.js";
import { selectDevelopmentBaseCheckout } from "./developmentBaseConfig.js";

/**
 * Adoption of the Vibestudio source as ordinary workspace projects.
 *
 * Self-development builds `projects/vibestudio` from the semantic workspace,
 * which means the monorepo has to be adopted there first — a documented
 * one-time setup step, never something a development session does implicitly.
 * A developer instance would otherwise have to adopt it by cloning the
 * published remote, which is both slow and the wrong source: the interesting
 * tree is the one on this disk.
 *
 * So the provisioner declares a local mirror for each canonical upstream and
 * then performs the ordinary import against that upstream. The adoption record
 * keeps the canonical URL, so identity, re-import, and publication all behave
 * exactly as they would for a repository that was cloned over the network.
 */
export interface SelfDevelopmentProject {
  repoPath: string;
  /** Canonical credential-free upstream the adoption record fixes. */
  url: string;
  /** Developer checkout whose bytes stand in for that upstream. */
  checkout: string;
}

export const SELF_DEVELOPMENT_BRANCH = "main" as const;

function git(directory: string, args: readonly string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(env ? { env } : {}),
  }).trim();
}

/**
 * The canonical HTTPS identity of a checkout's origin.
 *
 * Developers fetch over SSH; an adoption record may not carry that spelling,
 * because a credential-free HTTP(S) URL is what identifies the upstream.
 */
export function canonicalUpstreamUrl(checkout: string): string {
  const origin = git(checkout, ["remote", "get-url", "origin"]);
  const scp = /^(?:ssh:\/\/)?(?:[^@/]+@)?([^/:]+)[:/](.+?)(?:\.git)?\/?$/u.exec(origin);
  if (origin.startsWith("http://") || origin.startsWith("https://")) {
    return normalizeRemoteUrl(origin);
  }
  if (!scp?.[1] || !scp[2]) {
    throw new Error(`Checkout ${checkout} has no resolvable canonical origin URL: ${origin}`);
  }
  return normalizeRemoteUrl(`https://${scp[1]}/${scp[2]}.git`);
}

/** The projects a development instance adopts, in adoption order. */
export function selfDevelopmentProjects(repoRoot: string): SelfDevelopmentProject[] {
  const projects: SelfDevelopmentProject[] = [
    {
      repoPath: "projects/vibestudio",
      url: canonicalUpstreamUrl(repoRoot),
      checkout: fs.realpathSync(path.resolve(repoRoot)),
    },
  ];
  const base = selectDevelopmentBaseCheckout(repoRoot, { productionBase: false });
  if (base) {
    const checkout = fs.realpathSync(path.resolve(base));
    projects.push({
      repoPath: "projects/vibestudio-workspace-base",
      url: canonicalUpstreamUrl(checkout),
      checkout,
    });
  }
  return projects;
}

/** Dependency trees are never source, and no checkout ignore file promises so. */
const NEVER_MIRRORED = ["node_modules/", ".git/"] as const;

/**
 * Build a one-commit mirror of `checkout`'s current working tree.
 *
 * The mirror carries the tree and nothing else: history belongs to the
 * canonical upstream, and shipping it would make every adoption pay for a
 * decade of commits it never reads. Writing it through an owned `GIT_DIR`
 * leaves the developer's own repository completely untouched — no checkpoint
 * branch, no dangling object, no index of theirs rewritten.
 */
export function buildLocalGitMirror(input: {
  checkout: string;
  url: string;
  target: string;
  branch?: string;
}): LocalGitMirror {
  const checkout = fs.realpathSync(path.resolve(input.checkout));
  const target = path.resolve(input.target);
  const branch = input.branch ?? SELF_DEVELOPMENT_BRANCH;
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  execFileSync("git", ["init", "--bare", "--quiet", `--initial-branch=${branch}`, target], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const excludes = path.join(target, "vibestudio-mirror-excludes");
  const checkoutExcludes = path.join(checkout, ".git", "info", "exclude");
  fs.writeFileSync(
    excludes,
    [
      ...NEVER_MIRRORED,
      // The checkout's own private excludes live beside its object store, so
      // an owned GIT_DIR would not otherwise honor them.
      ...(fs.existsSync(checkoutExcludes) ? [fs.readFileSync(checkoutExcludes, "utf8")] : []),
    ].join("\n")
  );
  const index = path.join(target, "vibestudio-mirror-index");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_DIR: target,
    GIT_WORK_TREE: checkout,
    GIT_INDEX_FILE: index,
    GIT_AUTHOR_NAME: "Vibestudio Development",
    GIT_AUTHOR_EMAIL: "development@vibestudio.invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_NAME: "Vibestudio Development",
    GIT_COMMITTER_EMAIL: "development@vibestudio.invalid",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  };
  const run = (args: readonly string[]): string =>
    execFileSync(
      "git",
      [
        "-c",
        "core.bare=false",
        "-c",
        `core.excludesFile=${excludes}`,
        "-c",
        "core.longpaths=true",
        ...args,
      ],
      { encoding: "utf8", cwd: checkout, env: environment, stdio: ["ignore", "pipe", "pipe"] }
    ).trim();
  run(["add", "--all", "--", "."]);
  const tree = run(["write-tree"]);
  const commit = run(["commit-tree", tree, "-m", `Vibestudio development source for ${input.url}`]);
  run(["update-ref", `refs/heads/${branch}`, commit]);
  run(["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
  fs.rmSync(index, { force: true });
  return { url: normalizeRemoteUrl(input.url), checkout: target };
}

/** Mirrors for every adoptable project, built under `target`. */
export function prepareSelfDevelopmentMirrors(input: {
  repoRoot: string;
  target: string;
  projects?: readonly SelfDevelopmentProject[];
}): LocalGitMirror[] {
  const projects = input.projects ?? selfDevelopmentProjects(input.repoRoot);
  return projects.map((project) =>
    buildLocalGitMirror({
      checkout: project.checkout,
      url: project.url,
      target: path.join(input.target, `${project.repoPath.replace(/\//gu, "-")}.git`),
    })
  );
}

/** Environment that lets an instance serve those mirrors. */
export function selfDevelopmentMirrorEnvironment(
  mirrors: readonly LocalGitMirror[]
): NodeJS.ProcessEnv {
  return mirrors.length === 0 ? {} : { [LOCAL_GIT_MIRRORS_ENV]: serializeLocalGitMirrors(mirrors) };
}

export interface AdoptedSelfDevelopmentProject {
  repoPath: string;
  url: string;
  /** True when this run performed the adoption rather than finding it done. */
  adopted: boolean;
}

/** An import refuses a second adoption; that refusal is the idempotent answer. */
function alreadyAdopted(output: string): boolean {
  return /Path already exists/iu.test(output);
}

/**
 * Adopt each project through the ordinary import, then publish it.
 *
 * Import lands a semantic candidate in the git bridge's own context, which is
 * where an operator would compare and integrate it. A first adoption has
 * nothing to integrate against — the repository does not exist yet — so the
 * candidate is published straight to protected main, and that publication is
 * what later test contexts fork from.
 */
export async function adoptSelfDevelopmentProjects(input: {
  projects: readonly SelfDevelopmentProject[];
  runCli(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  branch?: string;
}): Promise<AdoptedSelfDevelopmentProject[]> {
  const branch = input.branch ?? SELF_DEVELOPMENT_BRANCH;
  const adopted: AdoptedSelfDevelopmentProject[] = [];
  for (const project of input.projects) {
    const imported = await input.runCli([
      "vcs",
      "git",
      "import",
      project.url,
      "--path",
      project.repoPath,
      "--branch",
      branch,
      "--json",
    ]);
    if (imported.code !== 0) {
      if (alreadyAdopted(`${imported.stdout}${imported.stderr}`)) {
        adopted.push({ repoPath: project.repoPath, url: project.url, adopted: false });
        continue;
      }
      throw new Error(
        `Could not adopt ${project.repoPath} from ${project.url}: ` +
          `${imported.stderr.trim() || imported.stdout.trim()}`
      );
    }
    const candidate = (
      JSON.parse(imported.stdout) as { candidate?: { contextId?: string; eventId?: string } }
    ).candidate;
    if (!candidate?.contextId || !candidate.eventId) {
      throw new Error(`Import of ${project.repoPath} returned no semantic candidate`);
    }
    const published = await input.runCli([
      "vcs",
      "push",
      "--context",
      candidate.contextId,
      "--json",
    ]);
    if (published.code !== 0) {
      throw new Error(
        `Adopted ${project.repoPath} but could not publish it to protected main: ` +
          `${published.stderr.trim() || published.stdout.trim()}`
      );
    }
    adopted.push({ repoPath: project.repoPath, url: project.url, adopted: true });
  }
  return adopted;
}
