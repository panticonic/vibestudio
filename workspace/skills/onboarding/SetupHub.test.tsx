// @vitest-environment jsdom

import { fireEvent, render, waitFor } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { lintRendererSource } from "@workspace/agentic-core";
import SetupHub from "./SetupHub.js";
import type { SetupCapabilitySnapshot } from "./snapshot.js";
import type { TemplateCatalogSnapshot } from "@workspace/template-registry";

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
const installableGoogle: SetupCapabilitySnapshot[] = [
  {
    id: "connection.google-workspace",
    state: "not-installed",
    summary: "Google Workspace is not installed in this workspace.",
    scope: "user-workspace",
    tier: "direct",
    attention: "none",
    nextAction: "install",
    observedAt,
  },
];
const templateCatalog = {
  version: 1,
  revision: "2026-07-30.1",
  systemEpoch: 57,
  source: "verified",
  stale: false,
  verifiedAt: observedAt,
  coordinates: {
    url: "git+https://github.com/vibestudio/template-registry.git",
    ref: "refs/heads/main",
    commit: "a".repeat(40),
    snapshot: `v1-sha256:${"b".repeat(64)}`,
  },
  entries: [
    {
      id: "google-workspace",
      name: "Google Workspace",
      description: "Connect Gmail, Calendar, and Drive.",
      tags: ["google"],
      recommended: true,
      url: "git+https://github.com/vibestudio/template-google-workspace.git",
      promoted: {
        ref: "refs/tags/v1.0.0",
        commit: "c".repeat(40),
        snapshot: `v1-sha256:${"d".repeat(64)}`,
      },
    },
  ],
} satisfies TemplateCatalogSnapshot;

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

  it("offers the mobile template from the devices row", () => {
    const installableMobile: SetupCapabilitySnapshot[] = [
      {
        id: "connection.device",
        state: "not-installed",
        summary: "Mobile support is available to install for this workspace.",
        scope: "device",
        tier: "host-topology",
        attention: "none",
        nextAction: "install",
        observedAt,
      },
    ];
    const mobileCatalog = {
      ...templateCatalog,
      entries: [
        {
          ...templateCatalog.entries[0]!,
          id: "mobile",
          name: "Mobile",
          description: "Install the mobile app and phone setup workflow.",
        },
      ],
    } satisfies TemplateCatalogSnapshot;
    const view = render(
      <Theme>
        <SetupHub
          props={{ snapshot: installableMobile, templateCatalog: mobileCatalog }}
          chat={{ send: vi.fn() }}
        />
      </Theme>
    );

    expect(view.getByRole("button", { name: "Install template" })).toBeTruthy();
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

  it("routes an unavailable advertised capability through the exact verified template pin", async () => {
    const send = vi.fn(async () => undefined);
    const view = render(
      <Theme>
        <SetupHub props={{ snapshot: installableGoogle, templateCatalog }} chat={{ send }} />
      </Theme>
    );

    fireEvent.click(view.getByRole("button", { name: "Install template" }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith("Install Google Workspace for Google Workspace", {
        metadata: {
          interaction: {
            source: "onboarding-template-catalog",
            kind: "template-add",
            targetId: "google-workspace",
            catalogId: "google-workspace",
            registryCommit: "a".repeat(40),
            registrySnapshot: `v1-sha256:${"b".repeat(64)}`,
          },
        },
      })
    );
  });
});
