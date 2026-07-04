import { describe, it, expect } from "vitest";
import { withInvocationId } from "../tool-vcs.js";
import { StubVcs } from "./stub-vcs.js";

describe("withInvocationId (T2 stamping seam)", () => {
  it("injects the invocationId into edit calls that omit one", async () => {
    const vcs = new StubVcs();
    const stamped = withInvocationId(vcs, "inv-7");
    await stamped.edit({ edits: [{ kind: "write", path: "a.ts", content: { kind: "text", text: "x" } }] });
    expect(vcs.lastEditInput?.invocationId).toBe("inv-7");
  });

  it("does not override an invocationId the caller already resolved", async () => {
    const vcs = new StubVcs();
    const stamped = withInvocationId(vcs, "inv-7");
    await stamped.edit({
      edits: [{ kind: "write", path: "a.ts", content: { kind: "text", text: "x" } }],
      invocationId: "explicit",
    });
    expect(vcs.lastEditInput?.invocationId).toBe("explicit");
  });

  it("keeps the non-write methods intact (prototype-defined adapter stays whole)", async () => {
    const vcs = new StubVcs({ files: { ["a.ts"]: "hello" } });
    const stamped = withInvocationId(vcs, "inv-7");
    const read = await stamped.readFile("a.ts");
    expect(read?.content).toEqual({ kind: "text", text: "hello" });
    const discarded = await stamped.discardEdits("meta");
    expect(discarded).toMatchObject({ discarded: 0 });
  });
});
