import * as fs from "fs";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { createBuildScratchDir } from "./buildScratch.js";

const created: string[] = [];

afterEach(() => {
  for (const directory of created.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("createBuildScratchDir", () => {
  it("gives concurrent invocations isolated directories for the same build key", () => {
    const directories = Array.from({ length: 32 }, () => {
      const directory = createBuildScratchDir("build-same-key");
      created.push(directory);
      return directory;
    });

    expect(new Set(directories).size).toBe(directories.length);

    const firstEntry = path.join(directories[0]!, "_entry.js");
    const secondEntry = path.join(directories[1]!, "_entry.js");
    fs.writeFileSync(firstEntry, "first");
    fs.writeFileSync(secondEntry, "second");

    fs.rmSync(directories[0]!, { recursive: true, force: true });
    expect(fs.readFileSync(secondEntry, "utf8")).toBe("second");
  });
});
