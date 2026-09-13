import { describe, expect, it } from "vitest";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import {
  assertWorkspaceConfigPathScope,
  changedWorkspaceConfigPaths,
  workspaceConfigDigest,
} from "./preparedConfig.js";

const config = {
  id: "workspace:test",
  systemEpoch: 1,
  git: {
    remotes: { origin: { url: "https://example.test/one.git" } },
    upstreams: {},
  },
} as unknown as WorkspaceConfig;

describe("prepared workspace config", () => {
  it("digests canonical config independently of object key order", () => {
    expect(workspaceConfigDigest(config)).toBe(
      workspaceConfigDigest({
        git: config.git,
        systemEpoch: config.systemEpoch,
        id: config.id,
      } as WorkspaceConfig)
    );
  });

  it("reports exact changed leaves and enforces segment-aware scopes", () => {
    const next = structuredClone(config);
    (
      next as unknown as {
        git: { remotes: Record<string, { url: string }> };
      }
    ).git.remotes["origin"] = { url: "https://example.test/two.git" };
    const paths = changedWorkspaceConfigPaths(config, next);
    expect(paths).toEqual(["git.remotes.origin.url"]);
    expect(() => assertWorkspaceConfigPathScope(paths, ["git.remotes"])).not.toThrow();
    expect(() => assertWorkspaceConfigPathScope(paths, ["git.remote"])).toThrow(
      /outside its allowed scope/
    );
  });

  it("reports added and removed config leaves without canonicalizing missing values", () => {
    const added = structuredClone(config);
    const addedRemotes = added.git!.remotes as unknown as Record<string, unknown>;
    addedRemotes["backup"] = { url: "https://example.test/backup.git" };
    expect(changedWorkspaceConfigPaths(config, added)).toEqual(["git.remotes.backup.url"]);

    const removed = structuredClone(added);
    delete (removed.git!.remotes as unknown as Record<string, unknown>)["origin"];
    expect(changedWorkspaceConfigPaths(added, removed)).toEqual(["git.remotes.origin.url"]);
  });

  it("scopes the first write to a section that does not exist yet", () => {
    const empty = { id: config.id, systemEpoch: config.systemEpoch } as unknown as WorkspaceConfig;
    const paths = changedWorkspaceConfigPaths(empty, config);
    // Adopting a project declares a workspace's first remote and upstream, so
    // the whole `git` section appears in that one mutation.
    expect(paths).toEqual(["git.remotes.origin.url", "git.upstreams"]);
    expect(() =>
      assertWorkspaceConfigPathScope(paths, ["git.remotes", "git.upstreams"])
    ).not.toThrow();
    expect(() => assertWorkspaceConfigPathScope(paths, ["git.upstreams"])).toThrow(
      /git\.remotes\.origin\.url outside its allowed scope/
    );
  });
});
