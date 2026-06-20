import { describe, expect, it } from "vitest";
import {
  describeEvalBindingSurface,
  EVAL_RUNTIME_METHOD_NOTES,
  normalizeAmbientRpcCall,
} from "./evalSurfaceHelp.js";

describe("normalizeAmbientRpcCall — eval ambient rpc.call accepts 2-arg and 3-arg forms", () => {
  it("2-arg sugar call(method, args) targets main", () => {
    expect(normalizeAmbientRpcCall("meta.describeService", ["fs"])).toEqual([
      "main",
      "meta.describeService",
      ["fs"],
    ]);
  });

  it("2-arg with omitted args defaults to []", () => {
    expect(normalizeAmbientRpcCall("vcs.status")).toEqual(["main", "vcs.status", []]);
  });

  it("3-arg full-client form call('main', method, args) is accepted (the recurring footgun)", () => {
    expect(normalizeAmbientRpcCall("main", "meta.describeService", ["panelTree"])).toEqual([
      "main",
      "meta.describeService",
      ["panelTree"],
    ]);
  });

  it("3-arg also routes a non-main runtime-id target", () => {
    expect(normalizeAmbientRpcCall("do:workers/x:Y:z", "ping", [1])).toEqual([
      "do:workers/x:Y:z",
      "ping",
      [1],
    ]);
  });
});

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

  it("describes mktemp as a temp FILE path (not a directory) so it isn't misused", () => {
    const out = describeEvalBindingSurface("fs", ["mktemp"], fsService);
    const desc = (out!.methods["mktemp"] as { description: string }).description;
    expect(desc).toContain("NOT created");
    expect(desc).toMatch(/mkdir|NOT Node's mkdtemp/);
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
    expect(out!.note).toContain("services.fs");
  });

  it("returns null when there are no live methods (caller falls back to the service schema)", () => {
    expect(describeEvalBindingSurface("vcs", [], { applyEdits: {} })).toBeNull();
  });
});
