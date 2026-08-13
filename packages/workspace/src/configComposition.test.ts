import { describe, expect, it } from "vitest";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import {
  ManifestEntryConflictError,
  composeWorkspaceConfig,
  parseWorkspaceConfigFragment,
  parseWorkspaceConfigTopLayer,
  projectWorkspaceConfigMutationToTop,
  type WorkspaceConfigFragmentLayer,
} from "./configComposition.js";

const top = (extra = "") => parseWorkspaceConfigTopLayer(`systemEpoch: 58\n${extra}`);

function layer(
  nodeId: string,
  alias: string,
  yaml: string,
  ancestors: readonly string[] = []
): WorkspaceConfigFragmentLayer {
  return {
    nodeId,
    alias,
    ancestors,
    config: parseWorkspaceConfigFragment(`systemEpoch: 58\n${yaml}`, nodeId),
  };
}

describe("workspace template manifest composition", () => {
  it("rejects a persisted workspace id in the authored source layer", () => {
    expect(() => top("id: checkout-name\n")).toThrow();
  });

  it("lets a child replace an ancestor by canonical declaration identity", () => {
    const config = composeWorkspaceConfig(
      top(),
      [
        layer("t-a", "base", "extensions:\n  - source: extensions/chat\n    ref: v1\n"),
        layer("t-b", "child", "extensions:\n  - source: extensions/chat\n    ref: v2\n", ["t-a"]),
      ],
      "ws"
    );
    expect(config.extensions).toEqual([{ source: "extensions/chat", ref: "v2" }]);
  });

  it("rejects sibling shadowing instead of making order authoritative", () => {
    expect(() =>
      composeWorkspaceConfig(
        top(),
        [
          layer("t-a", "base", "apps:\n  - source: apps/shell\n    ref: v1\n"),
          layer("t-b", "news", "apps:\n  - source: apps/shell\n    ref: v2\n"),
        ],
        "ws"
      )
    ).toThrow(ManifestEntryConflictError);
  });

  it("uses a workspace redeclaration to resolve a sibling conflict", () => {
    const config = composeWorkspaceConfig(
      top("apps:\n  - source: apps/shell\n    ref: local\n"),
      [
        layer("t-a", "base", "apps:\n  - source: apps/shell\n    ref: v1\n"),
        layer("t-b", "news", "apps:\n  - source: apps/shell\n    ref: v2\n"),
      ],
      "ws"
    );
    expect(config.apps).toEqual([{ source: "apps/shell", ref: "local" }]);
  });

  it("applies disable before workspace redeclarations", () => {
    const config = composeWorkspaceConfig(
      top('disable: ["apps/apps/shell"]\napps:\n  - source: apps/history\n'),
      [
        layer("t-a", "base", "apps:\n  - source: apps/shell\n"),
      ],
      "ws"
    );
    expect(config.apps?.map((entry) => entry.source)).toEqual(["apps/history"]);
  });

  it("rejects template trust and provider grants at the fragment boundary", () => {
    expect(() =>
      parseWorkspaceConfigFragment("systemEpoch: 58\ntrust:\n  chromeApps: [apps/shell]\n", "t-a")
    ).toThrow();
    expect(() =>
      parseWorkspaceConfigFragment(
        "systemEpoch: 58\nproviders:\n  gitInterop: { extension: extensions/git }\n",
        "t-a"
      )
    ).toThrow();
  });

  it("requires every template to use the host-compatible epoch", () => {
    expect(() =>
      composeWorkspaceConfig(
        top(),
        [
          {
            nodeId: "t-a",
            alias: "old",
            ancestors: [],
            config: parseWorkspaceConfigFragment("systemEpoch: 56\n", "t-a"),
          },
        ],
        "ws"
      )
    ).toThrow(/incompatible/);
  });

  it("projects resolved keyed edits without baking unchanged inherited entries", () => {
    const workspaceTop = top();
    const layers = [
      layer(
        "t-a",
        "base",
        "extensions:\n  - source: extensions/chat\n  - source: extensions/git\n"
      ),
    ];
    const current = composeWorkspaceConfig(workspaceTop, layers, "ws");
    const next: WorkspaceConfig = {
      ...current,
      extensions: current.extensions?.map((entry) =>
        entry.source === "extensions/chat" ? { ...entry, ref: "feature" } : entry
      ),
    };
    const projected = projectWorkspaceConfigMutationToTop(workspaceTop, current, next);
    expect(projected.extensions).toEqual([{ source: "extensions/chat", ref: "feature" }]);
    expect(composeWorkspaceConfig(projected, layers, "ws")).toEqual(next);
  });

  it("projects removal of an inherited keyed entry as an explicit disable", () => {
    const workspaceTop = top();
    const layers = [layer("t-a", "base", "apps:\n  - source: apps/shell\n")];
    const current = composeWorkspaceConfig(workspaceTop, layers, "ws");
    const next = { ...current, apps: undefined };
    const projected = projectWorkspaceConfigMutationToTop(workspaceTop, current, next);
    expect(projected.disable).toEqual(["apps/apps/shell"]);
    expect(composeWorkspaceConfig(projected, layers, "ws").apps).toBeUndefined();
  });

  it("uses the same disable address for inherited scalar and whole-map sections", () => {
    const layers = [
      layer(
        "t-a",
        "base",
        "defaultRepo: panels/chat\ndefaultAgentConfig:\n  model: inherited\nhostTargets:\n  electron: { app: apps/shell }\ninitPanels:\n  - source: panels/chat\n"
      ),
    ];
    const current = composeWorkspaceConfig(top(), layers, "ws");
    const next = {
      ...current,
      defaultRepo: undefined,
      defaultAgentConfig: undefined,
      hostTargets: undefined,
      initPanels: undefined,
    };
    const projected = projectWorkspaceConfigMutationToTop(top(), current, next);
    // A whole-value section is one declaration, so its address is the bare
    // section name rather than a doubled `defaultRepo/defaultRepo`.
    expect(projected.disable).toEqual([
      "defaultAgentConfig",
      "defaultRepo",
      "hostTargets",
      "initPanels",
    ]);
    const recomposed = composeWorkspaceConfig(projected, layers, "ws");
    expect(recomposed.defaultRepo).toBeUndefined();
    expect(recomposed.defaultAgentConfig).toBeUndefined();
    expect(recomposed.hostTargets).toBeUndefined();
    expect(recomposed.initPanels).toBeUndefined();
  });

  it("uses disable when a mutation removes a workspace override from the effective config", () => {
    const workspaceTop = top("apps:\n  - source: apps/shell\n    ref: local\n");
    const layers = [layer("t-a", "base", "apps:\n  - source: apps/shell\n    ref: v1\n")];
    const current = composeWorkspaceConfig(workspaceTop, layers, "ws");
    const next = { ...current, apps: undefined };
    const projected = projectWorkspaceConfigMutationToTop(workspaceTop, current, next);
    expect(projected.apps).toBeUndefined();
    expect(projected.disable).toEqual(["apps/apps/shell"]);
    expect(composeWorkspaceConfig(projected, layers, "ws").apps).toBeUndefined();
  });

  it("disables inherited Git declarations by their canonical remote and upstream addresses", () => {
    const layers = [
      layer(
        "t-a",
        "base",
        "git:\n  remotes:\n    panels:\n      chat:\n        origin: { url: https://example.test/chat.git }\n  upstreams:\n    panels:\n      chat: { remote: origin }\n"
      ),
    ];
    const current = composeWorkspaceConfig(top(), layers, "ws");
    const next = { ...current, git: undefined };
    const projected = projectWorkspaceConfigMutationToTop(top(), current, next);
    expect(projected.disable).toEqual([
      "git.remotes/panels/chat/origin",
      "git.upstreams/panels/chat",
    ]);
    expect(composeWorkspaceConfig(projected, layers, "ws").git).toBeUndefined();
  });
});
