/** Exact command protocol for materializing one semantic workspace state. */
import {
  canonicalJson,
  compareUtf16CodeUnits,
  sha256HexSyncText,
} from "@vibestudio/content-addressing";

export type WorkspaceStateRef =
  | { kind: "event"; eventId: string }
  | { kind: "application"; applicationId: string };

export interface WorkspaceMaterializationFile {
  path: string;
  contentHash: string;
  mode: number;
}

export interface WorkspaceMaterializationChange {
  path: string;
  expected: { contentHash: string; mode: number } | null;
  result: { contentHash: string; mode: number } | null;
}

export type WorkspaceMaterializationSource =
  | {
      /** The host has already derived and stored this immutable manifest. */
      kind: "content-root";
      contentRoot: string;
    }
  | {
      /** Rebuild one new immutable manifest from a known root and exact path changes. */
      kind: "delta";
      basisContentRoot: string;
      changes: WorkspaceMaterializationChange[];
    }
  | {
      /** One-time admission for a repository with no materialized basis. */
      kind: "snapshot";
      files: WorkspaceMaterializationFile[];
    };

export type WorkspaceMaterializationRepository =
  | {
      repositoryId: string;
      repoPath: string;
      presence: "present";
      /** Authenticated semantic identity bound to the host-derived root by the receipt. */
      fileManifestId: string;
      source: WorkspaceMaterializationSource;
    }
  | {
      repositoryId: string;
      repoPath: string;
      presence: "deleted";
    };

export interface WorkspaceMaterializationBlob {
  contentHash: string;
  base64: string;
}

export interface ContextMaterializationCommand {
  materializationId: string;
  contextId: string;
  commandId: string;
  /**
   * `initialize` admits a projection only when no private host state exists.
   * `patch` advances one exact materialized state incrementally.
   * `replace` repairs an observed private state (including observed absence)
   * with one self-contained projection.
   */
  mode: "initialize" | "patch" | "replace";
  previousState: WorkspaceStateRef | null;
  targetState: WorkspaceStateRef;
  repositories: WorkspaceMaterializationRepository[];
  /** Newly authored content needed by the host CAS for this exact effect. */
  blobs: WorkspaceMaterializationBlob[];
  payloadDigest: string;
}

export interface ContextMaterializationReceipt {
  materializationId: string;
  contextId: string;
  targetState: WorkspaceStateRef;
  repositories: Array<{
    repositoryId: string;
    repoPath: string;
    contentRoot: string;
  }>;
  payloadDigest: string;
}

const PROTOCOL = "vibestudio.vcs.context-materialization.v7";

function digest(domain: string, payload: unknown): string {
  return `${domain}:${sha256HexSyncText(canonicalJson({ domain, protocol: PROTOCOL, payload }))}`;
}

export function contextMaterializationCommand(input: {
  contextId: string;
  commandId: string;
  mode: ContextMaterializationCommand["mode"];
  previousState: WorkspaceStateRef | null;
  targetState: WorkspaceStateRef;
  repositories: readonly WorkspaceMaterializationRepository[];
  blobs: readonly WorkspaceMaterializationBlob[];
}): ContextMaterializationCommand {
  if (
    !(["initialize", "patch", "replace"] as const).includes(input.mode) ||
    (input.mode === "initialize" && input.previousState !== null) ||
    (input.mode === "patch" && input.previousState === null)
  ) {
    throw new Error(`${input.mode} materialization has an invalid basis`);
  }
  const mode = input.mode;
  const repositories = [...input.repositories]
    .map(
      (repository): WorkspaceMaterializationRepository =>
        repository.presence === "present"
          ? {
              ...repository,
              source:
                repository.source.kind === "snapshot"
                  ? {
                      ...repository.source,
                      files: [...repository.source.files].sort((left, right) =>
                        compareUtf16CodeUnits(left.path, right.path)
                      ),
                    }
                  : repository.source.kind === "delta"
                    ? {
                        ...repository.source,
                        changes: [...repository.source.changes].sort((left, right) =>
                          compareUtf16CodeUnits(left.path, right.path)
                        ),
                      }
                    : { ...repository.source },
            }
          : repository
    )
    .sort((left, right) => compareUtf16CodeUnits(left.repositoryId, right.repositoryId));
  const blobs = [...input.blobs].sort((left, right) =>
    compareUtf16CodeUnits(left.contentHash, right.contentHash)
  );
  const payloadDigest = digest("context-materialization-payload", {
    contextId: input.contextId,
    mode,
    previousState: input.previousState,
    targetState: input.targetState,
    repositories,
    blobs,
  });
  const materializationId = digest("context-materialization", {
    contextId: input.contextId,
    commandId: input.commandId,
    previousState: input.previousState,
    targetState: input.targetState,
    payloadDigest,
  });
  return {
    materializationId,
    contextId: input.contextId,
    commandId: input.commandId,
    mode,
    previousState: input.previousState,
    targetState: input.targetState,
    repositories,
    blobs,
    payloadDigest,
  };
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareUtf16CodeUnits);
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort(compareUtf16CodeUnits)[index])
  );
}

