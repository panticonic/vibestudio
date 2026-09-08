import { describe, expect, it } from "vitest";
import {
  assertProductDesktopArguments,
  productDesktopEnvironment,
} from "./productDesktopLaunch.js";

const systemPin = {
  url: "git+https://example.test/base.git",
  ref: "refs/heads/distributions/system",
  commit: "a".repeat(40),
  snapshot: `v1-sha256:${"b".repeat(64)}` as const,
};
const base = {
  pins: {
    base: { ...systemPin, ref: "refs/heads/distributions/base" },
    personal: { ...systemPin, ref: "refs/heads/distributions/personal" },
    system: systemPin,
  },
  checkouts: {
    base: "/temporary/base",
    personal: "/temporary/personal",
    system: "/temporary/system",
  },
  sourceCheckout: "/visible/base",
  writebackRepositories: ["meta", "packages/base"],
};
const templates = [{ pin: { commit: "template" }, checkout: "/private/template" }];

describe("product desktop source launch", () => {
  it.each([
    "--ephemeral",
    "--ephemeral-workspace",
    "--resume-ephemeral-workspace",
    "--instance=other",
    "--base-checkout=/tmp/base",
    "--workspace-checkout=/tmp/app",
    "--workspace-checkout",
    "--production-base",
    "--dev-iroh-remote",
  ])("rejects developer-only option %s", (option) => {
    expect(() => assertProductDesktopArguments([option])).toThrow(/not supported by pnpm start/);
  });

  it("retains ordinary desktop arguments", () => {
    expect(() =>
      assertProductDesktopArguments(["--workspace", "default", "vibestudio://panel?v=1"])
    ).not.toThrow();
  });

  it("uses production behavior and the ordinary profile without Base write-back", () => {
    const env = productDesktopEnvironment({
      parent: {
        NODE_ENV: "development",
        VIBESTUDIO_INSTANCE_ROOT: "/instance",
        VIBESTUDIO_INSTANCE: "source",
        VIBESTUDIO_SOURCE_INSTANCE: "1",
        VIBESTUDIO_DEV_ROOT_TEMPLATE_WRITEBACK: "/visible/base",
      },
      repoRoot: "/host",
      distributions: base,
      bootstrapSystem: true,
    });

    expect(env).toMatchObject({
      NODE_ENV: "production",
      VIBESTUDIO_APP_ROOT: "/host",
      VIBESTUDIO_INITIAL_WORKSPACE_TEMPLATE: JSON.stringify(base.pins.system),
      VIBESTUDIO_DEFAULT_WORKSPACE_TEMPLATES: JSON.stringify(base.pins),
    });
    expect(env["VIBESTUDIO_INSTANCE_ROOT"]).toBeUndefined();
    expect(env["VIBESTUDIO_INSTANCE"]).toBeUndefined();
    expect(env["VIBESTUDIO_SOURCE_INSTANCE"]).toBeUndefined();
    expect(env["VIBESTUDIO_DEV_ROOT_TEMPLATE_WRITEBACK"]).toBeUndefined();
  });

  it("clears ambient selectors when no source distributions are provided", () => {
    const env = productDesktopEnvironment({
      parent: {
        VIBESTUDIO_INITIAL_WORKSPACE_TEMPLATE: "stale",
        VIBESTUDIO_DEV_ROOT_TEMPLATE: "stale",
      },
      repoRoot: "/host",
    });
    expect(env["VIBESTUDIO_INITIAL_WORKSPACE_TEMPLATE"]).toBeUndefined();
    expect(env["VIBESTUDIO_DEV_ROOT_TEMPLATE"]).toBeUndefined();
  });

  it("keeps production runtime semantics while explicitly enabling local template acquisition", () => {
    const env = productDesktopEnvironment({
      parent: {
        VIBESTUDIO_DEV_TEMPLATE_SOURCES: "stale",
        VIBESTUDIO_DEV_TEMPLATE_SOURCES_ENABLED: "stale",
      },
      repoRoot: "/host",
      templates,
    });
    expect(env).toMatchObject({
      NODE_ENV: "production",
      VIBESTUDIO_DEV_TEMPLATE_SOURCES: JSON.stringify(templates),
      VIBESTUDIO_DEV_TEMPLATE_SOURCES_ENABLED: "1",
    });
  });
});
