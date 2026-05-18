/**
 * HookBus - NatStack's typed event fan-out around AgentHarness.
 *
 * AgentHarness owns all upstream lifecycle events. NatStack only adds events
 * that upstream does not model, such as local recovery banners.
 */

import type {
  AgentHarnessEvent,
  AgentHarnessStreamOptionsPatch,
} from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface OrphanFileMutationIntentEvent {
  type: "system_event";
  kind: "orphan_file_mutation_intent";
  intentEntryId: string;
  path: string | null;
}

export type NatStackRunnerEvent = OrphanFileMutationIntentEvent;
export type RunnerEvent = AgentHarnessEvent | NatStackRunnerEvent;

export type EventListener = (event: RunnerEvent) => Promise<void> | void;
export type TransformContextListener = (
  messages: AgentMessage[],
) => Promise<AgentMessage[]> | AgentMessage[];
export type BeforeProviderRequestListener = (
  event: Extract<AgentHarnessEvent, { type: "before_provider_request" }>,
) =>
  | Promise<{ streamOptions?: AgentHarnessStreamOptionsPatch } | undefined>
  | { streamOptions?: AgentHarnessStreamOptionsPatch }
  | undefined;

export interface HookListenerMap {
  event: EventListener;
  transform_context: TransformContextListener;
  before_provider_request: BeforeProviderRequestListener;
}

export type HookName = keyof HookListenerMap;

export class HookBus {
  private readonly eventListeners: EventListener[] = [];
  private readonly transformContextListeners: TransformContextListener[] = [];
  private readonly beforeProviderRequestListeners: BeforeProviderRequestListener[] = [];

  on<TName extends HookName>(name: TName, listener: HookListenerMap[TName]): () => void {
    const list = this.bucket(name);
    list.push(listener as never);
    return () => {
      const idx = list.indexOf(listener as never);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  async emitEvent(event: RunnerEvent): Promise<void> {
    for (const listener of [...this.eventListeners]) {
      try {
        await listener(event);
      } catch (err) {
        console.error("[HookBus] event listener threw:", err);
      }
    }
  }

  async emitTransformContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
    let current = messages;
    for (const listener of [...this.transformContextListeners]) {
      try {
        const result = await listener(current);
        if (Array.isArray(result)) current = result;
      } catch (err) {
        console.error("[HookBus] transform_context listener threw:", err);
      }
    }
    return current;
  }

  async emitBeforeProviderRequest(
    event: Extract<AgentHarnessEvent, { type: "before_provider_request" }>,
  ): Promise<{ streamOptions?: AgentHarnessStreamOptionsPatch } | undefined> {
    let streamOptions: AgentHarnessStreamOptionsPatch | undefined;
    for (const listener of [...this.beforeProviderRequestListeners]) {
      try {
        const result = await listener(event);
        if (result?.streamOptions) {
          streamOptions = mergeStreamOptionPatch(streamOptions, result.streamOptions);
        }
      } catch (err) {
        console.error("[HookBus] before_provider_request listener threw:", err);
      }
    }
    return streamOptions ? { streamOptions } : undefined;
  }

  clear(): void {
    this.eventListeners.length = 0;
    this.transformContextListeners.length = 0;
    this.beforeProviderRequestListeners.length = 0;
  }

  private bucket<TName extends HookName>(name: TName): HookListenerMap[TName][] {
    if (name === "event") return this.eventListeners as never;
    if (name === "transform_context") return this.transformContextListeners as never;
    if (name === "before_provider_request") {
      return this.beforeProviderRequestListeners as never;
    }
    throw new Error(`[HookBus] unknown hook: ${String(name)}`);
  }
}

function mergeStreamOptionPatch(
  previous: AgentHarnessStreamOptionsPatch | undefined,
  next: AgentHarnessStreamOptionsPatch,
): AgentHarnessStreamOptionsPatch {
  return {
    ...(previous ?? {}),
    ...next,
    headers: mergeRecordPatch(previous?.headers, next.headers),
    metadata: mergeRecordPatch(previous?.metadata, next.metadata),
  };
}

function mergeRecordPatch<T>(
  previous: Record<string, T | undefined> | undefined,
  next: Record<string, T | undefined> | undefined,
): Record<string, T | undefined> | undefined {
  if (next === undefined) return previous;
  return { ...(previous ?? {}), ...next };
}
