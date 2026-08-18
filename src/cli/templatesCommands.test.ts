import { describe, expect, it } from "vitest";
import { parseInvocation } from "./commandTable.js";
import { templatesCommands } from "./templatesCommands.js";

describe("templates CLI commands", () => {
  it("exposes the full current templates service family", () => {
    expect(templatesCommands.map((command) => command.name)).toEqual([
      "check-base",
      "pull-base",
      "author-parts",
      "author-inspect",
      "author-publish",
      "registry-suggest",
      "status",
      "catalog",
      "check",
      "inspect",
      "add",
      "adopt",
      "pull",
      "remove",
      "suggest",
      "operations",
      "resume",
      "cancel",
      "decide-suggestion",
    ]);
  });

  it("exposes the host/Base handshake without adding an alternate review command", () => {
    const check = templatesCommands.find((command) => command.name === "check-base")!;
    const pull = templatesCommands.find((command) => command.name === "pull-base")!;
    expect(parseInvocation(check, []).positionals).toEqual([]);
    expect(parseInvocation(pull, ["--command-id", "base-release-1"]).flags["command-id"]).toBe(
      "base-release-1"
    );
    expect(templatesCommands.some((command) => command.name === "review-base")).toBe(false);
  });

  it("keeps authoring selection and publication receipts explicit", () => {
    const inspect = templatesCommands.find((command) => command.name === "author-inspect")!;
    const inspection = parseInvocation(inspect, [
      "--name",
      "News",
      "--description",
      "Focused news workspace",
      "--part",
      "panels/news",
      "--part=workers/news-agent",
      "--dependency",
      "git+https://example.test/base.git",
    ]);
    expect(inspection.flagsMulti("part")).toEqual(["panels/news", "workers/news-agent"]);
    expect(inspection.flagsMulti("dependency")).toEqual(["git+https://example.test/base.git"]);

    const publish = templatesCommands.find((command) => command.name === "author-publish")!;
    const publication = parseInvocation(publish, [
      "news-receipt.json",
      "--version",
      "1.0.0",
      "--repository",
      "vibestudio-template-news",
      "--owner",
      "panticonic",
      "--receipt",
      "publication.json",
    ]);
    expect(publication.positionals).toEqual(["news-receipt.json"]);
    expect(publication.flags["owner"]).toBe("panticonic");
    expect(publication.flags["private"]).toBeUndefined();
    expect(publication.flags["receipt"]).toBe("publication.json");

    const registry = templatesCommands.find((command) => command.name === "registry-suggest")!;
    const suggestion = parseInvocation(registry, [
      "publication.json",
      "--id",
      "news",
      "--name",
      "News",
      "--description",
      "Focused news workspace",
      "--tag",
      "news",
      "--revision",
      "2026-08-09.1",
    ]);
    expect(suggestion.positionals).toEqual(["publication.json"]);
    expect(suggestion.flagsMulti("tag")).toEqual(["news"]);
    expect(suggestion.flags["revision"]).toBe("2026-08-09.1");
  });

  it("routes overlapping additions directly into semantic review", () => {
    const add = templatesCommands.find((command) => command.name === "add")!;
    const parsed = parseInvocation(add, ["https://example.test/news.git"]);
    expect(parsed.positionals).toEqual(["https://example.test/news.git"]);
    expect(() =>
      parseInvocation(add, ["https://example.test/news.git", "--choice", "panels/news=keep"])
    ).toThrow("Unknown flag");
  });

  it("exposes lineage adoption as a distinct exact-release operation", () => {
    const adopt = templatesCommands.find((command) => command.name === "adopt")!;
    const parsed = parseInvocation(adopt, ["https://example.test/base.git"]);
    expect(parsed.positionals).toEqual(["https://example.test/base.git"]);
  });

  it("makes registry network refresh explicit", () => {
    const catalog = templatesCommands.find((command) => command.name === "catalog")!;
    expect(parseInvocation(catalog, ["--refresh"]).flags["refresh"]).toBe(true);
  });

  it("accepts a logical credential only as an explicit direct-template input", () => {
    const inspect = templatesCommands.find((command) => command.name === "inspect")!;
    const parsed = parseInvocation(inspect, [
      "https://example.test/private.git",
      "--credential",
      "github-main",
    ]);
    expect(parsed.flags["credential"]).toBe("github-main");
  });

  it("keeps resume and discard as separate operation lifecycle commands", () => {
    const resume = templatesCommands.find((command) => command.name === "resume")!;
    const cancel = templatesCommands.find((command) => command.name === "cancel")!;
    expect(parseInvocation(resume, ["operation-1"]).positionals).toEqual(["operation-1"]);
    expect(parseInvocation(cancel, ["operation-1"]).positionals).toEqual(["operation-1"]);
    expect(() => parseInvocation(resume, ["operation-1", "--on-build-failure", "discard"])).toThrow(
      "Unknown flag"
    );
  });
});
