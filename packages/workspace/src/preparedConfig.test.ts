import { describe, expect, it } from "vitest";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import {
  assertWorkspaceConfigPathScope,
  changedWorkspaceConfigPaths,
  workspaceConfigDigest,
} from "./preparedConfig.js";

const config: WorkspaceConfig = {
  id: "workspace:test",
  systemEpoch: 1,
  defaultAgentConfig: { model: "model-one", thinkingLevel: "low" },
};

describe("prepared workspace config", () => {
  it("digests canonical config independently of object key order", () => {
    expect(workspaceConfigDigest(config)).toBe(workspaceConfigDigest({
      defaultAgentConfig: { thinkingLevel: "low", model: "model-one" },
      systemEpoch: config.systemEpoch,
      id: config.id,
    }));
  });

  it("reports exact changed leaves and enforces segment-aware scopes", () => {
    const next = { ...config, defaultAgentConfig: { ...config.defaultAgentConfig, model: "model-two" } };
    const paths = changedWorkspaceConfigPaths(config, next);
    expect(paths).toEqual(["defaultAgentConfig.model"]);
    expect(() => assertWorkspaceConfigPathScope(paths, ["defaultAgentConfig"])).not.toThrow();
    expect(() => assertWorkspaceConfigPathScope(paths, ["defaultAgent"])).toThrow(/outside its allowed scope/);
  });

  it("reports added and removed config leaves without canonicalizing missing values", () => {
    const added = { ...config, defaultAgentConfig: { ...config.defaultAgentConfig, fastMode: true } };
    expect(changedWorkspaceConfigPaths(config, added)).toEqual(["defaultAgentConfig.fastMode"]);
    const removed = { ...added, defaultAgentConfig: { fastMode: true, thinkingLevel: "low" } };
    expect(changedWorkspaceConfigPaths(added, removed)).toEqual(["defaultAgentConfig.model"]);
  });

  it("scopes the first write to a section that does not exist yet", () => {
    const empty = { id: config.id, systemEpoch: config.systemEpoch };
    const paths = changedWorkspaceConfigPaths(empty, config);
    expect(paths).toEqual(["defaultAgentConfig.model", "defaultAgentConfig.thinkingLevel"]);
    expect(() => assertWorkspaceConfigPathScope(paths, ["defaultAgentConfig"])).not.toThrow();
    expect(() => assertWorkspaceConfigPathScope(paths, ["defaultAgentConfig.thinkingLevel"])).toThrow(/defaultAgentConfig\.model outside its allowed scope/);
  });
});