function exactStateRef(value: unknown): WorkspaceStateRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (
    state["kind"] === "event" &&
    exactKeys(state, ["kind", "eventId"]) &&
    typeof state["eventId"] === "string" &&
    state["eventId"].length > 0
  ) {
    return { kind: "event", eventId: state["eventId"] };
  }
  if (
    state["kind"] === "application" &&
    exactKeys(state, ["kind", "applicationId"]) &&
    typeof state["applicationId"] === "string" &&
    state["applicationId"].length > 0
  ) {
    return { kind: "application", applicationId: state["applicationId"] };
  }
  return null;
}

/** Parse one exact host observation. Unknown fields never become durable facts. */
export function normalizeContextMaterializationReceipt(
  command: ContextMaterializationCommand,
  value: unknown
): ContextMaterializationReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  if (
    !exactKeys(receipt, [
      "materializationId",
      "contextId",
      "targetState",
      "repositories",
      "payloadDigest",
    ]) ||
    typeof receipt["materializationId"] !== "string" ||
    typeof receipt["contextId"] !== "string" ||
    typeof receipt["payloadDigest"] !== "string" ||
    !Array.isArray(receipt["repositories"])
  ) {
    return null;
  }
  const targetState = exactStateRef(receipt["targetState"]);
  if (!targetState) return null;
  const expectedPresent = command.repositories
    .filter(
      (
        repository
      ): repository is Extract<WorkspaceMaterializationRepository, { presence: "present" }> =>
        repository.presence === "present"
    )
    .map(({ repositoryId, repoPath }) => ({ repositoryId, repoPath }))
    .sort((left, right) => compareUtf16CodeUnits(left.repositoryId, right.repositoryId));
  const actual = receipt["repositories"].flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const repository = value as Record<string, unknown>;
    if (
      !exactKeys(repository, ["repositoryId", "repoPath", "contentRoot"]) ||
      typeof repository["repositoryId"] !== "string" ||
      typeof repository["repoPath"] !== "string" ||
      typeof repository["contentRoot"] !== "string" ||
      !/^state:[0-9a-f]{64}$/u.test(repository["contentRoot"])
    ) {
      return [];
    }
    return [
      {
        repositoryId: repository["repositoryId"],
        repoPath: repository["repoPath"],
        contentRoot: repository["contentRoot"],
      },
    ];
  });
  if (
    receipt["materializationId"] !== command.materializationId ||
    receipt["contextId"] !== command.contextId ||
    canonicalJson(targetState) !== canonicalJson(command.targetState) ||
    receipt["payloadDigest"] !== command.payloadDigest ||
    actual.length !== receipt["repositories"].length ||
    actual.length !== expectedPresent.length ||
    !actual.every(
      (repository, index) =>
        repository.repositoryId === expectedPresent[index]?.repositoryId &&
        repository.repoPath === expectedPresent[index]?.repoPath
    )
  ) {
    return null;
  }
  return {
    materializationId: receipt["materializationId"],
    contextId: receipt["contextId"],
    targetState,
    repositories: actual,
    payloadDigest: receipt["payloadDigest"],
  };
}

export function contextMaterializationReceiptProves(
  command: ContextMaterializationCommand,
  receipt: unknown
): receipt is ContextMaterializationReceipt {
  return normalizeContextMaterializationReceipt(command, receipt) !== null;
}
