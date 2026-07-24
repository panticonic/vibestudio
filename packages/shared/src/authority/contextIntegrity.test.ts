import { describe, expect, it } from "vitest";
import {
  canonicalLineageSet,
  ContextIntegrityLatch,
  isContentAddressedLineageKey,
  isLineageSetKey,
  joinContextIntegrity,
  parseLineageKey,
} from "./contextIntegrity.js";

describe("context integrity", () => {
  it("is monotone and increments the epoch only for new sources", () => {
    const latch = new ContextIntegrityLatch();
    latch.ingest({
      key: "web:example.com",
      class: "external",
      via: "web-extract",
      at: new Date(0),
    });
    latch.ingest({
      key: "web:example.com",
      class: "external",
      via: "web-extract",
      at: new Date(1),
    });
    expect(latch.snapshot()).toMatchObject({
      class: "external",
      latchEpoch: 1,
      sources: [{ key: "web:example.com", count: 2 }],
    });
  });

  it("refuses an oversized outside batch without partially advancing the latch", () => {
    const latch = new ContextIntegrityLatch();
    const inputs = Array.from(
      { length: ContextIntegrityLatch.MAX_DISTINCT_KEYS + 1 },
      (_, index) => ({
        key: `web:source-${index}.example`,
        class: "external" as const,
        via: "test-batch",
      })
    );

    expect(() => latch.ingestMany(inputs)).toThrow(/256 outside sources/);
    expect(latch.snapshot()).toEqual({ class: "internal", latchEpoch: 0, sources: [] });
  });

  it("does not block internal content when the bounded index contains only outside sources", () => {
    const latch = new ContextIntegrityLatch();
    latch.ingestMany(
      Array.from({ length: ContextIntegrityLatch.MAX_DISTINCT_KEYS }, (_, index) => ({
        key: `web:source-${index}.example`,
        class: "external" as const,
        via: "test-fill",
      }))
    );

    expect(() =>
      latch.ingest({
        key: `file:repository/file@change`,
        class: "internal",
        via: "test-internal",
      })
    ).not.toThrow();
    expect(latch.snapshot()).toMatchObject({
      class: "external",
      latchEpoch: ContextIntegrityLatch.MAX_DISTINCT_KEYS,
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
    expect(parseLineageKey(`repo:vibestudio://workspace/source@state:${"a".repeat(64)}`)).toBe(
      `repo:vibestudio://workspace/source@state:${"a".repeat(64)}`
    );
    expect(isContentAddressedLineageKey(`blob:${"a".repeat(64)}`)).toBe(true);
    expect(isContentAddressedLineageKey("web:example.com")).toBe(false);
    expect(() => parseLineageKey("web: example.com")).toThrow(/Invalid lineage/);
    expect(() => parseLineageKey("mail:inbox:cafe\u0301")).toThrow(/Invalid lineage/);
  });

  it("content-addresses canonical leaf lineage sets without permitting nesting", () => {
    const left = canonicalLineageSet(["web:b.example", "web:a.example", "web:b.example"]);
    const right = canonicalLineageSet(["web:a.example", "web:b.example"]);

    expect(left).toEqual(right);
    expect(left.members).toEqual(["web:a.example", "web:b.example"]);
    expect(isLineageSetKey(left.key)).toBe(true);
    expect(isContentAddressedLineageKey(left.key)).toBe(true);
    expect(() => canonicalLineageSet([left.key, "web:c.example"])).toThrow(/nested sets/);
  });
});
