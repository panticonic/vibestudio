import { describe, expect, it } from "vitest";
import { FAVICON_MIME_TYPES, detectFaviconMimeType } from "./favicon.js";
import { PAGE_FAVICONS_TABLE_SQL } from "./storage/schema.js";

describe("detectFaviconMimeType", () => {
  it.each([
    ["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    ["image/jpeg", [0xff, 0xd8, 0xff, 0xe0]],
    ["image/gif", Buffer.from("GIF89a")],
    ["image/webp", Buffer.from("RIFF0000WEBP")],
    ["image/x-icon", [0x00, 0x00, 0x01, 0x00, 0x01, 0x00]],
    ["image/bmp", Buffer.from("BM")],
  ])("recognizes %s from its byte signature", (mimeType, input) => {
    expect(detectFaviconMimeType(Uint8Array.from(input))).toBe(mimeType);
  });

  it("recognizes SVG after a valid XML prologue instead of searching arbitrary text", () => {
    expect(
      detectFaviconMimeType(
        Buffer.from(`\uFEFF<?xml version="1.0"?><!-- icon --><svg viewBox="0 0 1 1"></svg>`)
      )
    ).toBe("image/svg+xml");
    expect(detectFaviconMimeType(Buffer.from(`<html>the text &lt;svg is not an icon</html>`))).toBe(
      null
    );
  });

  it("recognizes AVIF from ISO-BMFF compatible brands", () => {
    const bytes = Buffer.alloc(24);
    bytes.writeUInt32BE(24, 0);
    bytes.write("ftyp", 4, "ascii");
    bytes.write("mif1", 8, "ascii");
    bytes.writeUInt32BE(0, 12);
    bytes.write("avif", 16, "ascii");
    expect(detectFaviconMimeType(bytes)).toBe("image/avif");
  });

  it("does not infer a format from unrecognized bytes", () => {
    expect(detectFaviconMimeType(Buffer.from("favicon.ico"))).toBe(null);
  });
});

describe("page favicon storage schema", () => {
  it("derives its MIME constraint from the canonical format vocabulary", () => {
    for (const mimeType of FAVICON_MIME_TYPES) {
      expect(PAGE_FAVICONS_TABLE_SQL).toContain(`'${mimeType}'`);
    }
    expect(PAGE_FAVICONS_TABLE_SQL.match(/'image\//g)).toHaveLength(FAVICON_MIME_TYPES.length);
  });
});
