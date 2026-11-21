import { build } from "esbuild";
import type { Page } from "@playwright/test";
import { createRpcMethods } from "@vibestudio/shared/rpcMethods";
import type { ServiceMethodSchemas } from "@vibestudio/shared/typedServiceClient";
import {
  deserializeRpcFailure,
  type RpcDestination,
  type RpcFailure,
  type RpcMethod,
} from "@vibestudio/rpc";

const READER_SYMBOL = "vibestudio.e2e.nativeUiRead.v2";
let readerBundle: Promise<string> | undefined;

function getReaderBundle(): Promise<string> {
  readerBundle ??= build({
    absWorkingDir: process.cwd(),
    stdin: {
      contents: `
        import { createRpcClient, serializeRpcFailure } from "@vibestudio/rpc";

        const key = Symbol.for(${JSON.stringify(READER_SYMBOL)});
        globalThis[key] ??= async ({ destination, methodName, args }) => {
          const bridge = globalThis.__vibestudioTransport;
          if (!bridge) throw new Error("Native UI RPC transport is unavailable");

          const lifetime = new AbortController();
          const deadline = new AbortController();
          const timer = setTimeout(() => deadline.abort(new Error("Timed out reading " + methodName)), 30_000);
          try {
            const client = createRpcClient({
              selfId: bridge.identity.runtimeId,
              callerKind: "client",
              workspaceId: bridge.identity.workspaceId,
              transport: {
                send: (envelope) => bridge.send(envelope),
                onMessage: (handler) => bridge.onMessage(handler),
                status: () => "connected",
                ready: () => Promise.resolve(),
                onStatusChange: () => () => {},
              },
              lifetime: lifetime.signal,
            });
            await client.ready();
            const value = await client.call("main", {
              name: methodName,
              invoke: (args, dispatch) => dispatch(args),
              parseArgs: async (args) => args,
            }, args, { destination, signal: deadline.signal });
            return { ok: true, value };
          } catch (error) {
            return { ok: false, failure: serializeRpcFailure(error, "transport") };
          } finally {
            clearTimeout(timer);
            lifetime.abort(new Error("Native UI read RPC client retired"));
          }
        };
      `,
      resolveDir: process.cwd(),
      sourcefile: "native-ui-read-rpc.ts",
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
  }).then((result) => {
    const output = result.outputFiles[0];
    if (!output) throw new Error("Native UI RPC reader bundle produced no browser output");
    return output.text;
  });
  return readerBundle;
}

type BrowserReadResult = { ok: true; value: unknown } | { ok: false; failure: RpcFailure };

/** Execute a schema-checked read through the renderer's admitted native session. */
export async function nativeUiRead<Args extends unknown[], Result>(
  page: Page,
  destination: RpcDestination,
  method: RpcMethod<Args, Result>,
  args: NoInfer<Args>
): Promise<Result> {
  return method.invoke(args, async (parsedArgs) => {
    const installed = await page.evaluate(
      (symbol) => typeof Reflect.get(globalThis, Symbol.for(symbol)) === "function",
      READER_SYMBOL
    );
    if (!installed) await page.evaluate(await getReaderBundle());

    const result = await page.evaluate(
      ({ symbol, request }) => {
        const read = Reflect.get(globalThis, Symbol.for(symbol)) as
          | ((input: typeof request) => Promise<BrowserReadResult>)
          | undefined;
        if (!read) throw new Error("Native UI RPC reader is unavailable in this document");
        return read(request);
      },
      { symbol: READER_SYMBOL, request: { destination, methodName: method.name, args: parsedArgs } }
    );
    if (!result.ok) throw deserializeRpcFailure(result.failure);
    return result.value;
  });
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
