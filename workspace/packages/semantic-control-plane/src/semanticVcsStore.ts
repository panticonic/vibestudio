import { canonicalJson, compareUtf16CodeUnits } from "@vibestudio/content-addressing";
import type { VcsExternalSnapshot } from "@vibestudio/service-schemas/vcs";
import {
  NORMALIZATION_PROTOCOL,
  SEMANTIC_PROTOCOL,
  canonicalDigest,
  compactId,
  type ContentMapping,
  type StateNodeRef,
  type WorkspaceFactChangeSet,
} from "@workspace/vcs-engine";
import type { SqlStorage } from "@workspace/runtime/worker/durable-base";
import {
  normalizeContextMaterializationReceipt,
  type ContextMaterializationCommand,
  type ContextMaterializationReceipt,
} from "@vibestudio/shared/vcs/workspaceProjection";
import {
  readWorkingApplicationBasisChain,
  type WorkingApplicationBasisChain,
} from "./semanticVcsApplicationBasisChain.js";
import { SemanticWorkspaceFacts } from "./semanticWorkspaceFacts.js";
import {
  contentMappingRowValues,
  encodeContentMappingRow,
} from "./semanticVcsContentMappingCodec.js";

export { NORMALIZATION_PROTOCOL, SEMANTIC_PROTOCOL } from "@workspace/vcs-engine";

type Row = Record<string, unknown>;

const text = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new SemanticVcsError("IntegrityFailure", `Missing ${key}`);
  }
  return value;
};
const nullableText = (row: Row, key: string): string | null => {
  const value = row[key];
  return value == null ? null : String(value);
};
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;

export type SemanticVcsErrorCode =
  | "InvalidReference"
  | "RevisionChanged"
  | "NoEffect"
  | "ConflictPresent"
  | "DependencyBlocked"
  | "IntegrationIncomplete"
  | "CommandIdReuse"
  | "IntegrityFailure"
  | "ScopeTooLarge";

export class SemanticVcsError extends Error {
  constructor(
    readonly code: SemanticVcsErrorCode,
    message: string,
    readonly detail: Row = {}
  ) {
    super(message);
    this.name = "SemanticVcsError";
  }
}

/** Keep internal journal/effect contract diagnostics inspectable without
 * minting caller-facing semantic error codes for host/control-plane bugs. */
export function internalSemanticIntegrityFailure(
  diagnostic: "CommandInProgress" | "EffectMismatch",
  message: string,
  detail: Record<string, unknown> = {}
): SemanticVcsError {
  return new SemanticVcsError("IntegrityFailure", message, {
    internalDiagnostic: diagnostic,
    ...detail,
  });
}

export interface CausalCommandRef {
  parent: {
    logId: string;
    head: string;
    invocationId: string;
  } | null;
}

export interface SemanticStateRecord {
  ref: StateNodeRef;
  workspaceFactRootId: string;
}

export interface ContextRecord {
  contextId: string;
  committed: SemanticStateRecord & { ref: { kind: "event"; eventId: string } };
  working: SemanticStateRecord;
  workingHeadApplicationId: string | null;
}

export interface WorkspaceEventRecord {
  eventId: string;
  commandId: string;
  kind: "genesis" | "commit" | "integration-commit";
  parentEventIds: readonly string[];
  applicationIds: readonly string[];
  resultWorkspaceFactRootId: string;
  message: string | null;
  createdAt: string;
}

export interface WorkUnitRecord {
  workUnitId: string;
  commandId: string;
  kind: "edit" | "file-transfer" | "lifecycle" | "integrate" | "revert" | "import";
  authoredChangeIds: readonly string[];
  intentSummary: string | null;
  externalSnapshot: ExternalSnapshotRecord | null;
  normalizationProtocol: string;
  createdAt: string;
}

export interface ExternalSnapshotRecord {
  sourceKind: VcsExternalSnapshot["sourceKind"];
  sourceUri: string;
  snapshotRevision: string;
  snapshotDigest: string;
  targetRepositoryIds: readonly string[];
}

export interface ChangeRecord {
  changeId: string;
  workUnitId: string;
  operation: number;
  ordinal: number;
  kind: string;
  /** Exact cross-state endpoint named by an authored copy. The change owns
   * this fact; payload conventions and parallel copy-source tables do not. */
  source: AuthoredCopySourceEndpoint | null;
  base: Row | null;
  result: Row | null;
  payload: Row;
  effectDigest: string;
}

export interface AuthoredCopySourceEndpoint {
  kind: "file";
  state: StateNodeRef;
  repositoryId: string;
  repoPath: string;
  fileId: string;
  path: string;
  contentHash: string;
  mode: number;
  contentKind: "text" | "bytes";
  byteLength: number;
  coordinateExtent: number;
}

export interface StatePredicateRecord {
  kind: string;
  [key: string]: unknown;
}

export interface AppliedChangeRecord {
  appliedChangeId: string;
  applicationId: string;
  changeId: string;
  ordinal: number;
  appliedBase: Row | null;
  appliedResult: Row | null;
  resultPredicates: readonly StatePredicateRecord[];
}

export interface ApplicationRecord {
  applicationId: string;
  workUnitId: string;
  basis: StateNodeRef;
  appliedChangeIds: readonly string[];
  resultWorkspaceFactRootId: string;
  semanticProtocol: string;
}

export interface ContentEdgeRecord {
  contentEdgeId: string;
  childAppliedChangeId: string;
  parentAppliedChangeId: string;
  relation: "preserves" | "copies" | "incorporates";
  mappings: readonly ContentMapping[];
}

export type IntegrationDecisionRecord = {
  decisionId: string;
  kind: "adopted" | "reconciled" | "declined";
  targetState: StateNodeRef;
  sourceEventId: string;
  sourceChangeIds: readonly string[];
  workUnitId: string;
  evidencePredicates: readonly StatePredicateRecord[];
  rationale: string | null;
  createdAt: string;
};

export interface ApplicationPersistencePlan {
  contextId: string;
  expectedWorkingHead: StateNodeRef;
  workUnit: WorkUnitRecord;
  changes: readonly ChangeRecord[];
  application: ApplicationRecord;
  appliedChanges: readonly AppliedChangeRecord[];
  contentEdges: readonly ContentEdgeRecord[];
  decisions: readonly IntegrationDecisionRecord[];
  workspaceChangeSet: WorkspaceFactChangeSet | null;
  newRepositories: readonly { repositoryId: string }[];
  newFiles: readonly { fileId: string; repositoryId: string; changeId: string }[];
}

