import { describe, expect, it } from "vitest";
import { parseBaseTemplateReleaseArtifact } from "./baseTemplateRelease.js";

const pin = {
  url: "git+https://example.test/base.git",
  ref: "refs/heads/main",
  commit: "a".repeat(40),
  snapshot: `v1-sha256:${"b".repeat(64)}`,
};

describe("base template release artifact", () => {
  it("keeps host rescue notes verbatim and validates their contract", () => {
    const markdown = `---
degraded-ok: false
verify: pnpm type-check
---

# Current host contract
`;
    expect(
      parseBaseTemplateReleaseArtifact({
        version: 1,
        baseTemplate: pin,
        systemNotes: [{ path: "migrations/system/host-contract.md", markdown }],
      })
    ).toMatchObject({
      baseTemplate: pin,
      systemNotes: [{ markdown }],
      parsedSystemNotes: [{ facet: "system", degradedOk: false }],
    });
  });

  it("does not accept a third-party facet as a host rescue input", () => {
    expect(() =>
      parseBaseTemplateReleaseArtifact({
        version: 1,
        baseTemplate: pin,
        systemNotes: [
          {
            path: "migrations/news/contract.md",
            markdown: "---\ndegraded-ok: true\nverify: test\n---\n\n# Contract\n",
          },
        ],
      })
    ).toThrow("non-system note");
  });
});
