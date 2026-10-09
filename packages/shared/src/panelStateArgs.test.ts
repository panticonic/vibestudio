import { describe, expect, it } from "vitest";
import { applyStateArgsMergePatch, createJsonMergePatch } from "./panelStateArgs.js";

describe("panel state merge patches", () => {
  it("treats prototype property names as ordinary JSON keys", () => {
    const patch = JSON.parse('{"__proto__":{"owned":true},"constructor":{"name":"value"}}');
    const result = applyStateArgsMergePatch({}, patch);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(JSON.stringify(result)).toBe(JSON.stringify(patch));
    expect(applyStateArgsMergePatch(result, JSON.parse('{"__proto__":null}'))).toEqual({
      constructor: { name: "value" },
    });
  });

  it("diffs nested replacement without losing deletions or prototype keys", () => {
    const before = JSON.parse('{"__proto__":{"old":true},"notes":{"a":"keep","b":"remove"}}');
    const after = JSON.parse('{"__proto__":{"next":true},"notes":{"a":"keep","c":"new"}}');
    const patch = createJsonMergePatch(before, after) as Record<string, unknown>;
    expect(applyStateArgsMergePatch(before, patch)).toEqual(after);
    expect(
      applyStateArgsMergePatch(before, createJsonMergePatch(before, {}) as Record<string, unknown>)
    ).toEqual({});
  });
});
