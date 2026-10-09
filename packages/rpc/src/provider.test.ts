import { describe, expect, it } from "vitest";
import { runtimeConnectionInfoFromBootstrap } from "./provider.js";

describe("runtimeConnectionInfoFromBootstrap", () => {
  it("retains authenticated workspace coordinates without credentials", () => {
    expect(
      runtimeConnectionInfoFromBootstrap(
        {
          workspaceId: "workspace:source",
          entityId: "panel:document",
          contextId: "context:source",
          gatewayConfig: { token: "private-token" },
          env: { SECRET: "private-value" },
        },
        "panel:document"
      )
    ).toEqual({
      workspaceId: "workspace:source",
      runtimeId: "panel:document",
      slotId: "panel:document",
      contextId: "context:source",
      parentId: null,
      parentEntityId: null,
      theme: "light",
    });
  });
  it("refuses a bootstrap without its owning workspace or for another runtime", () => {
    expect(() =>
      runtimeConnectionInfoFromBootstrap(
        { entityId: "panel:document", contextId: "context" },
        "panel:document"
      )
    ).toThrow("does not match this document");
    expect(() =>
      runtimeConnectionInfoFromBootstrap(
        { workspaceId: "workspace:source", entityId: "panel:other", contextId: "context" },
        "panel:document"
      )
    ).toThrow("does not match this document");
  });
});
