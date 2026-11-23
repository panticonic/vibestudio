import { describe, expect, it } from "vitest";
import { NATIVE_CAPTURE_RETENTION_ENV, readNativeCaptureRetentionMode, SYSTEM_TEST_INSTANCE_ENV, readSystemTestInstanceMode } from "./systemTestInstanceMode.js";

describe("system-test instance mode", () => {
  it("is off unless the process was started for tests", () => {
    expect(readSystemTestInstanceMode({})).toBe(false);
    expect(readSystemTestInstanceMode({ [SYSTEM_TEST_INSTANCE_ENV]: "" })).toBe(false);
    expect(readSystemTestInstanceMode({ [SYSTEM_TEST_INSTANCE_ENV]: "0" })).toBe(false);
    // Nothing truthy-but-vague: an ambiguous value is not a test server.
    expect(readSystemTestInstanceMode({ [SYSTEM_TEST_INSTANCE_ENV]: "true" })).toBe(false);
  });

  it("is on for a server started to run system tests", () => {
    expect(readSystemTestInstanceMode({ [SYSTEM_TEST_INSTANCE_ENV]: "1" })).toBe(true);
  });
});

it("native storage retention requires both explicit capture and system-test process ownership", () => {
  expect(readNativeCaptureRetentionMode({})).toBe(false);
  expect(readNativeCaptureRetentionMode({ [NATIVE_CAPTURE_RETENTION_ENV]: "1" })).toBe(false);
  expect(readNativeCaptureRetentionMode({ [SYSTEM_TEST_INSTANCE_ENV]: "1" })).toBe(false);
  expect(readNativeCaptureRetentionMode({ [SYSTEM_TEST_INSTANCE_ENV]: "1", [NATIVE_CAPTURE_RETENTION_ENV]: "0" })).toBe(false);
  expect(readNativeCaptureRetentionMode({ [SYSTEM_TEST_INSTANCE_ENV]: "1", [NATIVE_CAPTURE_RETENTION_ENV]: "1" })).toBe(true);
});

it("carries collector retention through the actual supervisor and workspace environment builders", async () => {
  const { liveTeacherEnvironment } = await import("../../scripts/lib/live-teacher-retention.mjs");
  const { systemTestInstanceEnvironment } = await import("../dev/systemTestInstance.js");
  const { buildWorkspaceChildEnv } = await import("./hubServer.js");
  const { developmentInstanceEnvironment } = await import("../dev/developmentInstanceEnvironment.js");
  for (const optOut of [false, true]) {
    const collector = liveTeacherEnvironment(optOut ? { [NATIVE_CAPTURE_RETENTION_ENV]: "0" } : {});
    const supervisor = systemTestInstanceEnvironment(collector);
    const server = developmentInstanceEnvironment({ parent: supervisor, repoRoot: "/owned/app", instanceRoot: "/owned/retained/generation", instanceId: "capture", sourceCoupled: false, disposable: true });
    const workspace = buildWorkspaceChildEnv({
      baseEnv: server, appRoot: "/owned/app", workspaceName: "system", workspaceId: "owned-workspace",
      hubUrl: "http://127.0.0.1:7788", identityDbPath: "/owned/identity.db", workspaceChildToken: "test-child-token",
    });
    expect(readNativeCaptureRetentionMode(workspace)).toBe(!optOut);
    expect(workspace[NATIVE_CAPTURE_RETENTION_ENV]).toBe(optOut ? "0" : "1");
    const {captureEvidenceForWorkspace}=await import("./captureEvidenceOwnership.js");
    const selected=captureEvidenceForWorkspace("/owned/retained/generation/workspaces/owned-workspace/state","owned-workspace",workspace);
    expect(selected.root).toMatch(optOut ? /workspaces\/owned-workspace\/state\/capture-evidence$/ : /^\/owned\/retained\/generation\/capture-evidence\/workspaces\/[a-f0-9]{64}$/);
  }
});
