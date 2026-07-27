import { describe, expect, it } from "vitest";
import {
  describeEvalBindingSurface,
  describeEvalBindingIndex,
  describeEvalMethod,
  EVAL_RUNTIME_METHOD_NOTES,
  evalRuntimeServiceName,
  invalidHelpArgumentResponse,
} from "./evalSurfaceHelp.js";

describe("describeEvalBindingSurface (help('<binding>') reflects the injected surface)", () => {
  // The fs case: the injected client exposes open()/readFile()/mktemp() but NOT the low-level
  // handle* wire methods, which the raw service schema DOES advertise.
  const fsService = {
    open: { description: "wire open → { handleId }", argsSchema: {} },
    readFile: { description: "read a file", argsSchema: {} },
    handleClose: { description: "low-level handle close", argsSchema: {} },
    handleStat: { description: "low-level handle stat", argsSchema: {} },
  };

  it("drops wire methods the injected object doesn't expose (no fs.handleClose leak)", () => {
    const out = describeEvalBindingSurface("fs", ["open", "readFile", "mktemp"], fsService);
    expect(out).not.toBeNull();
    expect(Object.keys(out!.methods).sort()).toEqual(["mktemp", "open", "readFile"]);
    expect(out!.methods).not.toHaveProperty("handleClose");
    expect(out!.methods).not.toHaveProperty("handleStat");
  });

  it("a known ergonomic note WINS over the raw wire schema (fs.open → FileHandle, not {handleId})", () => {
    const out = describeEvalBindingSurface("fs", ["open"], fsService);
    expect(out!.methods["open"]).toBe(EVAL_RUNTIME_METHOD_NOTES["fs.open"]);
    expect((out!.methods["open"] as { description: string }).description).toContain("FileHandle");
    expect((out!.methods["open"] as { description: string }).description).not.toContain("handleId");
  });

  it("reuses the RPC-service schema for methods with no override (rich arg info preserved)", () => {
    const out = describeEvalBindingSurface("fs", ["readFile"], fsService);
    expect(out!.methods["readFile"]).toBe(fsService.readFile);
  });

  it("maps ergonomic Git help to the canonical gitInterop service contract", () => {
    const importSchema = {
      description: "Import an external Git project.",
      argsSchema: { type: "array", items: [{ type: "object" }] },
    };
    const out = describeEvalBindingSurface(
      "git",
      ["importProject"],
      { importProject: importSchema },
      EVAL_RUNTIME_METHOD_NOTES,
      evalRuntimeServiceName("git")
    );

    expect(evalRuntimeServiceName("git")).toBe("gitInterop");
    expect(evalRuntimeServiceName("vcs")).toBe("vcs");
    expect(out!.methods["importProject"]).toBe(importSchema);
    expect(out!.note).toContain('rpc.call("main", "gitInterop.…"');
  });

  it("documents the runtime-only blobstore byte helpers without inventing wire methods", () => {
    const putBase64Schema = { description: "wire base64 method", argsSchema: {} };
    const out = describeEvalBindingSurface("blobstore", ["putBase64", "putBytes", "getBytes"], {
      putBase64: putBase64Schema,
    });

    expect(out!.methods["putBase64"]).toBe(putBase64Schema);
    expect(out!.methods["putBytes"]).toBe(EVAL_RUNTIME_METHOD_NOTES["blobstore.putBytes"]);
    const description = (out!.methods["putBytes"] as { description: string }).description;
    expect(description).toContain("Uint8Array | ArrayBuffer");
    expect(description).toContain("MIME metadata");
    expect(out!.methods["getBytes"]).toBe(EVAL_RUNTIME_METHOD_NOTES["blobstore.getBytes"]);
    expect((out!.methods["getBytes"] as { description: string }).description).toContain(
      "Uint8Array | null"
    );
  });

  it("uses the canonical semantic VCS schema and documents the runtime commit wrapper", () => {
    const historySchema = {
      description: "history({ root, limit?, cursor? }) → a focused chronological projection",
      argsSchema: {},
    };
    const result = describeEvalBindingSurface("vcs", ["history", "commit"], {
      history: historySchema,
    });
    expect(result?.methods["history"]).toBe(historySchema);
    expect(result?.methods["commit"]).toMatchObject({
      description: expect.stringContaining("complete local application chain"),
    });
  });

  it("describes mktemp as a temp FILE path (not a directory) so it isn't misused", () => {
    const out = describeEvalBindingSurface("fs", ["mktemp"], fsService);
    const desc = (out!.methods["mktemp"] as { description: string }).description;
    expect(desc).toContain("NOT created");
    expect(desc).toMatch(/mkdir|NOT Node's mkdtemp/);
  });

  it("describes the composed temp-directory helper separately", () => {
    const out = describeEvalBindingSurface("fs", ["mkdtemp"], fsService);
    const desc = (out!.methods["mkdtemp"] as { description: string }).description;
    expect(desc).toContain("temp DIRECTORY");
    expect(desc).toContain("creates");
  });

  it("documents the worker launch/retire path via runtime.createEntity/retireEntity", () => {
    const out = describeEvalBindingSurface("runtime", ["createEntity", "retireEntity"], {});

    const createDesc = (out!.methods["createEntity"] as { description: string }).description;
    expect(createDesc).toContain('kind: "worker"');
    expect(createDesc).toContain("ctx:${ctx.contextId}");
    expect(createDesc).toContain("workers.listSources()");
    expect(createDesc).toContain("real manifest entry points");
    expect(createDesc).toContain("not that worker code observed");
    expect(createDesc).toContain("implemented by the worker under test");
    expect(createDesc).toContain("immutable instance identity");
    expect(createDesc).toContain("fresh key after each code change");
    expect(createDesc).toContain('rpc.call("main", `workers.listSources`, [])');
    const retireDesc = (out!.methods["retireEntity"] as { description: string }).description;
    expect(retireDesc).toContain("runtime.retireEntity");
    expect(retireDesc).toContain("runtime.listEntities");
  });

  it("documents immutable worker keys and awaited cleanup on the ergonomic surface", () => {
    const out = describeEvalBindingSurface("workers", ["create", "destroy"], {});
    const createDesc = (out!.methods["create"] as { description: string }).description;
    expect(createDesc).toContain("immutable instance identity");
    expect(createDesc).toContain("fresh key");
    expect(createDesc).toContain("handle.targetId");
    expect(createDesc).toContain("finally");
    const destroyDesc = (out!.methods["destroy"] as { description: string }).description;
    expect(destroyDesc).toContain("Await");
    expect(destroyDesc).toContain("stable key");
  });

  it("falls back to a generic introspect note for a live method with no schema or override", () => {
    const out = describeEvalBindingSurface("widget", ["frobnicate"], {});
    expect((out!.methods["frobnicate"] as { description: string }).description).toContain(
      "introspect the return value"
    );
  });

  it("sorts methods and tags the surface as injected-runtime", () => {
    const out = describeEvalBindingSurface("fs", ["readFile", "open", "mktemp"], fsService);
    expect(Object.keys(out!.methods)).toEqual(["mktemp", "open", "readFile"]);
    expect(out!.surface).toBe("injected-runtime");
    expect(out!.note).toContain('rpc.call("main", "fs.…"');
    expect(out!.note).toContain("services.fs");
  });

  it("returns null when there are no live methods (caller falls back to the service schema)", () => {
    expect(describeEvalBindingSurface("vcs", [], { applyEdits: {} })).toBeNull();
  });

  it("keeps binding discovery compact and points to exact per-method help", () => {
    const detailed = describeEvalBindingSurface("vcs", ["status", "edit"], {
      status: {
        description: "Read the current frontier.",
        argsSchema: { deliberately: "large" },
      },
      edit: {
        description: "Author an exact semantic edit.",
        argsSchema: { deliberately: "large" },
      },
    })!;
    expect(describeEvalBindingIndex(detailed)).toEqual({
      name: "vcs",
      surface: "injected-runtime-index",
      note: detailed.note,
      methods: [
        { name: "edit", description: "Author an exact semantic edit." },
        { name: "status", description: "Read the current frontier." },
      ],
      next: 'Call help("vcs.<method>") for that method\'s exact arguments, return schema, and typed errors.',
    });
  });
});

describe("describeEvalMethod", () => {
  it("renders nested discriminated unions completely without returning a deep raw schema", () => {
    const result = describeEvalMethod("vcs.edit", {
      description: "Author exact edits.",
      access: { sensitivity: "write" },
      errors: [{ code: "RevisionChanged", description: "The basis advanced." }],
      seeAlso: ["vcs.revert"],
      argsSchema: {
        type: "array",
        items: [
          {
            type: "object",
            properties: {
              commandId: { type: "string" },
              changes: {
                type: "array",
                items: {
                  anyOf: [
                    {
                      type: "object",
                      properties: {
                        kind: { type: "string", enum: ["text-edit"] },
                        edits: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              start: { type: "integer" },
                              end: { type: "integer" },
                              text: { type: "string" },
                            },
                            required: ["start", "end", "text"],
                          },
                        },
                      },
                      required: ["kind", "edits"],
                    },
                    {
                      type: "object",
                      properties: {
                        kind: { type: "string", enum: ["file-delete"] },
                        fileId: { type: "string" },
                      },
                      required: ["kind", "fileId"],
                    },
                  ],
                },
              },
            },
            required: ["commandId", "changes"],
          },
        ],
      },
      returnsSchema: {
        type: "object",
        properties: { applicationId: { type: "string" } },
        required: ["applicationId"],
      },
    });

    expect(result).toEqual({
      name: "vcs.edit",
      surface: "injected-runtime-method",
      description: "Author exact edits.",
      call: "await vcs.edit(input)",
      arguments: [
        '{ commandId: string; changes: ({ kind: "text-edit"; edits: ({ start: integer; end: integer; text: string })[] } | { kind: "file-delete"; fileId: string })[] }',
      ],
      returns: "{ applicationId: string }",
      access: { sensitivity: "write" },
      errors: [{ code: "RevisionChanged", description: "The basis advanced." }],
      seeAlso: ["vcs.revert"],
      note: "Compact exact types for the injected call. Use the docs service only when machine-readable JSON Schema is needed.",
    });
    expect(JSON.stringify(result)).not.toContain("Max depth exceeded");
    expect(result).not.toHaveProperty("argsSchema");
    expect(result).not.toHaveProperty("returnsSchema");
  });
});

describe("invalidHelpArgumentResponse", () => {
  it("turns help(workers) into a useful non-throwing diagnostic", () => {
    expect(
      invalidHelpArgumentResponse({ create: () => undefined, destroy: () => undefined })
    ).toEqual({
      error: "help() expects a string service or runtime binding name.",
      received: "create, destroy",
      example: 'await help("workers")',
      note:
        "Pass the binding name as a string. For a live object's enumerable methods, " +
        "Object.keys(workers) also works.",
    });
  });
});
