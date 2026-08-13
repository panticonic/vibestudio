import { describe, expect, it } from "vitest";
import { developmentInstanceEnvironment } from "./developmentInstanceEnvironment.js";

const base = {
  pin: { commit: "candidate" },
  checkout: "/private/checkpoint",
  sourceCheckout: "/visible/base",
};

describe("development instance environment", () => {
  it("gives only the source-coupled instance the visible checkout write-back target", () => {
    const env = developmentInstanceEnvironment({
      parent: {},
      repoRoot: "/host",
      instanceRoot: "/instance",
      instanceId: "source",
      sourceCoupled: true,
      base,
    });
    expect(env).toMatchObject({
      VIBESTUDIO_SOURCE_INSTANCE: "1",
      VIBESTUDIO_DEV_ROOT_TEMPLATE_CHECKOUT: "/private/checkpoint",
      VIBESTUDIO_DEV_ROOT_TEMPLATE_WRITEBACK: "/visible/base",
    });
  });

  it.each([
    ["named development", true],
    ["disposable development", true],
    ["production selection", false],
  ])("strips hostile ambient Base selection for %s", (_label, hasBase) => {
    const env = developmentInstanceEnvironment({
      parent: {
        VIBESTUDIO_DEV_ROOT_TEMPLATE: "stale",
        VIBESTUDIO_DEV_ROOT_TEMPLATE_CHECKOUT: "/stale/checkpoint",
        VIBESTUDIO_DEV_ROOT_TEMPLATE_WRITEBACK: "/stale/writeback",
        VIBESTUDIO_SOURCE_INSTANCE: "1",
      },
      repoRoot: "/host",
      instanceRoot: "/instance",
      instanceId: "isolated",
      sourceCoupled: false,
      ...(hasBase ? { base } : {}),
    });
    expect(env["VIBESTUDIO_SOURCE_INSTANCE"]).toBe("0");
    expect(env["VIBESTUDIO_DEV_ROOT_TEMPLATE_WRITEBACK"]).toBeUndefined();
    expect(env["VIBESTUDIO_DEV_ROOT_TEMPLATE_CHECKOUT"]).toBe(
      hasBase ? "/private/checkpoint" : undefined
    );
  });
});
