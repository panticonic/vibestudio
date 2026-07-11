/**
 * Canonical workspace-wide channel invitation contracts.
 *
 * Channel DOs own membership and project invite/remove mutations into the
 * workspace GAD store's generic account notification inbox. Clients consume
 * `channel.invite` notifications without enumerating channel DOs.
 */

export interface ChannelInvite {
  channelId: string;
  /** Bare workspace account id. */
  userId: string;
  /** Canonical channel participant id (`user:<userId>`). */
  memberId: string;
  /** Invite-time display snapshot; live account profiles remain authoritative. */
  handle: string;
  /** Canonical acting participant id, or the verified runtime caller id. */
  addedBy: string;
  addedAt: number;
}

/**
 * A channel-local, monotonically increasing projection revision. GAD retains
 * the last revision even after a membership is deleted, so delayed cross-DO
 * completions cannot resurrect or erase newer state.
 */
export interface ChannelMembershipMutationRevision {
  revision: number;
}

/** Durable channel membership projection stored in the workspace GAD index. */
export type PutChannelMembershipInput = ChannelInvite & ChannelMembershipMutationRevision;

export interface DeleteChannelInviteInput {
  channelId: string;
  userId: string;
}

export type DeleteChannelMembershipInput = DeleteChannelInviteInput &
  ChannelMembershipMutationRevision;

export interface ChannelMembershipCleanupPlan {
  userId: string;
  channelIds: string[];
}