export interface SemanticEffect {
  effectId: string;
  scopeKind: "context" | "workspace";
  scopeId: string;
  commandId: string;
  kind: "observe-content" | "materialize-context" | "publish-main";
  payload: Row;
  payloadDigest: string;
  status: "pending" | "applied";
  receipt: Row | null;
  createdAt: string;
}

export interface JournalCommand {
  scopeKind: "context" | "workspace";
  scopeId: string;
  commandId: string;
  method: string;
  requestDigest: string;
  cause: CausalCommandRef;
  status: "pending" | "effect-pending" | "complete";
  result: unknown;
}

export const stateNodeKey = (ref: StateNodeRef): string =>
  ref.kind === "event" ? `event:${ref.eventId}` : `application:${ref.applicationId}`;

export const workUnitIdentity = (input: {
  commandId: string;
  kind: WorkUnitRecord["kind"];
  intentSummary: string | null;
  externalSnapshot: WorkUnitRecord["externalSnapshot"];
}): string => compactId("work-unit", input);

export const changeIdentity = (input: Omit<ChangeRecord, "changeId" | "effectDigest">): string =>
  compactId("change", input);

export const appliedChangeIdentity = (
  input: Omit<AppliedChangeRecord, "appliedChangeId">
): string => compactId("applied-change", input);

export const applicationIdentity = (
  input: Omit<ApplicationRecord, "applicationId" | "appliedChangeIds"> & {
    changes: readonly Omit<AppliedChangeRecord, "appliedChangeId" | "applicationId">[];
  }
): string => compactId("application", input);

export const contentEdgeIdentity = (input: Omit<ContentEdgeRecord, "contentEdgeId">): string =>
  compactId("content-edge", input);

export const decisionIdentity = (input: Omit<IntegrationDecisionRecord, "decisionId">): string =>
  compactId("decision", input);

const stateKindAndId = (ref: StateNodeRef): ["event" | "application", string] =>
  ref.kind === "event" ? ["event", ref.eventId] : ["application", ref.applicationId];

const stateRef = (kind: unknown, id: unknown): StateNodeRef => {
  if (kind === "event") return { kind, eventId: String(id) };
  if (kind === "application") return { kind, applicationId: String(id) };
  throw new SemanticVcsError("IntegrityFailure", `Invalid state kind ${String(kind)}`);
};

export class SemanticVcsStore {
  readonly facts: SemanticWorkspaceFacts;

  constructor(
    private readonly sql: SqlStorage,
    private readonly now: () => string = () => new Date().toISOString()
  ) {
    this.facts = new SemanticWorkspaceFacts(sql);
  }

  assertIntegrity(): void {
    const contexts = this.sql
      .exec(`SELECT context_id, committed_event_id, working_head_application_id FROM vcs_contexts`)
      .toArray() as Row[];
    for (const row of contexts) {
      const context = this.context(text(row, "context_id"));
      if (!context) throw new SemanticVcsError("IntegrityFailure", "Context disappeared");
      const chain = this.workingChain(context.contextId, 100_000);
      if (chain.root?.kind !== "event" || chain.root.eventId !== context.committed.ref.eventId) {
        throw new SemanticVcsError(
          "IntegrityFailure",
          `Context ${context.contextId} has a detached working chain`
        );
      }
      this.facts.assertIndexParity(context.committed.workspaceFactRootId);
      if (context.working.workspaceFactRootId !== context.committed.workspaceFactRootId) {
        this.facts.assertIndexParity(context.working.workspaceFactRootId);
      }
    }
  }

  initializeWorkspace(contextId: string, commandId: string): ContextRecord {
    const existing = this.context(contextId);
    if (existing) return existing;
    const root = this.facts.empty();
    let genesis = this.sql
      .exec(`SELECT event_id FROM gad_workspace_events WHERE kind = 'genesis' LIMIT 2`)
      .toArray() as Row[];
    let eventId: string;
    let genesisCreatedAt: string | null = null;
    if (genesis.length === 0) {
      const createdAt = this.now();
      genesisCreatedAt = createdAt;
      eventId = compactId("workspace-event", {
        commandId,
        kind: "genesis",
        parentEventIds: [],
        applicationIds: [],
        resultWorkspaceFactRootId: root.workspaceFactRootId,
        message: null,
        createdAt,
      });
      this.sql.exec(
        `INSERT INTO gad_workspace_events
         (event_id, command_id, kind, result_workspace_fact_root_id, message, created_at)
         VALUES (?, ?, 'genesis', ?, NULL, ?)`,
        eventId,
        commandId,
        root.workspaceFactRootId,
        createdAt
      );
      this.sql.exec(
        `INSERT OR IGNORE INTO vcs_workspace_heads (head, event_id, updated_at)
         VALUES ('main', ?, ?)`,
        eventId,
        createdAt
      );
    } else if (genesis.length === 1) {
      eventId = text(genesis[0]!, "event_id");
    } else {
      throw new SemanticVcsError("IntegrityFailure", "Workspace has multiple genesis events");
    }
    this.sql.exec(
      `INSERT INTO vcs_contexts
       (context_id, committed_event_id, working_head_application_id, updated_at)
       VALUES (?, ?, NULL, ?)`,
      contextId,
      eventId,
      this.now()
    );
    const existingGenesisCommand = this.sql
      .exec(`SELECT 1 FROM vcs_command_journal WHERE command_id = ?`, commandId)
      .toArray()[0];
    if (genesisCreatedAt && !existingGenesisCommand) {
      this.sql.exec(
        `INSERT INTO vcs_command_journal
         (command_id, scope_kind, scope_id, method, request_digest,
          cause_log_id, cause_head, cause_invocation_id, status, result_json,
          created_at, completed_at)
         VALUES (?, 'context', ?, 'initialize-workspace', ?, NULL, NULL, NULL,
                 'complete', ?, ?, ?)`,
        commandId,
        contextId,
        compactId("initialize-workspace-request", { contextId }),
        canonicalJson({ eventId }),
        genesisCreatedAt,
        genesisCreatedAt
      );
    }
    return this.contextRequired(contextId);
  }

  ensureContext(contextId: string, commandId: string): ContextRecord {
    const current = this.context(contextId);
    if (current) return current;
    const main = this.mainEventId();
    if (!main) return this.initializeWorkspace(contextId, commandId);
    this.sql.exec(
      `INSERT INTO vcs_contexts
       (context_id, committed_event_id, working_head_application_id, updated_at)
       VALUES (?, ?, NULL, ?)`,
      contextId,
      main,
      this.now()
    );
    return this.contextRequired(contextId);
  }

