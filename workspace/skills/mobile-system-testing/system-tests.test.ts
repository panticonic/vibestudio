import { describe, expect, it } from "vitest";
import type { TestExecutionResult } from "@workspace-skills/system-testing";
import { mobileTests } from "./system-tests.js";

const installAndroid = mobileTests.find((test) => test.name === "mobile-extension-install-android");
const provisionAndroid = mobileTests.find(
  (test) => test.name === "onboarding-desktop-mobile-install-android"
);

if (!installAndroid || !provisionAndroid) {
  throw new Error("mobile system-test declaration is missing");
}

function execution(rendering: boolean): TestExecutionResult {
  return {
    duration: 0,
    messages: [
      {
        id: "prompt",
        kind: "message",
        senderId: "user",
        complete: true,
        content: "Install the Android app.",
      },
      {
        id: "eval",
        kind: "message",
        senderId: "agent",
        complete: true,
        content: "",
        contentType: "invocation",
        invocation: {
          id: "eval-1",
          name: "eval",
          status: "complete",
          terminalOutcome: "success",
          isError: false,
          arguments: {
            code: 'return services.extensions.invoke("@workspace-extensions/mobile-debug", "installAndroid", [{ reset: true, launch: true }]).then(async (installation) => ({ installation, verification: await services.extensions.invoke("@workspace-extensions/mobile-debug", "verify", [{ platform: "android" }]) }));',
          },
          result: {
            details: {
              returnValue: {
                installation: { packageName: "app.vibestudio.mobile.internal" },
                verification: {
                  installed: true,
                  rendering,
                  issues: rendering ? [] : ["process not rendering"],
                },
              },
            },
          },
        },
      } as unknown as TestExecutionResult["messages"][number],
      {
        id: "final",
        kind: "message",
        senderId: "agent",
        senderMetadata: { type: "agent" },
        complete: true,
        content: `Installed app.vibestudio.mobile.internal on Android emulator-5554; the process is ${rendering ? "rendering" : "not rendering"}.`,
      },
    ],
  } as TestExecutionResult;
}

describe("mobile system-test declarations", () => {
  it("budgets the complete cold source-install and readiness workflow", () => {
    expect(provisionAndroid.timeoutMs).toBe(25 * 60_000);
  });

  it("pregrants each capability on the exact provisioning service boundary", () => {
    const policy = provisionAndroid.authorityPolicy;
    expect(typeof policy).toBe("object");
    if (!policy || typeof policy === "function")
      throw new Error("expected static authority policy");
    for (const capability of [
      "workspace-service:phone.provisioning",
      "mobile.devices.read",
      "mobile.provision",
    ]) {
      expect(policy.authority).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            capability: { kind: "exact", key: capability },
            resource: {
              kind: "prefix",
              prefix: "do:vibestudio/internal:PhoneProvisioningDO:",
            },
          }),
        ])
      );
    }
    expect(policy.authority).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability: { kind: "exact", key: "connected-client.transport" },
          resource: { kind: "exact", key: "connected-client.transport" },
        }),
      ])
    );
  });

  it("requires extension-backed installation and rendering evidence", () => {
    expect(installAndroid.validate(execution(true)).passed).toBe(true);
    expect(installAndroid.validate(execution(false)).passed).toBe(false);
  });
});
