import { describe, expect, it } from "vitest";
import { analyzeRetainedFunctionSource } from "./retainedFunction.js";

describe("analyzeRetainedFunctionSource", () => {
  it("accepts portable functions and excludes parameters and local bindings", () => {
    expect(
      analyzeRetainedFunctionSource(
        "({ value }, factor = 2) => { const scaled = value * factor; return scaled; }"
      )
    ).toEqual({ freeNames: [] });
  });

  it("reports globals and captured lexical bindings once in stable order", () => {
    expect(
      analyzeRetainedFunctionSource(
        "function (value) { return Math.max(value, captured) + captured + scopeValue; }"
      )
    ).toEqual({ freeNames: ["Math", "captured", "scopeValue"] });
  });

  it("rejects object method shorthand instead of persisting invalid expression syntax", () => {
    expect(() => analyzeRetainedFunctionSource("double(value) { return value * 2; }")).toThrow(
      /not a function expression/
    );
  });

  it("rejects classes and non-function expressions", () => {
    expect(() => analyzeRetainedFunctionSource("class Example {}")).toThrow(
      /exactly one function expression/
    );
    expect(() => analyzeRetainedFunctionSource("42")).toThrow(/exactly one function expression/);
  });
});
