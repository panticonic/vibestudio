// @vitest-environment jsdom

import { fireEvent, render, waitFor } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { lintRendererSource } from "@workspace/agentic-core";
import SetupHub from "./SetupHub.js";
import type { SetupCapabilitySnapshot } from "./snapshot.js";

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

describe("SetupHub", () => {
  it("uses only renderer-safe imports", () => {
    const source = readFileSync(
      resolve(process.cwd(), "workspace/skills/onboarding/SetupHub.tsx"),
      "utf8"
    );
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
});
