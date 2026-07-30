import { Buffer } from "node:buffer";
import YAML from "yaml";
import { sha256HexSyncText } from "@vibestudio/content-addressing";
import type {
  VcsReadFileResult,
  VcsResolveRepositoryResult,
  VcsStateNodeRef,
  VcsStatusResult,
} from "@vibestudio/service-schemas/vcs";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import { assertTemplateLockIntegrityForRead } from "@vibestudio/workspace/templateLock";
import { composeWorkspaceConfig } from "@vibestudio/workspace/configComposition";
import type {
  TemplateCompositionPlan,
  TemplateOperationInspection,
  TemplateOperationPorts,
} from "@workspace/template-composer";
import type { ExtensionContextLike } from "./context.js";
import { acquireTemplateSnapshot } from "./source.js";
import {
  listSemanticRepositoryFiles,
  semanticRepositoryDigest,
  semanticRepositoryMatches,
} from "./semanticRepository.js";
import {
  LOCK_PATH,
  COMPOSITION_SOURCE_PATH,
  META_REPOSITORY,
  TOP_CONFIG_PATH,
  type SemanticWorkspaceObservation,
} from "./workspace.js";

export interface TemplateReviewItem {
  repoPath: string;
  deltaId: string;
}

export class TemplateReviewRequired extends Error {
  constructor(
    readonly contextId: string,
    readonly items: readonly TemplateReviewItem[],
    readonly deltaBasis: VcsStateNodeRef
  ) {
    super(`Template changes require review in ${contextId}`);
    this.name = "TemplateReviewRequired";
  }
}

export const OPERATION_CONTEXT_PREFIX = "template-composer-operation-";
const OPERATION_CONTEXT_DIGEST_LENGTH = 32;
const OPERATION_RECORD_DIR = "template-operations";
const OPERATION_MESSAGE_PREFIX = "template-composer-intent:v1:";
const CANCELLATION_RECORD_DIR = "template-cancellations";

export interface TemplateOperationRecord {
  version: 1;
  operationId: string;
  kind: TemplateOperationInspection["kind"] | "publish-authoring";
  fingerprint: string;
  intent: unknown;
  pins: WorkspaceTemplatePin[];
  addedParts: string[];
  orphanedParts: string[];
  reviews?: TemplateReviewItem[];
  deltaBasis?: VcsStateNodeRef;
}

export function affectedRepositoryPaths(
  imported: readonly string[],
  reviewed: readonly string[],
  ownershipChanges: readonly { repoPath: string }[]
): string[] {
  return [
    ...new Set([...imported, ...reviewed, ...ownershipChanges.map((change) => change.repoPath)]),
  ].sort();
}

function operationContextId(operationId: string): string {
  return `${OPERATION_CONTEXT_PREFIX}${sha256HexSyncText(operationId).slice(
    0,
    OPERATION_CONTEXT_DIGEST_LENGTH
  )}`;
}

function operationRecordPath(): string {
  return `${OPERATION_RECORD_DIR}/record.json`;
}

function cancellationRecordPath(operationId: string): string {
  return `${CANCELLATION_RECORD_DIR}/${sha256HexSyncText(operationId)}.json`;
}

function text(file: NonNullable<VcsReadFileResult>): string {
  return file.content.kind === "text"
    ? file.content.text
    : Buffer.from(file.content.base64, "base64").toString("utf8");
}

async function status(ctx: ExtensionContextLike, contextId: string): Promise<VcsStatusResult> {
  return ctx.rpc.call("main", "vcs.status", { contextId });
}

async function resolveRepository(
  ctx: ExtensionContextLike,
  state: VcsStateNodeRef,
  repoPath: string
): Promise<VcsResolveRepositoryResult> {
  return ctx.rpc.call("main", "vcs.resolveRepository", { state, repoPath });
}

function parseOperationMessage(message: unknown): TemplateOperationRecord | null {
  if (typeof message !== "string" || !message.startsWith(OPERATION_MESSAGE_PREFIX)) return null;
  try {
    return JSON.parse(
      Buffer.from(message.slice(OPERATION_MESSAGE_PREFIX.length), "base64url").toString("utf8")
    ) as TemplateOperationRecord;
  } catch {
    return null;
  }
}

export async function ensureTemplateOperationContext(
  ctx: ExtensionContextLike,
  operationId: string
): Promise<string> {
  const contextId = operationContextId(operationId);
  await ctx.rpc.call("main", "runtime.createContext", { contextId });
  return contextId;
}

