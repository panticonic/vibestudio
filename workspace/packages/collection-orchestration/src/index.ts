import { launchAgentIntoChannel, type AgentSubscriptionConfig } from "@workspace/agentic-core";
import { connectViaRpc } from "@workspace/pubsub";

export const COLLECTION_AGENT_SOURCE = "workers/agent-worker";
export const COLLECTION_AGENT_CLASS = "AiChatWorker";
export const COLLECTION_AGENT_HANDLE = "conductor";

export interface CollectionSessionDescriptor {
  channelName: string;
  agentKey: string;
}

export interface CollectionStartupTask {
  kind: "title-browser-import-windows";
  sourceName: string;
}

export interface CollectionOrchestrationState {
  /** Stable resident orchestration channel owned by this collection panel. */
  channelName?: string;
  /** Stable object key for the resident collection agent. */
  agentKey?: string;
  /** Optional one-shot task sent after the resident agent joins. */
  initialPrompt?: string;
  /** Structured first-run intent supplied by a collection creator. */
  startupTask?: CollectionStartupTask;
  /** Optional agent subscription overrides such as model or thinking level. */
  agentConfig?: AgentSubscriptionConfig | Record<string, unknown>;
}

export interface CollectionOrchestrationRpc {
  call<T = unknown>(targetId: string, method: string, args: unknown[]): Promise<T>;
  stream(
    targetId: string,
    method: string,
    args: unknown[],
    options?: { signal?: AbortSignal }
  ): Promise<Response>;
  selfId: string;
}

export function createCollectionSession(
  id: string = crypto.randomUUID()
): CollectionSessionDescriptor {
  const suffix = id.replace(/[^a-zA-Z0-9]/g, "");
  if (!suffix) throw new Error("Collection session identity must contain letters or digits");
  return {
    channelName: `collection-${suffix}`,
    agentKey: `conductor-${suffix}`,
  };
}

export function buildCollectionAgentSystemPrompt(args: {
  rootPanelId: string;
  title: string;
}): string {
  return [
    `You are the resident conductor for the Vibestudio collection "${args.title}".`,
    `Your collection root is the stable panel slot \`${args.rootPanelId}\`. This is a machine-readable scope identifier, not a snapshot of its members.`,
    "",
    "At the start of every task, and again after structural mutations, call:",
    "",
    "```ts",
    'import { panelTree } from "@workspace/runtime";',
    `let page = await panelTree.page({ group: { kind: "children", parentSlotId: ${JSON.stringify(args.rootPanelId)} }, limit: 50 });`,
    "```",
    "",
    "Process `page.entries` and follow `page.nextCursor` before descending into child groups. Keep only the current page and a bounded work queue; never materialize the complete subtree. Every entry has `.node` metadata and `.handle` operations.",
    "Keep the first `page.revision` for a traversal. If a later page has a different revision, discard the partial traversal and restart its affected sibling groups from the first page.",
    "",
    "You supervise the entire subtree:",
    "- Inspect and automate browser leaves through `node.handle.cdp`; metadata and tree operations do not require loading a deferred panel.",
    "- Rename any panel with `await node.handle.setTitle(title, { explicit: true })`.",
    "- Reparent or reorder with `await node.handle.movePanel(newParentId, { beforeSlotId, afterSlotId })`.",
    `- Create nested collection panels in this root's orchestration context (\`panelTree.get(${JSON.stringify(args.rootPanelId)}).contextId\`) so their resident conductors inherit the same prompt-free control boundary.`,
    `- Example: \`openPanel("about/collection", { parentId, contextId: panelTree.get(${JSON.stringify(args.rootPanelId)}).contextId, title, focus: false, stateArgs: { title, note } })\`.`,
    `- Collection notes live on the root state as \`notes: Record<panelId, string>\`; merge them through \`panelTree.get(${JSON.stringify(args.rootPanelId)}).stateArgs.set({ notes })\` rather than replacing unrelated state.`,
    `- Read that root's current \`note\`, \`notes\`, and \`origin\` state at the start of a task. When renaming a collection panel itself, update both its explicit panel title and its \`stateArgs.title\` so its own UI and its parent agree.`,
    "",
    "Read `about/collection/SKILL.md` before reorganizing or batch-automating the subtree. Preserve recursive collection structure, refresh after each structural batch, use bounded concurrency for CDP, and do not eagerly materialize every imported browser panel merely to derive a title when URL/title metadata is sufficient.",
  ].join("\n");
}

export function buildBrowserImportWindowTitlePrompt(sourceName: string): string {
  return [
    `Assign best-effort semantic titles to every imported ${sourceName} window collection under this collection root.`,
    "Refresh the affected sibling groups first. Identify descendant `about/collection` panels whose state `origin` marks them as imported browser windows.",
    "For each window collection, infer one concise, navigation-friendly theme from its descendant browser panels' existing titles and URLs. Use metadata only; do not materialize or inspect browser pages through CDP.",
    "Replace generic labels such as “Window 1” with the inferred title using `setTitle(title, { explicit: true })`, and merge the same title into that collection panel's `stateArgs.title`.",
    "Do not rename browser leaves, move panels, or change the hierarchy in this task. Keep a generic window title when the tabs are genuinely unrelated rather than inventing a misleading theme.",
    "Restart affected sibling groups after the batch and briefly summarize the window titles you changed.",
  ].join(" ");
}

export function promptForCollectionStartupTask(task: CollectionStartupTask): string {
  switch (task.kind) {
    case "title-browser-import-windows":
      return buildBrowserImportWindowTitlePrompt(task.sourceName);
  }
}

export async function launchCollectionTask(
  rpc: CollectionOrchestrationRpc,
  args: {
    rootPanelId: string;
    rootTitle: string;
    contextId: string;
    session: CollectionSessionDescriptor;
    task: string;
    idempotencyKey: string;
    agentConfig?: AgentSubscriptionConfig | Record<string, unknown>;
  }
): Promise<void> {
  await launchAgentIntoChannel(rpc, {
    source: COLLECTION_AGENT_SOURCE,
    className: COLLECTION_AGENT_CLASS,
    key: args.session.agentKey,
    channelId: args.session.channelName,
    contextId: args.contextId,
    replay: true,
    config: {
      handle: COLLECTION_AGENT_HANDLE,
      name: "Collection conductor",
      approvalLevel: 2,
      systemPrompt: buildCollectionAgentSystemPrompt({
        rootPanelId: args.rootPanelId,
        title: args.rootTitle,
      }),
      systemPromptMode: "append",
      ...(args.agentConfig ?? {}),
    },
  });

  const client = connectViaRpc({
    rpc,
    channel: args.session.channelName,
    contextId: args.contextId,
    channelConfig: { approvalLevel: 2 },
    clientId: `${rpc.selfId}:collection-task:${args.rootPanelId}`,
    name: "Collection task",
    type: "headless",
    handle: "collection-task",
    replayMode: "skip",
  });
  try {
    await client.ready();
    await client.send(args.task, {
      idempotencyKey: args.idempotencyKey,
      tier: "secondary",
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}
