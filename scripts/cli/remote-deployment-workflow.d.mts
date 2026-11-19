import type fs from "node:fs";

type DeploymentIdentity = {
  serverId: string;
  bootId: string;
  buildId: string;
  workspaceId: string;
};

type DeploymentObservation =
  | { state: "inactive"; identity: DeploymentIdentity | null }
  | { state: "unverified"; identity: null }
  | { state: "ready"; identity: DeploymentIdentity };

export function inspectDeploymentIdentity(options: {
  fileSystem?: Pick<typeof fs, "lstatSync" | "readFileSync">;
  fetchImpl?: typeof fetch;
  readyFile: string;
  port: number;
  workspace?: string;
  active?: boolean;
}): Promise<DeploymentObservation>;

export function bindRemoteDeployment(
  argv: readonly string[],
  options?: {
    run?: (
      command: string,
      args: string[],
      options?: { capture?: boolean; input?: string; signal?: AbortSignal }
    ) => Promise<string | undefined>;
    signal?: AbortSignal;
  }
): {
  request: { operationId: string };
  takeVerifiedIdentity(receipt: string): Promise<DeploymentIdentity | null>;
  services: {
    remoteDeploymentRead: {
      observe(operationId: string): Promise<{
        receipt: string;
        intent: "deploy" | "update";
        state: DeploymentObservation["state"];
        hasPriorIdentity: boolean;
      }>;
    };
    remoteDeploymentApply: {
      apply(baselineReceipt: string): Promise<{
        receipt: string;
        state: "applied" | "failed" | "baseline-changed";
      }>;
    };
    remoteDeploymentVerify: {
      verify(
        actionReceipt: string
      ): Promise<
        { receipt: string } & (
          | { state: "verified"; identity: DeploymentIdentity }
          | { state: "unready" | "unchanged-boot" | "identity-changed"; identity: null }
        )
      >;
    };
  };
};
