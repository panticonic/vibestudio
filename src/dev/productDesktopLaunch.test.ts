import { describe, expect, it } from "vitest";
import {
  assertProductDesktopArguments,
  productDesktopEnvironment,
} from "./productDesktopLaunch.js";

const systemPin = {
  url: "git+https://example.test/base.git",
  ref: "refs/heads/main",
  commit: "a".repeat(40),
};
const defaultTemplates = {
  pins: {
    base: { ...systemPin, url: "git+https://example.test/base.git" },
    personal: { ...systemPin, url: "git+https://example.test/personal.git" },
    system: systemPin,
  },
  checkouts: {
    base: "/temporary/base",
    personal: "/temporary/personal",
    system: "/temporary/system",
  },
  sourceCheckouts: {
    base: "/visible/base",
    personal: "/visible/personal",
    system: "/visible/system",
  },
  dependencies: [],
};
const templates = [{ pin: { commit: "template" }, checkout: "/private/template" }];

describe("product desktop source launch", () => {
  it.each([
    "--ephemeral",
    "--instance=other",
    "--template-checkouts=/tmp/templates",
    "--workspace-checkout=/tmp/app",
    "--workspace-checkout",
    "--production-templates",
    "--dev-iroh-remote",
  ])("rejects developer-only option %s", (option) => {
    expect(() => assertProductDesktopArguments([option])).toThrow(/not supported by pnpm start/);
  });

  it("retains ordinary desktop arguments", () => {
    expect(() =>
      assertProductDesktopArguments(["--workspace", "default", "vibestudio://panel?v=1"])
    ).not.toThrow();
  });

  it("uses production behavior and the ordinary profile", () => {
    const env = productDesktopEnvironment({
      parent: {
        NODE_ENV: "development",
        VIBESTUDIO_INSTANCE_ROOT: "/instance",
        VIBESTUDIO_INSTANCE: "source",
        VIBESTUDIO_SOURCE_INSTANCE: "1",
      },
      repoRoot: "/host",
      defaultTemplates,
      bootstrapSystem: true,
    });

    expect(env).toMatchObject({
      NODE_ENV: "production",
      VIBESTUDIO_APP_ROOT: "/host",
      VIBESTUDIO_INITIAL_WORKSPACE_TEMPLATE: JSON.stringify(defaultTemplates.pins.system),
      VIBESTUDIO_DEFAULT_WORKSPACE_TEMPLATES: JSON.stringify(defaultTemplates.pins),
    });
    expect(env["VIBESTUDIO_INSTANCE_ROOT"]).toBeUndefined();
    expect(env["VIBESTUDIO_INSTANCE"]).toBeUndefined();
    expect(env["VIBESTUDIO_SOURCE_INSTANCE"]).toBeUndefined();
  });

  it("clears ambient selectors when no development templates are provided", () => {
    const env = productDesktopEnvironment({
      parent: {
        VIBESTUDIO_INITIAL_WORKSPACE_TEMPLATE: "stale",
        VIBESTUDIO_DEFAULT_WORKSPACE_TEMPLATES: "stale",
      },
      repoRoot: "/host",
    });
    expect(env["VIBESTUDIO_INITIAL_WORKSPACE_TEMPLATE"]).toBeUndefined();
    expect(env["VIBESTUDIO_DEFAULT_WORKSPACE_TEMPLATES"]).toBeUndefined();
  });

  it("keeps production runtime semantics while explicitly enabling local template acquisition", () => {
    const env = productDesktopEnvironment({
      parent: {
        VIBESTUDIO_WORKSPACE_SOURCES: "stale",
      },
      repoRoot: "/host",
      templates,
    });
    expect(env).toMatchObject({
      NODE_ENV: "production",
      VIBESTUDIO_WORKSPACE_SOURCES: JSON.stringify(templates),
    });
  });
});
