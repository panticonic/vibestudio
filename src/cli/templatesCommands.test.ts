import { describe, expect, it } from "vitest";
import { parseInvocation } from "./commandTable.js";
import { templatesCommands } from "./templatesCommands.js";

describe("templates CLI commands", () => {
  it("exposes the full current templates service family", () => {
    expect(templatesCommands.map((command) => command.name)).toEqual([
      "status",
      "catalog",
      "check",
      "inspect",
      "add",
      "pull",
      "remove",
      "suggest",
      "operations",
      "resume",
      "cancel",
      "decide-suggestion",
    ]);
  });

  it("keeps conflict choices and part selections explicit", () => {
    const add = templatesCommands.find((command) => command.name === "add")!;
    const parsed = parseInvocation(add, [
      "https://example.test/news.git",
      "--choice",
      "panels/news=keep",
      "--choice=workers/news=take",
    ]);
    expect(parsed.positionals).toEqual(["https://example.test/news.git"]);
    expect(parsed.flagsMulti("choice")).toEqual(["panels/news=keep", "workers/news=take"]);
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

  it("retains failed resume contexts unless discard is explicit", () => {
    const resume = templatesCommands.find((command) => command.name === "resume")!;
    expect(parseInvocation(resume, ["operation-1"]).flags["on-build-failure"]).toBeUndefined();
    expect(
      parseInvocation(resume, ["operation-1", "--on-build-failure", "discard"]).flags[
        "on-build-failure"
      ]
    ).toBe("discard");
  });
});
