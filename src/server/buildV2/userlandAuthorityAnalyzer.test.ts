import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { usingTypeScriptProject } from "@vibestudio/typecheck";
import { analyzeWorkspaceServiceCalls } from "./userlandAuthorityAnalyzer.js";

function analyze(
  source: string,
  executableModules?: Parameters<typeof analyzeWorkspaceServiceCalls>[0]["executableModules"]
) {
  const root = mkdtempSync(join(tmpdir(), "vibestudio-authority-facts-"));
  const file = join(root, "index.ts");
  return usingTypeScriptProject([{ fileName: file, content: source }], (project) =>
    analyzeWorkspaceServiceCalls({
      project,
      sourceRoot: root,
      unitRelativePath: ".",
      units: [{ name: "consumer", relativePath: "." }],
      executableModules,
    })
  );
}

describe("userland authority facts", () => {
  it("binds a resolved service target to its method call", () => {
    const facts = analyze(`
      declare const workers: { resolveService(query: string, objectKey?: string | null): Promise<{ targetId: string }> };
      declare const rpc: { call(target: string, method: string, args: unknown[]): Promise<unknown> };
      const query = "example.notes.v1" as const;
      async function run() {
        const service = await workers.resolveService(query, "notes");
        await rpc.call(service.targetId, "deleteNote", []);
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

  it("does not infer an unrelated object named workers", () => {
    const facts = analyze(`
      const workers = { resolveService: async (_query: string) => ({ targetId: "x" }) };
      const rpc = { call: async (_target: string, _method: string, _args: unknown[]) => undefined };
      async function run() {
        const service = await workers.resolveService("not-a-workspace-service");
        await rpc.call(service.targetId, "deleteNote", []);
      }
    `);
    expect(facts).toEqual([]);
  });

  it("does not recurse forever through a recursive service helper", () => {
    const facts = analyze(`
      declare const rpc: { call(target: string, method: string, args: unknown[]): Promise<unknown> };
      function service() {
        return service();
      }
      async function run() {
        const value = service();
        await rpc.call(value.targetId, "deleteNote", []);
      }
    `);
    expect(facts).toEqual([]);
  });

  it("recognizes the public connectViaRpc service client by symbol identity", () => {
    const facts = analyze(`
      declare module "@workspace/pubsub" {
        export function connectViaRpc(options: { protocol: string; channel: string }): { call(method: string, ...args: unknown[]): Promise<unknown> };
      }
      import { connectViaRpc } from "@workspace/pubsub";
      async function run() {
        const client = connectViaRpc({ protocol: "example.notes.v1", channel: "notes" });
        await client.call("deleteNote");
      }
    `);
    expect(facts).toHaveLength(2);
    expect(facts[0]?.serviceQueries).toMatchObject({
      kind: "literals",
      values: new Set(["example.notes.v1"]),
    });
    expect(facts[1]?.methods).toMatchObject({
      kind: "literals",
      values: new Set(["deleteNote"]),
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
            declare const rpc: { call(target: string, method: string, args: unknown[]): Promise<unknown> };
            async function run() {
              const service = await workers.resolveService("example.notes.v1");
              await rpc.call(service.targetId, "deleteNote", []);
            }
          `,
      },
    ]);
    expect(facts.some((fact) => fact.origin.package?.name === "example-client")).toBe(true);
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
            declare const rpc: { call(target: string, method: string, args: unknown[]): Promise<unknown> };
            async function run() {
              const service = await workers.resolveService("example.notes.v1");
              await rpc.call(service.targetId, "deleteNote", []);
            }
          `,
      },
    ]);
    expect(facts.some((fact) => fact.origin.package?.name === "@workspace/wrapper")).toBe(true);
  });
});
