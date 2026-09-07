import { HubWorkspaceRouteSchema } from "@vibestudio/service-schemas/hubControl";
import type { IrohConnection } from "./connect.js";
import type { StoredShellPairing } from "./storedCredential.js";
import { MobileConnectionAggregateError } from "./connectionPair.js";

export type MobileRecoveryHandler = (kind: "resubscribe" | "cold-recover") => void | Promise<void>;

/** One authenticated account connection; child sessions never change workspace. */
export class MobileWorkspaceAccount {
  private readonly children = new Set<IrohConnection>();
  private readonly opening = new Set<Promise<IrohConnection>>();
  private closing: Promise<void> | null = null;

  constructor(
    readonly control: IrohConnection,
    private readonly connectWorkspace: (
      reach: StoredShellPairing,
      onRecovery?: MobileRecoveryHandler
    ) => Promise<IrohConnection>
  ) {}

  openWorkspace(workspaceId: string, onRecovery?: MobileRecoveryHandler): Promise<IrohConnection> {
    if (this.closing) return Promise.reject(new Error("The mobile account is closed"));
    if (!workspaceId.trim() || workspaceId !== workspaceId.trim()) {
      return Promise.reject(new Error("Choose a valid workspace"));
    }
    const opening = this.open(workspaceId, onRecovery);
    this.opening.add(opening);
    void opening.then(
      () => this.opening.delete(opening),
      () => this.opening.delete(opening)
    );
    return opening;
  }

  private async open(
    workspaceId: string,
    onRecovery?: MobileRecoveryHandler
  ): Promise<IrohConnection> {
    const route = HubWorkspaceRouteSchema.parse(
      await this.control.rpc.call("main", "hubControl.routeWorkspace", [{ workspaceId }])
    );
    if (route.workspaceId !== workspaceId) {
      throw new Error("The server routed a different workspace than requested");
    }
    if (this.closing) throw new Error("The mobile account closed while routing the workspace");
    const child = await this.connectWorkspace(route.workspaceReach, onRecovery);
    let closing: Promise<void> | null = null;
    const session: IrohConnection = {
      ...child,
      serverId: route.serverId,
      hubControlRpc: this.control.rpc,
      close: () => {
        closing ??= child.close().finally(() => this.children.delete(session));
        return closing;
      },
    };
    this.children.add(session);
    // The account owns every successful dial, including ones that finish after
    // close begins. Its cleanup waits for openings, then closes these children.
    if (this.closing) {
      throw new Error("The mobile account closed while connecting the workspace");
    }
    return session;
  }

  close(): Promise<void> {
    this.closing ??= Promise.resolve().then(async () => {
      await Promise.allSettled([...this.opening]);
      const results = await Promise.allSettled([...this.children].map((child) => child.close()));
      // Keep the account endpoint alive until every child releases its reference.
      results.push(...(await Promise.allSettled([this.control.close()])));
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (failures.length) {
        throw new MobileConnectionAggregateError(
          failures,
          "Mobile account connections failed to close"
        );
      }
    });
    return this.closing;
  }
}
