import { describe, expect, it } from "vitest";
import { readAttachedHostChildEnvironment } from "./attachedHostRuntime.js";

describe("readAttachedHostChildEnvironment", () => {
  it("does not classify an ordinary developer instance as an attached child", () => {
    expect(
      readAttachedHostChildEnvironment({
        VIBESTUDIO_INSTANCE: "source-development-instance",
      })
    ).toBeNull();
  });

  it("returns the complete isolated-child binding", () => {
    expect(
      readAttachedHostChildEnvironment({
        VIBESTUDIO_INSTANCE: "development-instance",
        VIBESTUDIO_DEVELOPMENT_INSTANCE_GENERATION: "generation",
        VIBESTUDIO_DEVELOPMENT_PARENT_RUN: "run",
        VIBESTUDIO_ATTACHED_PARENT_GATEWAY_URL: "http://127.0.0.1:43100",
      })
    ).toEqual({
      instanceId: "development-instance",
      generationId: "generation",
      developmentRunId: "run",
      parentGatewayUrl: "http://127.0.0.1:43100",
    });
  });

  it.each([
    {
      VIBESTUDIO_DEVELOPMENT_INSTANCE_GENERATION: "generation",
    },
    {
      VIBESTUDIO_INSTANCE: "development-instance",
      VIBESTUDIO_DEVELOPMENT_PARENT_RUN: "run",
      VIBESTUDIO_ATTACHED_PARENT_GATEWAY_URL: "http://127.0.0.1:43100",
    },
    {
      VIBESTUDIO_INSTANCE: "development-instance",
      VIBESTUDIO_DEVELOPMENT_INSTANCE_GENERATION: "generation",
      VIBESTUDIO_ATTACHED_PARENT_GATEWAY_URL: "http://127.0.0.1:43100",
    },
  ])("rejects a partial attached-child marker", (env) => {
    expect(() => readAttachedHostChildEnvironment(env)).toThrow(
      "Attached-host child environment is incomplete"
    );
  });
});
