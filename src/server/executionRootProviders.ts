import type { BuildResult } from "./buildV2/buildStore.js";
import { canonicalJson } from "@vibestudio/content-addressing";
import {
  verifyExecutionArtifactRef,
  type ExecutionArtifactRefV1,
  type ExecutionRoot,
  type ExecutionRootProvider,
  type ExecutionOwnerKind,
  type ExecutionRootReason,
} from "@vibestudio/shared/execution/retention";

export const REQUIRED_EXECUTION_ROOT_PROVIDER_IDS = [
  "runtime-entity",
  "panel-history",
  "app-generation",
  "terminal-app",
  "runtime-image",
  "extension-generation",
  "eval-run",
  "development-run",
  "product-seed",
] as const;

export interface ExecutionRootSnapshot {
  readonly epoch: number;
  readonly complete: boolean;
  readonly roots: readonly ExecutionRoot[];
  readonly providerFailures: readonly { provider: string; error: string }[];
}

export function executionArtifactRefFromBuild(
  workspaceId: string,
  build: BuildResult
): ExecutionArtifactRefV1 {
  const identity = build.metadata.execution;
  if (!identity || !build.sourceStateHash || !build.metadata.sourcePath) {
    throw new Error(`Build ${build.buildKey} has no reconstructible execution identity`);
  }
  if (!build.metadata.sourceState) {
    throw new Error(`Build ${build.buildKey} has no exact source identity`);
  }
  if (
    build.buildKey !== build.metadata.buildKey ||
    build.buildKey !== identity.buildKey ||
    build.sourceStateHash !== build.metadata.sourceStateHash
  ) {
    throw new Error(`Build ${build.buildKey} has inconsistent immutable identity`);
  }
  const verified = verifyExecutionArtifactRef(identity);
  if (
    verified.sourceState.kind !== "workspace" ||
    verified.sourceState.workspaceId !== workspaceId ||
    canonicalJson(verified.sourceState.state) !== canonicalJson(build.metadata.sourceState)
  ) {
    throw new Error(`Build ${build.buildKey} has inconsistent execution source identity`);
  }
  return verified;
}

export class ExecutionRootProviderRegistry {
  private readonly providers = new Map<string, ExecutionRootProvider>();

  register(provider: ExecutionRootProvider): void {
    if (!provider.id) throw new Error("Execution root provider id is required");
    if (this.providers.has(provider.id)) {
      throw new Error(`Execution root provider already registered: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
  }

  list(): readonly ExecutionRootProvider[] {
    return [...this.providers.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  assertCompleteCensus(): void {
    const missing = REQUIRED_EXECUTION_ROOT_PROVIDER_IDS.filter((id) => !this.providers.has(id));
    if (missing.length > 0) {
      throw new Error(`Missing mandatory execution root provider(s): ${missing.join(", ")}`);
    }
  }

  async snapshot(epoch: number): Promise<ExecutionRootSnapshot> {
    const roots: ExecutionRoot[] = [];
    const providerFailures: Array<{ provider: string; error: string }> = [];
    for (const provider of this.list()) {
      try {
        const provided = await provider.snapshotRoots(epoch);
        for (const root of provided) {
          if (!root.ownerId) throw new Error("root ownerId is required");
          roots.push({ ...root, artifact: verifyExecutionArtifactRef(root.artifact) });
        }
      } catch (error) {
        providerFailures.push({
          provider: provider.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      epoch,
      complete: providerFailures.length === 0,
      roots,
      providerFailures,
    };
  }
}

/** Mandatory composition slot for services whose durable store starts later. */
export class DelegatingExecutionRootProvider implements ExecutionRootProvider {
  readonly mandatory = true;
  private delegate: ExecutionRootProvider | null = null;

  constructor(readonly id: string) {}

  bind(delegate: ExecutionRootProvider): void {
    if (delegate.id !== this.id) {
      throw new Error(`Execution root provider slot ${this.id} cannot bind ${delegate.id}`);
    }
    if (this.delegate) throw new Error(`Execution root provider slot already bound: ${this.id}`);
    this.delegate = delegate;
  }

  snapshotRoots(epoch: number): Promise<readonly ExecutionRoot[]> {
    if (!this.delegate) {
      throw new Error(`Execution root provider ${this.id} is not initialized`);
    }
    return this.delegate.snapshotRoots(epoch);
  }
}

export function buildKeyRootProvider(input: {
  id: string;
  owner: ExecutionOwnerKind;
  mandatory?: boolean;
  buildKeys(): Iterable<{
    ownerId: string;
    buildKey: string;
    reason: ExecutionRootReason;
    /**
     * Optional discriminator for artifacts that share a bundle build key.
     * Product-sealed internal DO classes are one such family: the bytes are
     * shared while their authority-bound execution identities differ.
     */
    executionDigest?: string;
  }>;
  resolve(candidate: {
    ownerId: string;
    buildKey: string;
    reason: ExecutionRootReason;
    executionDigest?: string;
  }): ExecutionArtifactRefV1 | null;
}): ExecutionRootProvider {
  return {
    id: input.id,
    mandatory: input.mandatory ?? true,
    async snapshotRoots() {
      const roots: ExecutionRoot[] = [];
      for (const candidate of input.buildKeys()) {
        const artifact = input.resolve(candidate);
        if (!artifact) {
          throw new Error(
            `${candidate.ownerId} references missing execution artifact ${candidate.buildKey}`
          );
        }
        roots.push({
          owner: input.owner,
          ownerId: candidate.ownerId,
          reason: candidate.reason,
          artifact,
        });
      }
      return roots;
    },
  };
}
