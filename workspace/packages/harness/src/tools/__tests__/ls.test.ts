import { describe, it, expect } from "vitest";
import { createLsTool } from "../ls.js";
import { StubFs } from "./stub-fs.js";

const CWD = "/work/ctx";

describe("createLsTool", () => {
  it("distinguishes source presence from live runtime availability", () => {
    const tool = createLsTool(CWD, new StubFs());
    expect(tool.description).toContain("proves only that source exists");
    expect(tool.description).toContain("documented live runtime API");
  });

  it("lists files and directories alphabetically", async () => {
    const fs = new StubFs({
      files: {
        [`${CWD}/b.ts`]: "x",
        [`${CWD}/a.ts`]: "x",
        [`${CWD}/sub/c.ts`]: "x",
      },
    });
    const tool = createLsTool(CWD, fs);
    const result = await tool.execute("call-1", {});
    const text = (result.content[0] as { text: string }).text;
    const lines = text.split("\n");
    expect(lines[0]).toBe("a.ts");
    expect(lines[1]).toBe("b.ts");
    expect(lines[2]).toBe("sub/");
  });

  it("returns '(empty directory)' for empty dir", async () => {
    const fs = new StubFs();
    await fs.mkdir("/work/ctx/empty", { recursive: true });
    const tool = createLsTool(CWD, fs);
    const result = await tool.execute("call-1", { path: "empty" });
    expect((result.content[0] as { text: string }).text).toBe("(empty directory)");
  });

  it("returns a recoverable diagnostic when path doesn't exist", async () => {
    const fs = new StubFs();
    const tool = createLsTool(CWD, fs);
    const result = await tool.execute("call-1", { path: "nope" });
    expect((result.content[0] as { text: string }).text).toMatch(/recoverable lookup miss/i);
    expect(result.details).toEqual({ diagnostic: "not-found", path: `${CWD}/nope` });
  });

  it("returns a recoverable diagnostic when path is a file, not a directory", async () => {
    const fs = new StubFs({ files: { [`${CWD}/a.ts`]: "x" } });
    const tool = createLsTool(CWD, fs);
    const result = await tool.execute("call-1", { path: "a.ts" });
    expect((result.content[0] as { text: string }).text).toMatch(/use read for a file/i);
    expect(result.details).toEqual({ diagnostic: "not-directory", path: `${CWD}/a.ts` });
  });
});
