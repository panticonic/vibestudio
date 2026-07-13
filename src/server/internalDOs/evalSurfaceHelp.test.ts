import { describe, expect, it } from "vitest";
import {
  describeEvalBindingSurface,
  EVAL_RUNTIME_METHOD_NOTES,
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

  it("documents the runtime-only blobstore.putBytes helper without inventing a wire method", () => {
    const putBase64Schema = { description: "wire base64 method", argsSchema: {} };
    const out = describeEvalBindingSurface("blobstore", ["putBase64", "putBytes"], {
      putBase64: putBase64Schema,
    });

    expect(out!.methods["putBase64"]).toBe(putBase64Schema);
    expect(out!.methods["putBytes"]).toBe(EVAL_RUNTIME_METHOD_NOTES["blobstore.putBytes"]);
    const description = (out!.methods["putBytes"] as { description: string }).description;
    expect(description).toContain("Uint8Array | ArrayBuffer");
    expect(description).toContain("MIME metadata");
  });

  it("documents runtime-only VCS history signatures", () => {
    const result = describeEvalBindingSurface("vcs", ["fileHistory", "editsByTurn"], {});
    expect(result?.methods["fileHistory"]).toMatchObject({
      description: expect.stringContaining("fileHistory({ path, repoPath?, head?, limit? })"),
    });
    expect(result?.methods["editsByTurn"]).toMatchObject({
      description: expect.stringContaining("editsByTurn(turnId)"),
    });
  });

  it("describes mktemp as a temp FILE path (not a directory) so it isn't misused", () => {
    const out = describeEvalBindingSurface("fs", ["mktemp"], fsService);
    const desc = (out!.methods["mktemp"] as { description: string }).description;
    expect(desc).toContain("NOT created");
    expect(desc).toMatch(/mkdir|NOT Node's mkdtemp/);
  });

  it("documents the worker launch/retire path via runtime.createEntity/retireEntity", () => {
    const out = describeEvalBindingSurface("runtime", ["createEntity", "retireEntity"], {});

    const createDesc = (out!.methods["createEntity"] as { description: string }).description;
    expect(createDesc).toContain('kind: "worker"');
    expect(createDesc).toContain("ctx:${ctx.contextId}");
    expect(createDesc).toContain("workers.listSources()");
    expect(createDesc).toContain("real manifest entry points");
    expect(createDesc).toContain("not that worker code observed");
    expect(createDesc).toContain("readNonSecretProbe");
    expect(createDesc).toContain('rpc.call("main", `workers.listSources`, [])');
    const retireDesc = (out!.methods["retireEntity"] as { description: string }).description;
    expect(retireDesc).toContain("runtime.retireEntity");
    expect(retireDesc).toContain("runtime.listEntities");
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
