import {
  vcsCommitInputSchema,
  vcsCommitResultSchema,
  vcsImportSnapshotInputSchema,
  vcsImportSnapshotResultSchema,
} from "@vibestudio/service-schemas/vcs";
import type { RpcCausalParent } from "@vibestudio/rpc";
import type {
  NativeDevelopmentSemanticAdapter,
  NativeDevelopmentSemanticIngress,
} from "./nativeDevelopmentExecutor.js";

export interface NativeDevelopmentSemanticCausalPort {
  semanticCausalCall(
    method: string,
    input: unknown,
    causalParent: RpcCausalParent | null,
    contextIntegrity: {
      class: "internal" | "external";
      externalKeys: readonly string[];
    }
  ): Promise<unknown>;
}

/**
 * Compose native development with the canonical semantic VCS ingress.
 *
 * The base commit carries the verified development invocation's integrity.
 * A checkpoint is always an external observation, so its exact descriptor is
 * added as an external integrity key even when the initiating invocation was
 * otherwise internal.
 */
export function createNativeDevelopmentSemanticAdapter(
  workspaceVcs: NativeDevelopmentSemanticCausalPort
): NativeDevelopmentSemanticAdapter {
  return {
    async commitChildBase(input) {
      if (input.expectedWorkingHead.kind === "event") {
        return input.expectedWorkingHead;
      }
      const request = vcsCommitInputSchema.parse({
        contextId: input.developmentContextId,
        commandId: input.commandId,
        expectedWorkingHead: input.expectedWorkingHead,
        intentSummary: "Commit the inherited working chain for a native development session",
        message: input.message,
      });
      const result = vcsCommitResultSchema.parse(
        await workspaceVcs.semanticCausalCall(
          "vcsCommit",
          request,
          input.ingress.causalParent,
          input.ingress.contextIntegrity
        )
      );
      if (result.contextId !== input.developmentContextId || result.event.kind !== "event") {
        throw coded("EINTEGRITY", "Native development base commit returned the wrong context");
      }
      return result.event;
    },

    async importSnapshot(input) {
      if (input.descriptor.repositoryId !== input.repositoryId) {
        throw coded(
          "EIDENTITYDRIFT",
          "Native checkpoint descriptor does not bind the existing repository identity"
        );
      }
      const expectedUri = `vibestudio-development://session/${encodeURIComponent(
        input.descriptor.source.uri.slice("vibestudio-development://session/".length)
      )}`;
      if (
        !input.descriptor.source.uri.startsWith("vibestudio-development://session/") ||
        expectedUri !== input.descriptor.source.uri
      ) {
        throw coded(
          "EINTEGRITY",
          "Native checkpoint source is not a canonical credential-free development URI"
        );
      }
      const request = vcsImportSnapshotInputSchema.parse({
        contextId: input.developmentContextId,
        commandId: input.commandId,
        expectedWorkingHead: input.expectedWorkingHead,
        intentSummary: "Import one explicit native development checkpoint",
        source: input.descriptor.source,
        repositories: [
          {
            repositoryId: input.repositoryId,
            repoPath: input.descriptor.repoPath,
            files: input.descriptor.files,
          },
        ],
        message: `Native development checkpoint ${input.descriptor.source.snapshotRevision}`,
      });
      const integrity = externalCheckpointIntegrity(
        input.ingress,
        input.descriptor.descriptorDigest
      );
      const result = vcsImportSnapshotResultSchema.parse(
        await workspaceVcs.semanticCausalCall(
          "vcsImportSnapshot",
          request,
          input.ingress.causalParent,
          integrity
        )
      );
      if (
        result.contextId !== input.developmentContextId ||
        result.importedRepositoryIds.length !== 1 ||
        result.importedRepositoryIds[0] !== input.repositoryId ||
        result.externalSnapshot.sourceKind !== "filesystem" ||
        result.externalSnapshot.sourceUri !== input.descriptor.source.uri ||
        result.externalSnapshot.snapshotRevision !== input.descriptor.source.snapshotRevision ||
        result.externalSnapshot.targetRepositoryIds.length !== 1 ||
        result.externalSnapshot.targetRepositoryIds[0] !== input.repositoryId
      ) {
        throw coded(
          "EINTEGRITY",
          "Semantic VCS returned a checkpoint receipt for different source facts"
        );
      }
      return result;
    },
  };
}

function externalCheckpointIntegrity(
  ingress: NativeDevelopmentSemanticIngress,
  descriptorDigest: string
): { class: "external"; externalKeys: readonly string[] } {
  return {
    class: "external",
    externalKeys: [
      ...new Set([
        ...ingress.contextIntegrity.externalKeys,
        `native-development-snapshot:${descriptorDigest}`,
      ]),
    ].sort(),
  };
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
