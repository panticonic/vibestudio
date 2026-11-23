import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureEvidenceForWorkspace } from "./captureEvidenceOwnership.js";

describe("collection custody ownership", () => {
  it("preserves normal workspace deletion behavior outside explicit managed collection", () => {
    expect(captureEvidenceForWorkspace("/workspace/state", "owner", {}).root).toBe(
      "/workspace/state/capture-evidence"
    );
    expect(
      captureEvidenceForWorkspace("/workspace/state", "owner", {
        VIBESTUDIO_RETAIN_NATIVE_STORAGE: "1",
      }).root
    ).toBe("/workspace/state/capture-evidence");
  });
  it("requires the trusted managed instance root and partitions exact workspace owners", () => {
    const enabled = { VIBESTUDIO_RETAIN_NATIVE_STORAGE: "1", VIBESTUDIO_SYSTEM_TEST_INSTANCE: "1" };
    expect(() => captureEvidenceForWorkspace("/workspace/state", "owner", enabled)).toThrow(
      "managed supervisor instance root"
    );
    expect(() =>
      captureEvidenceForWorkspace("/workspace/state", "owner", {
        ...enabled,
        VIBESTUDIO_INSTANCE_ROOT: "relative",
      })
    ).toThrow("absolute");
    const environment = { ...enabled, VIBESTUDIO_INSTANCE_ROOT: "/retained/generation" };
    const first = captureEvidenceForWorkspace("/workspace/state", "../owner", environment),
      second = captureEvidenceForWorkspace("/workspace/state", "other", environment);
    expect(first.root).toMatch(
      /^\/retained\/generation\/capture-evidence\/workspaces\/[a-f0-9]{64}$/
    );
    expect(first.root).not.toBe(second.root);
  });
  it("retains native and existing Natlang evidence after the owned workspace is removed", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "capture-owner-"));
    try {
      const workspace = path.join(root, "workspaces/owned"),
        state = path.join(workspace, "state");
      await fs.mkdir(state, { recursive: true });
      const custody = captureEvidenceForWorkspace(state, "owned", {
        VIBESTUDIO_RETAIN_NATIVE_STORAGE: "1",
        VIBESTUDIO_SYSTEM_TEST_INSTANCE: "1",
        VIBESTUDIO_INSTANCE_ROOT: root,
      });
      for (const directory of [custody.nativeStorage, custody.natlang]) {
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, "fixture"), "exact retained bytes");
      }
      await fs.rm(workspace, { recursive: true });
      for (const directory of [custody.nativeStorage, custody.natlang])
        expect(await fs.readFile(path.join(directory, "fixture"), "utf8")).toBe(
          "exact retained bytes"
        );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
