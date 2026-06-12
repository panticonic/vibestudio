/**
 * Spectrolite panel state — the single source of truth rendered by the UI.
 *
 * Controllers (`session`, `vault`, `editor`, `git`) own all the imperative
 * machinery and are the only writers. Components read via `useAppState`.
 */

import type { PubSubClient } from "@workspace/pubsub";
import type { ChatParticipantMetadata } from "@workspace/agentic-core";
import type { AvailableAgent, InstalledAgentRecord } from "../bootstrap";
import type { FileBufferMap } from "../state/fileBuffer";

export interface RosterAgent {
  handle: string;
  participantId?: string;
  status: "live" | "pending";
}

export type AgentVaultNotice =
  | { state: "current"; repoRoot: string; handles: string[]; at: number }
  | { state: "pending"; repoRoot: string; handles: string[] }
  | { state: "failed"; repoRoot: string; handles: string[]; error: string };

export type MentionDeliveryNotice =
  | { state: "sent"; path: string; handles: string[]; at: number }
  | { state: "failed"; path: string; handles: string[]; error: string };

export interface ChannelMessage {
  id: string;
  senderId: string;
  senderHandle?: string;
  senderName?: string;
  senderType?: string;
  content: string;
  ts: number;
}

export interface BranchEntry {
  name: string;
  current: boolean;
}

export interface SaveError {
  path: string;
  message: string;
  at: number;
}

export type GitOperation = "flushing" | "status" | "committing" | "checkout";

export interface SpectroliteState {
  // ---- session / channel ----
  contextId: string | null;
  channelName: string | null;
  client: PubSubClient<ChatParticipantMetadata> | null;
  installedAgents: InstalledAgentRecord[];
  availableAgents: AvailableAgent[];
  roster: RosterAgent[];
  /** Handles optimistically hidden while a remove call is in flight. */
  removedHandles: ReadonlyArray<string>;

  // ---- vault ----
  repoRoot: string | null;
  paths: string[];
  pathsLoading: boolean;
  /** False until the first path scan for the current vault settles. */
  pathsLoaded: boolean;

  // ---- editor ----
  activePath: string | null;
  recentPaths: string[];
  buffers: FileBufferMap;
  lastFlushedAt: Record<string, number>;
  /** Frontmatter-declared dependencies of the active doc (feeds inline JSX + eval imports). */
  activeDeps: Record<string, string>;
  saveErrors: Record<string, SaveError>;

  // ---- git ----
  gitBranch: string | null;
  gitDirty: string[];
  gitStatusError: string | null;
  gitOperation: GitOperation | null;
  branches: BranchEntry[];
  branchesLoading: boolean;
  branchError: string | null;
  checkoutBusy: boolean;

  // ---- notices / channel UI ----
  agentVaultNotice: AgentVaultNotice | null;
  mentionDeliveryNotice: MentionDeliveryNotice | null;
  messages: ChannelMessage[];
  commitMessage: string;
  /** Bumped to programmatically open the channel dock (e.g. from a toast). */
  dockOpenSignal: number;
}

export function initialState(args: {
  contextId: string | null;
  channelName: string | null;
  repoRoot: string | null;
  openPath: string | null;
  installedAgents: InstalledAgentRecord[];
}): SpectroliteState {
  return {
    contextId: args.contextId,
    channelName: args.channelName,
    client: null,
    installedAgents: args.installedAgents,
    availableAgents: [],
    roster: [],
    removedHandles: [],

    repoRoot: args.repoRoot,
    paths: [],
    pathsLoading: false,
    pathsLoaded: false,

    activePath: args.openPath,
    recentPaths: args.openPath ? [args.openPath] : [],
    buffers: {},
    lastFlushedAt: {},
    activeDeps: {},
    saveErrors: {},

    gitBranch: null,
    gitDirty: [],
    gitStatusError: null,
    gitOperation: null,
    branches: [],
    branchesLoading: false,
    branchError: null,
    checkoutBusy: false,

    agentVaultNotice: null,
    mentionDeliveryNotice: null,
    messages: [],
    commitMessage: "",
    dockOpenSignal: 0,
  };
}

/** Roster minus optimistically-removed handles. */
export function visibleRoster(state: SpectroliteState): RosterAgent[] {
  if (state.removedHandles.length === 0) return state.roster;
  return state.roster.filter((agent) => !state.removedHandles.includes(agent.handle));
}
