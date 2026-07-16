import { describe, expect, it } from "vitest";
import { fsMethods } from "./fs.js";

describe("fs.readFile schema ergonomics", () => {
  it("normalizes Node-style encoding options to the wire encoding string", () => {
    expect(fsMethods.readFile.args.parse(["notes.txt", { encoding: "utf8" }])).toEqual([
      "notes.txt",
      "utf8",
    ]);
    expect(fsMethods.readFile.args.parse(["ctx-1", "notes.txt", { encoding: "utf8" }])).toEqual([
      "ctx-1",
      "notes.txt",
      "utf8",
    ]);
  });
});

describe("managed file transfer contract", () => {
  it("documents copy as explicit import and rename as a preserving refusal", () => {
    expect(fsMethods.copyFile.description).toContain("ordinary file creation");
    expect(fsMethods.copyFile.description).toContain("no earlier semantic origin");
    expect(fsMethods.copyFile.description).toContain("Managed destinations must be vacant");
    expect(fsMethods.rename.description).toContain("scratch-to-managed rename is refused");
    expect(fsMethods.rename.description).toContain("leaves the scratch source intact");
    expect(fsMethods.rename.examples).not.toContainEqual([
      "/.tmp/tmp-ab12",
      "/projects/demo/notes/todo.md",
    ]);
  });
});