  forkContext(sourceContextId: string, targetContextId: string): ContextRecord {
    if (this.context(targetContextId)) {
      throw new SemanticVcsError("RevisionChanged", `Context ${targetContextId} already exists`);
    }
    const source = this.contextRequired(sourceContextId);
    this.sql.exec(
      `INSERT INTO vcs_contexts
       (context_id, committed_event_id, working_head_application_id, updated_at)
       VALUES (?, ?, ?, ?)`,
      targetContextId,
      source.committed.ref.eventId,
      source.workingHeadApplicationId,
      this.now()
    );
    return this.contextRequired(targetContextId);
  }

  dropContext(contextId: string): boolean {
    // Context command journals and host-effect intents are operational
    // idempotency state, not semantic history. Keeping them after deleting the
    // context would make a later ensure of the same identity replay a command
    // whose context row no longer exists.
    this.sql.exec(
      `DELETE FROM gad_effect_intents WHERE scope_kind = 'context' AND scope_id = ?`,
      contextId
    );
    this.sql.exec(
      `DELETE FROM vcs_command_journal WHERE scope_kind = 'context' AND scope_id = ?`,
      contextId
    );
    this.sql.exec(`DELETE FROM vcs_contexts WHERE context_id = ?`, contextId);
    return Number((this.sql.exec(`SELECT changes() AS n`).toArray()[0] as Row)["n"]) === 1;
  }

  context(contextId: string): ContextRecord | null {
    const row = this.sql
      .exec(
        `SELECT context_id, committed_event_id, working_head_application_id
           FROM vcs_contexts WHERE context_id = ?`,
        contextId
      )
      .toArray()[0] as Row | undefined;
    if (!row) return null;
    const committedEventId = text(row, "committed_event_id");
    const workingHeadApplicationId = nullableText(row, "working_head_application_id");
    const committed: SemanticStateRecord & { ref: { kind: "event"; eventId: string } } = {
      ref: { kind: "event", eventId: committedEventId },
      workspaceFactRootId: this.stateRoot({ kind: "event", eventId: committedEventId }),
    };
    const workingRef: StateNodeRef = workingHeadApplicationId
      ? { kind: "application", applicationId: workingHeadApplicationId }
      : committed.ref;
    return {
      contextId,
      committed,
      working: { ref: workingRef, workspaceFactRootId: this.stateRoot(workingRef) },
      workingHeadApplicationId,
    };
  }

  contextRequired(contextId: string): ContextRecord {
    const context = this.context(contextId);
    if (!context) {
      throw new SemanticVcsError("InvalidReference", `Unknown context ${contextId}`, { contextId });
    }
    return context;
  }

  stateRoot(ref: StateNodeRef): string {
    const [kind, id] = stateKindAndId(ref);
    const row = this.sql
      .exec(
        kind === "event"
          ? `SELECT result_workspace_fact_root_id AS root
               FROM gad_workspace_events WHERE event_id = ?`
          : `SELECT result_workspace_fact_root_id AS root
               FROM gad_work_unit_applications WHERE application_id = ?`,
        id
      )
      .toArray()[0] as Row | undefined;
    if (!row) {
      throw new SemanticVcsError("InvalidReference", `Unknown ${stateNodeKey(ref)}`);
    }
    return text(row, "root");
  }

  workingChain(contextId: string, maxApplications: number): WorkingApplicationBasisChain {
    const context = this.contextRequired(contextId);
    const chain = readWorkingApplicationBasisChain({
      sql: this.sql,
      tailApplicationId: context.workingHeadApplicationId,
      maxApplications,
    });
    return chain.root ? chain : { ...chain, root: context.committed.ref };
  }

  assertExpectedWorking(contextId: string, expected: StateNodeRef): ContextRecord {
    const context = this.contextRequired(contextId);
    if (stateNodeKey(context.working.ref) !== stateNodeKey(expected)) {
      throw new SemanticVcsError("RevisionChanged", `Context ${contextId} changed`, {
        expected: stateNodeKey(expected),
        actual: stateNodeKey(context.working.ref),
      });
    }
    return context;
  }

  mainEventId(): string | null {
    const row = this.sql
      .exec(`SELECT event_id FROM vcs_workspace_heads WHERE head = 'main'`)
      .toArray()[0] as Row | undefined;
    return row ? text(row, "event_id") : null;
  }

  event(eventId: string): WorkspaceEventRecord | null {
    const row = this.sql
      .exec(`SELECT * FROM gad_workspace_events WHERE event_id = ?`, eventId)
      .toArray()[0] as Row | undefined;
    if (!row) return null;
    return {
      eventId,
      commandId: text(row, "command_id"),
      kind: text(row, "kind") as WorkspaceEventRecord["kind"],
      parentEventIds: (
        this.sql
          .exec(
            `SELECT parent_event_id FROM gad_workspace_event_parents
            WHERE event_id = ? ORDER BY ordinal`,
            eventId
          )
          .toArray() as Row[]
      ).map((parent) => text(parent, "parent_event_id")),
      applicationIds: (
        this.sql
          .exec(
            `SELECT application_id FROM gad_workspace_event_applications
            WHERE event_id = ? ORDER BY ordinal`,
            eventId
          )
          .toArray() as Row[]
      ).map((application) => text(application, "application_id")),
      resultWorkspaceFactRootId: text(row, "result_workspace_fact_root_id"),
      message: nullableText(row, "message"),
      createdAt: text(row, "created_at"),
    };
  }

  application(applicationId: string): ApplicationRecord | null {
    const row = this.sql
      .exec(`SELECT * FROM gad_work_unit_applications WHERE application_id = ?`, applicationId)
      .toArray()[0] as Row | undefined;
    if (!row) return null;
    return {
      applicationId,
      workUnitId: text(row, "work_unit_id"),
      basis: stateRef(row["basis_kind"], row["basis_id"]),
      appliedChangeIds: (
        this.sql
          .exec(
            `SELECT applied_change_id FROM gad_applied_changes
            WHERE application_id = ? ORDER BY ordinal`,
            applicationId
          )
          .toArray() as Row[]
      ).map((value) => text(value, "applied_change_id")),
      resultWorkspaceFactRootId: text(row, "result_workspace_fact_root_id"),
      semanticProtocol: text(row, "semantic_protocol"),
    };
  }

