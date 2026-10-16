import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import type { Page } from "@playwright/test";
import { createRpcMethods } from "@vibestudio/shared/rpcMethods";
import type { ServiceMethodSchemas } from "@vibestudio/shared/typedServiceClient";
import {
  createRpcClient,
  deserializeRpcFailure,
  type EnvelopeRpcTransport,
  type RpcDestination,
  type RpcEnvelope,
  type RpcErrorKind,
  type RpcFailure,
  type RpcMethod,
} from "@vibestudio/rpc";

const SERIALIZER_SYMBOL = "vibestudio.e2e.rpcFailureSerializer.v1";
const DOCUMENT_TOKEN_SYMBOL = "vibestudio.e2e.nativeUiRead.documentToken.v1";

type BridgeIdentity = { runtimeId: string; workspaceId: string };
type PageTransportBridge = {
  identity: BridgeIdentity;
  send(envelope: RpcEnvelope): Promise<void>;
  onMessage(handler: (envelope: RpcEnvelope) => void): () => void;
};

let serializerBundle: Promise<string> | undefined;
const pageBrokers = new WeakMap<Page, PageBridgeSlot>();

type PageBridgeSlot = {
  generation: number;
  callbackName: string;
  binding: Promise<void>;
  initialization: Promise<PageBridgeBroker> | undefined;
  active: PageBridgeBroker | undefined;
};

type PageBridgeBroker = {
  transport: EnvelopeRpcTransport;
  identity: BridgeIdentity;
  generation: number;
  documentToken: string;
  deliver: (documentToken: string, envelope: RpcEnvelope) => void;
  disconnect: () => void;
};

function getSerializerBundle(): Promise<string> {
  serializerBundle ??= build({
    absWorkingDir: process.cwd(),
    stdin: {
      contents: `
        import { serializeRpcFailure } from "@vibestudio/rpc";
        const key = Symbol.for(${JSON.stringify(SERIALIZER_SYMBOL)});
        Object.defineProperty(globalThis, key, { value: serializeRpcFailure });
      `,
      resolveDir: process.cwd(),
      sourcefile: "native-ui-read-rpc-failure-serializer.ts",
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
  }).then((result) => {
    const output = result.outputFiles[0];
    if (!output) throw new Error("RPC failure serializer bundle produced no browser output");
    return output.text;
  });
  return serializerBundle;
}

function createPageBridgeSlot(page: Page): PageBridgeSlot {
  const slot: PageBridgeSlot = {
    generation: 0,
    callbackName: `__vibestudioE2eRpcMessage_${randomUUID().replaceAll("-", "")}`,
    binding: Promise.resolve(),
    initialization: undefined,
    active: undefined,
  };
  const invalidateDocument = (): void => {
    slot.generation += 1;
    slot.initialization = undefined;
    const active = slot.active;
    slot.active = undefined;
    active?.disconnect();
  };
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) invalidateDocument();
  });
  page.on("close", invalidateDocument);
  slot.binding = page.exposeFunction(
    slot.callbackName,
    (documentToken: string, envelope: RpcEnvelope) => {
      slot.active?.deliver(documentToken, envelope);
    }
  );
  return slot;
}

