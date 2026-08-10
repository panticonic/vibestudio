// @vitest-environment jsdom

import { fireEvent, render, waitFor } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { lintRendererSource } from "@workspace/agentic-core";
import SetupHub from "./SetupHub.js";
import type { SetupCapabilitySnapshot } from "./snapshot.js";
import type { OptionalTemplateSnapshot } from "./templates.js";
import { onboardingCatalog, type OnboardingCapabilityDefinition } from "./catalog.js";

const loaders = vi.hoisted(() => ({
  capabilities: vi.fn(),
  templates: vi.fn(),
}));

vi.mock("./snapshot.js", () => ({
  composeOnboardingCapabilities: loaders.capabilities,
}));

vi.mock("./templates.js", () => ({
  loadOptionalTemplateSnapshot: loaders.templates,
}));

const googleCapability: OnboardingCapabilityDefinition = {
  id: "connection.google-workspace",
  title: "Google Workspace",
  summary: "Connect Google Workspace.",
  category: "connections",
  role: "connection",
  scope: "user-workspace",
  tier: "direct",
  ownerSkillPath: "skills/google-workspace/SKILL.md",
  actions: { check: { via: "owner-skill" } },
  visibility: "primary",
  setup: { statusAdapter: "google", successDescription: "Verified live." },
};
const catalog = [...onboardingCatalog, googleCapability];
const selection = {
  catalogId: "examples",
  registryCommit: "a".repeat(40),
  registrySnapshot: `v1-sha256:${"b".repeat(64)}`,
};

const observedAt = new Date().toISOString();
const snapshots: SetupCapabilitySnapshot[] = [
  {
    id: "connection.google-workspace",
    state: "connected-unverified",
    verification: "unverified",
    summary: "Connected; not checked live.",
    scope: "user-workspace",
    tier: "direct",
    attention: "none",
    nextAction: "check",
    observedAt,
  },
  {
    id: "connection.device",
    state: "connected",
    summary: "This device is paired.",
    scope: "device",
    tier: "host-topology",
    attention: "none",
    nextAction: "setup",
    observedAt,
  },
];
const templates: OptionalTemplateSnapshot[] = [
  {
    id: "template.examples",
    title: "Examples",
    description: "Sample panels and workers.",
    state: "available",
    summary: "Available to review and add.",
    observedAt,
    selection,
  },
  {
    id: "template.news",
    title: "News",
    description: "News tools.",
    state: "installed",
    summary: "Installed in this workspace.",
    observedAt,
    selection: { ...selection, catalogId: "news" },
  },
  {
    id: "template.spectrolite",
    title: "Spectrolite",
    description: "MDX writing.",
    state: "unknown",
    summary: "Installation status could not be read right now.",
    observedAt,
    selection: { ...selection, catalogId: "spectrolite" },
  },
];

beforeEach(() => {
  loaders.capabilities.mockReset();
  loaders.capabilities.mockResolvedValue({ catalog, snapshot: snapshots });
  loaders.templates.mockReset();
  loaders.templates.mockResolvedValue(templates);
});