export async function readTemplateOperationRecord(
  ctx: ExtensionContextLike,
  operationId: string
): Promise<TemplateOperationRecord | null> {
  const contextId = operationContextId(operationId);
  const listed = await ctx.rpc.call<{ contexts: string[] }>("main", "runtime.listContexts", {
    prefix: contextId,
  });
  if (!listed.contexts.includes(contextId)) return null;
  const record = await readTemplateOperationRecordInContext(ctx, contextId);
  return record?.operationId === operationId ? record : null;
}

export async function readTemplateOperationRecordInContext(
  ctx: ExtensionContextLike,
  contextId: string
): Promise<TemplateOperationRecord | null> {
  const current = await status(ctx, contextId);
  const meta = await resolveRepository(ctx, current.workingHead, META_REPOSITORY);
  if (meta) {
    const file = await readFile(ctx, current.workingHead, meta.repositoryId, operationRecordPath());
    if (file) {
      const record = JSON.parse(text(file)) as TemplateOperationRecord;
      if (operationContextId(record.operationId) === contextId) return record;
    }
  }
  let cursor: string | undefined;
  do {
    const page = await ctx.rpc.call<{
      entries: Array<{ node: { kind: string; eventId?: string } }>;
      nextCursor: string | null;
    }>("main", "vcs.history", {
      root: current.committed,
      direction: "past",
      ...(cursor ? { cursor } : {}),
      limit: 200,
    });
    for (const entry of page.entries) {
      if (entry.node.kind !== "event" || !entry.node.eventId) continue;
      const inspected = await ctx.rpc.call<{
        node: { kind: string; value?: { message?: string | null } };
      }>("main", "vcs.inspect", {
        node: { kind: "event", eventId: entry.node.eventId },
        edgeLimit: 1,
      });
      const record = parseOperationMessage(inspected.node.value?.message);
      if (record && operationContextId(record.operationId) === contextId) return record;
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return null;
}

export async function isTemplateOperationCancelled(
  ctx: ExtensionContextLike,
  mainEventId: string,
  operationId: string
): Promise<boolean> {
  const state = { kind: "event" as const, eventId: mainEventId };
  const meta = await resolveRepository(ctx, state, META_REPOSITORY);
  if (!meta) return false;
  const file = await readFile(ctx, state, meta.repositoryId, cancellationRecordPath(operationId));
  if (!file) return false;
  try {
    const record = JSON.parse(text(file)) as { version?: unknown; operationId?: unknown };
    if (record.version !== 1 || record.operationId !== operationId) {
      throw new Error("does not match its content-addressed command identity");
    }
    return true;
  } catch (error) {
    throw new Error(
      `Template cancellation record for ${operationId} is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export async function writeTemplateOperationRecord(
  ctx: ExtensionContextLike,
  record: TemplateOperationRecord
): Promise<void> {
  const contextId = await ensureTemplateOperationContext(ctx, record.operationId);
  const current = await status(ctx, contextId);
  if (!current.clean) {
    throw new Error(`Template operation ${record.operationId} has uncommitted work before review`);
  }
  const meta = await resolveRepository(ctx, current.workingHead, META_REPOSITORY);
  if (!meta) throw new Error("Template operation context has no meta repository");
  const content = `${JSON.stringify(record, null, 2)}\n`;
  await ctx.rpc.call("main", "vcs.edit", {
    commandId: `${contextId}:record-intent`,
    contextId,
    expectedWorkingHead: current.workingHead,
    intentSummary: "Record the approved exact template operation intent",
    changes: [
      {
        kind: "file-create",
        repositoryId: meta.repositoryId,
        path: operationRecordPath(),
        content: { kind: "text", text: content },
        mode: 0o644,
      },
    ],
  });
  const edited = await status(ctx, contextId);
  const encoded = Buffer.from(JSON.stringify(record), "utf8").toString("base64url");
  await ctx.rpc.call("main", "vcs.commit", {
    commandId: `${contextId}:commit-intent`,
    contextId,
    expectedWorkingHead: edited.workingHead,
    intentSummary: "Commit the approved exact template operation intent",
    message: `${OPERATION_MESSAGE_PREFIX}${encoded}`,
  });
}

export async function updateTemplateOperationRecord(
  ctx: ExtensionContextLike,
  record: TemplateOperationRecord
): Promise<void> {
  const contextId = await ensureTemplateOperationContext(ctx, record.operationId);
  let current = await status(ctx, contextId);
  if (!current.clean) {
    throw new Error(`Cannot update template operation ${record.operationId} with pending work`);
  }
  const meta = await resolveRepository(ctx, current.workingHead, META_REPOSITORY);
  if (!meta) throw new Error("Template operation context has no meta repository");
  const file = await readFile(ctx, current.workingHead, meta.repositoryId, operationRecordPath());
  if (!file) throw new Error(`Template operation ${record.operationId} has no context record`);
  const content = `${JSON.stringify(record, null, 2)}\n`;
  await ctx.rpc.call("main", "vcs.edit", {
    commandId: `${contextId}:update-review-record`,
    contextId,
    expectedWorkingHead: current.workingHead,
    intentSummary: "Record resumable template VCS review handles",
    changes: [
      {
        kind: "text-edit",
        repositoryId: meta.repositoryId,
        fileId: file.fileId,
        edits: [{ start: 0, end: text(file).length, text: content }],
      },
    ],
  });
  current = await status(ctx, contextId);
  await ctx.rpc.call("main", "vcs.commit", {
    commandId: `${contextId}:commit-review-record`,
    contextId,
    expectedWorkingHead: current.workingHead,
    intentSummary: "Commit resumable template VCS review handles",
    message: `${OPERATION_MESSAGE_PREFIX}${Buffer.from(JSON.stringify(record), "utf8").toString(
      "base64url"
    )}`,
  });
}

async function readFile(
  ctx: ExtensionContextLike,
  state: VcsStateNodeRef,
  repositoryId: string,
  filePath: string
): Promise<VcsReadFileResult> {
  return ctx.rpc.call("main", "vcs.readFile", {
    state,
    repositoryId,
    file: { kind: "path", path: filePath },
  });
}

function pinForContribution(plan: TemplateCompositionPlan, nodeId: string): WorkspaceTemplatePin {
  const node = plan.nodes.find((candidate) => candidate.nodeId === nodeId);
  if (!node) throw new Error(`Template plan is missing node ${nodeId}`);
  return node.pin;
}

async function alreadyStaged(
  ctx: ExtensionContextLike,
  contextId: string,
  fingerprint: string
): Promise<boolean> {
  const current = await status(ctx, contextId);
  const meta = await resolveRepository(ctx, current.workingHead, META_REPOSITORY);
  if (!meta) return false;
  const lock = await readFile(ctx, current.workingHead, meta.repositoryId, LOCK_PATH);
  if (!lock) return false;
  try {
    return (
      assertTemplateLockIntegrityForRead(YAML.parse(text(lock)) as unknown).fingerprint ===
      fingerprint
    );
  } catch {
    return false;
  }
}

async function importRepositories(
  ctx: ExtensionContextLike,
  contextId: string,
  plan: TemplateCompositionPlan,
  previous: SemanticWorkspaceObservation["lock"]
): Promise<string[]> {
  const affected: string[] = [];
  for (const [repoPath, contribution] of Object.entries(plan.repositories)) {
    const current = await status(ctx, contextId);
    const existing = await resolveRepository(ctx, current.workingHead, repoPath);
    if (existing) {
      const files = await listSemanticRepositoryFiles(
        ctx,
        current.workingHead,
        existing.repositoryId
      );
      if (semanticRepositoryMatches(files, contribution.files)) continue;
      const previousOwner = previous?.repositories[repoPath]?.nodeId;
      if (previousOwner) continue;
      throw new Error(
        `Template plan selected occupied repository ${repoPath} with different local content`
      );
    }
    const pin = pinForContribution(plan, contribution.nodeId);
    await ctx.rpc.call("main", "vcs.importSnapshot", {
      commandId: `${contextId}:import:${repoPath}`,
      contextId,
      expectedWorkingHead: current.workingHead,
      intentSummary: `Import ${repoPath} from template ${contribution.alias}`,
      source: {
        kind: "git",
        url: pin.url,
        commit: pin.commit,
        subdir: contribution.subdir,
        snapshot: contribution.subtreeDigest,
      },
      repositories: [
        {
          repoPath,
          files: contribution.files.map(({ path, contentHash, mode }) => ({
            path,
            contentHash,
            mode,
          })),
        },
      ],
      message: `Import ${repoPath} from template ${contribution.alias}`,
    });
    affected.push(repoPath);
  }
  return affected;
}

function subtreeFiles(
  files: readonly {
    path: string;
    contentHash: string;
    size: number;
    mode: 0o644 | 0o755;
  }[],
  repoPath: string
) {
  const prefix = `${repoPath}/`;
  return files
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => ({ ...file, path: file.path.slice(prefix.length) }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export async function reviewTemplateUpdates(
  ctx: ExtensionContextLike,
  statePath: string,
  contextId: string,
  plan: TemplateCompositionPlan,
  previous: NonNullable<SemanticWorkspaceObservation["lock"]>,
  record?: TemplateOperationRecord
): Promise<string[]> {
  const items: TemplateReviewItem[] = [];
  const changed: string[] = [];
  const completedDeltas: Array<{ repoPath: string; deltaId: string }> = [];
  const registeredDeltas: Array<{ repoPath: string; deltaId: string }> = [];
  let deltaBasis = record?.deltaBasis;
  for (const [repoPath, contribution] of Object.entries(plan.repositories)) {
    const previousRepository = previous.repositories[repoPath];
    if (!previousRepository) continue;
    const previousNode = previous.nodes.find(
      (candidate) => candidate.nodeId === previousRepository.nodeId
    );
    if (!previousNode) {
      throw new Error(`Previous template lock is missing node ${previousRepository.nodeId}`);
    }
    const nextPin = pinForContribution(plan, contribution.nodeId);
    if (
      previousNode.pin.url === nextPin.url &&
      previousNode.pin.commit === nextPin.commit &&
      previousRepository.subtreeDigest === contribution.subtreeDigest
    ) {
      continue;
    }
    const current = await status(ctx, contextId);
    deltaBasis ??= current.committed;
    const repository = await resolveRepository(ctx, current.workingHead, repoPath);
    if (!repository) {
      throw new Error(`Tracked template repository ${repoPath} is missing`);
    }
    const oldSnapshot = await acquireTemplateSnapshot(
      ctx,
      statePath,
      previousNode.pin,
      previousNode.nodeId
    );
    const oldFiles = subtreeFiles(oldSnapshot.files, repoPath);
    if (
      semanticRepositoryDigest(oldFiles.map((file) => ({ ...file, byteLength: file.size }))) !==
      previousRepository.subtreeDigest
    ) {
      throw new Error(`Previous template subtree evidence for ${repoPath} is inconsistent`);
    }
    const delta = await ctx.rpc.call<{ deltaId: string }>("main", "vcs.registerExternalDelta", {
      commandId: `${contextId}:delta:${repoPath}`,
      contextId,
      expectedWorkingHead: deltaBasis,
      intentSummary: `Review ${repoPath} from template ${contribution.alias}`,
      repositoryId: repository.repositoryId,
      repoPath,
      oldSource: {
        kind: "git",
        url: previousNode.pin.url,
        commit: previousNode.pin.commit,
        subdir: repoPath,
        snapshot: previousRepository.subtreeDigest,
      },
      newSource: {
        kind: "git",
        url: nextPin.url,
        commit: nextPin.commit,
        subdir: contribution.subdir,
        snapshot: contribution.subtreeDigest,
      },
      oldFiles: oldFiles.map(({ path, contentHash, mode }) => ({
        path,
        contentHash,
        mode,
      })),
      newFiles: contribution.files.map(({ path, contentHash, mode }) => ({
        path,
        contentHash,
        mode,
      })),
    });
    registeredDeltas.push({ repoPath, deltaId: delta.deltaId });
  }
  for (const { repoPath, deltaId } of registeredDeltas) {
    let satisfiedBatch = 0;
    for (;;) {
      const latest = await status(ctx, contextId);
      const comparison = await ctx.rpc.call<{
        resolution: { complete: boolean };
        changes: Array<{
          changeId: string;
          disposition: { status: string; evidence?: unknown[] };
        }>;
      }>("main", "vcs.compare", {
        target: latest.workingHead,
        sourceDeltaId: deltaId,
        view: "changes",
        limit: 200,
      });
      const alreadySatisfied = comparison.changes.find(
        (change) => change.disposition.status === "already-satisfied"
      );
      if (!alreadySatisfied) break;
      if (!alreadySatisfied.disposition.evidence?.length) {
        throw new Error(
          `VCS reported ${alreadySatisfied.changeId} as already satisfied without reconciliation evidence`
        );
      }
      await ctx.rpc.call("main", "vcs.integrate", {
        commandId: `${contextId}:account-satisfied:${repoPath}:${satisfiedBatch}`,
        contextId,
        expectedWorkingHead: latest.workingHead,
        sourceDeltaId: deltaId,
        decision: {
          kind: "reconciled",
          sourceChangeIds: [alreadySatisfied.changeId],
          evidence: alreadySatisfied.disposition.evidence,
          rationale: "The exact template source change already holds in the workspace",
        },
      });
      satisfiedBatch += 1;
    }
    const latest = await status(ctx, contextId);
    const compared = await ctx.rpc.call<{
      resolution: { complete: boolean };
    }>("main", "vcs.compare", {
      target: latest.workingHead,
      sourceDeltaId: deltaId,
      view: "overview",
      limit: 1,
    });
    if (!compared.resolution.complete) {
      items.push({ repoPath, deltaId });
      continue;
    }
    completedDeltas.push({ repoPath, deltaId });
    changed.push(repoPath);
  }
  let current = await status(ctx, contextId);
  if (!current.clean) {
    await ctx.rpc.call("main", "vcs.commit", {
      commandId: `${contextId}:commit-reviewed-deltas`,
      contextId,
      expectedWorkingHead: current.workingHead,
      intentSummary: "Commit reviewed template repository updates",
      message: "Apply reviewed template repository updates",
    });
  }
  for (const completed of completedDeltas) {
    current = await status(ctx, contextId);
    await ctx.rpc.call("main", "vcs.finalizeExternalDelta", {
      commandId: `${contextId}:finalize:${completed.repoPath}`,
      contextId,
      expectedWorkingHead: current.workingHead,
      intentSummary: `Finalize reviewed template update for ${completed.repoPath}`,
      deltaId: completed.deltaId,
    });
  }
  if (items.length > 0) {
    throw new TemplateReviewRequired(contextId, items, deltaBasis!);
  }
  return changed;
}

function nextWorkspaceSource(
  observation: SemanticWorkspaceObservation,
  inspection: TemplateOperationInspection
): SemanticWorkspaceObservation["top"] {
  const registry = observation.top.templates?.registry;
  const relationships = inspection.nextTemplates;
  const templates = {
    use: relationships?.use ?? [],
    ...(relationships?.overrides && Object.keys(relationships.overrides).length > 0
      ? { overrides: relationships.overrides }
      : {}),
    ...(relationships?.conflicts && Object.keys(relationships.conflicts).length > 0
      ? { conflicts: relationships.conflicts }
      : {}),
    ...(registry ? { registry } : {}),
    ...((relationships?.bootstrapAdopted ?? observation.top.templates?.bootstrapAdopted)
      ? {
          bootstrapAdopted:
            relationships?.bootstrapAdopted ?? observation.top.templates?.bootstrapAdopted,
        }
      : {}),
    ...((relationships?.suggestionDecisions ?? observation.top.templates?.suggestionDecisions)
      ? {
          suggestionDecisions:
            relationships?.suggestionDecisions ?? observation.top.templates?.suggestionDecisions,
        }
      : {}),
  };
  return { ...observation.top, templates };
}

function flattenedRuntimeYaml(
  observation: SemanticWorkspaceObservation,
  inspection: TemplateOperationInspection,
  source: SemanticWorkspaceObservation["top"]
): string {
  const ancestors = new Map<string, Set<string>>();
  const layers = inspection.plan.nodes.map((node) => {
    const inherited = new Set<string>();
    for (const parent of node.parents) {
      inherited.add(parent);
      for (const ancestor of ancestors.get(parent) ?? []) inherited.add(ancestor);
    }
    ancestors.set(node.nodeId, inherited);
    return {
      nodeId: node.nodeId,
      alias: node.alias,
      ancestors: [...inherited],
      config: node.fragment,
    };
  });
  const { id: _id, ...runtime } = composeWorkspaceConfig(source, layers, observation.workspaceId);
  return YAML.stringify(runtime, { lineWidth: 0 });
}

async function stageMeta(
  ctx: ExtensionContextLike,
  contextId: string,
  observation: SemanticWorkspaceObservation,
  inspection: TemplateOperationInspection
): Promise<void> {
  let current = await status(ctx, contextId);
  if (!current.clean) {
    await ctx.rpc.call("main", "vcs.discard", {
      commandId: `${contextId}:discard-incomplete`,
      contextId,
      expectedWorkingHead: current.workingHead,
      intentSummary: "Discard an incomplete template metadata staging attempt",
    });
    current = await status(ctx, contextId);
  }
  const meta = await resolveRepository(ctx, current.workingHead, META_REPOSITORY);
  if (!meta) throw new Error("Template composition requires the meta repository");
  const desired = new Map<string, string>();
  const source = nextWorkspaceSource(observation, inspection);
  desired.set(COMPOSITION_SOURCE_PATH, YAML.stringify(source, { lineWidth: 0 }));
  desired.set(TOP_CONFIG_PATH, flattenedRuntimeYaml(observation, inspection, source));
  for (const artifact of inspection.plan.artifacts) {
    if (!artifact.path.startsWith("meta/")) {
      throw new Error(`Generated template artifact is outside meta: ${artifact.path}`);
    }
    desired.set(
      artifact.path.slice("meta/".length),
      new TextDecoder("utf8", { fatal: true }).decode(artifact.bytes)
    );
  }
  const removals = new Set(
    inspection.plan.removedArtifactPaths.map((artifactPath) =>
      artifactPath.startsWith("meta/") ? artifactPath.slice("meta/".length) : artifactPath
    )
  );
  if (inspection.plan.lock === null) removals.add(LOCK_PATH);
  removals.add(operationRecordPath());
  const changes: unknown[] = [];
  for (const [filePath, desiredText] of desired) {
    const existing = await readFile(ctx, current.workingHead, meta.repositoryId, filePath);
    if (!existing) {
      changes.push({
        kind: "file-create",
        repositoryId: meta.repositoryId,
        path: filePath,
        content: { kind: "text", text: desiredText },
        mode: 0o644,
      });
    } else if (text(existing) !== desiredText) {
      changes.push({
        kind: "text-edit",
        repositoryId: meta.repositoryId,
        fileId: existing.fileId,
        edits: [{ start: 0, end: text(existing).length, text: desiredText }],
      });
    }
  }
  for (const filePath of removals) {
    if (desired.has(filePath)) continue;
    const existing = await readFile(ctx, current.workingHead, meta.repositoryId, filePath);
    if (existing) {
      changes.push({
        kind: "file-delete",
        repositoryId: meta.repositoryId,
        fileId: existing.fileId,
      });
    }
  }
  for (let offset = 0; offset < changes.length; offset += 200) {
    current = await status(ctx, contextId);
    await ctx.rpc.call("main", "vcs.edit", {
      commandId: `${contextId}:meta:${offset / 200}`,
      contextId,
      expectedWorkingHead: current.workingHead,
      intentSummary: "Update generated template composition metadata",
      changes: changes.slice(offset, offset + 200),
    });
  }
  current = await status(ctx, contextId);
  if (current.clean) return;
  await ctx.rpc.call("main", "vcs.commit", {
    commandId: `${contextId}:commit`,
    contextId,
    expectedWorkingHead: current.workingHead,
    intentSummary: "Commit the reviewed template composition",
    message: `Compose templates ${inspection.plan.fingerprint}`,
  });
}

export function createTemplateOperationPorts(
  ctx: ExtensionContextLike,
  statePath: string,
  observation: SemanticWorkspaceObservation,
  buildAffected: TemplateOperationPorts["buildAffected"],
  record?: TemplateOperationRecord
): TemplateOperationPorts {
  return {
    async openContext(operationId) {
      const contextId = operationContextId(operationId);
      await ctx.rpc.call("main", "runtime.createContext", { contextId });
      const current = await status(ctx, contextId);
      if (current.mainRelation === "behind" || current.mainRelation === "diverged") {
        throw new Error(
          `Template operation ${operationId} was based on an older protected main; retry with a new command id`
        );
      }
      return { contextId };
    },
    async stageComposition(contextId, inspection) {
      if (await alreadyStaged(ctx, contextId, inspection.plan.fingerprint)) {
        return {
          affectedRepoPaths: Object.keys(inspection.plan.repositories).sort(),
        };
      }
      const reviewed = observation.lock
        ? await reviewTemplateUpdates(
            ctx,
            statePath,
            contextId,
            inspection.plan,
            observation.lock,
            record
          )
        : [];
      const imported = await importRepositories(ctx, contextId, inspection.plan, observation.lock);
      await stageMeta(ctx, contextId, observation, inspection);
      return {
        affectedRepoPaths: affectedRepositoryPaths(
          imported,
          reviewed,
          inspection.plan.ownershipChanges
        ),
      };
    },
    buildAffected,
    async publish(contextId, expectedMainEventId) {
      const current = await status(ctx, contextId);
      if (!current.clean || current.committed.kind !== "event") {
        throw new Error(`Template operation context ${contextId} is not committed`);
      }
      const result = await ctx.rpc.call<{ mainEventId: string }>("main", "vcs.push", {
        commandId: `${contextId}:publish`,
        contextId,
        expectedCommittedEventId: current.committed.eventId,
        expectedMainEventId,
      });
      return { mainEventId: result.mainEventId };
    },
    async discard(contextId) {
      await ctx.rpc.call("main", "runtime.destroyContext", { contextId, recursive: false });
    },
  };
}

export async function publishTemplateSuggestionTopLayer(
  ctx: ExtensionContextLike,
  operationId: string,
  observation: SemanticWorkspaceObservation,
  top: SemanticWorkspaceObservation["top"],
  inspection: TemplateOperationInspection
): Promise<string> {
  const contextId = await ensureTemplateOperationContext(ctx, operationId);
  let current = await status(ctx, contextId);
  if (current.mainRelation !== "at") {
    throw new Error(`Template suggestion ${operationId} was based on a different protected main`);
  }
  await stageMeta(ctx, contextId, { ...observation, top }, inspection);
  current = await status(ctx, contextId);
  const result = await ctx.rpc.call<{ mainEventId: string }>("main", "vcs.push", {
    commandId: `${contextId}:publish-suggestion`,
    contextId,
    expectedCommittedEventId: current.committed.eventId,
    expectedMainEventId: observation.mainEventId,
  });
  return result.mainEventId;
}

/**
 * Win cancellation through the same protected-main compare-and-swap used by
 * publication. If an operation publishes concurrently, exactly one push can
 * advance the expected main event; cancellation never destroys a context until
 * this durable tombstone has won.
 */
export async function publishTemplateOperationCancellation(
  ctx: ExtensionContextLike,
  operationId: string,
  expectedMainEventId: string
): Promise<string> {
  const contextId = `template-composer-cancellation-${sha256HexSyncText(
    `${operationId}\0${expectedMainEventId}`
  ).slice(0, OPERATION_CONTEXT_DIGEST_LENGTH)}`;
  const markerPath = cancellationRecordPath(operationId);
  await ctx.rpc.call("main", "runtime.createContext", { contextId });
  let current = await status(ctx, contextId);
  if (current.mainRelation !== "at" || current.mainEventId !== expectedMainEventId) {
    throw new Error(
      `Protected main changed before template operation ${operationId} could be cancelled`
    );
  }
  const meta = await resolveRepository(ctx, current.workingHead, META_REPOSITORY);
  if (!meta) throw new Error("Template operation cancellation requires the meta repository");
  if (await readFile(ctx, current.workingHead, meta.repositoryId, markerPath)) {
    return current.mainEventId;
  }
  await ctx.rpc.call("main", "vcs.edit", {
    commandId: `${contextId}:record`,
    contextId,
    expectedWorkingHead: current.workingHead,
    intentSummary: `Cancel template operation ${operationId}`,
    changes: [
      {
        kind: "file-create",
        repositoryId: meta.repositoryId,
        path: markerPath,
        content: {
          kind: "text",
          text: `${JSON.stringify({ version: 1, operationId }, null, 2)}\n`,
        },
        mode: 0o644,
      },
    ],
  });
  current = await status(ctx, contextId);
  await ctx.rpc.call("main", "vcs.commit", {
    commandId: `${contextId}:commit`,
    contextId,
    expectedWorkingHead: current.workingHead,
    intentSummary: `Commit cancellation of template operation ${operationId}`,
    message: `Cancel template operation ${operationId}`,
  });
  current = await status(ctx, contextId);
  if (!current.clean || current.committed.kind !== "event") {
    throw new Error(`Template cancellation context ${contextId} is not committed`);
  }
  const result = await ctx.rpc.call<{ mainEventId: string }>("main", "vcs.push", {
    commandId: `${contextId}:publish`,
    contextId,
    expectedCommittedEventId: current.committed.eventId,
    expectedMainEventId,
  });
  return result.mainEventId;
}
