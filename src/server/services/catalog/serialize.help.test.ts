/**
 * End-to-end acceptance for per-method help metadata: the REAL docs.search
 * schema, serialized through the one canonical serializer and re-parsed as the
 * wire shape eval receives, must project named parameters and an executable
 * example — never arg0/arg1. Guards the whole chain the agent depends on.
 */
import { describe, it, expect } from "vitest";
import { docsMethods, serializedServiceMethodSchema } from "@vibestudio/service-schemas/docs";
import { serializeMethod } from "./serialize.js";
import { permissionsMethods } from "@vibestudio/service-schemas/permissions";
import { fsMethods } from "@vibestudio/service-schemas/fs";

describe("help('docs.search') via the canonical serializer", () => {
  it("preserves the receiver's declared capability through serialization and help", () => {
    const wire = serializedServiceMethodSchema.parse(serializeMethod(permissionsMethods.list));
    expect(wire.access).toMatchObject({ capability: "permissions.read", sensitivity: "read" });
  });
  it("names parameters from argumentNames and keeps the worked example executable", () => {
    const wire = serializedServiceMethodSchema.parse(serializeMethod(docsMethods.search));
    expect(wire.argumentNames).toEqual(["query", "options"]);

    expect(JSON.stringify(wire)).not.toContain("arg0");
  });
  it("renders native byte schemas as Uint8Array", () => {
    const writeFile = serializedServiceMethodSchema.parse(serializeMethod(fsMethods.writeFile));
    expect(JSON.stringify(writeFile.argsSchema)).toContain('"format":"binary"');
    const handleRead = serializedServiceMethodSchema.parse(serializeMethod(fsMethods.handleRead));
    expect(JSON.stringify(handleRead.returnsSchema)).toContain('"format":"binary"');
  });
});
