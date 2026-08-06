/** Electron-owned persistence and connection actions for a paired WebRTC device. */

import { z } from "zod";
import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";

const readAccess: MethodAccessDescriptor = { sensitivity: "read" };
const writeAccess: MethodAccessDescriptor = { sensitivity: "write" };
const adminAccess: MethodAccessDescriptor = { sensitivity: "admin" };
const destructiveAccess: MethodAccessDescriptor = { sensitivity: "destructive" };

export const RemotePairArgsSchema = z
  .object({
    link: z
      .string()
      .min(1)
      .describe(
        "A vibestudio://connect or https://vibestudio.app/pair link containing WebRTC pairing material."
      ),
    label: z.string().trim().min(1).max(128).optional(),
  })
  .strict();
export type RemotePairArgs = z.infer<typeof RemotePairArgsSchema>;

export const RemoteCredCurrentSchema = z.object({
  connected: z.boolean(),
  configured: z.boolean(),
  isActive: z.boolean(),
  // A remote is reached over a paired WebRTC pipe ("device") or not configured
  // ("none"). The old cleartext "admin-token"/"hybrid" URL remotes were deleted
  // (§8c), along with the URL, token-preview, and nested-hub fields they carried.
  bootstrap: z.enum(["device", "none"]),
  deviceId: z.string().optional(),
  workspaceName: z.string().optional(),
});
export type RemoteCredCurrent = z.infer<typeof RemoteCredCurrentSchema>;

const PairResultSchema = z.object({
  ok: z.boolean(),
  error: z.literal("invalid-link").optional(),
  message: z.string().optional(),
});

const OkResultSchema = z.object({ ok: z.boolean() });

export const remoteCredMethods = defineServiceMethods({
  getCurrent: {
    capability: "remote-client.read",
    tier: {
      tier: "open",
      session: "family",
      residency: "secret",
      family: "remoteCred.read",
      rationale:
        "Open bias: returns secret-free connection status to authorized chrome; no C1-C4 or G1-G5 rule applies",
    },
    presentation: {
      title: "View the current remote connection",
      action: "view the current remote connection",
      description: "Allows {requesterKind} to view the current remote connection.",
      group: "credentials",
      authorityCategory: {
        domain: "people",
        verb: "see",
      },
    },
    description:
      "Report the locally stored remote-server credential: whether it's configured/active, the bootstrap kind (device|none), the paired device id, and the workspace name.",
    args: z.tuple([]),
    returns: RemoteCredCurrentSchema,
    access: readAccess,
  },
  pair: {
    capability: "remote-client.connect",
    tier: {
      tier: "gated",
      session: "family",
      residency: "secret",
      family: "remoteCred.control",
      rationale: "G2: credential mediation; §2 default {code, session} family",
    },
    presentation: {
      title: "Pair a remote connection",
      action: "pair a remote connection",
      description: "Allows {requesterKind} to pair a remote connection.",
      group: "credentials",
      authorityCategory: {
        domain: "people",
        verb: "manage",
      },
    },
    description: "Validate a WebRTC pairing link and relaunch into the one-time pairing session.",
    args: z.tuple([RemotePairArgsSchema]),
    returns: PairResultSchema,
    access: adminAccess,
  },
  reconnectNow: {
    capability: "remote-client.connect",
    tier: {
      tier: "gated",
      session: "family",
      residency: "secret",
      family: "remoteCred.control",
      rationale: "G2: credential mediation; §2 default {code, session} family",
    },
    presentation: {
      title: "Reconnect now",
      action: "reconnect now",
      description: "Allows {requesterKind} to reconnect now.",
      group: "credentials",
      authorityCategory: {
        domain: "people",
        verb: "manage",
      },
    },
    description: "Probe the current remote pipe immediately so a dead connection reconnects now.",
    args: z.tuple([]),
    returns: z.void(),
    access: writeAccess,
  },
  clear: {
    capability: "remote-client.clear",
    tier: {
      tier: "critical",
      session: "family",
      residency: "secret",
      family: "remoteCred.control",
      rationale:
        "C1: destroys credential or client secret material; §2 default {code, session} family",
    },
    presentation: {
      title: "Clear a remote connection",
      action: "clear a remote connection",
      description: "Allows {requesterKind} to clear a remote connection.",
      group: "credentials",
      authorityCategory: {
        domain: "people",
        verb: "manage",
      },
    },
    description: "Delete this desktop's stored WebRTC device pairing.",
    args: z.tuple([]),
    returns: OkResultSchema,
    access: destructiveAccess,
  },
  relaunch: {
    capability: "remote-client.connect",
    tier: {
      tier: "gated",
      session: "family",
      residency: "secret",
      family: "remoteCred.control",
      rationale: "G2: credential mediation; §2 default {code, session} family",
    },
    presentation: {
      title: "Restart the remote connection",
      action: "restart the remote connection",
      description: "Allows {requesterKind} to restart the remote connection.",
      group: "credentials",
      authorityCategory: {
        domain: "people",
        verb: "manage",
      },
    },
    description: "Relaunch Electron so a connection change takes effect.",
    args: z.tuple([]),
    returns: OkResultSchema,
    access: adminAccess,
  },
});
