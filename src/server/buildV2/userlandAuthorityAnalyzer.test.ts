import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { usingTypeScriptProject } from "@vibestudio/typecheck";
import { analyzeWorkspaceServiceCalls } from "./userlandAuthorityAnalyzer.js";

const sharedMethodsPath = join(
  fileURLToPath(new URL("../../../packages/shared/src/rpcMethods.ts", import.meta.url))
)
  .replace(/\\/gu, "/")
  .replace(/\.ts$/u, ".js");
const testRpcContract = `
  import { createReceiverRpcMethods } from "@vibestudio/shared/rpcMethods";
  interface TestRpcMethods {
    deleteNote(): Promise<void>;
    getNote(): Promise<void>;
    unused(): Promise<void>;
  }
  export const testRpcMethods = createReceiverRpcMethods<TestRpcMethods>([
    "deleteNote", "getNote", "unused"
  ]);
`;

function analyze(
  source: string,
  executableModules?: Parameters<typeof analyzeWorkspaceServiceCalls>[0]["executableModules"],
  additionalFiles: readonly { fileName: string; content: string }[] = []
) {
  const root = mkdtempSync(join(tmpdir(), "vibestudio-authority-facts-"));
  const file = join(root, "index.ts");
  return usingTypeScriptProject(
    [
      { fileName: file, content: source },
      { fileName: join(root, "test-rpc-contract.ts"), content: testRpcContract },
      ...additionalFiles.map((additional) => ({
        ...additional,
        fileName: join(root, additional.fileName),
      })),
    ],
    (project) =>
      analyzeWorkspaceServiceCalls({
        project,
        sourceRoot: root,
        unitRelativePath: ".",
        units: [{ name: "consumer", relativePath: "." }],
        executableModules,
      }),
    {
      compilerOptions: {
        baseUrl: root,
        paths: {
          "@vibestudio/shared/rpcMethods": [sharedMethodsPath],
          "@vibestudio/service-schemas/mainRpc": [join(root, "main-rpc.ts")],
        },
      },
    }
  );
}

