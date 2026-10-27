import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadProductRelease, prepareProductRelease } from "./productRelease.js";
import { runOwnedChild } from "./launchTermination.js";
import { prepareWorkspaceRelease } from "../../scripts/prepare-workspace-release.mjs";
import { readCurrentHostBuildGeneration } from "../../scripts/host-build-generations.mjs";
import {
  computeHostBuildFingerprint,
  readHostBuildFingerprint,
} from "../../scripts/host-build-fingerprint.mjs";

vi.mock("./launchTermination.js", () => ({ runOwnedChild: vi.fn() }));
vi.mock("../../scripts/prepare-workspace-release.mjs", () => ({
  prepareWorkspaceRelease: vi.fn(() => ({ completed: Promise.resolve(), stop: vi.fn() })),
}));
vi.mock("../../scripts/host-build-generations.mjs", () => ({
  readCurrentHostBuildGeneration: vi.fn(() => "/host/generation"),
}));
vi.mock("../../scripts/host-build-fingerprint.mjs", () => ({
  computeHostBuildFingerprint: vi.fn(),
  readHostBuildFingerprint: vi.fn(),
  sameHostBuildFingerprint: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b),
}));
vi.mock("@vibestudio/shared/centralData", () => ({
  CentralDataManager: class {
    listWorkspaces() {
      return ["system"];
    }
    close() {}
  },
}));
vi.mock("./developmentTemplateSet.js", () => ({
  resolveDevelopmentTemplateSet: vi.fn(async () => ({})),
}));
vi.mock("../workspaceTemplateSource.js", () => ({
  inspectWorkspaceSources: vi.fn(async () => []),
  workspaceSourceFromCheckout: vi.fn(),
}));
vi.mock("./productLaunch.js", () => ({
  productLaunchEnvironment: vi.fn(() => ({ NODE_ENV: "production" })),
}));

const input = () => ({
  ownership: {} as Parameters<typeof loadProductRelease>[0]["ownership"],
  termination: { signal: new AbortController().signal } as Parameters<
    typeof loadProductRelease
  >[0]["termination"],
  repoRoot: "/host",
  temporaryRoot: "/scratch",
  templateCheckouts: [],
  register: vi.fn(),
});
const fingerprint = { version: 1, mode: "production", fingerprint: "a".repeat(64), inputCount: 7 };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readCurrentHostBuildGeneration).mockReturnValue("/host/generation");
  vi.mocked(computeHostBuildFingerprint).mockReturnValue(fingerprint);
  vi.mocked(readHostBuildFingerprint).mockReturnValue(fingerprint);
});

describe("product release build and launch", () => {
  it("launches with verification and consumption only", async () => {
    await loadProductRelease(input());
    expect(vi.mocked(runOwnedChild).mock.calls.map((call) => call[2])).toEqual([
      ["scripts/native-host-dependencies.mjs"],
    ]);
    expect(prepareWorkspaceRelease).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "existing" })
    );
  });
  it.each(["missing", "stale"])("rejects a %s host before launching any child", async (state) => {
    if (state === "missing")
      vi.mocked(readCurrentHostBuildGeneration).mockImplementation(() => {
        throw new Error("ENOENT");
      });
    else
      vi.mocked(readHostBuildFingerprint).mockReturnValue({
        ...fingerprint,
        fingerprint: "b".repeat(64),
      });
    await expect(loadProductRelease(input())).rejects.toThrow(/Run pnpm build:product/);
    expect(runOwnedChild).not.toHaveBeenCalled();
    expect(prepareWorkspaceRelease).not.toHaveBeenCalled();
  });
  it("keeps native repair and host/runtime production in build:product", async () => {
    await prepareProductRelease(input());
    expect(vi.mocked(runOwnedChild).mock.calls.map((call) => call[2])).toEqual([
      ["scripts/native-host-dependencies.mjs", "--repair"],
      ["scripts/ensure-host-build.mjs"],
    ]);
    expect(prepareWorkspaceRelease).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "release" })
    );
  });
});
