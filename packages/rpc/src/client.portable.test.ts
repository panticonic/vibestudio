import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { createRpcMethods } from "@vibestudio/shared/rpcMethods";
import { createInProcessNetwork, inProcessTransport } from "./transports/inProcess.js";
import type { RpcEnvelope } from "./types.js";

type Bundle = typeof import("./client-core.js") &
  Pick<typeof import("./schemaClient.js"), "wireClientFor" | "schemaRpcClient">;
const source = path.dirname(fileURLToPath(import.meta.url));
const closed = { kind: "closed" as const, reason: "Portable RPC ownership test" };
const methods = createRpcMethods(
  "portable",
  defineServiceMethods({
    echo: { args: z.tuple([z.number()]), returns: z.number(), website: closed },
    bytes: { args: z.tuple([]), returns: z.unknown(), website: closed },
  }),
  ""
);

describe("RPC ownership across independently evaluated bundles", () => {
  let scratch: string;
  let creator: Bundle;
  let consumer: Bundle;
  beforeAll(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "vibestudio-rpc-bundles-"));
    const bundled = await build({
      stdin: {
        contents: `export * from ${JSON.stringify(path.join(source, "client-core.ts"))}; export { wireClientFor, schemaRpcClient } from ${JSON.stringify(path.join(source, "schemaClient.ts"))};`,
        resolveDir: source,
        loader: "ts",
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      tsconfig: path.resolve(source, "../../../tsconfig.json"),
    });
    const output = bundled.outputFiles[0];
    if (!output) throw new Error("RPC bundle was not produced");
    // One producer, two independent module identities and private registries,
    // just as the CLI and downloaded System app have in the product.
    const paths = [path.join(scratch, "creator.mjs"), path.join(scratch, "consumer.mjs")] as const;
    await Promise.all(paths.map((file) => writeFile(file, output.contents)));
    [creator, consumer] = await Promise.all([
      import(pathToFileURL(paths[0]).href) as Promise<Bundle>,
      import(pathToFileURL(paths[1]).href) as Promise<Bundle>,
    ]);
  });
  afterAll(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("admits async schema preparation to the creator before yielding and retains retirement", async () => {
    const lifetime = new AbortController();
    const observed: Promise<unknown>[] = [];
    const sent: RpcEnvelope[] = [];
    const wire = creator.createInternalRpcClient({
      selfId: "validation-owner",
      lifetime: lifetime.signal,
      transport: {
        send: async (envelope) => {
          sent.push(envelope);
        },
        onMessage: () => () => {},
      },
      onOutboundOperation: (operation) => observed.push(operation),
    });
    const rpc = consumer.withRpcAbortSignal(
      creator.schemaRpcClient(wire),
      new AbortController().signal
    );
    let finishValidation!: () => void;
    const validating = new Promise<void>((resolve) => {
      finishValidation = resolve;
    });
    const method = {
      name: "pending",
      async parseArgs(args: [number]) {
        await validating;
        return args;
      },
      async invoke(args: [number], dispatch: (args: unknown[]) => Promise<unknown>) {
        return dispatch(await this.parseArgs(args));
      },
    };
    const pending = rpc.call("server", method, [1]);
    const rejected = expect(pending).rejects.toThrow("retired");
    expect(observed).toHaveLength(1);
    lifetime.abort(new Error("transport creator retired"));
    finishValidation();
    await rejected;
    await Promise.allSettled(observed);
    expect(sent).toEqual([]);
  });

  it("delegates scoped schema calls, peers, events and async admission to the creator", async () => {
    const network = createInProcessNetwork();
    const lifetime = new AbortController();
    const borrower = new AbortController();
    const context = new AsyncLocalStorage<string>();
    const sent: Array<{ envelope: RpcEnvelope; context: string | undefined }> = [];
    const observed: Promise<unknown>[] = [];
    const wire = creator.createInternalRpcClient({
      selfId: "borrower",
      callerKind: "worker",
      lifetime: lifetime.signal,
      transport: {
        ...inProcessTransport("borrower", network),
        send: async (envelope) => {
          sent.push({ envelope, context: context.getStore() });
          await network.send(envelope);
        },
      },
      onOutboundOperation: (operation) => observed.push(operation),
    });
    const owner = creator.withRpcContext(wire, (operation) => operation());
    // Public schema facade is constructed in the creator bundle, not by the consumer.
    const rpc = creator.schemaRpcClient(wire);
    const serverLifetime = new AbortController();
    const server = creator.createRpcClient({
      selfId: "server",
      callerKind: "server",
      lifetime: serverLifetime.signal,
      transport: inProcessTransport("server", network),
    });
    server.expose("echo", ({ args }) => args[0], closed);
    server.exposeStreaming(
      "bytes",
      async (_request, sink) => {
        await sink({ kind: "head", status: 200, statusText: "OK", headerPairs: [], finalUrl: "" });
        await sink({ kind: "end", bytesIn: 0 });
      },
      closed
    );
    const events: unknown[] = [];
    server.on("changed", ({ payload }) => events.push(payload), closed);
    const parent = {
      kind: "trajectory-invocation" as const,
      logId: "channel:portable",
      head: "main",
      invocationId: "invoke",
    };
    try {
      expect(consumer.createRpcClient).not.toBe(creator.createRpcClient);
      expect(() => consumer.wireClientFor(rpc)).toThrow("no registered transport owner");
      const view = consumer.withRpcContext(
        consumer.withRpcAbortSignal(consumer.withCausalParent(rpc, parent), borrower.signal),
        (operation) => context.run("creator-owned", operation)
      );
      expect(creator.wireClientFor(view)).toBeDefined();
      expect(() => consumer.wireClientFor(view)).toThrow("no registered transport owner");
      await expect(view.call("server", methods.echo, [3])).resolves.toBe(3);
      const peer = view
        .peer("server")
        .withContract(
          consumer.defineContract({ caller: { methods: { echo: methods.echo } } }),
          "caller"
        );
      await expect(peer.call.echo(4)).resolves.toBe(4);
      const stream = await view.stream("server", methods.bytes, []);
      expect(await stream.text()).toBe("");
      const readable = await view.streamReadable("server", methods.bytes, []);
      const reader = readable.body.getReader();
      try {
        expect(await reader.read()).toMatchObject({ done: true });
      } finally {
        reader.releaseLock();
      }
      await view.emit("server", "changed", "event");
      expect(events).toEqual(["event"]);
      expect(sent.every((item) => item.context === "creator-owned")).toBe(true);
      expect(sent[0]?.envelope.message).toMatchObject({ causalParent: parent });
      const before = sent.length;
      await expect(view.call("server", methods.echo, ["invalid" as never])).rejects.toThrow();
      expect(sent).toHaveLength(before);
      expect(observed.length).toBeGreaterThan(0);
      borrower.abort(new Error("borrowed operation ended"));
      await expect(view.call("server", methods.echo, [5])).rejects.toThrow();
      await expect(rpc.call("server", methods.echo, [6])).resolves.toBe(6);
      lifetime.abort(new Error("creator retired"));
      await expect(rpc.call("server", methods.echo, [7])).rejects.toThrow("retired");
      expect(() => owner.createView({ mapOptions: (options) => options ?? {} })).not.toThrow();
    } finally {
      lifetime.abort();
      serverLifetime.abort();
      await Promise.allSettled(observed);
    }
  });
});
