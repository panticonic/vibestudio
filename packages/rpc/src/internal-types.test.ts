import { describe, expect, it } from "vitest";
import {
  bindExecutionSession,
  executionSessionNonceFor,
  mergeRpcOptions,
  bindVerifiedExternalContext,
  verifiedExternalContextFor,
} from "./internal-types.js";

describe("verified external RPC context", () => {
  it("seals an immutable out-of-band fact that JSON cannot carry", () => {
    const source = {
      class: "external" as const,
      latchEpoch: 4,
      externalKeys: ["api:webhook:" + "a".repeat(64)],
    };
    const options = bindVerifiedExternalContext({}, source);
    const sealed = verifiedExternalContextFor(options)!;

    source.externalKeys[0] = "api:webhook:" + "b".repeat(64);
    expect(sealed).toEqual({
      class: "external",
      latchEpoch: 4,
      externalKeys: ["api:webhook:" + "a".repeat(64)],
    });
    expect(Object.isFrozen(sealed)).toBe(true);
    expect(Object.isFrozen(sealed.externalKeys)).toBe(true);
    expect(JSON.parse(JSON.stringify(options))).toEqual({});
    expect(verifiedExternalContextFor(JSON.parse(JSON.stringify(options)))).toBeNull();
  });

  it("fails closed for internal, empty, or unbounded claimed lineage", () => {
    expect(() =>
      bindVerifiedExternalContext({}, { class: "internal", latchEpoch: 0, externalKeys: [] })
    ).toThrow(/bounded external lineage/);
    expect(() =>
      bindVerifiedExternalContext({}, { class: "external", latchEpoch: 0, externalKeys: [] })
    ).toThrow(/bounded external lineage/);
    expect(() =>
      bindVerifiedExternalContext(
        {},
        {
          class: "external",
          latchEpoch: 0,
          externalKeys: Array.from({ length: 257 }, (_, index) => `api:test:${index}`),
        }
      )
    ).toThrow(/bounded external lineage/);
  });
});

describe("runtime RPC option composition", () => {
  it("retains hidden facts, accepts an explicit admission replacement, and never serializes them", () => {
    const controller = new AbortController();
    const original = bindExecutionSession(
      bindVerifiedExternalContext(
        {
          signal: controller.signal,
          destination: { kind: "workspace" as const, workspaceId: "workspace:destination" },
        },
        { class: "external", latchEpoch: 3, externalKeys: ["api:webhook:source"] }
      ),
      "admission:original"
    );
    const traced = mergeRpcOptions(original, { readOnly: true });
    expect(executionSessionNonceFor(traced)).toBe("admission:original");
    expect(verifiedExternalContextFor(traced)).toEqual(verifiedExternalContextFor(original));
    expect(traced.signal).toBe(controller.signal);
    expect(traced.destination).toBe(original.destination);
    const replaced = mergeRpcOptions(traced, bindExecutionSession({}, "admission:replacement"));
    expect(executionSessionNonceFor(replaced)).toBe("admission:replacement");
    expect(executionSessionNonceFor(original)).toBe("admission:original");
    const wireCopy = JSON.parse(JSON.stringify(replaced));
    expect(executionSessionNonceFor(wireCopy)).toBeUndefined();
    expect(verifiedExternalContextFor(wireCopy)).toBeNull();
    expect(verifiedExternalContextFor(replaced)).toEqual(verifiedExternalContextFor(original));
  });
});
