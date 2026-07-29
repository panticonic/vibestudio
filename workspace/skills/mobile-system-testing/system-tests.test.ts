import { describe, expect, it } from "vitest";
import type { TestExecutionResult } from "@workspace-skills/system-testing";
import { mobileTests } from "./system-tests.js";

const installAndroid = mobileTests.find((test) => test.name === "mobile-extension-install-android");

if (!installAndroid) throw new Error("mobile system-test declaration is missing");

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
            code:
              'return services.extensions.invoke("@workspace-extensions/mobile-debug", "installAndroid", [{ reset: true, launch: true }]).then(async (installation) => ({ installation, verification: await services.extensions.invoke("@workspace-extensions/mobile-debug", "verify", [{ platform: "android" }]) }));',
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
        complete: true,
        content: `Installed app.vibestudio.mobile.internal on Android emulator-5554; the process is ${rendering ? "rendering" : "not rendering"}.`,
      },
    ],
  } as TestExecutionResult;
}

describe("mobile system-test declarations", () => {
  it("requires extension-backed installation and rendering evidence", () => {
    expect(installAndroid.validate(execution(true)).passed).toBe(true);
    expect(installAndroid.validate(execution(false)).passed).toBe(false);
  });
});