describe("userland authority facts", () => {
  it("binds a resolved service target to its method call", () => {
    const facts = analyze(`
      declare const workers: { resolveService(query: string, objectKey?: string | null): Promise<{ targetId: string }> };
      import { testRpcMethods } from "./test-rpc-contract";
      declare const rpc: { call(target: string, method: object, args: unknown[]): Promise<unknown> };
      const query = "example.notes.v1" as const;
      async function run() {
        const service = await workers.resolveService(query, "notes");
        await rpc.call(service.targetId, testRpcMethods.deleteNote, []);
      }
    `);
    expect(facts).toHaveLength(2);
    expect(facts.map((fact) => fact.kind)).toEqual(["resolution", "invocation"]);
    expect(facts[0]?.serviceQueries).toMatchObject({
      kind: "literals",
      values: new Set(["example.notes.v1"]),
    });
    expect(facts[1]?.methods).toMatchObject({
      kind: "literals",
      values: new Set(["deleteNote"]),
    });
  });

  it("does not mistake a dynamic RPC method identifier for its variable name", () => {
    const facts = analyze(`
      declare const workers: { resolveService(query: string): Promise<{ targetId: string }> };
      import { testRpcMethods } from "./test-rpc-contract";
      declare const rpc: { call(target: string, method: object, args: unknown[]): Promise<unknown> };
      async function invoke(method: object) {
        const service = await workers.resolveService("example.notes.v1");
        await rpc.call(service.targetId, method, []);
      }
    `);

    expect(facts.find((fact) => fact.kind === "invocation")?.methods).toMatchObject({
      kind: "unknown",
    });
  });

  it("resolves an imported receiver-owned descriptor without inspecting its tuple type", () => {
    const facts = analyze(
      `
        import { recordStoreRpcMethods as ownerMethods, dynamicRpcMethods } from "./contract";
        const aliasedMethods = ownerMethods;
        declare const workers: { resolveService(query: string): Promise<{ targetId: string }> };
        declare const rpc: { call(target: string, method: object, args: unknown[]): Promise<unknown> };
        declare const dynamicMethod: object;
        async function run() {
          const service = await workers.resolveService("example.records.v1");
          await rpc.call(service.targetId, aliasedMethods.listRecords, ["all"]);
          await rpc.call(service.targetId, dynamicRpcMethods.listRecords, []);
          await rpc.call(service.targetId, dynamicMethod, []);
        }
      `,
      undefined,
      [
        {
          fileName: "contract.ts",
          content: `
            import { createReceiverRpcMethods } from "@vibestudio/shared/rpcMethods";
            interface RecordStoreRpc {
              listRecords(filter: string): Promise<readonly { id: string }[]>;
            }
            export const recordStoreRpcMethods = createReceiverRpcMethods<RecordStoreRpc>(
              ["listRecords"],
              "records"
            );
            declare const runtimeNamespace: string;
            export const dynamicRpcMethods = createReceiverRpcMethods<RecordStoreRpc>(
              ["listRecords"],
              runtimeNamespace
            );
          `,
        },
      ]
    );

    const invocations = facts.filter((fact) => fact.kind === "invocation");
    expect(invocations[0]?.methods).toMatchObject({
      kind: "literals",
      values: new Set(["records.listRecords"]),
    });
    expect(invocations[0]?.arguments).toEqual([{ kind: "literals", values: new Set(["all"]) }]);
    expect(invocations[1]?.methods).toMatchObject({ kind: "unknown" });
    expect(invocations[2]?.methods).toMatchObject({ kind: "unknown" });
  });

  it("does not trust a descriptor alias after mutable reassignment", () => {
    const facts = analyze(`
      import { testRpcMethods } from "./test-rpc-contract";
      declare const workers: { resolveService(query: string): Promise<{ targetId: string }> };
      declare const rpc: { call(target: string, method: object, args: unknown[]): Promise<unknown> };
      declare const replacement: object;
      async function run() {
        const service = await workers.resolveService("example.notes.v1");
        let method = testRpcMethods.deleteNote;
        method = replacement;
        await rpc.call(service.targetId, method, []);
      }
    `);
    expect(facts.find((fact) => fact.kind === "invocation")?.methods).toMatchObject({
      kind: "unknown",
    });
  });

  it("expands static RPC argument tuple spreads and marks unknown spread positions conservatively", () => {
    const facts = analyze(`
      import { testRpcMethods } from "./test-rpc-contract";
      declare const workers: { resolveService(query: string): Promise<{ targetId: string }> };
      declare const rpc: { call(target: string, method: object, args: unknown[]): Promise<unknown> };
      declare const dynamicPrefix: unknown[];
      async function run() {
        const service = await workers.resolveService("example.notes.v1");
        await rpc.call(service.targetId, testRpcMethods.getNote, [...(["first"] as const), "last"]);
        await rpc.call(service.targetId, testRpcMethods.getNote, [...dynamicPrefix, "last"]);
        const mutableArgs = ["before-mutation"];
        mutableArgs[0] = "after-mutation";
        await rpc.call(service.targetId, testRpcMethods.getNote, mutableArgs);
      }
    `);
    const invocations = facts.filter((fact) => fact.kind === "invocation");
    expect(invocations[0]?.arguments).toEqual([
      { kind: "literals", values: new Set(["first"]) },
      { kind: "literals", values: new Set(["last"]) },
    ]);
    expect(invocations[1]?.arguments).toEqual([{ kind: "unknown" }, { kind: "unknown" }]);
    expect(invocations[2]?.arguments).toEqual([{ kind: "unknown" }]);
  });

  it("resolves namespace-imported main RPC exports through project module identity", () => {
    const facts = analyze(
      `
        import * as mainRpc from "@vibestudio/service-schemas/mainRpc";
        declare const workers: { resolveService(query: string): Promise<{ targetId: string }> };
        declare const rpc: { call(target: string, method: object, args: unknown[]): Promise<unknown> };
        declare const dynamicName: string;
        async function run() {
          const service = await workers.resolveService("main");
          await rpc.call(service.targetId, mainRpc.mainRpcMethods["catalog.read"], []);
          await rpc.call(service.targetId, mainRpc.mainRpcMethod("catalog.write"), []);
          await rpc.call(service.targetId, mainRpc.mainRpcMethod(dynamicName), []);
        }
      `,
      undefined,
      [
        {
          fileName: "main-rpc.ts",
          content: `
            export const mainRpcMethods = { "catalog.read": {} };
            export function mainRpcMethod(name: string) { return { name }; }
          `,
        },
      ]
    );
    const methods = facts.filter((fact) => fact.kind === "invocation").map((fact) => fact.methods);
    expect(methods[0]).toMatchObject({
      kind: "literals",
      values: new Set(["catalog.read"]),
    });
    expect(methods[1]).toMatchObject({
      kind: "literals",
      values: new Set(["catalog.write"]),
    });
    expect(methods[2]).toMatchObject({ kind: "unknown" });
  });

  it("maps bound client method keys through their receiver table and wire namespace", () => {
    const facts = analyze(
      `
        declare module "@workspace/runtime/worker" {
          export function createDurableObjectServiceClient(
            protocol: string,
            methods: object,
            objectKey?: string
          ): { call(method: string, ...args: unknown[]): Promise<unknown> };
        }
        import { createDurableObjectServiceClient } from "@workspace/runtime/worker";
        import { recordStoreRpcMethods } from "./contract";
        const store = createDurableObjectServiceClient(
          "example.records.v1",
          recordStoreRpcMethods,
          "main"
        );
        void store.call("listRecords", "all");
        void store.call("unknownMethod");
      `,
      undefined,
      [
        {
          fileName: "contract.ts",
          content: `
            import { z } from "zod";
            import { createRpcMethods } from "@vibestudio/shared/rpcMethods";
            export const recordStoreRpcMethods = createRpcMethods("recordStore", {
              listRecords: { args: z.tuple([z.string()]), returns: z.array(z.string()) },
            }, "records");
          `,
        },
      ]
    );
    const invocations = facts.filter((fact) => fact.kind === "invocation");
    expect(invocations[0]?.methods).toMatchObject({
      kind: "literals",
      values: new Set(["records.listRecords"]),
    });
    expect(invocations[0]?.arguments).toEqual([{ kind: "literals", values: new Set(["all"]) }]);
    expect(invocations[1]?.methods).toMatchObject({ kind: "unknown" });
  });

  it("recognizes an aliased import of the canonical bound client factory", () => {
    const facts = analyze(
      `
        declare module "@workspace/runtime/worker" {
          export function createDurableObjectServiceClient(
            protocol: string,
            methods: object,
            objectKey?: string
          ): { call(method: string, ...args: unknown[]): Promise<unknown> };
        }
        import { createDurableObjectServiceClient as bindStore } from "@workspace/runtime/worker";
        import { recordStoreRpcMethods } from "./contract";
        const store = bindStore("example.records.v1", recordStoreRpcMethods, "main");
        void store.call("listRecords", "all");
      `,
      undefined,
      [
        {
          fileName: "contract.ts",
          content: `
            import { createReceiverRpcMethods } from "@vibestudio/shared/rpcMethods";
            interface RecordStoreRpc { listRecords(filter: string): Promise<unknown> }
            export const recordStoreRpcMethods = createReceiverRpcMethods<RecordStoreRpc>(
              ["listRecords"],
              "records"
            );
          `,
        },
      ]
    );
    const invocation = facts.find((fact) => fact.kind === "invocation");
    expect(invocation?.methods).toMatchObject({
      kind: "literals",
      values: new Set(["records.listRecords"]),
    });
    expect(invocation?.arguments).toEqual([{ kind: "literals", values: new Set(["all"]) }]);
  });

  it("does not infer an unrelated object named workers", () => {
    const facts = analyze(`
      const workers = { resolveService: async (_query: string) => ({ targetId: "x" }) };
      const rpc = { call: async (_target: string, _method: object, _args: unknown[]) => undefined };
      import { testRpcMethods } from "./test-rpc-contract";
      async function run() {
        const service = await workers.resolveService("not-a-workspace-service");
        await rpc.call(service.targetId, testRpcMethods.deleteNote, []);
      }
    `);
    expect(facts).toEqual([]);
  });

  it("does not recurse forever through a recursive service helper", () => {
    const facts = analyze(`
      import { testRpcMethods } from "./test-rpc-contract";
      declare const rpc: { call(target: string, method: object, args: unknown[]): Promise<unknown> };
      function service() {
        return service();
      }
      async function run() {
        const value = service();
        await rpc.call(value.targetId, testRpcMethods.deleteNote, []);
      }
    `);
    expect(facts).toEqual([]);
  });

  it("recognizes connectViaRpc as a service resolution without treating facade methods as provider RPC", () => {
    const facts = analyze(`
      declare module "@workspace/pubsub" {
        export function connectViaRpc(options: { protocol: string; channel: string }): { ready(): Promise<void>; send(message: string): Promise<void> };
      }
      import { connectViaRpc } from "@workspace/pubsub";
      async function run() {
        const client = connectViaRpc({ protocol: "example.notes.v1", channel: "notes" });
        await client.ready();
        await client.send("hello");
      }
    `);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.serviceQueries).toMatchObject({
      kind: "literals",
      values: new Set(["example.notes.v1"]),
    });
  });

  it("uses the query argument of the host-side durable service client", () => {
    const facts = analyze(`
      declare module "@vibestudio/shared/workspaceServiceRpc" {
        export function createDurableObjectServiceClient(
          rpc: object,
          query: string,
          methods: object,
          objectKey?: string | null
        ): { call(method: string, ...args: unknown[]): Promise<unknown> };
      }
      import { createDurableObjectServiceClient } from "@vibestudio/shared/workspaceServiceRpc";
      import { testRpcMethods } from "./test-rpc-contract";
      declare const rpc: object;
      const client = createDurableObjectServiceClient(rpc, "example.notes.v1", testRpcMethods, "notes");
      void client.call("deleteNote");
    `);
    expect(facts).toHaveLength(2);
    expect(facts[0]?.serviceQueries).toMatchObject({
      kind: "literals",
      values: new Set(["example.notes.v1"]),
    });
    expect(facts[0]?.objectKeys).toMatchObject({
      kind: "literals",
      values: new Set(["notes"]),
    });
    expect(facts[1]?.methods).toMatchObject({
      kind: "literals",
      values: new Set(["deleteNote"]),
    });
  });

  it("uses the query argument of the worker runtime's unbound service client", () => {
    const facts = analyze(`
      declare module "@workspace/runtime/worker" {
        export function createDurableObjectServiceClient(
          query: string,
          methods: object,
          objectKey?: string | null
        ): { call(method: string, ...args: unknown[]): Promise<unknown> };
      }
      import { createDurableObjectServiceClient } from "@workspace/runtime/worker";
      import { testRpcMethods } from "./test-rpc-contract";
      createDurableObjectServiceClient("example.notes.v1", testRpcMethods, "notes");
    `);
    expect(facts[0]?.serviceQueries).toMatchObject({
      kind: "literals",
      values: new Set(["example.notes.v1"]),
    });
  });

  it("attributes testkit's generic service helpers to their caller", () => {
    const facts = analyze(`
      declare module "@workspace/testkit" {
        export function callDO<Args extends unknown[]>(query: string, method: object, args: Args, opts?: { objectKey?: string | null }): Promise<unknown>;
        export function profileDO(query: string, run: () => Promise<void>): Promise<unknown>;
      }
      import { callDO, profileDO } from "@workspace/testkit";
      import { testRpcMethods } from "./test-rpc-contract";
      void callDO("example.notes.v1", testRpcMethods.getNote, []);
      void profileDO("example.other.v1", async () => undefined);
    `);
    expect(facts.map((fact) => fact.serviceQueries)).toEqual([
      { kind: "literals", values: new Set(["example.notes.v1"]) },
      { kind: "literals", values: new Set(["example.other.v1"]) },
    ]);
  });

  it("uses the public channel protocol when connectViaRpc omits its override", () => {
    const facts = analyze(`
      declare module "@workspace/pubsub" {
        export function connectViaRpc(options: { channel: string }): object;
      }
      import { connectViaRpc } from "@workspace/pubsub";
      connectViaRpc({ channel: "news" });
    `);
    expect(facts[0]?.serviceQueries).toMatchObject({
      kind: "literals",
      values: new Set(["vibestudio.channel.v1"]),
    });
  });

  it("retains external executable module provenance", () => {
    const facts = analyze("export const value = 1;", [
      {
        moduleId: "external.mjs",
        contentDigest: "a".repeat(64),
        package: {
          kind: "external",
          name: "example-client",
          version: "1.2.3",
          packageDigest: "b".repeat(64),
        },
        format: "mjs",
        source: `
            declare const workers: { resolveService(query: string): Promise<{ targetId: string }> };
            async function run() {
              await workers.resolveService("example.notes.v1");
            }
          `,
      },
    ]);
    expect(facts.some((fact) => fact.origin.package?.name === "example-client")).toBe(true);
  });

  it("attributes first-party executable bytes to the consumer", () => {
    const facts = analyze("export const value = 1;", [
      {
        moduleId: "panel-entry.mjs",
        contentDigest: "d".repeat(64),
        package: { kind: "first-party" },
        format: "mjs",
        source: `
          declare const workers: { resolveService(query: string): Promise<{ targetId: string }> };
          void workers.resolveService("example.notes.v1");
        `,
      },
    ]);

    const executableFact = facts.find((fact) => fact.origin.file.includes("000000/module.js"));
    expect(executableFact?.origin).toMatchObject({ unitName: "consumer" });
    expect(executableFact?.origin.package).toBeUndefined();
  });

  it("retains workspace-package provenance for executable dependency bytes", () => {
    const facts = analyze("export const value = 1;", [
      {
        moduleId: "workspace-wrapper.mjs",
        contentDigest: "c".repeat(64),
        package: {
          kind: "workspace",
          name: "@workspace/wrapper",
          effectiveVersion: "ev-wrapper",
        },
        format: "mjs",
        source: `
            declare const workers: { resolveService(query: string): Promise<{ targetId: string }> };
            async function run() {
              await workers.resolveService("example.notes.v1");
            }
          `,
      },
    ]);
    expect(facts.some((fact) => fact.origin.package?.name === "@workspace/wrapper")).toBe(true);
  });
});
