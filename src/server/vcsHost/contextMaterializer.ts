import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { canonicalJson, compareUtf16CodeUnits } from "@vibestudio/content-addressing";
import {
  contextBinding,
  CONTEXT_BINDING_FILE,
  encodeContextBinding,
} from "@vibestudio/shared/contextBinding";
import {
  contextMaterializationCommand,
  contextMaterializationReceiptProves,
  type ContextMaterializationCommand,
  type ContextMaterializationReceipt,
  type WorkspaceMaterializationRepository,
  type WorkspaceStateRef,
} from "@vibestudio/shared/vcs/workspaceProjection";
import {
  collectExactTreeListing,
  hasTreeObject,
  mirrorWorktreeTree,
  putBytes,
} from "../services/blobstoreService.js";
import { writeFileAtomicSync } from "../../atomicFile.js";
import { DiskProjector } from "./diskProjector.js";
import { assertSemanticVcsPathAdmissible } from "@vibestudio/shared/vcs/pathAdmission";
import { normalizeRepositoryPath } from "./paths.js";
import { WORKSPACE_SOURCE_DIRS } from "@vibestudio/workspace-contracts/sourceDirs";

const CONTENT_HASH = /^[0-9a-f]{64}$/;
const CONTENT_ROOT = /^state:[0-9a-f]{64}$/;

export interface MaterializedRepository {
  repositoryId: string;
  repoPath: string;
  contentRoot: string;
}

const MATERIALIZATION_STATE_PROTOCOL = "vibestudio.context-materialization-state.v4" as const;
const MATERIALIZATION_STATE_FILE = "context-materialization.json";

/** Private, disposable host projection state. Never consumed by CLI clients. */
export interface ContextMaterializationState {
  protocol: typeof MATERIALIZATION_STATE_PROTOCOL;
  materializationId: string;
  contextId: string;
  targetState: WorkspaceStateRef;
  payloadDigest: string;
  repositories: MaterializedRepository[];
}

function stateKey(state: WorkspaceStateRef): string {
  return state.kind === "event" ? `event:${state.eventId}` : `application:${state.applicationId}`;
}

function canonicalCommand(input: ContextMaterializationCommand) {
  return contextMaterializationCommand({
    contextId: input.contextId,
    commandId: input.commandId,
    mode: input.mode,
    previousState: input.previousState,
    targetState: input.targetState,
    repositories: input.repositories,
    blobs: input.blobs,
  });
}

/**
 * Host-owned materialization of an exact semantic state.
 *
 * The command is self-contained. The host verifies bytes, derives content
 * roots, writes the disposable context folder, and returns only observations.
 * It never asks the semantic state machine how to interpret the command.
 */
