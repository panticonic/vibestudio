import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { parseConnectLink } from "@vibestudio/iroh-transport";
import type { CliDeviceIdentity } from "./credentialStore.js";
import { loadCliIdentity, saveCliCredentials } from "./credentialStore.js";
import { pairLocalCliFromDevice, type LocalCliPairingSponsor } from "./localPairing.js";
import { pairRemoteServer, selectRemoteWorkspace, type DeviceCredential } from "./remoteClient.js";
import { RpcClient } from "./rpcClient.js";

type Invitation =
  | { kind: "iroh"; link: string; label?: string }
  | { kind: "local-device"; sponsor: LocalCliPairingSponsor; label?: string };

export type RemoteAccessAssignment = {
  credentialFile: string;
  serverId: string;
  workspaceId: string;
  /** Required to resume an Iroh account that has not routed to a workspace. */
  controlEndpointId?: string;
  invitation?: Invitation;
  signal?: AbortSignal;
};

type ProfileState = "unpaired" | "account" | "workspace" | "foreign" | "unusable";

function privateFingerprint(path: string) {
  try {
    if (!lstatSync(path).isFile()) throw new Error("The assigned profile is not a regular file");
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Bind one host-authorized profile and exact workspace route to the shared
 * Natlang program. The caller retains ownership of invitation material and
 * credential storage. The returned methods accept only receipts minted in
 * this run. No invitation, credential, endpoint secret or raw error crosses
 * into the model-facing return values.
 */
export function bindRemoteWorkspaceAccess(assignment: RemoteAccessAssignment) {
  const { credentialFile, serverId, workspaceId, controlEndpointId, invitation, signal } =
    assignment;
  const operationId = randomUUID();
  const id = (step: string) => `${operationId}:${step}`;
  if (invitation?.kind === "local-device" && invitation.sponsor.serverId !== serverId)
    throw new Error("The assigned pairing sponsor belongs to a different server");
  if (invitation?.kind === "iroh") {
    const parsed = parseConnectLink(invitation.link);
    if (!controlEndpointId || parsed.kind === "error" || parsed.endpointId !== controlEndpointId)
      throw new Error("The assigned invitation does not identify the selected control endpoint");
  }
  let phase: "start" | "observed" | "paired" | "routed" | "terminal" = "start";
  let profileState: ProfileState = "unusable";
  let profile: CliDeviceIdentity | null = null;
  let selected: DeviceCredential | null = null;
  let fingerprint: string | null = null;

  function readProfile(): ProfileState {
    profile = null;
    try {
      fingerprint = privateFingerprint(credentialFile);
      if (fingerprint === null) return "unpaired";
      const observed = loadCliIdentity(credentialFile);
      if (observed?.kind !== "device") return "unusable";
      fingerprint = privateFingerprint(credentialFile);
      if (
        ("serverId" in observed && observed.serverId !== serverId) ||
        (observed.transport === "iroh" &&
          controlEndpointId !== undefined &&
          observed.controlPairing.endpointId !== controlEndpointId) ||
        (observed.phase === "account" && !controlEndpointId)
      )
        return "foreign";
      profile = observed;
      return observed.phase;
    } catch {
      return "unusable";
    }
  }

  function claim(receipt: string, expected: string) {
    signal?.throwIfAborted();
    if (receipt !== expected)
      throw new Error("The remote workflow receipt belongs to another attempt");
    if (privateFingerprint(credentialFile) !== fingerprint)
      throw new Error("The assigned profile changed after observation");
    phase = "terminal";
  }

  const services = {
    remoteAccessRead: {
      async observe(requestId: string) {
        signal?.throwIfAborted();
        if (phase !== "start" || requestId !== operationId)
          throw new Error("Read the assigned remote profile once");
        profileState = readProfile();
        phase = "observed";
        return { receipt: id("profile"), state: profileState, inviteAssigned: Boolean(invitation) };
      },
    },
    remoteAccessPair: {
      async pair(profileReceipt: string) {
        if (phase !== "observed" || profileState !== "unpaired" || !invitation)
          throw new Error("Pairing requires the assigned invite and an unpaired observed profile");
        claim(profileReceipt, id("profile"));
        const receipt = id("pair");
        try {
          if (invitation.kind === "iroh") {
            await pairRemoteServer({
              link: invitation.link,
              label: invitation.label,
              credentialFile,
              signal,
            });
          } else {
            const outcome = await pairLocalCliFromDevice(invitation.sponsor, {
              label: invitation.label,
              credentialFile,
              signal,
            });
            if (outcome.status !== "paired") return { receipt, state: "failed" as const };
          }
          const state = readProfile();
          if (state === "workspace" || state === "account") {
            phase = "paired";
            return { receipt, state: "paired" as const };
          }
        } catch {
          signal?.throwIfAborted();
        }
        return { receipt, state: "failed" as const };
      },
    },
    remoteAccessRoute: {
      async select(priorReceipt: string) {
        if ((phase !== "observed" && phase !== "paired") || !profile)
          throw new Error("Routing requires the assigned paired profile");
        claim(priorReceipt, id(phase === "paired" ? "pair" : "profile"));
        const receipt = id("route");
        try {
          const routed = await selectRemoteWorkspace(profile, { workspaceId }, { signal });
          if (routed.serverId === serverId && routed.workspaceId === workspaceId) {
            selected = routed;
            phase = "routed";
            return { receipt, state: "routed" as const };
          }
        } catch {
          signal?.throwIfAborted();
        }
        return { receipt, state: "failed" as const };
      },
    },
    remoteAccessVerify: {
      async verify(routeReceipt: string) {
        if (phase !== "routed" || !selected)
          throw new Error("Child verification requires the assigned authenticated route");
        claim(routeReceipt, id("route"));
        const receipt = id("child");
        let info: Record<string, unknown>;
        try {
          const rpc = new RpcClient(selected, { signal });
          try {
            info = await rpc.mainCall("auth.getConnectionInfo", []);
          } finally {
            await rpc.close();
          }
        } catch {
          signal?.throwIfAborted();
          return { receipt, state: "unreachable" as const, workspaceId: null };
        }
        if (info["serverId"] !== serverId || info["workspaceId"] !== workspaceId)
          return { receipt, state: "identity-mismatch" as const, workspaceId: null };
        if (privateFingerprint(credentialFile) !== fingerprint)
          throw new Error("The assigned profile changed during route verification");
        saveCliCredentials(selected, credentialFile);
        return { receipt, state: "verified" as const, workspaceId };
      },
    },
  };
  return { request: { operationId }, services };
}
