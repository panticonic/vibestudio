/**
 * Scribe dispatch — explicit, decoupled from autosave (plan section D + decision 7).
 *
 * The original failure: autosave was coupled to agent dispatch, so a half-typed
 * `@scribe` line invoked the agent mid-edit. Here, quiescence only commits
 * (DocController) and NEVER dispatches. Invoking the scribe is an explicit user
 * action — selecting text / a mention → **Send to @scribe**.
 *
 * Send must **flush first**: because autosave is decoupled, dirty blocks may be
 * uncommitted when Send fires. We synchronously commit the pending edits, then
 * dispatch referencing the resulting `stateHash` — otherwise the scribe reads
 * stale head content. This module encodes exactly that ordering guarantee.
 */

export interface ScribeDispatchDeps {
  /** Commit any pending dirty blocks now; resolves with the committed state. */
  commitPending: () => Promise<{ stateHash: string; changed: boolean } | null>;
  /** Send a chat message to the channel (the existing channel client). */
  send: (content: string, opts: { mentions: string[] }) => Promise<void>;
}

export interface ScribeRequest {
  /** The scribe's handle (default "scribe"). */
  handle?: string;
  /** The user's instruction to the scribe. */
  message: string;
  /** Optional context: a path + selected excerpt the user is asking about. */
  context?: { path: string; selection?: string };
}

/**
 * Build the message body. Keeps the prompt clean: the user's instruction first,
 * an optional quoted selection for grounding, and the committed `stateHash` so
 * the scribe edits against exactly what the user saw.
 */
export function buildScribeMessage(input: ScribeRequest, stateHash: string | null): string {
  const lines = [input.message.trim()];
  if (input.context?.selection) {
    lines.push("", `> Re: \`${input.context.path}\``, "", "```", input.context.selection, "```");
  } else if (input.context?.path) {
    lines.push("", `(Re: \`${input.context.path}\`)`);
  }
  if (stateHash) lines.push("", `<!-- @ ${stateHash} -->`);
  return lines.join("\n");
}

/**
 * Flush-then-dispatch. Returns the committed `stateHash` the scribe will see.
 * The commit ALWAYS precedes the send (the invariant the original bug violated).
 */
export async function sendToScribe(
  deps: ScribeDispatchDeps,
  request: ScribeRequest
): Promise<{ stateHash: string | null }> {
  const committed = await deps.commitPending();
  const stateHash = committed?.stateHash ?? null;
  const handle = request.handle ?? "scribe";
  await deps.send(buildScribeMessage(request, stateHash), { mentions: [handle] });
  return { stateHash };
}
