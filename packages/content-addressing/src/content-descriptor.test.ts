import { describe, expect, it } from "vitest";
import { intrinsicContentDescriptor } from "./content-descriptor.js";

describe("intrinsic source descriptors", () => {
  it("keeps text coordinates in UTF-16 while byte length stays UTF-8", () => {
    expect(intrinsicContentDescriptor(new TextEncoder().encode("😀"))).toEqual({
      contentKind: "text",
      byteLength: 4,
      coordinateExtent: 2,
    });
  });
  it("preserves malformed UTF-8 as byte content", () => {
    expect(intrinsicContentDescriptor(new Uint8Array([0xff, 0x00]))).toEqual({
      contentKind: "bytes",
      byteLength: 2,
      coordinateExtent: 2,
    });
  });
});
