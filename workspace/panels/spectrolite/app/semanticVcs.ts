/**
 * Thin product adapter over the canonical semantic VCS.
 *
 * A Spectrolite vault is one repository in one writable context. The adapter
 * keeps the exact working state used for optimistic edits and otherwise leaves
 * meaning in the semantic graph: repositories are discovered by walking
 * `contains-repository` edges, edits author changes, integration records local
 * decisions, commit seals the complete local chain, and push publishes it.
 */

import { vcs, type VcsClient } from "@workspace/runtime";
import type {
  VcsReadFileResult,
  VcsStateNodeRef,
  VcsStatePredicate,
  VcsWorkingMutationResult,
} from "@vibestudio/service-schemas/vcs";
import type { ReplaceEditOp } from "../coedit/commitEdits";

export type VaultVcsPort = Pick<
  VcsClient,
  | "status"
  | "resolveRepository"
  | "readFile"
  | "listFiles"
  | "edit"
  | "compare"
  | "integrate"
  | "revert"
  | "commit"
  | "push"
>;
type VcsFileListEntry = Awaited<ReturnType<VcsClient["listFiles"]>>["files"][number];

export interface VaultRevision {
  repositoryId: string;
  status: Awaited<ReturnType<VcsClient["status"]>>;
}

export interface VaultChange {
  previousWorkingHead: VcsStateNodeRef;
  workingHead: VcsStateNodeRef;
  changeIds: string[];
  paths: string[];
}

export interface VaultIntegrationConflict {
  changeId: string;
  kind: string;
  summary: string;
}

export type VaultIntegrationResult =
  | "up-to-date"
  | "integrated"
  | { status: "conflicts"; sourceEventId: string; conflicts: VaultIntegrationConflict[] };

function commandId(kind: string): string {
  return `spectrolite:${kind}:${crypto.randomUUID()}`;
}

function sameState(left: VcsStateNodeRef, right: VcsStateNodeRef): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "event"
      ? left.eventId === (right as { kind: "event"; eventId: string }).eventId
      : left.applicationId ===
        (right as { kind: "application"; applicationId: string }).applicationId)
  );
}

export class VaultSemanticVcs {
  private revision: VaultRevision | null = null;

  constructor(
    readonly contextId: string,
    readonly repoPath: string,
    private readonly client: VaultVcsPort = vcs
  ) {
    if (!contextId) throw new Error("A vault requires a writable context identity");
    if (!repoPath) throw new Error("A vault requires a repository path");
  }

  get current(): VaultRevision | null {
    return this.revision;
  }

  async refresh(): Promise<VaultRevision> {
    const status = await this.client.status({ contextId: this.contextId });
    const repositoryId = await this.repositoryAt(status.workingHead);
    this.revision = { repositoryId, status };
    return this.revision;
  }

  private async ready(): Promise<VaultRevision> {
    return this.revision ?? this.refresh();
  }

  private async repositoryAt(state: VcsStateNodeRef): Promise<string> {
    const repository = await this.client.resolveRepository({ state, repoPath: this.repoPath });
    if (repository) return repository.repositoryId;
    throw new Error(`Vault repository '${this.repoPath}' is not present in this context`);
  }

  private toRepositoryPath(path: string): string {
    const normalized = path.replace(/^\/+|\/+$/gu, "");
    const root = this.repoPath.replace(/^\/+|\/+$/gu, "");
    const prefix = `${root}/`;
    return normalized === root
      ? ""
      : normalized.startsWith(prefix)
        ? normalized.slice(prefix.length)
        : normalized;
  }

  private toWorkspacePath(path: string): string {
    const root = this.repoPath.replace(/^\/+|\/+$/gu, "");
    return path ? `${root}/${path}` : root;
  }

  async readFile(path: string, state?: VcsStateNodeRef): Promise<VcsReadFileResult> {
    const revision = await this.ready();
    return this.client.readFile({
      state: state ?? revision.status.workingHead,
      repositoryId: revision.repositoryId,
      file: { kind: "path", path: this.toRepositoryPath(path) },
    });
  }