export class ContextMaterializer {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly deps: {
      blobsDir: string;
      workspaceId: string;
      disk: DiskProjector;
    }
  ) {}

  async materialize(input: ContextMaterializationCommand): Promise<ContextMaterializationReceipt> {
    const command = canonicalCommand(input);
    if (canonicalJson(command) !== canonicalJson(input)) {
      throw new Error("materialization command is not canonical or has an invalid identity");
    }
    await this.validateRepositories(command.repositories);
    await this.storeBlobs(command);
    const patchRoots = await this.contentRoots(command.repositories);

    return this.locked(command.contextId, async () => {
      const prior = await this.readMaterializationState(command.contextId);
      if (
        prior?.materializationId === command.materializationId &&
        prior.payloadDigest === command.payloadDigest &&
        stateKey(prior.targetState) === stateKey(command.targetState)
      ) {
        // The receipt proves the semantic command, not the disposable bytes.
        // Re-establish every repository from the recorded exact roots on an
        // idempotent retry so a crash or external edit cannot make the private
        // state file a false integrity certificate.
        for (const repository of prior.repositories) {
          await this.deps.disk.projectContextRepository({
            contextId: command.contextId,
            repoPath: repository.repoPath,
            stateHash: repository.contentRoot,
            clean: true,
          });
        }
        const receipt: ContextMaterializationReceipt = {
          materializationId: command.materializationId,
          contextId: command.contextId,
          targetState: command.targetState,
          repositories: patchRoots,
          payloadDigest: command.payloadDigest,
        };
        if (!contextMaterializationReceiptProves(command, receipt)) {
          throw new Error("stored materialization cannot prove an idempotent retry");
        }
        return receipt;
      }
      if (
        (command.mode === "patch" ||
          (command.mode === "replace" && command.previousState !== null)) &&
        !prior
      ) {
        if (!command.previousState) {
          throw new Error(`materialization ${command.mode} command lacks its required basis`);
        }
        throw new Error(
          `materialization basis is missing: expected ${stateKey(command.previousState)}`
        );
      }
      if (
        (command.mode === "patch" || command.mode === "replace") &&
        prior &&
        (command.previousState === null ||
          stateKey(prior.targetState) !== stateKey(command.previousState))
      ) {
        throw new Error(
          command.previousState === null
            ? `materialization basis changed: expected absence, found ${stateKey(prior.targetState)}`
            : `materialization basis changed: expected ${stateKey(command.previousState)}, found ${stateKey(prior.targetState)}`
        );
      }
      if (command.mode === "initialize" && prior) {
        throw new Error(
          `materialization basis changed: expected absence, found ${stateKey(prior.targetState)}`
        );
      }

      const contextDir = this.deps.disk.contextDir(command.contextId);
      if (!prior || command.mode !== "patch") {
        await fsp.mkdir(contextDir, { recursive: true });
        // Replace only the managed source namespaces. Context-local scratch
        // data lives beside them and is not part of semantic projection.
        await Promise.all(
          WORKSPACE_SOURCE_DIRS.map((sourceDir) =>
            fsp.rm(path.join(contextDir, sourceDir), { recursive: true, force: true })
          )
        );
      }

      const nextRepositories = new Map(
        command.mode === "patch"
          ? (prior?.repositories ?? []).map((repository) => [repository.repositoryId, repository])
          : []
      );
      const rootsById = new Map(
        patchRoots.map((repository) => [repository.repositoryId, repository])
      );
      const removedPaths = new Set<string>();
      for (const repository of command.repositories) {
        const existing = nextRepositories.get(repository.repositoryId);
        if (
          existing &&
          (repository.presence === "deleted" || existing.repoPath !== repository.repoPath)
        ) {
          removedPaths.add(existing.repoPath);
        }
        if (repository.presence === "deleted") {
          nextRepositories.delete(repository.repositoryId);
          removedPaths.add(repository.repoPath);
          continue;
        }
        const root = rootsById.get(repository.repositoryId);
        if (!root) {
          throw new Error(`materialization omitted derived root ${repository.repositoryId}`);
        }
        nextRepositories.set(repository.repositoryId, root);
      }
      const next = [...nextRepositories.values()].sort((left, right) =>
        compareUtf16CodeUnits(left.repositoryId, right.repositoryId)
      );
      this.assertExactRepositorySet(next);
      const nextPaths = new Set(next.map((repository) => repository.repoPath));
      for (const repoPath of removedPaths) {
        if (nextPaths.has(repoPath)) continue;
        await fsp.rm(path.join(contextDir, ...repoPath.split("/")), {
          recursive: true,
          force: true,
        });
      }
      for (const repository of patchRoots) {
        await this.deps.disk.projectContextRepository({
          contextId: command.contextId,
          repoPath: repository.repoPath,
          stateHash: repository.contentRoot,
          clean: true,
        });
      }

      const receipt: ContextMaterializationReceipt = {
        materializationId: command.materializationId,
        contextId: command.contextId,
        targetState: command.targetState,
        repositories: patchRoots,
        payloadDigest: command.payloadDigest,
      };
      if (!contextMaterializationReceiptProves(command, receipt)) {
        throw new Error("host produced an invalid materialization receipt");
      }
      await this.writeMaterializationState({
        protocol: MATERIALIZATION_STATE_PROTOCOL,
        ...receipt,
        repositories: next,
      });
      await this.writeContextBinding(command.contextId);
      return receipt;
    });
  }

  async materializationState(contextId: string): Promise<ContextMaterializationState | null> {
    this.deps.disk.contextDir(contextId);
    return this.readMaterializationState(contextId);
  }

  /** Verify disposable bytes against their exact content roots, never cache metadata. */
  async projectionMatches(state: ContextMaterializationState): Promise<boolean> {
    try {
      for (const repository of state.repositories) {
        const local = await this.deps.disk.exactContextRepositoryState(
          state.contextId,
          repository.repoPath
        );
        if (local.skipped.length > 0 || local.stateHash !== repository.contentRoot) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async contentRoots(
    repositories: readonly WorkspaceMaterializationRepository[]
  ): Promise<MaterializedRepository[]> {
    await this.validateRepositories(repositories);
    return this.deriveContentRoots(repositories);
  }

  async drop(contextId: string): Promise<void> {
    await this.locked(contextId, async () => {
      await fsp.rm(this.deps.disk.contextDir(contextId), { recursive: true, force: true });
    });
  }

  private async validateRepositories(
    repositories: readonly WorkspaceMaterializationRepository[]
  ): Promise<void> {
    const repositoryIds = new Set<string>();
    const repoPaths = new Set<string>();
    for (const repository of repositories) {
      if (
        !repository.repositoryId ||
        repositoryIds.has(repository.repositoryId) ||
        repoPaths.has(repository.repoPath) ||
        normalizeRepositoryPath(repository.repoPath) !== repository.repoPath
      ) {
        throw new Error(
          `invalid or duplicate materialization repository ${repository.repositoryId}`
        );
      }
      repositoryIds.add(repository.repositoryId);
      repoPaths.add(repository.repoPath);
      if (repository.presence !== "present") continue;
      if (!repository.fileManifestId) {
        throw new Error(`materialization repository ${repository.repositoryId} has no manifest`);
      }
      if (repository.source.kind === "content-root") {
        if (!CONTENT_ROOT.test(repository.source.contentRoot)) {
          throw new Error(`invalid materialization content root for ${repository.repositoryId}`);
        }
        continue;
      }
      if (repository.source.kind === "delta") {
        if (
          !CONTENT_ROOT.test(repository.source.basisContentRoot) ||
          repository.source.changes.length === 0
        ) {
          throw new Error(`invalid materialization delta for ${repository.repositoryId}`);
        }
        const paths = new Set<string>();
        for (const change of repository.source.changes) {
          this.validatePath(change.path);
          if (
            paths.has(change.path) ||
            (change.expected === null && change.result === null) ||
            canonicalJson(change.expected) === canonicalJson(change.result)
          ) {
            throw new Error(
              `invalid or duplicate materialization change ${repository.repoPath}/${change.path}`
            );
          }
          paths.add(change.path);
          if (change.expected) this.validateFileValue(change.expected, change.path);
          if (change.result) this.validateFileValue(change.result, change.path);
        }
        continue;
      }
      const paths = new Set<string>();
      for (const file of repository.source.files) {
        this.validatePath(file.path);
        if (paths.has(file.path)) {
          throw new Error(
            `invalid or duplicate materialization file ${repository.repoPath}/${file.path}`
          );
        }
        paths.add(file.path);
        this.validateFileValue(file, file.path);
      }
    }
  }

  private assertExactRepositorySet(repositories: readonly MaterializedRepository[]): void {
    const repositoryIds = new Set<string>();
    const repoPaths = new Set<string>();
    for (const repository of repositories) {
      if (
        repositoryIds.has(repository.repositoryId) ||
        repoPaths.has(repository.repoPath) ||
        normalizeRepositoryPath(repository.repoPath) !== repository.repoPath ||
        !CONTENT_ROOT.test(repository.contentRoot)
      ) {
        throw new Error(`invalid resulting materialization repository ${repository.repositoryId}`);
      }
      repositoryIds.add(repository.repositoryId);
      repoPaths.add(repository.repoPath);
    }
  }

  private validatePath(filePath: string): void {
    assertSemanticVcsPathAdmissible(filePath);
  }

  private validateFileValue(file: { contentHash: string; mode: number }, filePath: string): void {
    if (
      !CONTENT_HASH.test(file.contentHash) ||
      !Number.isInteger(file.mode) ||
      file.mode < 0 ||
      file.mode > 0o777
    ) {
      throw new Error(`invalid materialization file value ${filePath}`);
    }
  }

  private async storeBlobs(command: ContextMaterializationCommand): Promise<void> {
    const contentHashes = new Set<string>();
    for (const blob of command.blobs) {
      if (!CONTENT_HASH.test(blob.contentHash) || contentHashes.has(blob.contentHash)) {
        throw new Error(`invalid materialization content hash ${blob.contentHash}`);
      }
      contentHashes.add(blob.contentHash);
      const bytes = Buffer.from(blob.base64, "base64");
      if (bytes.toString("base64") !== blob.base64) {
        throw new Error(`materialization blob ${blob.contentHash} is not canonical base64`);
      }
      const stored = await putBytes(this.deps.blobsDir, bytes);
      if (stored.digest !== blob.contentHash) {
        throw new Error(`materialization blob ${blob.contentHash} does not match its bytes`);
      }
    }
  }

  private async deriveContentRoots(
    repositories: readonly WorkspaceMaterializationRepository[]
  ): Promise<MaterializedRepository[]> {
    const present = repositories.filter(
      (
        repository
      ): repository is Extract<WorkspaceMaterializationRepository, { presence: "present" }> =>
        repository.presence === "present"
    );
    const roots: MaterializedRepository[] = [];
    for (const repository of present) {
      const contentRoot = await this.deriveRepositoryContentRoot(repository);
      roots.push({
        repositoryId: repository.repositoryId,
        repoPath: repository.repoPath,
        contentRoot,
      });
    }
    return roots.sort((left, right) =>
      compareUtf16CodeUnits(left.repositoryId, right.repositoryId)
    );
  }

  private async deriveRepositoryContentRoot(
    repository: Extract<WorkspaceMaterializationRepository, { presence: "present" }>
  ): Promise<string> {
    if (repository.source.kind === "content-root") {
      if (!(await hasTreeObject(this.deps.blobsDir, repository.source.contentRoot))) {
        throw new Error(
          `materialization content root is missing for ${repository.repositoryId}: ${repository.source.contentRoot}`
        );
      }
      return repository.source.contentRoot;
    }
    if (repository.source.kind === "snapshot") {
      return (
        await mirrorWorktreeTree(
          this.deps.blobsDir,
          repository.source.files.map((file) => ({
            path: file.path,
            contentHash: file.contentHash,
            mode: this.treeMode(file.mode),
          }))
        )
      ).stateHash;
    }
    const listing = await collectExactTreeListing(
      this.deps.blobsDir,
      repository.source.basisContentRoot
    );
    if (!listing) {
      throw new Error(
        `materialization basis is missing for ${repository.repositoryId}: ${repository.source.basisContentRoot}`
      );
    }
    const files = new Map(
      listing
        .filter(
          (entry): entry is Extract<(typeof listing)[number], { kind: "file" }> =>
            entry.kind === "file"
        )
        .map((file) => [
          file.path,
          { path: file.path, contentHash: file.contentHash, mode: file.mode },
        ])
    );
    for (const change of repository.source.changes) {
      const current = files.get(change.path);
      const expected = change.expected
        ? {
            path: change.path,
            contentHash: change.expected.contentHash,
            mode: this.treeMode(change.expected.mode),
          }
        : undefined;
      if (
        (expected === undefined && current !== undefined) ||
        (expected !== undefined &&
          (current === undefined ||
            current.contentHash !== expected.contentHash ||
            current.mode !== expected.mode))
      ) {
        throw new Error(`materialization basis changed at ${repository.repoPath}/${change.path}`);
      }
      if (change.result) {
        files.set(change.path, {
          path: change.path,
          contentHash: change.result.contentHash,
          mode: this.treeMode(change.result.mode),
        });
      } else {
        files.delete(change.path);
      }
    }
    return (await mirrorWorktreeTree(this.deps.blobsDir, [...files.values()])).stateHash;
  }

  private treeMode(mode: number): number {
    return mode & 0o111 ? 33261 : 33188;
  }

  private bindingPath(contextId: string): string {
    return path.join(this.deps.disk.contextDir(contextId), CONTEXT_BINDING_FILE);
  }

  private materializationStatePath(contextId: string): string {
    return path.join(this.deps.disk.contextDir(contextId), ".gad", MATERIALIZATION_STATE_FILE);
  }

  private async readMaterializationState(
    contextId: string
  ): Promise<ContextMaterializationState | null> {
    const statePath = this.materializationStatePath(contextId);
    let raw: string;
    try {
      raw = await fsp.readFile(statePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let state: unknown;
    try {
      state = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `corrupt context materialization state ${statePath}: ${(error as Error).message}`
      );
    }
    if (!this.isMaterializationState(state, contextId)) {
      throw new Error(`unsupported or corrupt context materialization state ${statePath}`);
    }
    return state;
  }

  private isMaterializationState(
    value: unknown,
    contextId: string
  ): value is ContextMaterializationState {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const state = value as Partial<ContextMaterializationState>;
    const expectedKeys = [
      "protocol",
      "materializationId",
      "contextId",
      "targetState",
      "payloadDigest",
      "repositories",
    ].sort(compareUtf16CodeUnits);
    const actualKeys = Object.keys(value).sort(compareUtf16CodeUnits);
    return (
      actualKeys.length === expectedKeys.length &&
      actualKeys.every((key, index) => key === expectedKeys[index]) &&
      state.protocol === MATERIALIZATION_STATE_PROTOCOL &&
      state.contextId === contextId &&
      typeof state.materializationId === "string" &&
      state.materializationId.length > 0 &&
      this.isStateRef(state.targetState) &&
      typeof state.payloadDigest === "string" &&
      state.payloadDigest.length > 0 &&
      Array.isArray(state.repositories) &&
      state.repositories.every(
        (repository) =>
          !!repository &&
          Object.keys(repository).sort(compareUtf16CodeUnits).join("\0") ===
            ["contentRoot", "repoPath", "repositoryId"].join("\0") &&
          typeof repository.repositoryId === "string" &&
          repository.repositoryId.length > 0 &&
          typeof repository.repoPath === "string" &&
          normalizeRepositoryPath(repository.repoPath) === repository.repoPath &&
          typeof repository.contentRoot === "string" &&
          CONTENT_ROOT.test(repository.contentRoot)
      )
    );
  }

  private isStateRef(value: unknown): value is WorkspaceStateRef {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const state = value as Record<string, unknown>;
    if (state["kind"] === "event") {
      return (
        Object.keys(state).sort(compareUtf16CodeUnits).join("\0") === "eventId\0kind" &&
        typeof state["eventId"] === "string" &&
        state["eventId"].length > 0
      );
    }
    return (
      state["kind"] === "application" &&
      Object.keys(state).sort(compareUtf16CodeUnits).join("\0") === "applicationId\0kind" &&
      typeof state["applicationId"] === "string" &&
      state["applicationId"].length > 0
    );
  }

  private async writeMaterializationState(state: ContextMaterializationState): Promise<void> {
    await this.writeAtomicJson(
      this.materializationStatePath(state.contextId),
      `${JSON.stringify(state, null, 2)}\n`,
      0o600
    );
  }

  private async writeContextBinding(contextId: string): Promise<void> {
    const binding = contextBinding({ workspaceId: this.deps.workspaceId, contextId });
    await this.writeAtomicJson(this.bindingPath(contextId), encodeContextBinding(binding), 0o644);
  }

  private async writeAtomicJson(filePath: string, data: string, mode: number): Promise<void> {
    writeFileAtomicSync(filePath, data, { mode });
  }

  private locked<T>(contextId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(contextId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.locks.set(contextId, next);
    return next.finally(() => {
      if (this.locks.get(contextId) === next) this.locks.delete(contextId);
    });
  }
}
