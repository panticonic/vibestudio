import type { RpcClient } from "@vibestudio/rpc";
import type { runtimeMethods } from "@vibestudio/service-schemas/runtime";
import type { MethodFn } from "@vibestudio/shared/typedServiceClient";

type CreateEntity = MethodFn<(typeof runtimeMethods)["createEntity"]>;

interface ConversationClient {
  history(channelTargetId: string): Promise<unknown>;
  send(
    channelTargetId: string,
    text: string,
    options: Record<string, unknown>,
  ): Promise<unknown>;
  subscribe(
    channelTargetId: string,
    participantId: string,
    metadata: Record<string, unknown>,
    onRecord: () => void | Promise<void>,
    options: { signal: AbortSignal },
  ): Promise<void>;
}

/** Public connected-website runtime members consumed by the embedded fixture. */
export interface EmbeddedInventionWorkspace {
  readonly rpc: Pick<RpcClient, "call" | "stream" | "selfId">;
  readonly contextId: string;
  readonly runtime: {
    createEntity(...args: Parameters<CreateEntity>): ReturnType<CreateEntity>;
  };
  readonly createConversationClient: (
    rpc: Pick<RpcClient, "call" | "stream">,
  ) => ConversationClient;
  readonly launchAgentIntoChannel: (
    rpc: Pick<RpcClient, "call" | "stream">,
    input: {
      source: string;
      className: string;
      key: string;
      contextId: string;
      channelId: string;
      replay: boolean;
    },
  ) => Promise<{ subscription: { participantId: string } }>;
  readonly formatRpcFailure: (error: unknown) => string;
}

type FixtureState = {
  key: string;
  target?: string;
  participant?: string;
  receipt?: { id: number };
};

type FixtureStatus = "idle" | "working" | "complete" | "failed";

/**
 * The executable fixture is ordinary checked TypeScript. inventorModelScript
 * serializes this self-contained function into the generated HTML after type
 * erasure; keep runtime dependencies inside the public workspace argument.
 */
export async function runEmbeddedMoonPermit(
  workspace: EmbeddedInventionWorkspace,
  directory: string,
): Promise<void> {
  function element<T extends HTMLElement>(id: string): T {
    const value = document.getElementById(id);
    if (!value) throw new Error(`Moon Permit Office is missing #${id}`);
    return value as T;
  }

  const button = element<HTMLButtonElement>("submit");
  const request = element<HTMLInputElement>("request");
  const status = element<HTMLElement>("status");
  const verdict = element<HTMLElement>("verdict");
  const client = workspace.createConversationClient(workspace.rpc);
  const storageKey = `smoke-moon:${directory}`;
  const stored = localStorage.getItem(storageKey);
  const state: FixtureState = stored
    ? (JSON.parse(stored) as FixtureState)
    : { key: `moon-${crypto.randomUUID()}` };
  let controller: AbortController | undefined;

  function setStatus(state: FixtureStatus, text: string): void {
    status.dataset["state"] = state;
    status.textContent = text;
  }

  function fail(error: unknown): void {
    setStatus("failed", workspace.formatRpcFailure(error));
    button.disabled = false;
  }

  function save(): void {
    localStorage.setItem(storageKey, JSON.stringify(state));
  }

  async function refresh(): Promise<void> {
    if (!state.target || !state.receipt) return;
    const history = await client.history(state.target);
    const rows =
      history &&
      typeof history === "object" &&
      Array.isArray((history as { logEvents?: unknown }).logEvents)
        ? (history as { logEvents: unknown[] }).logEvents
        : [];
    const reply = rows.find((row) => {
      if (!row || typeof row !== "object") return false;
      const record = row as {
        id?: unknown;
        payload?: {
          actor?: { id?: unknown };
          kind?: unknown;
          payload?: { role?: unknown; tier?: unknown };
        };
      };
      const payload = record.payload;
      return (
        typeof record.id === "number" &&
        record.id > state.receipt!.id &&
        payload !== undefined &&
        payload.actor?.id === state.participant &&
        payload.kind === "message.completed" &&
        payload.payload?.role === "assistant" &&
        payload.payload.tier === "primary"
      );
    }) as
      | {
          payload?: {
            payload?: { blocks?: Array<{ type?: unknown; content?: unknown }> };
          };
        }
      | undefined;
    if (!reply) return;
    verdict.textContent = (reply.payload?.payload?.blocks ?? [])
      .filter(
        (block): block is { type: "text"; content: string } =>
          block.type === "text" && typeof block.content === "string",
      )
      .map((block) => block.content)
      .join("\n");
    button.disabled = false;
    setStatus("complete", "Permit issued");
  }

  async function observe(): Promise<void> {
    if (!state.target) return;
    controller?.abort();
    const current = new AbortController();
    controller = current;
    void client
      .subscribe(state.target, workspace.rpc.selfId, {}, refresh, {
        signal: current.signal,
      })
      .catch((error: unknown) => {
        if (!current.signal.aborted && controller === current) fail(error);
      });
    await refresh();
  }

  save();
  setStatus("idle", "Ready");
  button.onclick = async () => {
    button.disabled = true;
    setStatus("working", "Consulting the lunar clerk");
    try {
      const channel = await workspace.runtime.createEntity({
        kind: "do",
        execution: { surface: "code", source: "workers/pubsub-channel" },
        className: "PubSubChannel",
        key: state.key,
        contextId: workspace.contextId,
      });
      state.target = channel.targetId;
      const agent = await workspace.launchAgentIntoChannel(workspace.rpc, {
        source: "workers/agent-worker",
        className: "AiChatWorker",
        key: `${state.key}-clerk`,
        contextId: workspace.contextId,
        channelId: state.key,
        replay: true,
      });
      state.participant = agent.subscription.participantId;
      const receipt = await client.send(
        state.target,
        `SMOKE_MOON_REQUEST:${request.value}`,
        {
          to: [{ kind: "participant", participantId: state.participant }],
          idempotencyKey: crypto.randomUUID(),
        },
      );
      if (
        !receipt ||
        typeof receipt !== "object" ||
        typeof (receipt as { id?: unknown }).id !== "number"
      )
        throw new Error("Moon Permit Office received an invalid send receipt");
      state.receipt = { id: (receipt as { id: number }).id };
      save();
      await observe();
    } catch (error) {
      fail(error);
    }
  };

  if (state.target) {
    setStatus("working", "Restoring the lunar clerk");
    try {
      await observe();
    } catch (error) {
      fail(error);
    }
  }
  addEventListener("pagehide", () => controller?.abort());
}