async function createPageBridgeTransport(
  page: Page,
  slot: PageBridgeSlot,
  generation: number
): Promise<PageBridgeBroker> {
  const assertCurrentDocument = (): void => {
    if (page.isClosed() || slot.generation !== generation) {
      throw new Error("Native UI RPC page navigated before the bridge was ready");
    }
  };
  await slot.binding;
  assertCurrentDocument();
  await page.addScriptTag({ content: await getSerializerBundle() });
  assertCurrentDocument();
  const identity = await page.evaluate(() => {
    const bridge = (window as unknown as { __vibestudioTransport: PageTransportBridge })
      .__vibestudioTransport;
    return bridge.identity;
  });
  assertCurrentDocument();
  const documentToken = randomUUID();
  const listeners = new Set<(envelope: RpcEnvelope) => void>();
  const statusListeners = new Set<(status: "connected" | "disconnected") => void>();
  const state = { connected: true };
  await page.evaluate(
    ({ name, documentToken, documentTokenSymbol }) => {
      const bridge = (window as unknown as { __vibestudioTransport: PageTransportBridge })
        .__vibestudioTransport;
      const callback = (globalThis as unknown as Record<string, unknown>)[name];
      if (typeof callback !== "function") throw new Error("RPC message callback is unavailable");
      Object.defineProperty(globalThis, Symbol.for(documentTokenSymbol), {
        configurable: true,
        value: documentToken,
      });
      bridge.onMessage((envelope) => {
        const currentToken = (globalThis as unknown as Record<PropertyKey, unknown>)[
          Symbol.for(documentTokenSymbol)
        ];
        if (currentToken === documentToken) {
          void (callback as (token: string, message: RpcEnvelope) => Promise<void>)(
            documentToken,
            envelope
          );
        }
      });
    },
    { name: slot.callbackName, documentToken, documentTokenSymbol: DOCUMENT_TOKEN_SYMBOL }
  );
  assertCurrentDocument();

  const transport: EnvelopeRpcTransport = {
    async send(envelope) {
      if (!state.connected || page.isClosed())
        throw new Error("Native UI RPC page is disconnected");
      const outcome = await page.evaluate(
        async ({ envelope, serializerSymbol, documentToken, documentTokenSymbol }) => {
          const currentToken = (globalThis as unknown as Record<PropertyKey, unknown>)[
            Symbol.for(documentTokenSymbol)
          ];
          if (currentToken !== documentToken) throw new Error("Native UI RPC document changed");
          const bridge = (window as unknown as { __vibestudioTransport: PageTransportBridge })
            .__vibestudioTransport;
          try {
            await bridge.send(envelope);
            return { ok: true as const };
          } catch (error) {
            const serializer = (globalThis as unknown as Record<PropertyKey, unknown>)[
              Symbol.for(serializerSymbol)
            ];
            if (typeof serializer !== "function") throw error;
            return {
              ok: false as const,
              failure: (serializer as (value: unknown, fallback: RpcErrorKind) => RpcFailure)(
                error,
                "transport"
              ),
            };
          }
        },
        {
          envelope,
          serializerSymbol: SERIALIZER_SYMBOL,
          documentToken,
          documentTokenSymbol: DOCUMENT_TOKEN_SYMBOL,
        }
      );
      if (!outcome.ok) throw deserializeRpcFailure(outcome.failure);
    },
    onMessage(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    status: () => (state.connected && !page.isClosed() ? "connected" : "disconnected"),
    ready: () => Promise.resolve(),
    onStatusChange(handler) {
      statusListeners.add(handler);
      if (!state.connected || page.isClosed()) handler("disconnected");
      return () => statusListeners.delete(handler);
    },
  };

  const broker: PageBridgeBroker = {
    transport,
    identity,
    generation,
    documentToken,
    deliver(token, envelope) {
      if (!state.connected || token !== documentToken) return;
      for (const listener of listeners) listener(envelope);
    },
    disconnect() {
      if (!state.connected) return;
      state.connected = false;
      for (const listener of statusListeners) listener("disconnected");
      statusListeners.clear();
      listeners.clear();
    },
  };
  return broker;
}

function pageBridgeTransport(page: Page): Promise<PageBridgeBroker> {
  let slot = pageBrokers.get(page);
  if (!slot) {
    slot = createPageBridgeSlot(page);
    pageBrokers.set(page, slot);
  }
  if (slot.active?.generation === slot.generation) return Promise.resolve(slot.active);
  if (slot.initialization) return slot.initialization;
  const generation = slot.generation;
  let initialization: Promise<PageBridgeBroker>;
  initialization = createPageBridgeTransport(page, slot, generation)
    .then((broker) => {
      if (slot?.generation !== generation || page.isClosed()) {
        broker.disconnect();
        throw new Error("Native UI RPC page navigated before the bridge was ready");
      }
      slot!.active = broker;
      return broker;
    })
    .catch((error: unknown) => {
      if (slot?.initialization === initialization) slot.initialization = undefined;
      if (slot?.active?.generation === generation) {
        slot.active.disconnect();
        slot.active = undefined;
      }
      throw error;
    });
  slot.initialization = initialization;
  return initialization;
}

/** Read-only assertions use the same admitted native System UI transport as the product. */
export async function nativeUiRead<Args extends unknown[], Result>(
  page: Page,
  destination: RpcDestination,
  method: RpcMethod<Args, Result>,
  args: NoInfer<Args>
): Promise<Result> {
  const bridge = await pageBridgeTransport(page);
  const lifetime = new AbortController();
  const client = createRpcClient({
    selfId: bridge.identity.runtimeId,
    callerKind: "client",
    workspaceId: bridge.identity.workspaceId,
    transport: bridge.transport,
    lifetime: lifetime.signal,
  });
  const deadline = new AbortController();
  const deadlineError = new Error(`Timed out reading ${method.name}`);
  const timer = setTimeout(() => deadline.abort(deadlineError), 30_000);
  let result: Result | undefined;
  let primaryFailure: unknown;
  let hasPrimaryFailure = false;
  try {
    await client.ready();
    result = await client.call("main", method, args, {
      destination,
      signal: deadline.signal,
    });
  } catch (error) {
    hasPrimaryFailure = true;
    primaryFailure = error;
  } finally {
    clearTimeout(timer);
    lifetime.abort(new Error("Native UI read RPC client retired"));
  }
  if (hasPrimaryFailure) throw primaryFailure;
  return result as Result;
}

/** Adapt the schema-derived service client's dynamic invoker to owned descriptors. */
export function nativeUiServiceInvoker<M extends ServiceMethodSchemas>(
  page: Page,
  destination: RpcDestination,
  service: string,
  schemas: M
): (serviceName: string, method: string, args: unknown[]) => Promise<unknown> {
  const methods = createRpcMethods(service, schemas);
  const byWireName = new Map(Object.values(methods).map((method) => [method.name, method]));
  return (serviceName, methodName, args) => {
    if (serviceName !== service) throw new Error(`Unexpected RPC service ${serviceName}`);
    const descriptor = byWireName.get(`${service}.${methodName}`);
    if (!descriptor) throw new Error(`No owned RPC descriptor for ${service}.${methodName}`);
    return nativeUiRead(page, destination, descriptor, args);
  };
}
