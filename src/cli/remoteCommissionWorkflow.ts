import { bindRemoteDeployment } from "../../scripts/cli/remote-deployment-workflow.mjs";
import { bindRemoteWorkspaceAccess, type RemoteAccessAssignment } from "./remoteAccessWorkflow.js";

type AccessBinding = ReturnType<typeof bindRemoteWorkspaceAccess>;
type Pairing = Pick<RemoteAccessAssignment, "invitation" | "controlEndpointId">;
type VerifiedIdentity = NonNullable<
  Awaited<ReturnType<ReturnType<typeof bindRemoteDeployment>["takeVerifiedIdentity"]>>
>;

/** Keep the deployment target, device profile and optional invitation with the trusted caller. */
export function bindRemoteCommission(
  argv: string[],
  assignment: {
    credentialFile: string;
    pairingFor?: (identity: VerifiedIdentity) => Promise<Pairing>;
  },
  options?: Parameters<typeof bindRemoteDeployment>[1]
) {
  const deployment = bindRemoteDeployment(argv, options);
  const { credentialFile, pairingFor } = assignment;
  let access: AccessBinding | undefined;

  function assignedServices() {
    if (!access) throw new Error("The deployment has not assigned a verified workspace");
    return access.services;
  }

  return {
    request: deployment.request,
    services: {
      ...deployment.services,
      remoteDeploymentHandoff: {
        async open(deploymentReceipt: string) {
          const identity = await deployment.takeVerifiedIdentity(deploymentReceipt);
          if (!identity) return { state: "deployment-changed" as const, operationId: null };
          const { serverId, workspaceId } = identity;
          try {
            const pairing = await pairingFor?.(identity);
            options?.signal?.throwIfAborted();
            access = bindRemoteWorkspaceAccess({
              invitation: pairing?.invitation,
              controlEndpointId: pairing?.controlEndpointId,
              credentialFile,
              serverId,
              workspaceId,
              signal: options?.signal,
            });
          } catch {
            options?.signal?.throwIfAborted();
            throw new Error("The assigned device profile could not be bound to the deployment");
          }
          return { state: "assigned" as const, operationId: access.request.operationId };
        },
      },
      remoteAccessRead: {
        async observe(id: string) {
          return assignedServices().remoteAccessRead.observe(id);
        },
      },
      remoteAccessPair: {
        async pair(receipt: string) {
          return assignedServices().remoteAccessPair.pair(receipt);
        },
      },
      remoteAccessRoute: {
        async select(receipt: string) {
          return assignedServices().remoteAccessRoute.select(receipt);
        },
      },
      remoteAccessVerify: {
        async verify(receipt: string) {
          return assignedServices().remoteAccessVerify.verify(receipt);
        },
      },
    },
  };
}
