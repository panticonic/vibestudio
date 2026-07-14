import type { Principal } from "./authorization.js";

export interface ChannelPresentation {
  title?: string;
  titleExplicit?: boolean;
  approvalLevel?: number;
  conversationPolicy?: string;
  agentHopLimit?: number;
  policies?: string[];
  [key: string]: unknown;
}

export type ChannelAdmission =
  | { kind: "workspace-members" }
  | { kind: "channel-members" }
  | {
      kind: "principals";
      allow: readonly Principal[];
      /**
       * An admitted entity may be pinned to its exact executable principal.
       * The channel also requires the live agent binding from authorization;
       * caller labels and stable entity ids alone never satisfy this chain.
       */
      entityCodeBindings?: readonly { entity: Principal; code: Principal }[];
    };

export type ChannelPresentationEditors =
  | { kind: "workspace-members" }
  | { kind: "owner" }
  | { kind: "principals"; allow: readonly Principal[] };

export interface ChannelCreation {
  governance: "standard" | "locked";
  contextBinding: { kind: "context"; contextId: string };
  origin: { kind: string; key?: string };
  admission: ChannelAdmission;
  presentationEditors: ChannelPresentationEditors;
  presentation: ChannelPresentation;
}

export interface ChannelStructureRevision {
  id: string;
  channelId: string;
  predecessor: string | null;
  createdBy: Principal;
  createdAt: number;
  reason: "created" | "fork" | "owner-transfer" | "policy-change" | "owner-recovery";
  owner: Principal;
  governance: ChannelCreation["governance"];
  contextBinding: ChannelCreation["contextBinding"];
  origin: ChannelCreation["origin"];
  admission: ChannelAdmission;
  presentationEditors: ChannelPresentationEditors;
}

export interface ChannelRecord {
  channelId: string;
  currentStructureRevision: string;
  structure: ChannelStructureRevision;
  presentation: ChannelPresentation;
  presentationRevision: number;
  deletedAt: number | null;
}
