import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { collectWorkspaceRpcCatalog } from "./workspaceRpcCatalog.js";

describe("workspace RPC build catalog", () => {
  it("derives documented receiver methods from the exact worker source", async () => {
    const root = mkdtempSync(join(tmpdir(), "vibestudio-rpc-catalog-"));
    mkdirSync(join(root, "nested"));
    writeFileSync(
      join(root, "nested", "provider.ts"),
      `
        class NotesDO {
          /** Return one note without changing it. */
          @rpc({ principals: ["code", "user"], effect: { kind: "open" }, tier: "open", sensitivity: "read" })
          async getNote(id: string): Promise<{ id: string }> { return { id }; }

          private helper(): void {}
        }
      `
    );
    writeFileSync(
      join(root, "provider.test.ts"),
      `class Fake { @rpc({ principals: ["code"], tier: "open", sensitivity: "read" }) nope() {} }`
    );

    expect(
      await collectWorkspaceRpcCatalog(root, {
        provider: "workers/notes",
        authority: { requests: [], provides: [] },
      })
    ).toEqual([
      expect.objectContaining({
        className: "NotesDO",
        name: "getNote",
        signature: "getNote(id: string): Promise<{ id: string }>",
        description: "Return one note without changing it.",
        effect: { kind: "open" },
        access: {
          principals: ["code", "user"],
          tier: "open",
          sensitivity: "read",
        },
        inputContractDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
  });

  it("resolves receiver capabilities against the sealed manifest and binds method contracts", async () => {
    const root = mkdtempSync(join(tmpdir(), "vibestudio-rpc-capability-"));
    writeFileSync(
      join(root, "provider.ts"),
      `class NotesDO {
        @rpc({
          principals: ["code", "user"],
          effect: {
            kind: "userland-capability",
            capability: "notes.delete",
            resource: { kind: "receiver-object" }
          },
          tier: "critical",
          sensitivity: "destructive"
        })
        async deleteNote(id: string): Promise<void> {}
      }`
    );
    const catalog = await collectWorkspaceRpcCatalog(root, {
      provider: "workers/notes",
      authority: {
        requests: [],
        provides: [
          {
            name: "notes.delete",
            title: "Delete note",
            action: "delete this note",
            tier: "critical",
            sensitivity: "destructive",
            resourceType: "note-store",
            presentation: { domain: "files", verb: "manage" },
            notability: "headline",
            grantScopes: ["once"],
          },
        ],
      },
    });
    expect(catalog[0]?.userlandCapability).toMatchObject({
      localName: "notes.delete",
      resourceType: "note-store",
      canonicalCapability: expect.stringMatching(
        /^userland:workers\/notes\/notes\.delete#[0-9a-f]{64}$/
      ),
      definitionDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("seals a schema-owned receiver from its runtime-checked build binding", async () => {
    const root = mkdtempSync(join(tmpdir(), "vibestudio-schema-rpc-capability-"));
    writeFileSync(
      join(root, "provider.ts"),
      `class NotesDO {
        @schemaRpc()
        async deleteNote(id: string): Promise<void> {}
      }`
    );
    const catalog = await collectWorkspaceRpcCatalog(root, {
      provider: "workers/notes",
      authority: {
        requests: [],
        provides: [
          {
            name: "notes.delete",
            title: "Delete note",
            action: "delete this note",
            tier: "critical",
            sensitivity: "destructive",
            resourceType: "note-store",
            presentation: { domain: "files", verb: "manage" },
            notability: "headline",
            grantScopes: ["once"],
          },
        ],
      },
      rpcSchemas: {
        NotesDO: defineServiceMethods({
          deleteNote: {
            args: z.tuple([z.string()]),
            returns: z.void(),
            capability: "notes.delete",
            authority: { principals: ["host", "code"] },
            tier: { tier: "critical", session: "family", rationale: "Destructive mutation." },
            access: { sensitivity: "destructive" },
            directEffect: {
              kind: "userland-capability",
              capability: "notes.delete",
              resource: { kind: "receiver-object" },
            },
          },
        }),
      },
    });
    expect(catalog[0]).toMatchObject({
      name: "deleteNote",
      access: {
        principals: ["host", "code"],
        tier: "critical",
        sensitivity: "destructive",
      },
      effect: {
        kind: "userland-capability",
        capability: "notes.delete",
        resource: { kind: "receiver-object" },
      },
      userlandCapability: {
        localName: "notes.delete",
      },
    });
  });

  it("seals handle producers and consumers into one definition identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "vibestudio-rpc-handle-"));
    writeFileSync(
      join(root, "index.ts"),
      `class Notes {
        @rpc({
          principals: ["code"],
          effect: { kind: "open" },
          produces: { kind: "opaque-handle", capability: "notes.read" },
          tier: "open",
          sensitivity: "read"
        })
        async prepareNote(id: string): Promise<unknown> {}

        @rpc({
          principals: ["code"],
          effect: {
            kind: "userland-capability",
            capability: "notes.read",
            resource: { kind: "opaque-handle", argument: 0 }
          },
          tier: "gated",
          sensitivity: "read"
        })
        async readNote(handle: string): Promise<unknown> {}
      }`
    );
    const catalog = await collectWorkspaceRpcCatalog(root, {
      provider: "workers/notes",
      authority: {
        requests: [],
        provides: [
          {
            name: "notes.read",
            title: "Read note",
            action: "read this note",
            tier: "gated",
            sensitivity: "read",
            resourceType: "note",
            presentation: { domain: "files", verb: "see" },
            notability: "headline",
            grantScopes: ["once", "session"],
          },
        ],
      },
    });
    const producer = catalog.find((method) => method.name === "prepareNote");
    const consumer = catalog.find((method) => method.name === "readNote");
    expect(producer?.producesHandle).toMatchObject({
      localName: "notes.read",
      canonicalCapability: consumer?.userlandCapability?.canonicalCapability,
      definitionDigest: consumer?.userlandCapability?.definitionDigest,
      resourceType: "note",
    });
    expect(producer).not.toHaveProperty("_handleCapability");
  });
});
