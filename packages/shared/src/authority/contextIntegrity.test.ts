import { describe, expect, it } from "vitest";
import {
  ContextIntegrityLatch,
  isContentAddressedLineageKey,
  joinContextIntegrity,
  parseLineageKey,
} from "./contextIntegrity.js";

describe("context integrity", () => {
  it("is monotone and increments the epoch only for new sources", () => {
    const latch = new ContextIntegrityLatch();
    latch.ingest({ key: "web:example.com", class: "external", via: "web-extract", at: new Date(0) });
    latch.ingest({ key: "web:example.com", class: "external", via: "web-extract", at: new Date(1) });
    expect(latch.snapshot()).toMatchObject({
      class: "external",
      latchEpoch: 1,
      sources: [{ key: "web:example.com", count: 2 }],
    });
  });

  it("joins harness and server facts without permitting under-reporting", () => {
    expect(
      joinContextIntegrity(
        { class: "internal", latchEpoch: 1, externalKeys: [] },
        { class: "external", latchEpoch: 2, externalKeys: ["log:server"] }
      )
    ).toEqual({ class: "external", latchEpoch: 2, externalKeys: ["log:server"] });
  });

  it("allows vouches only for content-addressed key kinds", () => {
    expect(isContentAddressedLineageKey("repo:github.com/org/repo@abc123")).toBe(true);
    expect(isContentAddressedLineageKey(`blob:${"a".repeat(64)}`)).toBe(true);
    expect(isContentAddressedLineageKey("web:example.com")).toBe(false);
    expect(() => parseLineageKey("web: example.com")).toThrow(/Invalid lineage/);
  });
});
