// @vitest-environment jsdom

import { fireEvent, render, waitFor } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { lintRendererSource } from "@workspace/agentic-core";
import SetupHub from "./SetupHub.js";
import type { SetupCapabilitySnapshot } from "./snapshot.js";
import type { OptionalTemplateSnapshot } from "./templates.js";

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
    state: "available",
    summary: "Available to review and add.",
    observedAt,
  },
  {
    id: "template.news",
    state: "installed",
    summary: "Installed in this workspace.",
    observedAt,
  },
  {
    id: "template.spectrolite",
    state: "unknown",
    summary: "Installation status could not be read right now.",
    observedAt,
  },
];
describe("SetupHub", () => {
  it("uses only renderer-safe imports", () => {
    const source = readFileSync(resolve(__dirname, "SetupHub.tsx"), "utf8");
    expect(lintRendererSource(source)).toEqual([]);
  });

  it("separates setup state from ready-now capabilities", () => {
    const view = render(
      <Theme>
        <SetupHub props={{ snapshot: snapshots }} chat={{ send: vi.fn() }} />
      </Theme>
    );
    expect(view.getByText("Google Workspace")).toBeTruthy();
    expect(view.getByRole("button", { name: "Ingest PDFs" })).toBeTruthy();
    expect(view.queryByText(/PDF.*Not configured/i)).toBeNull();
    expect(view.getByText(/not unfinished setup/i)).toBeTruthy();
  });

  it("reports a missing base owner without inventing an install action", () => {
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
    const view = render(
      <Theme>
        <SetupHub props={{ snapshot: unavailableMobile }} chat={{ send: vi.fn() }} />
      </Theme>
    );

    expect(view.getByText("Unavailable")).toBeTruthy();
    expect(view.queryByRole("button", { name: /Add Devices/i })).toBeNull();
  });

  it("sends a stable structured interaction and does not mutate the observation", async () => {
    const send = vi.fn(async () => undefined);
    const view = render(
      <Theme>
        <SetupHub props={{ snapshot: snapshots }} chat={{ send }} />
      </Theme>
    );

    fireEvent.click(view.getByRole("button", { name: "Check connection" }));

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith("Check connection Google Workspace", {
        metadata: {
          interaction: {
            source: "onboarding-setup-hub",
            kind: "onboarding-capability",
            action: "check",
            targetId: "connection.google-workspace",
          },
        },
      })
    );
    expect(view.getByText("Connected · not checked")).toBeTruthy();
  });

  it("shows optional templates and sends available choices through structured review", async () => {
    const send = vi.fn(async () => undefined);
    const view = render(
      <Theme>
        <SetupHub props={{ snapshot: snapshots, templates }} chat={{ send }} />
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
          },
        },
      })
    );
  });
});
