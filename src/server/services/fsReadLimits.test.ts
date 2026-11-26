import { describe, expect, it } from "vitest";
import { fsMethods } from "../../../packages/service-schemas/src/fs.js";
import { READ_BYTES_MAX_LIMIT, READ_TEXT_MAX_BYTES } from "@vibestudio/shared/fsReadLimits";
import { normalizedReadBytesOptions, normalizedReadTextOptions } from "./fsValues.js";
describe("native filesystem range protocol parity", () => {
  it("admits the same byte range maximum in wire and implementation", () => {
    const options = { limit: READ_BYTES_MAX_LIMIT };
    expect(fsMethods.readBytes.args.parse(["file", options])).toEqual(["file", options]);
    expect(normalizedReadBytesOptions(options).limit).toBe(READ_BYTES_MAX_LIMIT);
    expect(() => fsMethods.readBytes.args.parse(["file", { limit: READ_BYTES_MAX_LIMIT + 1 }])).toThrow();
    expect(() => normalizedReadBytesOptions({ limit: READ_BYTES_MAX_LIMIT + 1 })).toThrow();
  });
  it("admits the same text byte maximum in wire and implementation", () => {
    const options = { maxBytes: READ_TEXT_MAX_BYTES };
    expect(fsMethods.readText.args.parse(["file", options])).toEqual(["file", options]);
    expect(normalizedReadTextOptions(options).maxBytes).toBe(READ_TEXT_MAX_BYTES);
    expect(() => fsMethods.readText.args.parse(["file", { maxBytes: READ_TEXT_MAX_BYTES + 1 }])).toThrow();
    expect(() => normalizedReadTextOptions({ maxBytes: READ_TEXT_MAX_BYTES + 1 })).toThrow();
  });
});
