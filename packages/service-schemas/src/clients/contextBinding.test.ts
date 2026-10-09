import { describe, expect, it } from "vitest";
import { bindContextArgs } from "./contextBinding.js";

describe("context-bound argument binding", () => {
  it("supplies the bound context for a context-bound method", () => {
    expect(bindContextArgs("vcs", "status", [], "ctx-a")).toEqual([{ contextId: "ctx-a" }]);
    expect(bindContextArgs("vcs", "query", [{ text: "x" }], "ctx-a")).toEqual([
      { contextId: "ctx-a", text: "x" },
    ]);
  });

  it("keeps an explicit context and leaves other methods untouched", () => {
    expect(bindContextArgs("vcs", "status", [{ contextId: "ctx-b" }], "ctx-a")).toEqual([
      { contextId: "ctx-b" },
    ]);
    expect(bindContextArgs("blobstore", "getText", ["digest"], "ctx-a")).toEqual(["digest"]);
  });
});
