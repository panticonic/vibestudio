/**
 * End-to-end acceptance for per-method help metadata: the REAL docs.search
 * schema, serialized through the one canonical serializer and re-parsed as the
 * wire shape eval receives, must project named parameters and an executable
 * example — never arg0/arg1. Guards the whole chain the agent depends on.
 */
import { describe, it, expect } from "vitest";
import { docsMethods, serializedServiceMethodSchema } from "@vibestudio/service-schemas/docs";
import { serializeMethod } from "./serialize.js";
import { describeEvalMethod } from "../../../../packages/builtin/src/eval-engine/evalSurfaceHelp.js";

describe("help('docs.search') via the canonical serializer", () => {
  it("names parameters from argumentNames and keeps the worked example executable", () => {
    const wire = serializedServiceMethodSchema.parse(serializeMethod(docsMethods.search));
    expect(wire.argumentNames).toEqual(["query", "options"]);

    const description = describeEvalMethod("docs.search", wire);
    expect(description.call).toBe("await docs.search(query, options)");
    expect(description.parameters.map((parameter) => parameter.name)).toEqual(["query", "options"]);
    expect(description.examples?.[0]).toEqual({
      call: 'await docs.search("store a blob and get a digest", {"limit":5})',
    });
    expect(JSON.stringify(description)).not.toContain("arg0");
  });
});
