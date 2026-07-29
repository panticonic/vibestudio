import { describe, expect, it } from "vitest";
import {
  TemplateRegistryEpochError,
  TemplateRegistryRevisionError,
  parseTemplateRegistry,
  resolveTemplateRegistrySelection,
} from "./contract.js";

const commit = "0123456789abcdef0123456789abcdef01234567";
const snapshot = `v1-sha256:${"a".repeat(64)}`;

function registryValue() {
  return {
    version: 1,
    revision: "2026-07-29.3",
    systemEpoch: 57,
    entries: [
      {
        id: "news",
        name: "News workspace",
        description: "Read and discuss news.",
        tags: ["news", "agent"],
        recommended: true,
        url: "https://github.com/vibestudio/template-news.git",
        promoted: { ref: "refs/tags/v1.2.0", commit, snapshot },
      },
    ],
  };
}

describe("template registry contract", () => {
  it("normalizes registry URLs and returns only exact promoted coordinates", () => {
    const registry = parseTemplateRegistry(registryValue());
    expect(registry.entries[0]).toEqual({
      id: "news",
      name: "News workspace",
      description: "Read and discuss news.",
      tags: ["news", "agent"],
      recommended: true,
      url: "git+https://github.com/vibestudio/template-news.git",
      promoted: { ref: "refs/tags/v1.2.0", commit, snapshot },
    });
    expect(
      resolveTemplateRegistrySelection(
        registry,
        { catalogId: "news", registryRevision: "2026-07-29.3" },
        57
      )
    ).toEqual({
      catalogId: "news",
      registryRevision: "2026-07-29.3",
      name: "News workspace",
      url: "git+https://github.com/vibestudio/template-news.git",
      promoted: { ref: "refs/tags/v1.2.0", commit, snapshot },
    });
  });

  it("rejects stale selections and incompatible epochs", () => {
    const registry = parseTemplateRegistry(registryValue());
    expect(() =>
      resolveTemplateRegistrySelection(registry, {
        catalogId: "news",
        registryRevision: "2026-07-29.2",
      })
    ).toThrow(TemplateRegistryRevisionError);
    expect(() =>
      resolveTemplateRegistrySelection(
        registry,
        { catalogId: "news", registryRevision: registry.revision },
        58
      )
    ).toThrow(TemplateRegistryEpochError);
  });

  it("rejects duplicate identities and moving or malformed coordinates", () => {
    const duplicate = registryValue();
    duplicate.entries.push({ ...duplicate.entries[0]! });
    expect(() => parseTemplateRegistry(duplicate)).toThrow("Duplicate template registry id");

    expect(() =>
      parseTemplateRegistry({
        ...registryValue(),
        entries: [
          {
            ...registryValue().entries[0],
            promoted: { ref: "main", commit: "abc", snapshot: "sha256:abc" },
          },
        ],
      })
    ).toThrow("canonical branch or tag ref");
  });
});
