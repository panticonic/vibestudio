import { describe, expect, it } from "vitest";
import { developmentInstanceEnvironment } from "./developmentInstanceEnvironment.js";

const pin = (name: string) => ({
  url: `git+https://example.test/${name}.git`,
  ref: "refs/heads/main",
  commit: name[0]!.repeat(40),
});
const defaultTemplates = {
  pins: { base: pin("base"), personal: pin("personal"), system: pin("system") },
  checkouts: {
    base: "/private/base",
    personal: "/private/personal",
    system: "/private/system",
  },
};
const templates = [
  {
    pin: pin("example"),
    checkout: "/private/template",
    review: {
      presentation: { name: "Local example" },
      repositories: ["panels/example"],
      files: [],
    },
  },
];

describe("development instance environment", () => {
  it("retains the three foundation pins used for private workspace bootstrap", () => {
    const env = developmentInstanceEnvironment({
      parent: {},
      repoRoot: "/host",
      instanceRoot: "/instance",
      instanceId: "source",
      sourceCoupled: true,
      disposable: false,
      defaultTemplates,
    });
    expect(env).toMatchObject({
      VIBESTUDIO_SOURCE_INSTANCE: "1",
      VIBESTUDIO_DEFAULT_WORKSPACE_TEMPLATES: JSON.stringify(defaultTemplates.pins),
      VIBESTUDIO_INITIAL_WORKSPACE_TEMPLATE: JSON.stringify(defaultTemplates.pins.system),
    });
  });

  it("registers every source in a complete official development set", () => {
    const complete = {
      ...defaultTemplates,
      sourcePins: { ...defaultTemplates.pins, examples: pin("examples") },
      sources: [{ id: "base" }, { id: "personal" }, { id: "system" }, { id: "examples" }],
      checkouts: { ...defaultTemplates.checkouts, examples: "/private/examples" },
    };
    const env = developmentInstanceEnvironment({
      parent: {},
      repoRoot: "/host",
      instanceRoot: "/instance",
      instanceId: "source",
      sourceCoupled: true,
      disposable: false,
      defaultTemplates: complete,
    });
    expect(JSON.parse(env["VIBESTUDIO_WORKSPACE_SOURCES"]!)).toEqual([
      { pin: complete.sourcePins.base, checkout: "/private/base" },
      { pin: complete.sourcePins.personal, checkout: "/private/personal" },
      { pin: complete.sourcePins.system, checkout: "/private/system" },
      { pin: complete.sourcePins.examples, checkout: "/private/examples" },
    ]);
  });

  it("passes exact optional-template acquisition sources and replaces ambient values", () => {
    const env = developmentInstanceEnvironment({
      parent: { VIBESTUDIO_WORKSPACE_SOURCES: "stale" },
      repoRoot: "/host",
      instanceRoot: "/instance",
      instanceId: "isolated",
      sourceCoupled: false,
      disposable: false,
      templates,
    });
    expect(env["VIBESTUDIO_WORKSPACE_SOURCES"]).toBe(JSON.stringify(templates));
  });

  it("keeps optional templates read-only in the source-coupled instance", () => {
    const env = developmentInstanceEnvironment({
      parent: {},
      repoRoot: "/host",
      instanceRoot: "/instance",
      instanceId: "source",
      sourceCoupled: true,
      disposable: false,
      defaultTemplates,
      templates,
    });

    expect(JSON.parse(env["VIBESTUDIO_WORKSPACE_SOURCES"]!)).toEqual([
      { pin: defaultTemplates.pins.base, checkout: defaultTemplates.checkouts.base },
      { pin: defaultTemplates.pins.personal, checkout: defaultTemplates.checkouts.personal },
      { pin: defaultTemplates.pins.system, checkout: defaultTemplates.checkouts.system },
      ...templates,
    ]);
  });

  it.each([
    ["named development", true],
    ["disposable development", true],
    ["production selection", false],
  ])("strips hostile ambient template selection for %s", (_label, hasTemplates) => {
    const env = developmentInstanceEnvironment({
      parent: {
        VIBESTUDIO_DEFAULT_WORKSPACE_TEMPLATES: "stale",
        VIBESTUDIO_SOURCE_INSTANCE: "1",
      },
      repoRoot: "/host",
      instanceRoot: "/instance",
      instanceId: "isolated",
      sourceCoupled: false,
      disposable: false,
      ...(hasTemplates ? { defaultTemplates } : {}),
    });
    expect(env["VIBESTUDIO_SOURCE_INSTANCE"]).toBe("0");
    expect(env["VIBESTUDIO_DEFAULT_WORKSPACE_TEMPLATES"]).toBe(
      hasTemplates ? JSON.stringify(defaultTemplates.pins) : undefined
    );
  });
});

it("selects an exact additional checkout without changing the private workspace templates", () => {
  const env = developmentInstanceEnvironment({
    parent: {},
    repoRoot: "/host",
    instanceRoot: "/instance",
    instanceId: "test",
    sourceCoupled: false,
    disposable: false,
    defaultTemplates,
    templates,
    initialWorkspaceTemplate: templates[0]!.pin,
  });
  expect(JSON.parse(env["VIBESTUDIO_INITIAL_WORKSPACE_TEMPLATE"]!)).toEqual(templates[0]!.pin);
  expect(JSON.parse(env["VIBESTUDIO_DEFAULT_WORKSPACE_TEMPLATES"]!)).toEqual(defaultTemplates.pins);
  expect(JSON.parse(env["VIBESTUDIO_WORKSPACE_SOURCES"]!)).toContainEqual(templates[0]);
});
