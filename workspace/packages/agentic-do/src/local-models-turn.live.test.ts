/**
 * LIVE end-to-end agent turn through the REAL pubsub agentic messaging system
 * (design §11.2 scenario 2, full-stack form):
 *
 *   user publish → PubSubChannel DO (real) → structured onChannelEnvelope →
 *   AgentVesselBase (real driver, real modelCallExecutor) → loopback auth →
 *   REAL llama-server (local-models extension, real weights) → streamed reply
 *   → publish back through the channel.
 *
 * Then switches the agent's model from local:lfm2.5-1.2b (utility server) to
 * local:lfm2.5-230m (router/main server) and runs a second turn, proving
 * model switching across server processes.
 *
 * Gated behind RUN_LOCAL_MODELS_E2E=1: requires the models downloaded by the
 * extension's e2e (cached machine-globally) and starts real servers.
 */

import { describe, expect, it } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { GadWorkspaceDO } from "../../semantic-control-plane/src/index.js";
import { PubSubChannel } from "../../../workers/pubsub-channel/channel-do.js";
import { activate as activateLocalModels } from "../../../extensions/local-models/index.js";
import { AgentVesselBase } from "./agent-vessel.js";
import type { ChannelClient } from "./channel-client.js";
import type { ParticipantDescriptor } from "@workspace/harness";

const RUN = process.env["RUN_LOCAL_MODELS_E2E"] === "1";
const TIMEOUT_MS = 20 * 60_000; // CPU prefill of the full agent system prompt is minutes-scale

const CHANNEL = "live-local-chat";
// Participant-id SHAPE matters: the channel classifies transport (and DO
// callback routing) by the "do:" prefix (pubsub types.ts:79).
const AGENT_PID = "do:test:LiveVessel:agent-live";
const USER_PID = "panel:user";
const GAD_TARGET = "do:vibestudio/internal:GadWorkspaceDO:workspace-semantic-control-plane";
const CHANNEL_TARGET = `do:workers/pubsub-channel:PubSubChannel:${CHANNEL}`;
const AGENTIC_KIND = "agentic.trajectory.v1/event";

function stubCtx() {
  return { log: { info: () => {} }, emit: () => {} };
}

/** Stamp the verified rpc caller on a DO instance (channel-do.test.ts idiom). */
function setRpcCaller(instance: unknown, callerId: string | null, callerKind: string | null): void {
  (instance as { _currentRpcCallerId: string | null })._currentRpcCallerId = callerId;
  (instance as { _currentRpcCallerKind: string | null })._currentRpcCallerKind = callerKind;
  (instance as { _currentRpcCallerPanelId: string | null })._currentRpcCallerPanelId = null;
}

class LiveVessel extends AgentVesselBase {
  callerIdForTest: string | null = null;
  callerKindForTest: string | null = null;
  readonly signals: unknown[] = [];

  protected override get rpcCallerId(): string | null {
    return this.callerIdForTest;
  }
  protected override get rpcCallerKind(): string | null {
    return this.callerKindForTest;
  }
  protected override participantId(): string {
    return AGENT_PID;
  }
  protected override getParticipantInfo(): ParticipantDescriptor {
    return { type: "agent", name: "LocalAgent", handle: "local" } as ParticipantDescriptor;
  }
  protected override getDefaultModel(): string {
    return "local:lfm2.5-1.2b";
  }
  protected override getDefaultRespondPolicy(): "all" {
    // Respond to every message — the test publishes plain user text with no
    // @mention, which the default mentioned-or-followup policy would ignore.
    return "all";
  }

  channelDelegate: ((method: string, args: unknown[]) => Promise<unknown>) | null = null;

  protected override createChannelClient(channelId: string): ChannelClient {
    const delegate = (method: string, args: unknown[]) => {
      if (!this.channelDelegate) throw new Error("channelDelegate not wired");
      return this.channelDelegate(method, args);
    };
    const signals = this.signals;
    return {
      subscribe: async (pid: string, metadata: Record<string, unknown>) =>
        delegate("subscribe", [pid, metadata]),
      unsubscribe: async (pid: string) => delegate("unsubscribe", [pid]),
      publishAgenticEvent: async (
        pid: string,
        event: unknown,
        opts?: { idempotencyKey?: string }
      ) => delegate("publishAgenticEvent", [pid, event, opts]),
      sendSignalEvent: async (_pid: string, _kind: string, event: unknown) => {
        signals.push(event);
      },
      broadcastStoredEnvelopes: async (envelopeIds: string[]) =>
        delegate("broadcastStoredEnvelopes", [envelopeIds]),
      setTypingState: async () => {},
      updateMetadata: async () => {},
      getMessageType: async () => null,
      getMessageTypes: async () => [],
      getParticipants: async () => delegate("getParticipants", []),
      callMethod: async () => {
        throw new Error("no channel tools in this test");
      },
      getReplayAfter: async () => ({ logEvents: [], latestSeq: 0 }),
      recordTaskProvenance: async () => {},
    } as unknown as ChannelClient;
  }

