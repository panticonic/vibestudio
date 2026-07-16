import { describe, expect, it } from "vitest";
import { createTestDO } from "@vibestudio/durable/test-utils";
import { EvalDO } from "./evalDO.js";

function priv<T = unknown>(instance: object, key: string): T {
  return (instance as Record<string, unknown>)[key] as T;
}

function setPriv(instance: object, key: string, value: unknown): void {
  (instance as Record<string, unknown>)[key] = value;
}

const analyzer = {
  analyzeRetainedFunctionSource(source: string): { freeNames: string[] } {
    if (source.startsWith("double(")) throw new Error("not a function expression");
    return { freeNames: source.includes("captured") ? ["captured"] : [] };
  },
};

describe("EvalDO retained executable persistence", () => {
  it("persists portable function expressions but drops method shorthand and closures", async () => {
    const { instance } = await createTestDO(EvalDO);
    setPriv(instance, "engine", analyzer);
    setPriv(instance, "currentRunBindings", {});
    setPriv(instance, "currentDefinitionProvenance", {
      sourceDigest: "a".repeat(64),
      runDigest: "b".repeat(64),
    });
    const serialize = priv<(value: (...args: unknown[]) => unknown, path: string) => unknown>(
      instance,
      "serializeRetainedExecutable"
    ).bind(instance);

    expect(serialize((value) => value, "portable")).toMatchObject({
      source: expect.stringContaining("=>"),
      definitionSourceDigest: "a".repeat(64),
      definitionRunDigest: "b".repeat(64),
    });
    const method = {
      double(value: unknown) {
        return Number(value) * 2;
      },
    }.double;
    expect(serialize(method, "method")).toBeNull();
    const captured = 2;
    expect(serialize((value: unknown) => Number(value) * captured, "closure")).toBeNull();
  });

  it("rejects a hydrated closure before compiling or invoking it", async () => {
    const { instance } = await createTestDO(EvalDO);
    setPriv(instance, "engine", analyzer);
    setPriv(instance, "currentRunBindings", {});
    setPriv(instance, "currentEvalInvocation", { runId: "run-1", credential: "credential" });
    const deserialize = priv<
      (
        record: { source: string; definitionSourceDigest: string; definitionRunDigest: string },
        path: string
      ) => (...args: unknown[]) => unknown
    >(instance, "deserializeRetainedExecutable").bind(instance);
    const wrapper = deserialize(
      {
        source: "(value) => value + captured",
        definitionSourceDigest: "a".repeat(64),
        definitionRunDigest: "b".repeat(64),
      },
      "closure"
    );

    expect(() => wrapper(1)).toThrow(
      expect.objectContaining({
        code: "EVAL_INVOCATION_INVALID",
        message: expect.stringContaining("captured"),
      })
    );
  });
});
