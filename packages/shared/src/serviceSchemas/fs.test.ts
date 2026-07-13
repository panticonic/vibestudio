import { describe, expect, it } from "vitest";
import { fsMethods } from "./fs.js";

describe("fs.readFile schema ergonomics", () => {
  it("normalizes Node-style encoding options to the wire encoding string", () => {
    expect(fsMethods.readFile.args.parse(["notes.txt", { encoding: "utf8" }])).toEqual([
      "notes.txt",
      "utf8",
    ]);
    expect(
      fsMethods.readFile.args.parse(["ctx-1", "notes.txt", { encoding: "utf8" }])
    ).toEqual(["ctx-1", "notes.txt", "utf8"]);
  });
});
