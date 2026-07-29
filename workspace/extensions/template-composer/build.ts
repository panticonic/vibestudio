import { Buffer } from "node:buffer";
import type {
  VcsListDirectoryResult,
  VcsReadFileResult,
  VcsResolveRepositoryResult,
  VcsStateNodeRef,
  VcsStatusResult,
} from "@vibestudio/service-schemas/vcs";
import type { TemplateOperationPorts } from "@workspace/template-composer";
import type { ExtensionContextLike } from "./context.js";

const BUILDABLE_SECTIONS = new Set(["panels", "workers", "extensions", "apps", "about"]);

interface UnitManifest {
  repoPath: string;
  name: string;
  dependencies: Set<string>;
  buildable: boolean;
}

function fileText(file: NonNullable<VcsReadFileResult>): string {
  return file.content.kind === "text"
    ? file.content.text
    : Buffer.from(file.content.base64, "base64").toString("utf8");
}

async function directoryEntries(
  ctx: ExtensionContextLike,
  state: VcsStateNodeRef,
  directory: string
): Promise<NonNullable<VcsListDirectoryResult>["entries"]> {
  const entries: NonNullable<VcsListDirectoryResult>["entries"] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.rpc.call<VcsListDirectoryResult>("main", "vcs.listDirectory", {
      state,
      path: directory,
      ...(cursor ? { cursor } : {}),
      limit: 500,
    });
    if (!page) break;
    entries.push(...page.entries);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return entries;
}

async function allRepositoryPaths(
  ctx: ExtensionContextLike,
  state: VcsStateNodeRef
): Promise<string[]> {
  const paths = new Set<string>();
  for (const root of await directoryEntries(ctx, state, "")) {
    if (root.repositoryRoot) paths.add(root.path);
    if (root.kind !== "directory" || root.repositoryRoot) continue;
    for (const child of await directoryEntries(ctx, state, root.path)) {
      if (child.repositoryRoot) paths.add(child.path);
    }
  }
  return [...paths].sort();
}

async function manifest(
  ctx: ExtensionContextLike,
  state: VcsStateNodeRef,
  repoPath: string
): Promise<UnitManifest | null> {
  const repository = await ctx.rpc.call<VcsResolveRepositoryResult>(
    "main",
    "vcs.resolveRepository",
    { state, repoPath }
  );
  if (!repository) return null;
  const file = await ctx.rpc.call<VcsReadFileResult>("main", "vcs.readFile", {
    state,
    repositoryId: repository.repositoryId,
    file: { kind: "path", path: "package.json" },
  });
  if (!file) return null;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(fileText(file)) as Record<string, unknown>;
  } catch {
    throw new Error(`Cannot build template composition: ${repoPath}/package.json is invalid JSON`);
  }
  if (typeof value["name"] !== "string" || !value["name"]) return null;
  const dependencies = new Set<string>();
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const candidates = value[field];
    if (!candidates || typeof candidates !== "object" || Array.isArray(candidates)) continue;
    for (const name of Object.keys(candidates)) dependencies.add(name);
  }
  return {
    repoPath,
    name: value["name"],
    dependencies,
    buildable: BUILDABLE_SECTIONS.has(repoPath.split("/")[0] ?? ""),
  };
}

export function createAffectedBuildGate(
  ctx: ExtensionContextLike
): TemplateOperationPorts["buildAffected"] {
  return async (contextId, affectedRepoPaths) => {
    const status = await ctx.rpc.call<VcsStatusResult>("main", "vcs.status", { contextId });
    const state = status.workingHead;
    const manifests = (
      await Promise.all(
        (await allRepositoryPaths(ctx, state)).map((repoPath) => manifest(ctx, state, repoPath))
      )
    ).filter((candidate): candidate is UnitManifest => candidate !== null);
    const byName = new Map(manifests.map((candidate) => [candidate.name, candidate]));
    const dependants = new Map<string, Set<string>>();
    for (const candidate of manifests) {
      for (const dependency of candidate.dependencies) {
        if (!byName.has(dependency)) continue;
        const set = dependants.get(dependency) ?? new Set<string>();
        set.add(candidate.name);
        dependants.set(dependency, set);
      }
    }
    const affectedNames = new Set(
      manifests
        .filter((candidate) => affectedRepoPaths.includes(candidate.repoPath))
        .map((candidate) => candidate.name)
    );
    const pending = [...affectedNames];
    while (pending.length > 0) {
      const name = pending.pop()!;
      for (const dependant of dependants.get(name) ?? []) {
        if (affectedNames.has(dependant)) continue;
        affectedNames.add(dependant);
        pending.push(dependant);
      }
    }
    const units = manifests
      .filter((candidate) => candidate.buildable && affectedNames.has(candidate.name))
      .map((candidate) => candidate.repoPath)
      .sort();
    const manifestPaths = new Set(manifests.map((candidate) => candidate.repoPath));
    const failures: Array<{ unit: string; message: string }> = affectedRepoPaths
      .filter(
        (repoPath) =>
          BUILDABLE_SECTIONS.has(repoPath.split("/")[0] ?? "") && !manifestPaths.has(repoPath)
      )
      .sort()
      .map((unit) => ({
        unit,
        message: `Cannot build affected unit ${unit}: package.json with a package name is required`,
      }));
    for (const unit of units) {
      try {
        await ctx.rpc.call("main", "build.getBuild", unit, `ctx:${contextId}`);
      } catch (error) {
        failures.push({
          unit,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { failures };
  };
}
