import { describe, expect, it } from "vitest";
import { sanitizeReportText } from "./sanitize";

describe("report text sanitization", () => {
  it("preserves ordinary prose and harmless URLs exactly", () => {
    const text =
      "Still needs checking, only with future authorization: whether the issue reproduces. Visit https://example.com for context.";
    expect(sanitizeReportText(text)).toEqual({ text, redactions: [] });
  });

  it("removes complete authorization credentials and structured secret values", () => {
    const text =
      'Request header Authorization: Bearer opaque-token\npassword=private-value\n{"api_key":"hidden-key","secret":"hidden-secret"}';
    const result = sanitizeReportText(text);
    expect(result.redactions).toEqual(["sensitive-field"]);
    for (const secret of ["opaque-token", "private-value", "hidden-key", "hidden-secret"])
      expect(result.text).not.toContain(secret);
    expect(result.text).toContain("Authorization: [removed]");
  });

  it("removes registered secrets, home paths, and URL credentials and queries", () => {
    const result = sanitizeReportText(
      "known-token in /home/example/project at https://alice:password@example.com/log?token=private",
      ["known-token"],
      "/home/example"
    );
    expect(result.text).toBe("[secret removed] in [home]/project at https://example.com/log");
    expect(result.redactions).toEqual([
      "registered-secret",
      "home-path",
      "url-credentials-and-query",
    ]);
  });
});