  async registerSubscriptionForTest(channelId: string, config?: unknown): Promise<void> {
    await this.subscriptions.subscribe({
      channelId,
      contextId: "ctx-live",
      descriptor: this.getParticipantInfo(),
      config,
      replay: false,
    });
  }
}

describe.runIf(RUN)("full agent turn over pubsub with real local models", () => {
  it(
    "user message → channel → vessel → llama-server → reply; then switches models",
    async () => {
      // ── the real local-models extension (real servers, cached weights) ──
      const localModels = (await activateLocalModels(stubCtx())) as unknown as Record<
        string,
        (...args: unknown[]) => Promise<unknown>
      >;
      const ensureLoadedCalls: string[] = [];

      // ── real GAD + real channel DO ─────────────────────────────────────
      let envelopesDelivered = 0;
      const deliveredEnvelopes: Array<Record<string, unknown>> = [];
      const gad = await createTestDO(GadWorkspaceDO, {
        __objectKey: "workspace-semantic-control-plane",
      });
      const channel = await createTestDO(PubSubChannel, { __objectKey: CHANNEL });
      const blobs = new Map<string, string>();
      let blobSeq = 0;

      const gadCall = async (method: string, args: unknown[]) => {
        const callable = gad.instance as unknown as Record<
          string,
          ((...a: unknown[]) => unknown) | undefined
        >;
        const fn = callable[method];
        if (typeof fn !== "function") {
          throw new Error(`gad has no method ${method}`);
        }
        return await fn.apply(gad.instance, args);
      };

      const sharedMainCall = async (method: string, args: unknown[]): Promise<unknown> => {
        if (method === "blobstore.putText") {
          const value = String(args[0] ?? "");
          blobSeq += 1;
          const digest = `live-blob-${blobSeq}`;
          blobs.set(digest, value);
          return { digest, size: value.length };
        }
        if (method === "blobstore.getText") return blobs.get(String(args[0] ?? "")) ?? null;
        if (method === "extensions.invoke") {
          const [ext, extMethod, extArgs] = args as [string, string, unknown[]];
          if (ext !== "@workspace-extensions/local-models") {
            throw new Error(`unexpected extension ${ext}`);
          }
          if (extMethod === "ensureLoaded") ensureLoadedCalls.push(String(extArgs[0]));
          const fn = localModels[extMethod];
          if (!fn) throw new Error(`unknown extension method ${extMethod}`);
          return await fn(...(extArgs ?? []));
        }
        if (method === "workers.resolveService") {
          const wanted = JSON.stringify(args);
          if (/pubsub|channel/iu.test(wanted)) {
            return {
              kind: "durable-object",
              source: "workers/pubsub-channel",
              className: "PubSubChannel",
              objectKey: CHANNEL,
              targetId: CHANNEL_TARGET,
            };
          }
          return {
            kind: "durable-object",
            source: "vibestudio/internal",
            className: "GadWorkspaceDO",
            objectKey: "workspace-semantic-control-plane",
            targetId: GAD_TARGET,
          };
        }
        // Lifecycle bookkeeping (alarms, titles, telemetry) — irrelevant here.
        return undefined;
      };

      // ── the real vessel DO ─────────────────────────────────────────────
      const vessel = await createTestDO(LiveVessel, { __objectKey: "agent-live" });

      const vesselAsDo = <T>(fn: () => Promise<T>): Promise<T> => {
        vessel.instance.callerIdForTest = CHANNEL_TARGET;
        vessel.instance.callerKindForTest = "do";
        return fn();
      };

      // Channel DO transport: fan-out delivers structured envelopes straight
      // into the vessel; gad/blobstore ride the shared bridges.
      (
        channel.instance as unknown as {
          _connectionless: { client: unknown; respond: unknown; deliver: unknown };
        }
      )._connectionless = {
        client: {
          emit: async () => {},
          call: async (target: string, method: string, args: unknown[]) => {
            if (method === "onChannelEnvelope") {
              envelopesDelivered += 1;
              // The channel's own fan-out IS the proof of publish-back:
              // every stored envelope (including the agent's replies) flows
              // through here on its way to subscribers.
              deliveredEnvelopes.push(args[1] as Record<string, unknown>);
              return vesselAsDo(() =>
                (
                  vessel.instance as unknown as {
                    onChannelEnvelope(channelId: string, envelope: unknown): Promise<unknown>;
                  }
                ).onChannelEnvelope(args[0] as string, args[1])
              );
            }
            if (target === GAD_TARGET) return gadCall(method, args);
            if (target === "main") return sharedMainCall(method, args);
            return undefined;
          },
          expose: () => {},
          exposeAll: () => {},
          on: () => () => {},
        },
        respond: async () => null,
        deliver: () => {},
      };

      // Vessel DO transport: extension + blobstore + gad + channel bridges.
      const channelPublishes: Array<{ pid: string; event: Record<string, unknown> }> = [];
      (
        vessel.instance as unknown as {
          _connectionless: { client: unknown; respond: unknown; deliver: unknown };
        }
      )._connectionless = {
        client: {
          emit: async () => {},
          call: async (target: string, method: string, args: unknown[]) => {
            if (target === "main") return sharedMainCall(method, args);
            if (target === GAD_TARGET || target === "gad") return gadCall(method, args);
            if (target === CHANNEL_TARGET || target.includes("PubSubChannel")) {
              // The driver's terminal publishes ride THIS path (executorDeps
              // channel.publish → rpc "publish"), not publishAgenticEvent —
              // capture them for the assertions.
              if (method === "publish") {
                channelPublishes.push({
                  pid: String(args[0]),
                  event: (args[2] ?? {}) as Record<string, unknown>,
                });
              }
              setRpcCaller(channel.instance, AGENT_PID, "do");
              const callable = channel.instance as unknown as Record<
                string,
                ((...a: unknown[]) => unknown) | undefined
              >;
              const fn = callable[method];
              if (typeof fn !== "function") return undefined; // optional surface
              return await fn.apply(channel.instance, args);
            }
            return undefined;
          },
          expose: () => {},
          exposeAll: () => {},
          on: () => () => {},
        },
        respond: async () => null,
        deliver: () => {},
      } as never;

      vessel.instance.channelDelegate = async (method, args) => {
        if (method === "subscribe") {
          const [pid, metadata] = args as [string, Record<string, unknown>];
          setRpcCaller(channel.instance, AGENT_PID, "do");
          const callable = channel.instance as unknown as {
            subscribe(pid: string, metadata: Record<string, unknown>): Promise<unknown>;
          };
          return callable.subscribe(pid, { ...metadata, receivesChannelEnvelopes: true });
        }
        if (method === "unsubscribe") return { ok: true };
        if (method === "broadcastStoredEnvelopes") {
          setRpcCaller(channel.instance, AGENT_PID, "do");
          const callable = channel.instance as unknown as {
            broadcastStoredEnvelopes(ids: string[]): Promise<unknown>;
          };
          return callable.broadcastStoredEnvelopes(args[0] as string[]);
        }
        if (method === "publishAgenticEvent") {
          const [pid, event] = args as [string, Record<string, unknown>];
          channelPublishes.push({ pid, event });
          setRpcCaller(channel.instance, AGENT_PID, "do");
          const callable = channel.instance as unknown as {
            publish(pid: string, kind: string, payload: unknown): Promise<unknown>;
          };
          return callable.publish(pid, AGENTIC_KIND, event);
        }
        if (method === "getParticipants") return [];
        return undefined;
      };

      // ── roster: user + agent join the real channel ─────────────────────
      setRpcCaller(channel.instance, USER_PID, "panel");
      await (
        channel.instance as unknown as {
          subscribe(pid: string, descriptor: Record<string, unknown>): Promise<unknown>;
        }
      ).subscribe(USER_PID, { contextId: "ctx-live", name: "User", type: "panel" });

      // Agent joins through its OWN real subscription flow (vessel →
      // channel client → real channel roster with receivesChannelEnvelopes).
      vessel.instance.callerIdForTest = USER_PID;
      vessel.instance.callerKindForTest = "panel";
      await vessel.instance.registerSubscriptionForTest(CHANNEL, {
        model: "local:lfm2.5-1.2b",
        respondPolicy: "all",
        approvalLevel: 2,
      });

      const publishUserMessage = async (id: string, text: string) => {
        setRpcCaller(channel.instance, USER_PID, "panel");
        const callable = channel.instance as unknown as {
          publish(pid: string, kind: string, payload: unknown): Promise<unknown>;
        };
        await callable.publish(USER_PID, AGENTIC_KIND, {
          kind: "message.completed",
          actor: { kind: "user", id: USER_PID },
          causality: { messageId: id },
          payload: {
            protocol: "agentic.trajectory.v1",
            role: "user",
            blocks: [{ blockId: `${id}:block:0`, type: "text", content: text }],
            outcome: "completed",
          },
          createdAt: new Date().toISOString(),
        });
      };

      const settle = async (rounds: number, doneWhen: () => boolean) => {
        for (let i = 0; i < rounds && !doneWhen(); i += 1) {
          // Pump the DRIVER directly (driver-test idiom): the vessel's alarm
          // override consults its timer bookkeeping, which is inert here
          // because workspace-state.alarmSet is a no-op in this harness.
          await vesselAsDo(() =>
            (
              vessel.instance as unknown as { driver: { alarm(): Promise<void> } }
            ).driver.alarm()
          ).catch(() => {});
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      };

      const assistantCompletions = () => {
        const fromPublishes = channelPublishes
          .filter(
            (entry) =>
              entry.event["kind"] === "message.completed" &&
              (entry.event["payload"] as Record<string, unknown> | undefined)?.["role"] ===
                "assistant"
          )
          .map((entry) => entry.event);
        const fromFanout = deliveredEnvelopes
          // RpcLogMessage: { kind: "log", event: { ..., payload: AgenticEvent } }
          .map(
            (envelope) =>
              ((envelope["event"] as Record<string, unknown> | undefined)?.["payload"] ??
                envelope["payload"]) as Record<string, unknown> | undefined
          )
          .filter(
            (event): event is Record<string, unknown> =>
              !!event &&
              event["kind"] === "message.completed" &&
              (event["payload"] as Record<string, unknown> | undefined)?.["role"] === "assistant"
          );
        return [...fromPublishes, ...fromFanout];
      };

      // ── TURN 1: fallback model over the utility server ─────────────────
      await publishUserMessage("m-user-1", "Reply with a short greeting.");
      await settle(1000, () => assistantCompletions().length >= 1);

      const first = assistantCompletions()[0];
      expect(
        first,
        `no assistant reply published back to the channel; diag=${JSON.stringify({
          ensureLoadedCalls,
          signals: vessel.instance.signals.length,
          publishes: channelPublishes.map((p) => `${p.pid}:${String(p.event["kind"])}`),
          envelopesDelivered,
          fanoutKinds: deliveredEnvelopes.map(
            (envelope) =>
              ((envelope["event"] as Record<string, unknown> | undefined)?.["payload"] as
                | Record<string, unknown>
                | undefined)?.["kind"] ?? "?"
          ),
        })}`
      ).toBeTruthy();
      const firstBlocks = (first!["payload"] as { blocks?: Array<{ content?: string }> }).blocks;
      const firstText = (firstBlocks ?? [])
        .map((block) => block.content ?? "")
        .join("")
        .trim();
      expect(firstText.length, "empty assistant reply").toBeGreaterThan(0);
      expect(ensureLoadedCalls).toContain("lfm2.5-1.2b");

      // ── SWITCH: configure the agent onto the 230M router model ─────────
      // The direct settings write (the eval `agent.configure` path uses the
      // same method; chatOp is EvalDO-gated and not for tests).
      (
        vessel.instance as unknown as {
          configureAgent(patch: Record<string, unknown>): unknown;
        }
      ).configureAgent({ model: "local:lfm2.5-230m" });

      // ── TURN 2: tiny sibling over the main (router) server ─────────────
      const before = assistantCompletions().length;
      await publishUserMessage("m-user-2", "Say hello again, even shorter.");
      await settle(1000, () => assistantCompletions().length > before);

      const second = assistantCompletions()[before];
      expect(second, "no assistant reply after model switch").toBeTruthy();
      const secondText = (
        (second!["payload"] as { blocks?: Array<{ content?: string }> }).blocks ?? []
      )
        .map((block) => block.content ?? "")
        .join("")
        .trim();
      expect(secondText.length, "empty reply from switched model").toBeGreaterThan(0);
      expect(ensureLoadedCalls, "switch never reached the 230M model").toContain("lfm2.5-230m");
    },
    TIMEOUT_MS
  );
});
