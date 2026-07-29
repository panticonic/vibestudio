import { describe, expect, it } from "vitest";
import {
  canonicalTemplateNodeId,
  normalizeTemplateGitUrl,
  templateAliasFromUrl,
  templateGitTransportUrl,
} from "./templateCoordinates.js";

describe("template coordinates", () => {
  it("canonicalizes identity URLs independently from their Git transport spelling", () => {
    expect(normalizeTemplateGitUrl("https://example.test/team/base.git")).toBe(
      "git+https://example.test/team/base.git"
    );
    expect(normalizeTemplateGitUrl("git+https://example.test/team/base.git")).toBe(
      "git+https://example.test/team/base.git"
    );
    expect(templateGitTransportUrl("git+http://127.0.0.1:43123/repo.git")).toBe(
      "http://127.0.0.1:43123/repo.git"
    );
  });

  it("gives transport-equivalent pins one node identity", () => {
    const commit = "a".repeat(40);
    expect(canonicalTemplateNodeId("https://example.test/base.git", commit)).toBe(
      canonicalTemplateNodeId("git+https://example.test/base.git", commit)
    );
    expect(canonicalTemplateNodeId("git+http://127.0.0.1:43123/base.git", commit)).toMatch(
      /^t-[0-9a-f]{12}$/u
    );
  });

  it("derives a readable stable alias solely from the normalized URL", () => {
    const plain = templateAliasFromUrl(
      "https://github.com/vibestudio/vibestudio-template-news.git"
    );
    expect(plain).toMatch(/^news-[0-9a-f]{12}$/u);
    expect(plain).toBe(
      templateAliasFromUrl("git+https://github.com/vibestudio/vibestudio-template-news.git")
    );
    expect(plain).not.toBe(
      templateAliasFromUrl("https://git.example.test/other/vibestudio-template-news.git")
    );
  });

  it("retains ordinary HTTP remote safety rules", () => {
    expect(() => normalizeTemplateGitUrl("git+ssh://example.test/base.git")).toThrow(
      /http or https/
    );
    expect(() => normalizeTemplateGitUrl("git+https://user:pass@example.test/base.git")).toThrow(
      /credentials/
    );
    expect(() => normalizeTemplateGitUrl("git+https://example.test/base.git?token=secret")).toThrow(
      /query/
    );
    expect(() => canonicalTemplateNodeId("https://example.test/base.git", "A".repeat(40))).toThrow(
      /full lowercase/
    );
  });
});