  /** Repository coordinates touched by exact applied-change records.
   * Used to reverse a working chain without comparing or walking whole roots. */
  affectedRepositoryIds(applicationIds: readonly string[]): string[] {
    const repositoryIds = new Set<string>();
    for (const applicationId of applicationIds) {
      const rows = this.sql
        .exec(
          `SELECT applied_base_json, applied_result_json
             FROM gad_applied_changes
            WHERE application_id = ?
            ORDER BY ordinal`,
          applicationId
        )
        .toArray() as Row[];
      for (const row of rows) {
        for (const column of ["applied_base_json", "applied_result_json"] as const) {
          if (row[column] == null) continue;
          const value = parse<Row>(row[column]);
          const repositoryId = value["repositoryId"];
          if (typeof repositoryId !== "string" || !repositoryId) {
            throw new SemanticVcsError(
              "IntegrityFailure",
              `Applied change in ${applicationId} has no repository coordinate`
            );
          }
          repositoryIds.add(repositoryId);
        }
      }
    }
    return [...repositoryIds].sort(compareUtf16CodeUnits);
  }

  applyApplication(plan: ApplicationPersistencePlan): ContextRecord {
    this.assertExpectedWorking(plan.contextId, plan.expectedWorkingHead);
    if (stateNodeKey(plan.application.basis) !== stateNodeKey(plan.expectedWorkingHead)) {
      throw new SemanticVcsError("IntegrityFailure", "Application basis differs from context CAS");
    }
    this.validateApplicationPlan(plan);
    for (const repository of plan.newRepositories) {
      this.sql.exec(
        `INSERT INTO vcs_repositories (repository_id, created_work_unit_id, created_at)
         VALUES (?, ?, ?)`,
        repository.repositoryId,
        plan.workUnit.workUnitId,
        plan.workUnit.createdAt
      );
    }
    for (const file of plan.newFiles) {
      this.sql.exec(
        `INSERT INTO vcs_files (file_id, created_repository_id, created_change_id, created_at)
         VALUES (?, ?, ?, ?)`,
        file.fileId,
        file.repositoryId,
        file.changeId,
        plan.workUnit.createdAt
      );
    }
    if (plan.workspaceChangeSet) {
      this.persistResultStates(plan.workspaceChangeSet);
      const proof = this.facts.apply(plan.workspaceChangeSet);
      if (proof.resultRoot.workspaceFactRootId !== plan.application.resultWorkspaceFactRootId) {
        throw new SemanticVcsError("IntegrityFailure", "Application result root is not exact");
      }
    } else if (
      this.stateRoot(plan.application.basis) !== plan.application.resultWorkspaceFactRootId
    ) {
      throw new SemanticVcsError(
        "IntegrityFailure",
        "Decision-only application changed workspace facts"
      );
    }
    this.persistWorkUnit(plan.workUnit);
    for (const change of plan.changes) this.persistChange(change);
    this.persistApplication(plan.application);
    for (const applied of plan.appliedChanges) this.persistAppliedChange(applied);
    for (const edge of plan.contentEdges) this.persistContentEdge(edge);
    for (const decision of plan.decisions) this.persistDecision(decision);
    this.sql.exec(
      `UPDATE vcs_contexts SET working_head_application_id = ?, updated_at = ?
        WHERE context_id = ? AND
          ((? IS NULL AND working_head_application_id IS NULL AND committed_event_id = ?)
           OR working_head_application_id = ?)`,
      plan.application.applicationId,
      this.now(),
      plan.contextId,
      plan.expectedWorkingHead.kind === "event" ? null : plan.expectedWorkingHead.applicationId,
      plan.expectedWorkingHead.kind === "event" ? plan.expectedWorkingHead.eventId : null,
      plan.expectedWorkingHead.kind === "event" ? null : plan.expectedWorkingHead.applicationId
    );
    if (Number((this.sql.exec(`SELECT changes() AS n`).toArray()[0] as Row)["n"]) !== 1) {
      throw new SemanticVcsError("RevisionChanged", `Context ${plan.contextId} changed`);
    }
    return this.contextRequired(plan.contextId);
  }