  async listFiles(prefix?: string): Promise<VcsFileListEntry[]> {
    const revision = await this.refresh();
    const files: VcsFileListEntry[] = [];
    let cursor: string | undefined;
    const scopedPrefix = prefix === undefined ? undefined : this.toRepositoryPath(prefix);
    do {
      const page = await this.client.listFiles({
        state: revision.status.workingHead,
        repositoryId: revision.repositoryId,
        ...(scopedPrefix ? { prefix: scopedPrefix } : {}),
        limit: 500,
        ...(cursor ? { cursor } : {}),
      });
      files.push(...page.files.map((file) => ({ ...file, path: this.toWorkspacePath(file.path) })));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return files;
  }

  async edit(edits: ReplaceEditOp[], expectedWorkingHead?: VcsStateNodeRef): Promise<VaultChange> {
    const revision = await this.refresh();
    const basis = expectedWorkingHead ?? revision.status.workingHead;
    if (!sameState(basis, revision.status.workingHead)) {
      throw new Error("Vault changed before the edit could be recorded");
    }
    const changes = await Promise.all(
      edits.map(async (edit) => {
        const file = await this.readFile(edit.path, basis);
        if (!file?.fileId) throw new Error(`Cannot edit absent managed file: ${edit.path}`);
        return {
          kind: "text-edit" as const,
          repositoryId: revision.repositoryId,
          fileId: file.fileId,
          edits: edit.hunks.map((hunk) => ({
            start: hunk.start,
            end: hunk.end,
            text: hunk.newText,
          })),
        };
      })
    );
    const result = await this.client.edit({
      contextId: this.contextId,
      expectedWorkingHead: basis,
      commandId: commandId("edit"),
      changes,
    });
    revision.status.workingHead = result.workingHead;
    revision.status.clean = false;
    return mutationChange(
      result,
      basis,
      edits.map((edit) => edit.path)
    );
  }

  async createFile(path: string, text: string): Promise<VaultChange> {
    const revision = await this.refresh();
    const basis = revision.status.workingHead;
    const result = await this.client.edit({
      contextId: this.contextId,
      expectedWorkingHead: basis,
      commandId: commandId("create-file"),
      changes: [
        {
          kind: "file-create",
          repositoryId: revision.repositoryId,
          path: this.toRepositoryPath(path),
          content: { kind: "text", text },
          mode: 0o644,
        },
      ],
    });
    revision.status.workingHead = result.workingHead;
    revision.status.clean = false;
    return mutationChange(result, basis, [path]);
  }

  async commit(message: string | null, expectedWorkingHead?: VcsStateNodeRef) {
    const revision = await this.refresh();
    const basis = expectedWorkingHead ?? revision.status.workingHead;
    if (!sameState(basis, revision.status.workingHead)) {
      throw new Error("Vault changed before its local work could be committed");
    }
    if (revision.status.clean) return null;
    return this.client.commit({
      contextId: this.contextId,
      expectedWorkingHead: basis,
      commandId: commandId("commit"),
      ...(message ? { message } : {}),
    });
  }

  async pendingChangeCount(): Promise<number> {
    return (await this.refresh()).status.workingCounts.changes;
  }

  /** Integrate protected main as ordinary local decisions, then commit that chain. */
  async integrateMain(): Promise<VaultIntegrationResult> {
    const revision = await this.refresh();
    if (revision.status.mainRelation === "at" || revision.status.mainRelation === "ahead") {
      return "up-to-date";
    }

    const sourceEventId = revision.status.mainEventId;
    for (;;) {
      const applicable: string[] = [];
      const satisfied: Array<{ changeId: string; evidence: VcsStatePredicate[] }> = [];
      const conflicting: VaultIntegrationConflict[] = [];
      const blocked: Array<{ changeId: string; prerequisiteChangeIds: string[] }> = [];
      let cursor: string | undefined;
      do {
        const page = await this.client.compare({
          target: revision.status.workingHead,
          sourceEventId,
          view: "changes",
          limit: 500,
          ...(cursor ? { cursor } : {}),
        });
        for (const change of page.changes) {
          if (change.disposition.status === "actionable") {
            if (change.disposition.applicability === "applicable") {
              applicable.push(change.changeId);
            } else if (change.disposition.applicability === "conflicting") {
              conflicting.push({
                changeId: change.changeId,
                kind: change.kind,
                summary: change.summary,
              });
            } else {
              blocked.push({
                changeId: change.changeId,
                prerequisiteChangeIds: change.disposition.prerequisiteChangeIds,
              });
            }
          } else if (change.disposition.status === "already-satisfied") {
            satisfied.push({ changeId: change.changeId, evidence: change.disposition.evidence });
          }
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);

      if (conflicting.length > 0) {
        return { status: "conflicts", sourceEventId, conflicts: conflicting };
      }

      const nextApplicable = applicable[0];
      if (nextApplicable) {
        const result = await this.client.integrate({
          contextId: this.contextId,
          expectedWorkingHead: revision.status.workingHead,
          commandId: commandId("integrate-main"),
          sourceEventId,
          decision: { kind: "adopted", sourceChangeIds: [nextApplicable] },
        });
        revision.status.workingHead = result.workingHead;
        continue;
      }

      const nextSatisfied = satisfied[0];
      if (nextSatisfied) {
        const result = await this.client.integrate({
          contextId: this.contextId,
          expectedWorkingHead: revision.status.workingHead,
          commandId: commandId("account-for-main"),
          sourceEventId,
          decision: {
            kind: "reconciled",
            sourceChangeIds: [nextSatisfied.changeId],
            evidence: nextSatisfied.evidence,
            rationale: "The current vault already satisfies this published change.",
          },
        });
        revision.status.workingHead = result.workingHead;
        continue;
      }

      if (blocked.length > 0) {
        const explanation = blocked
          .map(
            ({ changeId, prerequisiteChangeIds }) =>
              `${changeId} after ${prerequisiteChangeIds.join(", ")}`
          )
          .join("; ");
        throw new Error(
          `Published changes remain blocked after safe integration steps: ${explanation}`
        );
      }
      break;
    }

    await this.client.commit({
      contextId: this.contextId,
      expectedWorkingHead: revision.status.workingHead,
      commandId: commandId("commit-integration"),
      integratesEventId: sourceEventId,
      message: "Integrate published vault changes",
    });
    await this.refresh();
    return "integrated";
  }

  /** Explicitly keep the current vault result for selected conflicting source changes. */
  async keepLocalForMain(changeIds: string[]): Promise<VaultIntegrationResult> {
    if (changeIds.length === 0) return this.integrateMain();
    const revision = await this.refresh();
    const sourceEventId = revision.status.mainEventId;
    for (const changeId of changeIds) {
      const result = await this.client.integrate({
        contextId: this.contextId,
        expectedWorkingHead: revision.status.workingHead,
        commandId: commandId("decline-main"),
        sourceEventId,
        decision: {
          kind: "declined",
          sourceChangeIds: [changeId],
          rationale: "Keep the current vault content instead of this conflicting published change.",
        },
      });
      revision.status.workingHead = result.workingHead;
    }
    return this.integrateMain();
  }

  async revert(changeIds: string[]): Promise<VaultChange> {
    const revision = await this.refresh();
    const basis = revision.status.workingHead;
    const result = await this.client.revert({
      contextId: this.contextId,
      expectedWorkingHead: basis,
      commandId: commandId("revert"),
      changeIds,
    });
    return mutationChange(result, basis, []);
  }

  async push() {
    const revision = await this.refresh();
    if (revision.status.committed.kind !== "event") {
      throw new Error("A vault can only publish a committed event");
    }
    return this.client.push({
      contextId: this.contextId,
      expectedCommittedEventId: revision.status.committed.eventId,
      expectedMainEventId: revision.status.mainEventId,
      commandId: commandId("push"),
    });
  }
}

function mutationChange(
  result: VcsWorkingMutationResult,
  previousWorkingHead: VcsStateNodeRef,
  paths: string[]
): VaultChange {
  return {
    previousWorkingHead,
    workingHead: result.workingHead,
    changeIds: result.changeIds,
    paths,
  };
}
