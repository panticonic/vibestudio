/**
 * Tests for normalizeRelativePanelPath.
 */

import { normalizePanelSource, normalizeRelativePanelPath } from "./pathUtils.js";

const WORKSPACE = "/home/user/workspace";

it("normalizes source identity without a local workspace checkout", () => {
  expect(normalizePanelSource("./panels\\nested/../chat/")).toBe("panels/chat");
  for (const source of ["", ".", "/etc/passwd", "C:\\Windows", "../escape"]) {
    expect(() => normalizePanelSource(source)).toThrow();
  }
});

describe("normalizeRelativePanelPath", () => {
  it("normalizes a simple relative path", () => {
    const result = normalizeRelativePanelPath("src/index.ts", WORKSPACE);
    expect(result).toEqual({
      relativePath: "src/index.ts",
      absolutePath: `${WORKSPACE}/src/index.ts`,
    });
  });

  it("strips leading ./", () => {
    const result = normalizeRelativePanelPath("./src/file.ts", WORKSPACE);
    expect(result.relativePath).toBe("src/file.ts");
  });

  it("strips trailing slashes", () => {
    const result = normalizeRelativePanelPath("src/dir/", WORKSPACE);
    expect(result.relativePath).toBe("src/dir");
  });

  it("normalizes backslashes to forward slashes", () => {
    const result = normalizeRelativePanelPath("src\\sub\\file.ts", WORKSPACE);
    expect(result.relativePath).toBe("src/sub/file.ts");
  });

  it("throws for absolute paths", () => {
    expect(() => normalizeRelativePanelPath("/etc/passwd", WORKSPACE)).toThrow("must be relative");
  });

  it("throws for empty path", () => {
    expect(() => normalizeRelativePanelPath("", WORKSPACE)).toThrow("Invalid panel path");
  });

  it("throws for dot path", () => {
    expect(() => normalizeRelativePanelPath(".", WORKSPACE)).toThrow("Invalid panel path");
  });

  it("throws for paths that escape workspace with ..", () => {
    expect(() => normalizeRelativePanelPath("../../etc/passwd", WORKSPACE)).toThrow();
  });
});
