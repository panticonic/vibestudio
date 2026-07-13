import type { ChatMessage } from "@workspace/agentic-core";
import type { ChannelViewState, ProjectedTurn } from "@workspace/agentic-protocol";

export interface HeadlessTurnSnapshot {
  messages: readonly ChatMessage[];
  channelView: ChannelViewState;
}

export type HeadlessTurnTerminalOutcome =
  | { kind: "succeeded"; message: ChatMessage }
  | { kind: "failed"; reason: string };

export interface HeadlessTurnObservation {
  /** The durable agent turn selected for this observation, when one exists. */
  turnId?: string;
  /** Latest newly completed, user-visible agent response. */
  response?: ChatMessage;
  /** Present only once durable state proves the observed turn is terminal. */
  terminal?: HeadlessTurnTerminalOutcome;
}

function isAgentTurn(turn: ProjectedTurn): boolean {
  return turn.actor.kind === "agent";
}

function isActiveTurn(turn: ProjectedTurn): boolean {
  return turn.status === "open" || turn.status === "waiting";
}

function turnOrder(turn: ProjectedTurn): number {
  return turn.lastSeq ?? (Date.parse(turn.updatedAt ?? turn.openedAt) || 0);
}

function latestTurn(turns: readonly ProjectedTurn[]): ProjectedTurn | undefined {
  return [...turns].sort((left, right) => turnOrder(right) - turnOrder(left))[0];
}

function messageRevision(message: ChatMessage): string {
  return JSON.stringify([
    message.complete === true,
    message.pending === true,
    message.kind ?? null,
    message.contentType ?? null,
    message.error ?? null,
    message.content,
    message.revision ?? null,
    message.editedAt ?? null,
  ]);
}

function failureReason(message: ChatMessage, clientId: string): string | null {
  if (message.senderId === clientId || !message.complete || message.pending) return null;
  if (
    message.contentType === "invocation" ||
    message.contentType === "thinking" ||
    message.contentType === "typing"
  ) {
    return null;
  }
  return typeof message.error === "string" && message.error.trim().length > 0
    ? message.error.trim()
    : null;
}

function isResponse(message: ChatMessage, clientId: string): boolean {
  return (
    message.senderId !== clientId &&
    message.kind === "message" &&
    message.complete === true &&
    !message.pending &&
    !message.error &&
    message.contentType !== "thinking" &&
    message.contentType !== "typing" &&
    message.contentType !== "invocation"
  );
}

function messageTurnId(message: ChatMessage, channelView: ChannelViewState): string | undefined {
  const projectedId = message.id.startsWith("diagnostic:")
    ? message.id.slice("diagnostic:".length)
    : message.id;
  return channelView.messages[projectedId]?.turnId;
}

function closedTurnIntegrityFailure(
  turnId: string,
  channelView: ChannelViewState
): string | undefined {
  const message = Object.values(channelView.messages).find(
    (candidate) =>
      candidate.turnId === turnId &&
      candidate.status !== "completed" &&
      candidate.status !== "failed"
  );
  if (message) {
    return `Agent turn closed with nonterminal message ${message.messageId} (${message.status})`;
  }
  const invocation = Object.values(channelView.invocations).find(
    (candidate) =>
      candidate.turnId === turnId &&
      !candidate.subagent &&
      candidate.status !== "completed" &&
      candidate.status !== "failed" &&
      candidate.status !== "cancelled" &&
      candidate.status !== "abandoned"
  );
  return invocation
    ? `Agent turn closed with nonterminal invocation ${invocation.invocationId} (${invocation.status})`
    : undefined;
}

/**
 * Revision-aware state machine for one headless agent turn.
 *
 * A model attempt may fail while its durable agent turn remains active (for
 * example while a fallback model continues). Such a failure is retained as a
 * pending outcome and becomes terminal only when the turn closes without a
 * later successful response. The observer keys transcript entries by id and
 * revision, so an in-place streaming -> completed transition cannot be missed.
 */
export class HeadlessTurnObserver {
  private readonly seenMessageRevisions = new Map<string, string>();
  private readonly baselineTurnIds = new Set<string>();
  private targetTurnId: string | undefined;
  private latestResponse: ChatMessage | undefined;
  private pendingFailure: string | undefined;

  constructor(
    private readonly clientId: string,
    baseline: HeadlessTurnSnapshot
  ) {
    for (const message of baseline.messages) {
      this.seenMessageRevisions.set(message.id, messageRevision(message));
    }
    const baselineTurns = Object.values(baseline.channelView.turns);
    for (const turn of baselineTurns) this.baselineTurnIds.add(turn.turnId);
    this.targetTurnId = latestTurn(
      baselineTurns.filter((turn) => isAgentTurn(turn) && isActiveTurn(turn))
    )?.turnId;

    // If observation begins during an already-active failed attempt, preserve
    // that failure so closing the turn cannot leave the waiter hanging. Existing
    // successful messages remain baseline history and are never returned.
    if (this.targetTurnId) {
      for (const message of baseline.messages) {
        if (messageTurnId(message, baseline.channelView) !== this.targetTurnId) continue;
        const reason = failureReason(message, this.clientId);
        if (reason) this.pendingFailure = reason;
      }
    }
  }

  observe(snapshot: HeadlessTurnSnapshot): HeadlessTurnObservation {
    if (!this.targetTurnId) {
      const unseenAgentTurns = Object.values(snapshot.channelView.turns).filter(
        (turn) => isAgentTurn(turn) && !this.baselineTurnIds.has(turn.turnId)
      );
      this.targetTurnId = latestTurn(unseenAgentTurns)?.turnId;
    }

    for (const message of snapshot.messages) {
      const revision = messageRevision(message);
      if (this.seenMessageRevisions.get(message.id) === revision) continue;
      this.seenMessageRevisions.set(message.id, revision);

      const turnId = messageTurnId(message, snapshot.channelView);
      if (turnId && this.targetTurnId && turnId !== this.targetTurnId) continue;

      const reason = failureReason(message, this.clientId);
      if (reason) {
        this.pendingFailure = reason;
        continue;
      }
      if (isResponse(message, this.clientId)) {
        this.pendingFailure = undefined;
        this.latestResponse = message;
      }
    }

    const turn = this.targetTurnId ? snapshot.channelView.turns[this.targetTurnId] : undefined;
    const observation: HeadlessTurnObservation = {
      ...(this.targetTurnId ? { turnId: this.targetTurnId } : {}),
      ...(this.latestResponse ? { response: this.latestResponse } : {}),
    };

    if (turn && turn.status === "closed") {
      const integrityFailure = closedTurnIntegrityFailure(turn.turnId, snapshot.channelView);
      if (integrityFailure) {
        observation.terminal = { kind: "failed", reason: integrityFailure };
      } else if (this.pendingFailure) {
        observation.terminal = { kind: "failed", reason: this.pendingFailure };
      } else if (this.latestResponse) {
        observation.terminal = { kind: "succeeded", message: this.latestResponse };
      } else {
        observation.terminal = {
          kind: "failed",
          reason: turn.reason?.trim() || "Agent turn closed without a response",
        };
      }
    } else if (!turn && this.latestResponse) {
      // Older/custom publishers may emit a completed agent response without
      // durable turn events. A response is still a valid terminal observation.
      observation.terminal = { kind: "succeeded", message: this.latestResponse };
    } else if (!turn && this.pendingFailure) {
      observation.terminal = { kind: "failed", reason: this.pendingFailure };
    }

    return observation;
  }
}
