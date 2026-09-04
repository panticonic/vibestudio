import { describe, expect, it } from "vitest";
import {
  DEVELOPMENT_TEMPLATE_SOURCES_ENV,
  DEVELOPMENT_TEMPLATE_SOURCES_ENABLED_ENV,
  readDevelopmentTemplateSources,
} from "./developmentTemplateSources.js";

const source = {
  pin: {
    url: "git+https://example.test/template.git",
    ref: "refs/heads/main",
    commit: "a".repeat(40),
    snapshot: `v1-sha256:${"b".repeat(64)}`,
  },
  checkout: "/private/template",
};

describe("development template sources", () => {
  it("accepts exact local acquisition sources only in development", () => {
    expect(
      readDevelopmentTemplateSources({
        NODE_ENV: "development",
        [DEVELOPMENT_TEMPLATE_SOURCES_ENV]: JSON.stringify([source]),
      })
    ).toEqual([source]);
    expect(() =>
      readDevelopmentTemplateSources({
        NODE_ENV: "production",
        [DEVELOPMENT_TEMPLATE_SOURCES_ENV]: JSON.stringify([source]),
      })
    ).toThrow("require an explicit source launch");
    expect(
      readDevelopmentTemplateSources({
        NODE_ENV: "production",
        [DEVELOPMENT_TEMPLATE_SOURCES_ENABLED_ENV]: "1",
        [DEVELOPMENT_TEMPLATE_SOURCES_ENV]: JSON.stringify([source]),
      })
    ).toEqual([source]);
  });

  it("rejects two transports for one durable template identity", () => {
    expect(() =>
      readDevelopmentTemplateSources({
        NODE_ENV: "development",
        [DEVELOPMENT_TEMPLATE_SOURCES_ENV]: JSON.stringify([source, source]),
      })
    ).toThrow("selected more than once");
  });
});
