/**
 * HTTP POST-based RPC client for Cloudflare Workers/DOs.
 *
 * Used by environments that do not maintain persistent connections.
 */

import type {
  AuthenticatedCaller,
  RpcContextHandler,
  RpcContextMethods,
  RpcCallOptions,
  RpcClient,
  RpcEventContext,
  RpcRequestContext,
} from "@natstack/rpc";

const rpcFetch = globalThis.fetch.bind(globalThis);
const RPC_RUNTIME_ID_HEADER = "X-Natstack-Runtime-Id";

export interface HttpRpcClientConfig {
  selfId: string;
  serverUrl: string;
  authToken: string;
}

export function createHttpRpcClient(config: HttpRpcClientConfig): RpcClient & {
  handleIncomingPost(body: unknown): Promise<unknown>;
} {
  const { selfId, serverUrl, authToken } = config;
  const selfCaller: AuthenticatedCaller = { callerId: selfId, callerKind: "unknown" };
  const methodHandlers = new Map<string, (request: RpcRequestContext) => Promise<unknown>>();
  const eventListeners = new Map<string, Set<(event: RpcEventContext) => void>>();

  async function postToServer(payload: object): Promise<unknown> {
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      let res: Response;
      try {
        res = await rpcFetch(`${serverUrl}/rpc`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
            [RPC_RUNTIME_ID_HEADER]: selfId,
          },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt)));
          continue;
        }
        throw err;
      }

      if (res.status >= 500 && attempt < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt)));
        continue;
      }
      if (res.status === 401) throw new Error("RPC authentication failed");

      const json = (await res.json()) as Record<string, unknown>;
      if (json["error"]) {
        const err = new Error(json["error"] as string);
        if (json["errorCode"]) (err as Error & { code?: unknown }).code = json["errorCode"];
        throw err;
      }
      return json["result"];
    }
    throw new Error("RPC request failed after retries");
  }

  const client: RpcClient & { handleIncomingPost(body: unknown): Promise<unknown> } = {
    selfId,

    expose<TArgs extends unknown[], TReturn>(
      method: string,
      handler: RpcContextHandler<TArgs, TReturn>,
    ): void {
      methodHandlers.set(method, async (request) => handler(request as RpcRequestContext & { args: TArgs }));
    },

    exposeAll(methods: RpcContextMethods): void {
      for (const [name, handler] of Object.entries(methods)) {
        methodHandlers.set(name, async (request) => handler(request));
      }
    },

    exposeStreaming(method: string): void {
      throw new Error(
        `exposeStreaming("${method}") is not supported on the HTTP RPC client; ` +
          `register the handler on the server-side RpcServer or a transport-based RpcClient.`,
      );
    },

    async call<T>(
      targetId: string,
      method: string,
      args: unknown[],
      options?: RpcCallOptions,
    ): Promise<T> {
      if (options?.signal?.aborted) throw new Error("RPC call aborted by caller");
      if (targetId === selfId) {
        const handler = methodHandlers.get(method);
        if (!handler) throw new Error(`No handler for method '${method}'`);
        return handler({
          caller: selfCaller,
          origin: selfCaller,
          method,
          args,
          signal: options?.signal ?? new AbortController().signal,
          rpc: client,
        }) as Promise<T>;
      }

      const request = postToServer({ type: "call", targetId, method, args }) as Promise<T>;
      if (!options?.timeoutMs && !options?.signal) return request;

      return new Promise<T>((resolve, reject) => {
        let settled = false;
        let timeout: ReturnType<typeof setTimeout> | null = null;
        const cleanup = (): void => {
          if (timeout) clearTimeout(timeout);
          options?.signal?.removeEventListener("abort", onAbort);
        };
        const settle = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          cleanup();
          fn();
        };
        const onAbort = (): void => settle(() => reject(new Error("RPC call aborted by caller")));
        if (typeof options?.timeoutMs === "number" && options.timeoutMs >= 0) {
          timeout = setTimeout(
            () => settle(() => reject(new Error(`RPC call timed out after ${options.timeoutMs}ms`))),
            options.timeoutMs,
          );
        }
        options?.signal?.addEventListener("abort", onAbort, { once: true });
        request.then(
          (value) => settle(() => resolve(value)),
          (err) => settle(() => reject(err)),
        );
      });
    },

    async stream(
      targetId: string,
      method: string,
      args: unknown[],
      options?: { signal?: AbortSignal },
    ): Promise<Response> {
      if (targetId === selfId) throw new Error("stream is not supported for local dispatch");
      const wireResponse = await rpcFetch(`${serverUrl}/rpc/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
          [RPC_RUNTIME_ID_HEADER]: selfId,
        },
        body: JSON.stringify({ targetId, method, args }),
        signal: options?.signal,
      });
      if (wireResponse.status === 401) {
        await wireResponse.text().catch(() => "");
        throw new Error("RPC streaming authentication failed");
      }
      if (!wireResponse.ok) {
        const detail = await wireResponse.text().catch(() => "");
        throw new Error(
          `RPC streaming endpoint returned HTTP ${wireResponse.status}${detail ? `: ${detail}` : ""}`,
        );
      }
      if (!wireResponse.body) throw new Error("RPC streaming response has no body");
      const { decodeFramedResponseToStreaming } = await import("@natstack/rpc/protocol/streamCodec");
      return decodeFramedResponseToStreaming(wireResponse.body, "", options?.signal ?? null);
    },

    async emit(targetId: string, event: string, payload: unknown): Promise<void> {
      await postToServer({ type: "emit", targetId, event, payload });
    },

    on(event: string, listener: (event: RpcEventContext) => void): () => void {
      if (!eventListeners.has(event)) eventListeners.set(event, new Set());
      eventListeners.get(event)!.add(listener);
      return () => eventListeners.get(event)?.delete(listener);
    },

    peer(targetId: string) {
      return {
        id: targetId,
        call: new Proxy({}, {
          get(_target, method) {
            if (typeof method !== "string") return undefined;
            return (...args: unknown[]) => client.call(targetId, method, args);
          },
        }) as never,
        on: (event: string, listener: (event: never) => void): (() => void) =>
          client.on(event, (ev: RpcEventContext) => {
            if (ev.caller.callerId === targetId) listener(ev as never);
          }),
        emit: (event: string, payload: unknown) => client.emit(targetId, event, payload),
        withContract: () => client.peer(targetId) as never,
      };
    },

    status: () => "connected" as const,
    ready: () => Promise.resolve(),
    onStatusChange: () => () => {},
    parent: async () => null,
    children: async () => [],
    tree: {
      root: async () => null,
      self: () => client.peer(selfId),
      siblings: async () => [],
    },
    automation() {
      throw new Error("RPC automation adapter is not configured");
    },

    async handleIncomingPost(body: unknown): Promise<unknown> {
      const msg = body as {
        type?: string;
        fromId?: string;
        method?: string;
        args?: unknown[];
        event?: string;
        payload?: unknown;
      };
      if (msg.type === "call") {
        const handler = methodHandlers.get(msg.method ?? "");
        if (!handler) return { error: `No handler for method '${msg.method}'` };
        const caller: AuthenticatedCaller = {
          callerId: msg.fromId ?? "",
          callerKind: "unknown",
        };
        try {
          const result = await handler({
            caller,
            origin: caller,
            method: msg.method ?? "",
            args: msg.args ?? [],
            signal: new AbortController().signal,
            rpc: client,
          });
          return { result };
        } catch (err) {
          const error = err as Error & { code?: string };
          return { error: error.message, errorCode: error.code };
        }
      }
      if (msg.type === "emit") {
        const listeners = eventListeners.get(msg.event ?? "");
        const caller: AuthenticatedCaller = { callerId: msg.fromId ?? "", callerKind: "unknown" };
        if (listeners) {
          for (const listener of listeners) {
            try {
              listener({ caller, origin: caller, event: msg.event ?? "", payload: msg.payload });
            } catch (err) {
              console.error(`[HttpRpcClient] Event listener error for '${msg.event}':`, err);
            }
          }
        }
        return { result: "ok" };
      }
      return { error: "Unknown message type" };
    },
  };

  return client;
}
