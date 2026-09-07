import { describe, expect, it } from "vitest";
import { developmentInstanceEnvironment } from "./developmentInstanceEnvironment.js";

const pin = (name: string) => ({
  url: `git+https://example.test/${name}.git`,
  ref: `refs/heads/distributions/${name}`,
  commit: name[0]!.repeat(40),
  snapshot: `v1-sha256:${name[0]!.repeat(64)}` as const,
});
const base = {
  pins: { base: pin("base"), personal: pin("personal"), system: pin("system") },
  checkouts: {
    base: "/private/base",
    personal: "/private/personal",
    system: "/private/system",
  },
  sourceCheckout: "/visible/base",
  writebackRepositories: ["meta", "packages/base"],
};
const templates = [{ pin: { commit: "template" }, checkout: "/private/template" }];

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
      VIBESTUDIO_DEFAULT_WORKSPACE_TEMPLATES: JSON.stringify(base.pins),
      VIBESTUDIO_INITIAL_WORKSPACE_TEMPLATE: JSON.stringify(base.pins.system),
      VIBESTUDIO_DEV_ROOT_TEMPLATE_WRITEBACK: JSON.stringify({
        root: "/visible/base",
        repositories: ["meta", "packages/base"],
      }),
    });
  });

  it("passes exact optional-template acquisition sources and replaces ambient values", () => {
    const env = developmentInstanceEnvironment({
      parent: { VIBESTUDIO_DEV_TEMPLATE_SOURCES: "stale" },
      repoRoot: "/host",
      instanceRoot: "/instance",
      instanceId: "isolated",
      sourceCoupled: false,
      templates,
    });
    expect(env["VIBESTUDIO_DEV_TEMPLATE_SOURCES"]).toBe(JSON.stringify(templates));
  });

  it("keeps optional templates read-only in the source-coupled instance", () => {
    const env = developmentInstanceEnvironment({
      parent: {},
      repoRoot: "/host",
      instanceRoot: "/instance",
      instanceId: "source",
      sourceCoupled: true,
      base,
      templates,
    });

    expect(JSON.parse(env["VIBESTUDIO_DEV_TEMPLATE_SOURCES"]!)).toEqual([
      { pin: base.pins.base, checkout: base.checkouts.base },
      { pin: base.pins.personal, checkout: base.checkouts.personal },
      { pin: base.pins.system, checkout: base.checkouts.system },
      ...templates,
    ]);
    expect(JSON.parse(env["VIBESTUDIO_DEV_ROOT_TEMPLATE_WRITEBACK"]!)).toEqual({
      root: "/visible/base",
      repositories: ["meta", "packages/base"],
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
    expect(env["VIBESTUDIO_DEV_ROOT_TEMPLATE_CHECKOUT"]).toBeUndefined();
    expect(env["VIBESTUDIO_DEFAULT_WORKSPACE_TEMPLATES"]).toBe(
      hasBase ? JSON.stringify(base.pins) : undefined
    );
  });
});
