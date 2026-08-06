import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import type { ProtectedPublicationEvent } from "@vibestudio/shared/protectedPublicationEvents";

export interface DevTemplateTreeFile {
  path: string;
  contentHash: string;
  executable: boolean;
}

export interface DevTemplateRepositoryInspection {
  files: DevTemplateTreeFile[];
  skippedPaths: string[];
}

export interface DevTemplateMirrorConflict {
  repoPath: string;
  paths: string[];
  skippedPaths: string[];
}

export interface DevTemplateMirrorResult {
  appliedRepositories: string[];
  changedPathCount: number;
  conflicts: DevTemplateMirrorConflict[];
}

interface MirrorDevTemplatePublicationOptions {
  destinationRoot: string;
  publication: ProtectedPublicationEvent;
  inspectRepository(repoPath: string): Promise<DevTemplateRepositoryInspection>;
  readState(stateHash: string): Promise<DevTemplateTreeFile[]>;
  readBlob(contentHash: string): Promise<Buffer | null>;
}

interface RepositoryPlan {
  repoPath: string;
  repositoryRoot: string;
  removes: DevTemplateTreeFile[];
  writes: DevTemplateTreeFile[];
}

function safeJoin(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...relativePath.split("/"));
  if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Dev template mirror path escapes its root: ${JSON.stringify(relativePath)}`);
  }
  return resolved;
}

function sameFile(left: DevTemplateTreeFile | null, right: DevTemplateTreeFile | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.contentHash === right.contentHash &&
      left.executable === right.executable)
  );
}

function fileMap(files: DevTemplateTreeFile[]): Map<string, DevTemplateTreeFile> {
  return new Map(files.map((file) => [file.path, file]));
}

function structuralConflictPaths(files: Iterable<DevTemplateTreeFile>): string[] {
  const paths = [...files].map((file) => file.path).sort();
  const conflicts = new Set<string>();
  for (let index = 1; index < paths.length; index += 1) {
    const previous = paths[index - 1];
    const current = paths[index];
    if (previous && current?.startsWith(`${previous}/`)) {
      conflicts.add(previous);
      conflicts.add(current);
    }
  }
  return [...conflicts].sort();
}

async function currentFile(
  filePath: string
): Promise<{ contentHash: string; executable: boolean } | null> {
  let stat: fs.Stats;
  try {
    stat = await fsp.lstat(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
  if (!stat.isFile()) return null;
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return { contentHash: hash.digest("hex"), executable: (stat.mode & 0o111) !== 0 };
}

async function assertExpectedFile(filePath: string, expected: DevTemplateTreeFile): Promise<void> {
  const actual = await currentFile(filePath);
  if (actual?.contentHash !== expected.contentHash || actual.executable !== expected.executable) {
    throw new Error(`destination changed while mirroring: ${filePath}`);
  }
}

async function assertUnoccupied(filePath: string): Promise<void> {
  try {
    await fsp.lstat(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return;
    throw error;
  }
  throw new Error(`destination became occupied while mirroring: ${filePath}`);
}

async function pruneEmptyParents(filePath: string, repositoryRoot: string): Promise<void> {
  const root = path.resolve(repositoryRoot);
  let directory = path.dirname(filePath);
  while (directory !== root && directory.startsWith(`${root}${path.sep}`)) {
    try {
      await fsp.rmdir(directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOENT") return;
      throw error;
    }
    directory = path.dirname(directory);
  }
}

async function writeBlob(filePath: string, bytes: Buffer, executable: boolean): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    await fsp.writeFile(temporary, bytes, { flag: "wx", mode: executable ? 0o755 : 0o644 });
    await fsp.rename(temporary, filePath);
  } finally {
    await fsp.rm(temporary, { force: true });
  }
}

async function stateFiles(
  stateHash: string | null,
  readState: (stateHash: string) => Promise<DevTemplateTreeFile[]>
): Promise<DevTemplateTreeFile[]> {
  return stateHash === null ? [] : readState(stateHash);
}

/**
 * Three-way persistence for one protected publication:
 *
 *   base    = the repository state before the app publication
 *   current = the developer checkout now
 *   next    = the repository state published by the app
 *
 * App-only changes are applied, checkout-only changes are preserved, identical
 * changes coalesce, and overlapping/structurally incompatible changes reject
 * the complete publication before any file is touched. Platform metadata such
 * as nested `.git` directories remains outside all three semantic trees.
 */
export async function mirrorDevTemplatePublication(
  options: MirrorDevTemplatePublicationOptions
): Promise<DevTemplateMirrorResult> {
  const prepared = await Promise.all(
    options.publication.repositories.map(async (repository) => ({
      repository,
      current: await options.inspectRepository(repository.repoPath),
      base: await stateFiles(repository.previousStateHash, options.readState),
      next: await stateFiles(repository.nextStateHash, options.readState),
    }))
  );

  const plans: RepositoryPlan[] = [];
  const conflicts: DevTemplateMirrorConflict[] = [];
  for (const { repository, current, base, next } of prepared) {
    const baseByPath = fileMap(base);
    const currentByPath = fileMap(current.files);
    const nextByPath = fileMap(next);
    const merged = new Map<string, DevTemplateTreeFile>();
    const conflictPaths = new Set<string>();
    const paths = new Set([...baseByPath.keys(), ...currentByPath.keys(), ...nextByPath.keys()]);

    for (const filePath of paths) {
      const baseFile = baseByPath.get(filePath) ?? null;
      const currentFileAtPath = currentByPath.get(filePath) ?? null;
      const nextFile = nextByPath.get(filePath) ?? null;
      let selected: DevTemplateTreeFile | null;
      if (sameFile(currentFileAtPath, baseFile)) selected = nextFile;
      else if (sameFile(nextFile, baseFile) || sameFile(currentFileAtPath, nextFile)) {
        selected = currentFileAtPath;
      } else {
        conflictPaths.add(filePath);
        continue;
      }
      if (selected) merged.set(filePath, selected);
    }
    for (const filePath of structuralConflictPaths(merged.values())) conflictPaths.add(filePath);
    if (conflictPaths.size > 0 || current.skippedPaths.length > 0) {
      conflicts.push({
        repoPath: repository.repoPath,
        paths: [...conflictPaths].sort(),
        skippedPaths: current.skippedPaths,
      });
      continue;
    }

    const removes = [...currentByPath.values()].filter(
      (file) => !sameFile(file, merged.get(file.path) ?? null)
    );
    const writes = [...merged.values()].filter(
      (file) => !sameFile(file, currentByPath.get(file.path) ?? null)
    );
    plans.push({
      repoPath: repository.repoPath,
      repositoryRoot: safeJoin(options.destinationRoot, repository.repoPath),
      removes,
      writes,
    });
  }
  if (conflicts.length > 0) {
    return { appliedRepositories: [], changedPathCount: 0, conflicts };
  }

  const blobs = new Map<string, Buffer>();
  for (const plan of plans) {
    for (const write of plan.writes) {
      if (blobs.has(write.contentHash)) continue;
      const bytes = await options.readBlob(write.contentHash);
      if (bytes === null) {
        throw new Error(`Publication blob is unavailable: ${write.contentHash}`);
      }
      blobs.set(write.contentHash, bytes);
    }
  }

  // Recheck every replaced/removed leaf before mutating anything. This catches
  // an external edit made after the current-tree scan.
  for (const plan of plans) {
    for (const file of plan.removes) {
      await assertExpectedFile(safeJoin(plan.repositoryRoot, file.path), file);
    }
  }

  for (const plan of plans) {
    for (const file of plan.removes) {
      const destination = safeJoin(plan.repositoryRoot, file.path);
      await fsp.rm(destination, { force: true });
      await pruneEmptyParents(destination, plan.repositoryRoot);
    }
  }
  for (const plan of plans) {
    for (const write of plan.writes) {
      const destination = safeJoin(plan.repositoryRoot, write.path);
      await assertUnoccupied(destination);
      const bytes = blobs.get(write.contentHash);
      if (bytes === undefined) throw new Error(`Publication blob disappeared from the mirror plan`);
      await writeBlob(destination, bytes, write.executable);
    }
  }

  return {
    appliedRepositories: plans.map((plan) => plan.repoPath),
    changedPathCount: new Set(
      plans.flatMap((plan) => [
        ...plan.removes.map((file) => `${plan.repoPath}/${file.path}`),
        ...plan.writes.map((write) => `${plan.repoPath}/${write.path}`),
      ])
    ).size,
    conflicts: [],
  };
}