describe("SetupHub", () => {
  it("uses only renderer-safe imports", () => {
    const source = readFileSync(resolve(__dirname, "SetupHub.tsx"), "utf8");
    expect(lintRendererSource(source)).toEqual([]);
  });

  it("separates setup state from ready-now capabilities", async () => {
    const view = render(
      <Theme>
        <SetupHub props={{ catalog, snapshot: snapshots }} chat={{ send: vi.fn() }} />
      </Theme>
    );
    expect(view.getByText("Google Workspace")).toBeTruthy();
    expect(view.getByRole("button", { name: "Ingest PDFs" })).toBeTruthy();
    expect(view.queryByText(/PDF.*Not configured/i)).toBeNull();
    expect(view.getByText(/not unfinished setup/i)).toBeTruthy();
    await waitFor(() => expect(view.getByText("Refresh")).toBeTruthy());
  });

  it("reports a missing base owner without inventing an install action", async () => {
    const unavailableMobile: SetupCapabilitySnapshot[] = [
      {
        id: "connection.device",
        state: "unavailable",
        summary:
          "Device setup is unavailable because its base capability owner could not be loaded.",
        scope: "device",
        tier: "host-topology",
        attention: "blocking",
        observedAt,
      },
    ];
    loaders.capabilities.mockResolvedValue({ catalog, snapshot: unavailableMobile });
    const view = render(
      <Theme>
        <SetupHub props={{ catalog, snapshot: unavailableMobile }} chat={{ send: vi.fn() }} />
      </Theme>
    );

    expect(view.getByText("Unavailable")).toBeTruthy();
    expect(view.queryByRole("button", { name: /Add Devices/i })).toBeNull();
    await waitFor(() => expect(view.getByText("Refresh")).toBeTruthy());
  });

  it("checks a connection directly and refreshes the cached owner state", async () => {
    const send = vi.fn(async () => undefined);
    const view = render(
      <Theme>
        <SetupHub props={{ catalog, snapshot: snapshots }} chat={{ send }} />
      </Theme>
    );

    fireEvent.click(view.getByRole("button", { name: "Check connection" }));

    await waitFor(() =>
      expect(loaders.capabilities).toHaveBeenCalledWith({
        verifyCapabilityId: "connection.google-workspace",
      })
    );
    expect(send).not.toHaveBeenCalled();
    expect(view.getByText("Connected · not checked")).toBeTruthy();
  });

  it("refreshes capabilities on mount and on a stable-card rerender", async () => {
    const scope: Record<string, unknown> = {
      onboardingSetupOverview: { catalog, snapshot: snapshots },
    };
    const save = vi.fn(async () => undefined);
    const view = render(
      <Theme>
        <SetupHub
          props={{}}
          chat={{ send: vi.fn() }}
          scope={scope}
          scopes={{ save }}
          inlineUi={{ id: "onboarding-setup-overview", renderedAt: "first" }}
        />
      </Theme>
    );

    await waitFor(() => expect(loaders.capabilities).toHaveBeenCalledTimes(1));
    view.rerender(
      <Theme>
        <SetupHub
          props={{}}
          chat={{ send: vi.fn() }}
          scope={scope}
          scopes={{ save }}
          inlineUi={{ id: "onboarding-setup-overview", renderedAt: "second" }}
        />
      </Theme>
    );
    await waitFor(() => expect(loaders.capabilities).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenCalled();
  });

  it("explains templates and contacts the registry only after an explicit load", async () => {
    const view = render(
      <Theme>
        <SetupHub props={{ catalog, snapshot: snapshots }} chat={{ send: vi.fn() }} />
      </Theme>
    );

    expect(view.getByText(/reviewed bundles of panels, skills/i)).toBeTruthy();
    expect(view.getByText(/contacts Vibestudio's verified template registry/i)).toBeTruthy();
    expect(loaders.templates).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole("button", { name: "Load optional templates" }));
    await waitFor(() => expect(loaders.templates).toHaveBeenCalledOnce());
    expect(view.getByText("Examples")).toBeTruthy();
  });

  it("shows optional templates and sends available choices through structured review", async () => {
    const send = vi.fn(async () => undefined);
    const view = render(
      <Theme>
        <SetupHub props={{ catalog, snapshot: snapshots, templates }} chat={{ send }} />
      </Theme>
    );

    expect(view.getByText("Optional templates")).toBeTruthy();
    expect(view.getByText("Installed")).toBeTruthy();
    expect(view.getByText("Unknown")).toBeTruthy();
    expect(view.getAllByRole("button", { name: "Review & add" })).toHaveLength(1);

    fireEvent.click(view.getByRole("button", { name: "Review & add" }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith("Review and add Examples", {
        metadata: {
          interaction: {
            source: "onboarding-setup-hub",
            kind: "onboarding-template",
            action: "add",
            targetId: "template.examples",
            ...selection,
          },
        },
      })
    );
  });
});
