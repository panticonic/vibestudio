import { describe, expect, it } from "vitest";
import { compactHomePath, documentTitleForSession } from "./documentTitle.js";
import type { SessionInfo } from "./types.js";

describe("documentTitleForSession", () => {
  it("uses a descriptive label when one is available", () => {
    expect(documentTitleForSession(session({ label: "vim package.json" }))).toBe(
      "vim package.json"
    );
  });

  it("compacts absolute home paths in terminal-provided labels", () => {
    expect(documentTitleForSession(session({ label: "/home/alice/project" }))).toBe("~/project");
  });

  it("falls back to the cwd when the label is generic", () => {
    expect(documentTitleForSession(session({ label: "Shell", cwd: "/home/alice/project" }))).toBe(
      "~/project"
    );
  });
});

describe("compactHomePath", () => {
  it("compacts common home directory prefixes", () => {
    expect(compactHomePath("/home/alice")).toBe("~");
    expect(compactHomePath("/home/alice/src/vibestudio")).toBe("~/src/vibestudio");
    expect(compactHomePath("/Users/alice/src/vibestudio")).toBe("~/src/vibestudio");
    expect(compactHomePath("C:\\Users\\alice\\src\\vibestudio")).toBe("~\\src\\vibestudio");
  });

  it("leaves other titles alone", () => {
    expect(compactHomePath("/var/log")).toBe("/var/log");
    expect(compactHomePath("pnpm dev")).toBe("pnpm dev");
  });
});

function session(opts: { label?: string; cwd?: string }): SessionInfo {
  return {
    sessionId: "session-1",
    label: opts.label ?? "Shell",
    command: { argv: ["/bin/bash"], cwd: opts.cwd ?? "/repo" },
    cols: 80,
    rows: 24,
    alive: true,
    detectedPorts: [],
    detectedUrls: [],
    lastActivityAt: 0,
    bytesOut: 0,
    meta: {},
  };
}
