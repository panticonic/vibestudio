import type { ProtectedPublicationEvent } from "@vibestudio/shared/protectedPublicationEvents";
import type { ExecutionSourceStateRef } from "@vibestudio/shared/execution/retention";
import type { BuildSourceProvider } from "./buildSource.js";
import type { GraphNode } from "./packageGraph.js";
import type { BuildRecord, WorkspaceStateSource } from "./stateTrigger.js";

/** One immutable content-store publication breaks the source-provider bootstrap
 * fixed point. Creation supplies the acquired template tree; restart supplies
 * persisted protected main. Neither operation infers source from a projection. */
export class BootstrapWorkspaceSource implements WorkspaceStateSource, BuildSourceProvider {
  constructor(
    readonly workspaceId: string,
    private readonly source: WorkspaceStateSource & BuildSourceProvider,
    readonly stateHash: string,
    private readonly executionState: ExecutionSourceStateRef
  ) {
    if (!/^state:[0-9a-f]{64}$/u.test(stateHash)) {
      throw new Error(`Invalid bootstrap content coordinate: ${stateHash}`);
    }
  }

  private coordinate(ref: string): string {
    if (ref !== "main" && ref !== this.stateHash) {
      throw new Error(`Bootstrap publication ${this.stateHash} cannot resolve ${ref}`);
    }
    return this.stateHash;
  }

  async ensureFresh(): Promise<{ stateHash: string }> {
    return { stateHash: this.stateHash };
  }

  unitHashes(stateHash: string, paths: string[]) {
    return this.source.unitHashes(this.coordinate(stateHash), paths);
  }

  async resolveContextState(_contextId: string): Promise<string> {
    throw new Error("Bootstrap publication has no semantic contexts");
  }

  readFile(stateHash: string, file: string) {
    return this.source.readFile(this.coordinate(stateHash), file);
  }

  executionStateForContent(stateHash: string): ExecutionSourceStateRef | null {
    return stateHash === this.stateHash ? this.executionState : null;
  }

  discoverGraph(stateHash: string) {
    return this.source.discoverGraph(this.coordinate(stateHash));
  }

  materializeForBuild(units: GraphNode[], ref: string, workspaceRoot: string) {
    return this.source.materializeForBuild(units, this.coordinate(ref), workspaceRoot);
  }

  onProtectedPublication(_cb: (event: ProtectedPublicationEvent) => void): () => void {
    return () => {};
  }

  async recordBuild(_record: BuildRecord): Promise<void> {}
}