  commit(input: {
    contextId: string;
    expectedWorkingHead: StateNodeRef;
    commandId: string;
    message: string | null;
    integratesEventId: string | null;
    maxApplications: number;
  }): { context: ContextRecord; event: WorkspaceEventRecord } {
    const context = this.assertExpectedWorking(input.contextId, input.expectedWorkingHead);
    const chain = this.workingChain(input.contextId, input.maxApplications);
    if (chain.applicationIds.length === 0 && !input.integratesEventId) {
      throw new SemanticVcsError("RevisionChanged", "Nothing is working");
    }
    if (input.integratesEventId && !this.event(input.integratesEventId)) {
      throw new SemanticVcsError(
        "InvalidReference",
        `Unknown source event ${input.integratesEventId}`
      );
    }
    const createdAt = this.now();
    const eventInput = {
      commandId: input.commandId,
      kind: input.integratesEventId ? ("integration-commit" as const) : ("commit" as const),
      parentEventIds: [
        context.committed.ref.eventId,
        ...(input.integratesEventId ? [input.integratesEventId] : []),
      ],
      applicationIds: chain.applicationIds,
      resultWorkspaceFactRootId: context.working.workspaceFactRootId,
      message: input.message,
      createdAt,
    };
    const eventId = compactId("workspace-event", eventInput);
    this.sql.exec(
      `INSERT INTO gad_workspace_events
       (event_id, command_id, kind, result_workspace_fact_root_id, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      eventId,
      input.commandId,
      eventInput.kind,
      eventInput.resultWorkspaceFactRootId,
      input.message,
      createdAt
    );
    eventInput.parentEventIds.forEach((parentEventId, ordinal) =>
      this.sql.exec(
        `INSERT INTO gad_workspace_event_parents (event_id, ordinal, parent_event_id)
         VALUES (?, ?, ?)`,
        eventId,
        ordinal,
        parentEventId
      )
    );
    chain.applicationIds.forEach((applicationId, ordinal) =>
      this.sql.exec(
        `INSERT INTO gad_workspace_event_applications (event_id, ordinal, application_id)
         VALUES (?, ?, ?)`,
        eventId,
        ordinal,
        applicationId
      )
    );
    this.sql.exec(
      `UPDATE vcs_contexts
          SET committed_event_id = ?, working_head_application_id = NULL, updated_at = ?
        WHERE context_id = ? AND committed_event_id = ?`,
      eventId,
      createdAt,
      input.contextId,
      context.committed.ref.eventId
    );
    if (Number((this.sql.exec(`SELECT changes() AS n`).toArray()[0] as Row)["n"]) !== 1) {
      throw new SemanticVcsError("RevisionChanged", `Context ${input.contextId} changed`);
    }
    return { context: this.contextRequired(input.contextId), event: this.event(eventId)! };
  }

  discard(contextId: string, expectedWorkingHead: StateNodeRef): ContextRecord {
    const context = this.assertExpectedWorking(contextId, expectedWorkingHead);
    this.sql.exec(
      `UPDATE vcs_contexts SET working_head_application_id = NULL, updated_at = ?
        WHERE context_id = ? AND committed_event_id = ?`,
      this.now(),
      contextId,
      context.committed.ref.eventId
    );
    return this.contextRequired(contextId);
  }

  isEventAncestor(ancestorEventId: string, descendantEventId: string, maxEdges: number): boolean {
    if (!Number.isSafeInteger(maxEdges) || maxEdges < 0) {
      throw new SemanticVcsError("ScopeTooLarge", "Invalid ancestry bound");
    }
    const rows = this.sql
      .exec(
        `WITH RECURSIVE ancestry(event_id, depth) AS (
           SELECT ?, 0
           UNION
           SELECT parent.parent_event_id, ancestry.depth + 1
             FROM ancestry
             JOIN gad_workspace_event_parents parent ON parent.event_id = ancestry.event_id
            WHERE ancestry.depth < ?
         )
         SELECT event_id, depth FROM ancestry WHERE event_id = ? LIMIT 1`,
        descendantEventId,
        maxEdges,
        ancestorEventId
      )
      .toArray() as Row[];
    if (rows.length > 0) return true;
    const boundary = this.sql
      .exec(
        `WITH RECURSIVE ancestry(event_id, depth) AS (
           SELECT ?, 0
           UNION
           SELECT parent.parent_event_id, ancestry.depth + 1
             FROM ancestry
             JOIN gad_workspace_event_parents parent ON parent.event_id = ancestry.event_id
            WHERE ancestry.depth < ?
         )
         SELECT 1 FROM ancestry a
         JOIN gad_workspace_event_parents p ON p.event_id = a.event_id
         WHERE a.depth = ? LIMIT 1`,
        descendantEventId,
        maxEdges,
        maxEdges
      )
      .toArray();
    if (boundary.length > 0) {
      throw new SemanticVcsError("ScopeTooLarge", `Ancestry exceeds ${maxEdges} edges`);
    }
    return false;
  }

  beginCommand(input: Omit<JournalCommand, "status" | "result">): JournalCommand | null {
    const existing = this.command(input.commandId);
    if (existing) {
      if (
        existing.scopeKind !== input.scopeKind ||
        existing.scopeId !== input.scopeId ||
        existing.method !== input.method ||
        existing.requestDigest !== input.requestDigest ||
        canonicalJson(existing.cause) !== canonicalJson(input.cause)
      ) {
        throw new SemanticVcsError(
          "CommandIdReuse",
          `Command ${input.commandId} was reused with different scope, input, or cause`
        );
      }
      return existing;
    }
    this.sql.exec(
      `INSERT INTO vcs_command_journal
       (scope_kind, scope_id, command_id, method, request_digest,
        cause_log_id, cause_head, cause_invocation_id,
        status, result_json, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)`,
      input.scopeKind,
      input.scopeId,
      input.commandId,
      input.method,
      input.requestDigest,
      input.cause.parent?.logId ?? null,
      input.cause.parent?.head ?? null,
      input.cause.parent?.invocationId ?? null,
      this.now()
    );
    return null;
  }

  command(commandId: string): JournalCommand | null {
    const row = this.sql
      .exec(
        `SELECT * FROM vcs_command_journal
          WHERE command_id = ?`,
        commandId
      )
      .toArray()[0] as Row | undefined;
    if (!row) return null;
    const causeInvocationId = nullableText(row, "cause_invocation_id");
    return {
      scopeKind: text(row, "scope_kind") as JournalCommand["scopeKind"],
      scopeId: text(row, "scope_id"),
      commandId,
      method: text(row, "method"),
      requestDigest: text(row, "request_digest"),
      cause: {
        parent: causeInvocationId
          ? {
              logId: text(row, "cause_log_id"),
              head: text(row, "cause_head"),
              invocationId: causeInvocationId,
            }
          : null,
      },
      status: text(row, "status") as JournalCommand["status"],
      result: row["result_json"] == null ? null : parse(row["result_json"]),
    };
  }

  finishCommand(input: {
    scopeKind: "context" | "workspace";
    scopeId: string;
    commandId: string;
    result: unknown;
    effectPending: boolean;
  }): void {
    this.sql.exec(
      `UPDATE vcs_command_journal
          SET status = ?, result_json = ?, completed_at = ?
        WHERE scope_kind = ? AND scope_id = ? AND command_id = ? AND status = 'pending'`,
      input.effectPending ? "effect-pending" : "complete",
      canonicalJson(input.result),
      input.effectPending ? null : this.now(),
      input.scopeKind,
      input.scopeId,
      input.commandId
    );
    if (Number((this.sql.exec(`SELECT changes() AS n`).toArray()[0] as Row)["n"]) !== 1) {
      throw internalSemanticIntegrityFailure(
        "CommandInProgress",
        `Command ${input.commandId} is not pending`,
        { commandId: input.commandId, expectedStatus: "pending" }
      );
    }
  }

  queueEffect(input: {
    scopeKind: "context" | "workspace";
    scopeId: string;
    commandId: string;
    kind: SemanticEffect["kind"];
    payload: Row;
    effectId?: string;
    payloadDigest?: string;
  }): SemanticEffect {
    const payloadDigest =
      input.payloadDigest ??
      canonicalDigest("host-effect", {
        scopeKind: input.scopeKind,
        scopeId: input.scopeId,
        commandId: input.commandId,
        kind: input.kind,
        payload: input.payload,
      });
    const effectId =
      input.effectId ?? compactId("host-effect", { kind: input.kind, payloadDigest });
    const createdAt = this.now();
    this.sql.exec(
      `INSERT INTO gad_effect_intents
       (effect_id, scope_kind, scope_id, command_id, kind, payload_json,
        payload_digest, status, receipt_json, receipt_digest, created_at, applied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL)`,
      effectId,
      input.scopeKind,
      input.scopeId,
      input.commandId,
      input.kind,
      canonicalJson(input.payload),
      payloadDigest,
      createdAt
    );
    return {
      effectId,
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      commandId: input.commandId,
      kind: input.kind,
      payload: input.payload,
      payloadDigest,
      status: "pending",
      receipt: null,
      createdAt,
    };
  }

  pendingEffects(commandId?: string): SemanticEffect[] {
    const rows = this.sql
      .exec(
        `SELECT * FROM gad_effect_intents
          WHERE status = 'pending' ${commandId ? "AND command_id = ?" : ""}
          ORDER BY created_at, effect_id`,
        ...(commandId ? [commandId] : [])
      )
      .toArray() as Row[];
    return rows.map((row) => this.effectFromRow(row));
  }

  /** Resolve the host root receipted for one repository at one exact semantic
   * workspace state. Placement manifests are not content identities: an
   * in-place edit retains its path-to-file manifest while changing bytes. */
  materializedRepositoryContentRoot(
    workspaceFactRootId: string,
    repositoryId: string
  ): string | null {
    const row = this.sql
      .exec(
        `SELECT content_root
           FROM gad_materialized_repository_states
          WHERE workspace_fact_root_id = ? AND repository_id = ?`,
        workspaceFactRootId,
        repositoryId
      )
      .toArray()[0] as Row | undefined;
    if (!row) return null;
    const root = text(row, "content_root");
    if (!/^state:[0-9a-f]{64}$/.test(root)) {
      throw new SemanticVcsError(
        "IntegrityFailure",
        `Stored materialization root for ${workspaceFactRootId}/${repositoryId} is invalid`
      );
    }
    return root;
  }

  acknowledgeEffect(input: {
    effectId: string;
    payloadDigest: string;
    receipt: Row;
    deferCommandCompletion?: boolean;
  }): SemanticEffect {
    const row = this.sql
      .exec(`SELECT * FROM gad_effect_intents WHERE effect_id = ?`, input.effectId)
      .toArray()[0] as Row | undefined;
    if (!row) throw new SemanticVcsError("InvalidReference", `Unknown effect ${input.effectId}`);
    const effect = this.effectFromRow(row);
    if (effect.payloadDigest !== input.payloadDigest) {
      throw internalSemanticIntegrityFailure(
        "EffectMismatch",
        `Effect ${input.effectId} payload changed`,
        { effectId: input.effectId, contract: "payload-digest" }
      );
    }
    if (effect.status === "applied") return effect;
    let receipt = input.receipt;
    if (effect.kind === "materialize-context") {
      const normalized = normalizeContextMaterializationReceipt(
        effect.payload as unknown as ContextMaterializationCommand,
        input.receipt
      );
      if (!normalized) {
        throw internalSemanticIntegrityFailure(
          "EffectMismatch",
          `Receipt does not prove materialization effect ${effect.effectId}`,
          { effectId: effect.effectId, contract: "materialization-receipt" }
        );
      }
      this.applyMaterializationReceipt(effect, normalized);
      receipt = normalized as unknown as Row;
    }
    if (effect.kind === "publish-main") this.applyPublicationReceipt(effect, receipt);
    const receiptDigest = canonicalDigest("host-effect-receipt", {
      effectId: effect.effectId,
      payloadDigest: effect.payloadDigest,
      receipt,
    });
    // Content observations carry transient blob bytes so the semantic command
    // can verify and derive its mutation in this same transaction. Persisting
    // those bytes would turn the effect journal into a second blob store and
    // can exceed the Durable Object SQLite value limit for a workspace import.
    // The digest is the durable acknowledgement; receipts that describe
    // durable host state (materialization/publication) remain queryable JSON.
    const durableReceipt = effect.kind === "observe-content" ? null : canonicalJson(receipt);
    this.sql.exec(
      `UPDATE gad_effect_intents
          SET status = 'applied', receipt_json = ?, receipt_digest = ?, applied_at = ?
        WHERE effect_id = ? AND status = 'pending'`,
      durableReceipt,
      receiptDigest,
      this.now(),
      effect.effectId
    );
    const remaining = this.sql
      .exec(
        `SELECT 1 FROM gad_effect_intents
          WHERE scope_kind = ? AND scope_id = ? AND command_id = ? AND status = 'pending'
          LIMIT 1`,
        effect.scopeKind,
        effect.scopeId,
        effect.commandId
      )
      .toArray();
    if (remaining.length === 0 && !input.deferCommandCompletion) {
      this.sql.exec(
        `UPDATE vcs_command_journal SET status = 'complete', completed_at = ?
          WHERE scope_kind = ? AND scope_id = ? AND command_id = ?
            AND status = 'effect-pending'`,
        this.now(),
        effect.scopeKind,
        effect.scopeId,
        effect.commandId
      );
    }
    return { ...effect, status: "applied", receipt };
  }

  private applyMaterializationReceipt(
    effect: SemanticEffect,
    receipt: ContextMaterializationReceipt
  ): void {
    const command = effect.payload as unknown as ContextMaterializationCommand;
    const targetRoot = this.stateRoot(command.targetState);
    const roots = new Map(
      receipt.repositories.map((repository) => [repository.repositoryId, repository.contentRoot])
    );
    for (const repository of command.repositories) {
      if (repository.presence !== "present") continue;
      const contentRoot = roots.get(repository.repositoryId);
      if (!contentRoot) {
        throw internalSemanticIntegrityFailure(
          "EffectMismatch",
          `Materialization receipt omitted ${repository.repositoryId}`,
          {
            effectId: effect.effectId,
            repositoryId: repository.repositoryId,
            contract: "materialization-repository",
          }
        );
      }
      const existing = this.sql
        .exec(
          `SELECT content_root
             FROM gad_materialized_repository_states
            WHERE workspace_fact_root_id = ? AND repository_id = ?`,
          targetRoot,
          repository.repositoryId
        )
        .toArray()[0] as Row | undefined;
      if (existing) {
        if (text(existing, "content_root") !== contentRoot) {
          throw new SemanticVcsError(
            "IntegrityFailure",
            `Materialized repository ${repository.repositoryId} at ${targetRoot} changed its immutable host root`
          );
        }
        continue;
      }
      this.sql.exec(
        `INSERT INTO gad_materialized_repository_states
           (workspace_fact_root_id, repository_id, content_root, receipt_effect_id)
         VALUES (?, ?, ?, ?)`,
        targetRoot,
        repository.repositoryId,
        contentRoot,
        effect.effectId
      );
    }
  }

  updatePendingCommandResult(input: {
    scopeKind: "context" | "workspace";
    scopeId: string;
    commandId: string;
    result: unknown;
  }): void {
    this.sql.exec(
      `UPDATE vcs_command_journal SET result_json = ?
        WHERE scope_kind = ? AND scope_id = ? AND command_id = ?
          AND status = 'effect-pending'`,
      canonicalJson(input.result),
      input.scopeKind,
      input.scopeId,
      input.commandId
    );
    if (Number((this.sql.exec(`SELECT changes() AS n`).toArray()[0] as Row)["n"]) !== 1) {
      throw internalSemanticIntegrityFailure(
        "CommandInProgress",
        `Command ${input.commandId} is not waiting`,
        { commandId: input.commandId, expectedStatus: "effect-pending" }
      );
    }
  }

  /** Drop admitted observation descriptors while retaining the exact effect and receipt digests.
   *
   * The command, work unit, changes, and content-addressed blobs own the durable facts after
   * admission. Keeping the original observation payload would be a second snapshot model. */
  compactAppliedObservation(effectId: string): void {
    this.sql.exec(
      `UPDATE gad_effect_intents SET payload_json = '{}'
        WHERE effect_id = ? AND kind = 'observe-content' AND status = 'applied'`,
      effectId
    );
    if (Number((this.sql.exec(`SELECT changes() AS n`).toArray()[0] as Row)["n"]) !== 1) {
      throw new SemanticVcsError(
        "IntegrityFailure",
        `Observation ${effectId} was not durably admitted`
      );
    }
  }

  private validateApplicationPlan(plan: ApplicationPersistencePlan): void {
    const authored = plan.changes.map((change) => change.changeId);
    const decision = plan.decisions[0];
    const incorporated = decision?.sourceChangeIds ?? [];
    const appliedChangeIds = new Set(plan.appliedChanges.map((value) => value.appliedChangeId));
    const targets = plan.workUnit.externalSnapshot?.targetRepositoryIds ?? [];
    const normalizedTargets = [...new Set(targets)].sort(compareUtf16CodeUnits);
    if (
      (plan.workUnit.kind === "import") !== (plan.workUnit.externalSnapshot !== null) ||
      (plan.workUnit.externalSnapshot !== null &&
        (targets.length === 0 || canonicalJson(targets) !== canonicalJson(normalizedTargets))) ||
      canonicalJson(authored) !== canonicalJson(plan.workUnit.authoredChangeIds) ||
      plan.changes.some((change) => change.workUnitId !== plan.workUnit.workUnitId) ||
      plan.application.workUnitId !== plan.workUnit.workUnitId ||
      (plan.workUnit.kind === "integrate"
        ? plan.decisions.length !== 1
        : plan.decisions.length !== 0) ||
      plan.decisions.some(
        (value) =>
          value.workUnitId !== plan.workUnit.workUnitId ||
          stateNodeKey(value.targetState) !== stateNodeKey(plan.application.basis)
      ) ||
      canonicalJson(plan.appliedChanges.map((value) => value.appliedChangeId)) !==
        canonicalJson(plan.application.appliedChangeIds) ||
      plan.appliedChanges.some(
        (value) =>
          value.applicationId !== plan.application.applicationId ||
          ![...authored, ...incorporated].includes(value.changeId)
      ) ||
      plan.changes.some((change) => (change.kind === "file-copy") !== (change.source !== null)) ||
      (decision?.kind === "adopted" &&
        canonicalJson(plan.appliedChanges.map((value) => value.changeId)) !==
          canonicalJson(decision.sourceChangeIds)) ||
      (decision != null && decision.kind !== "adopted" && plan.appliedChanges.length !== 0) ||
      plan.contentEdges.some((edge) => !appliedChangeIds.has(edge.childAppliedChangeId))
    ) {
      throw new SemanticVcsError("IntegrityFailure", "Application plan ownership is inconsistent");
    }
  }

  private persistResultStates(changeSet: WorkspaceFactChangeSet): void {
    for (const update of changeSet.repositoryUpdates) {
      const value = update.result;
      this.sql.exec(
        value.presence === "present"
          ? `INSERT OR IGNORE INTO vcs_repository_states
             (repository_state_id, repository_id, presence, repo_path, file_manifest_id,
              prior_repository_state_id, tombstone_change_id)
             VALUES (?, ?, 'present', ?, ?, NULL, NULL)`
          : `INSERT OR IGNORE INTO vcs_repository_states
             (repository_state_id, repository_id, presence, repo_path, file_manifest_id,
              prior_repository_state_id, tombstone_change_id)
             VALUES (?, ?, 'deleted', NULL, NULL, ?, ?)`,
        value.repositoryStateId,
        value.repositoryId,
        value.presence === "present" ? value.repoPath : value.priorRepositoryStateId,
        value.presence === "present" ? value.fileManifestId : value.tombstoneChangeId
      );
    }
    for (const update of changeSet.fileUpdates) {
      const value = update.result;
      if (value.presence === "placed") {
        this.sql.exec(
          `INSERT OR IGNORE INTO vcs_file_states
           (file_state_id, file_id, presence, repository_id, path, content_hash, mode,
            content_kind, byte_length, coordinate_extent,
            prior_file_state_id, tombstone_change_id)
           VALUES (?, ?, 'placed', ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
          value.fileStateId,
          value.fileId,
          value.repositoryId,
          value.path,
          value.contentHash,
          value.mode,
          value.contentKind,
          value.byteLength,
          value.coordinateExtent
        );
      } else {
        this.sql.exec(
          `INSERT OR IGNORE INTO vcs_file_states
           (file_state_id, file_id, presence, repository_id, path, content_hash, mode,
            content_kind, byte_length, coordinate_extent,
            prior_file_state_id, tombstone_change_id)
           VALUES (?, ?, 'deleted', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
          value.fileStateId,
          value.fileId,
          value.priorFileStateId,
          value.tombstoneChangeId
        );
      }
    }
  }

  private persistWorkUnit(value: WorkUnitRecord): void {
    this.sql.exec(
      `INSERT INTO gad_work_units
       (work_unit_id, command_id, kind, intent_summary, external_snapshot_json,
        normalization_protocol, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      value.workUnitId,
      value.commandId,
      value.kind,
      value.intentSummary,
      value.externalSnapshot == null ? null : canonicalJson(value.externalSnapshot),
      value.normalizationProtocol,
      value.createdAt
    );
  }

  private persistChange(value: ChangeRecord): void {
    this.sql.exec(
      `INSERT INTO gad_changes
       (change_id, work_unit_id, operation, ordinal, kind, source_json, base_json, result_json,
        payload_json, effect_digest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      value.changeId,
      value.workUnitId,
      value.operation,
      value.ordinal,
      value.kind,
      value.source ? canonicalJson(value.source) : null,
      value.base ? canonicalJson(value.base) : null,
      value.result ? canonicalJson(value.result) : null,
      canonicalJson(value.payload),
      value.effectDigest
    );
    for (const [role, endpoint] of [
      ["base", value.base],
      ["result", value.result],
    ] as const) {
      if (!endpoint) continue;
      this.sql.exec(
        `INSERT INTO gad_change_coordinates
         (change_id, role, repository_id, repo_path, file_id, path)
         VALUES (?, ?, ?, ?, ?, ?)`,
        value.changeId,
        role,
        endpoint["repositoryId"] ?? null,
        endpoint["repoPath"] ?? null,
        endpoint["fileId"] ?? null,
        endpoint["path"] ?? null
      );
    }
    const counteractions = value.payload["counteractsChangeIds"];
    if (Array.isArray(counteractions)) {
      counteractions.forEach((counteractedChangeId, ordinal) => {
        if (typeof counteractedChangeId !== "string") return;
        this.sql.exec(
          `INSERT INTO gad_change_counteractions
           (change_id, ordinal, counteracted_change_id) VALUES (?, ?, ?)`,
          value.changeId,
          ordinal,
          counteractedChangeId
        );
      });
    }
  }

  private persistApplication(value: ApplicationRecord): void {
    const [basisKind, basisId] = stateKindAndId(value.basis);
    this.sql.exec(
      `INSERT INTO gad_work_unit_applications
       (application_id, work_unit_id, basis_kind, basis_id,
        result_workspace_fact_root_id, semantic_protocol)
       VALUES (?, ?, ?, ?, ?, ?)`,
      value.applicationId,
      value.workUnitId,
      basisKind,
      basisId,
      value.resultWorkspaceFactRootId,
      value.semanticProtocol
    );
  }

  private persistAppliedChange(value: AppliedChangeRecord): void {
    this.sql.exec(
      `INSERT INTO gad_applied_changes
       (applied_change_id, application_id, change_id, ordinal, applied_base_json, applied_result_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      value.appliedChangeId,
      value.applicationId,
      value.changeId,
      value.ordinal,
      value.appliedBase ? canonicalJson(value.appliedBase) : null,
      value.appliedResult ? canonicalJson(value.appliedResult) : null
    );
    value.resultPredicates.forEach((predicate, ordinal) =>
      this.sql.exec(
        `INSERT INTO gad_applied_change_predicates
         (applied_change_id, ordinal, predicate_json, predicate_digest)
         VALUES (?, ?, ?, ?)`,
        value.appliedChangeId,
        ordinal,
        canonicalJson(predicate),
        compactId("state-predicate", predicate)
      )
    );
  }

  private persistContentEdge(value: ContentEdgeRecord): void {
    this.sql.exec(
      `INSERT INTO gad_content_edges
       (content_edge_id, child_applied_change_id, parent_applied_change_id, relation)
       VALUES (?, ?, ?, ?)`,
      value.contentEdgeId,
      value.childAppliedChangeId,
      value.parentAppliedChangeId,
      value.relation
    );
    this.persistMappings(value.contentEdgeId, value.mappings);
  }

  private persistDecision(value: IntegrationDecisionRecord): void {
    const [targetKind, targetId] = stateKindAndId(value.targetState);
    this.sql.exec(
      `INSERT INTO gad_integration_decisions
       (decision_id, kind, target_state_kind, target_state_id,
        source_event_id, work_unit_id, rationale, evidence_predicates_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      value.decisionId,
      value.kind,
      targetKind,
      targetId,
      value.sourceEventId,
      value.workUnitId,
      value.rationale,
      value.evidencePredicates.length ? canonicalJson(value.evidencePredicates) : null,
      value.createdAt
    );
    value.sourceChangeIds.forEach((changeId) =>
      this.sql.exec(
        `INSERT INTO gad_decision_source_changes (decision_id, change_id) VALUES (?, ?)`,
        value.decisionId,
        changeId
      )
    );
  }

  private persistMappings(contentEdgeId: string, mappings: readonly ContentMapping[]): void {
    mappings.forEach((mapping, ordinal) => {
      const row = encodeContentMappingRow(mapping);
      this.sql.exec(
        `INSERT INTO gad_content_edge_mappings
         (content_edge_id, ordinal, child_content_hash, coordinate_kind, child_start, child_end,
          parent_content_hash, parent_start, parent_end, digest)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        contentEdgeId,
        ordinal,
        ...contentMappingRowValues(row)
      );
    });
  }

  private effectFromRow(row: Row): SemanticEffect {
    return {
      effectId: text(row, "effect_id"),
      scopeKind: text(row, "scope_kind") as SemanticEffect["scopeKind"],
      scopeId: text(row, "scope_id"),
      commandId: text(row, "command_id"),
      kind: text(row, "kind") as SemanticEffect["kind"],
      payload: parse<Row>(row["payload_json"]),
      payloadDigest: text(row, "payload_digest"),
      status: text(row, "status") as SemanticEffect["status"],
      receipt: row["receipt_json"] == null ? null : parse<Row>(row["receipt_json"]),
      createdAt: text(row, "created_at"),
    };
  }

  private applyPublicationReceipt(effect: SemanticEffect, receipt: Row): void {
    const keys = Object.keys(receipt).sort(compareUtf16CodeUnits);
    const appliedAt = receipt["appliedAt"];
    let canonicalAppliedAt = false;
    if (typeof appliedAt === "string" && appliedAt.length > 0) {
      try {
        canonicalAppliedAt = new Date(appliedAt).toISOString() === appliedAt;
      } catch {
        canonicalAppliedAt = false;
      }
    }
    if (
      keys.length !== 2 ||
      keys[0] !== "applied" ||
      keys[1] !== "appliedAt" ||
      receipt["applied"] !== true ||
      !canonicalAppliedAt
    ) {
      throw internalSemanticIntegrityFailure("EffectMismatch", "Publication receipt is not exact", {
        effectId: effect.effectId,
        contract: "publication-receipt",
      });
    }
    const previousEventId = String(effect.payload["previousEventId"] ?? "");
    const publishedEventId = String(effect.payload["publishedEventId"] ?? "");
    if (!previousEventId || !publishedEventId || !this.event(publishedEventId)) {
      throw new SemanticVcsError("IntegrityFailure", "Publication effect names invalid events");
    }
    this.sql.exec(
      `UPDATE vcs_workspace_heads SET event_id = ?, updated_at = ?
        WHERE head = 'main' AND event_id = ?`,
      publishedEventId,
      this.now(),
      previousEventId
    );
    if (Number((this.sql.exec(`SELECT changes() AS n`).toArray()[0] as Row)["n"]) !== 1) {
      throw new SemanticVcsError(
        "RevisionChanged",
        "Protected main changed before publication ack"
      );
    }
  }
}
