import { describe, expect, it } from "vitest";
import { normalizeFavicon } from "../normalize/favicon.js";

const formats = [
  ["image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0])],
  ["image/x-icon", Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00])],
  ["image/svg+xml", Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`)],
] as const;

describe("normalizeFavicon", () => {
  it.each(formats)("preserves validated %s bytes", (mimeType, data) => {
    const result = normalizeFavicon(
      {
        url: "https://example.test/path",
        sourceUrl: `https://cdn.example.test/icon`,
        data,
        // Browser database hints are deliberately not trusted.
        mimeType: "image/png",
      },
      123
    );

    expect(result).toEqual({
      pageUrl: "https://example.test/path",
      origin: "https://example.test",
      sourceUrl: "https://cdn.example.test/icon",
      data: data.toString("base64"),
      mimeType,
      updatedAt: 123,
    });
  });

  it("rejects non-image bytes and non-web page associations", () => {
    expect(
      normalizeFavicon({
        url: "https://example.test",
        data: Buffer.from("not an image"),
        mimeType: "image/png",
      })
    ).toBeNull();
    expect(
      normalizeFavicon({
        url: "file:///tmp/page.html",
        data: formats[0][1],
        mimeType: "image/png",
      })
    ).toBeNull();
  });

  it("does not retain a non-web source URL", () => {
    expect(
      normalizeFavicon(
        {
          url: "https://example.test",
          sourceUrl: "data:image/png;base64,AAAA",
          data: formats[0][1],
          mimeType: "image/png",
        },
        123
      )
    ).not.toHaveProperty("sourceUrl");
  });
});
