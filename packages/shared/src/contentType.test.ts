import { describe, expect, it } from "vitest";
import { contentTypeForPath } from "./contentType.js";

describe("contentTypeForPath", () => {
  it.each([
    ["assets/guide.pdf", "application/pdf"],
    ["assets/photo.avif", "image/avif"],
    ["assets/track.m4a", "audio/mp4"],
    ["assets/movie.webm", "video/webm"],
    ["assets/font.woff2", "font/woff2"],
    ["assets/readme.md", "text/markdown; charset=utf-8"],
  ])("maps %s to %s", (filePath, contentType) => {
    expect(contentTypeForPath(filePath)).toBe(contentType);
  });

  it("is case-insensitive and ignores URL suffixes", () => {
    expect(contentTypeForPath("assets/REPORT.PDF?download=0#page=1")).toBe("application/pdf");
    expect(contentTypeForPath("assets\\PHOTO.PNG")).toBe("image/png");
  });

  it("keeps unknown files downloadable", () => {
    expect(contentTypeForPath("assets/archive.zip")).toBe("application/octet-stream");
  });
});
