import { describe, expect, it, vi } from "vitest";
import { createGitApi } from "./gitApi.js";

const GIT_BRIDGE_EXTENSION = "@workspace-extensions/git-bridge";

describe("runtime git API", () => {
  it("unwraps single-repo upstreamStatus rows and forwards status options", async () => {
    const row = {
      repoPath: "projects/demo",
      remote: "origin",
      branch: "main",
      autoPush: false,
      state: "behind",
      aheadBy: 0,
      behindBy: 2,
    };
    const rpc = {
      call: vi.fn(async () => [row]),
    };

    const api = createGitApi(rpc as never, vi.fn() as never);
    await expect(api.upstreamStatus("projects/demo", { fetch: false })).resolves.toEqual(row);

    expect(rpc.call).toHaveBeenCalledWith("main", "extensions.invoke", [
      GIT_BRIDGE_EXTENSION,
      "upstreamStatus",
      [["projects/demo"], { fetch: false }],
    ]);
  });
});
