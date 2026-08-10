import { describe, expect, it, vi } from "vitest";
import { panelFailure, PanelOperationError } from "@vibestudio/shared/panel/observation";

vi.mock("@workspace/runtime", () => ({
  callMain: vi.fn(async (method: string) => (method === "workspace.listSkills" ? [] : undefined)),
  openPanel: vi.fn(),
}));

import { openPanel } from "@workspace/runtime";
import { executeOnboardingSelection } from "./execution";
import { onboardingInteraction } from "./routing";

function dependencies() {
  return {
    openWorkspacePanel: vi.fn(async (source: string) => ({ id: `panel:${source}` })),
    openShellSurface: vi.fn(async () => undefined),
  };
}

describe("executeOnboardingSelection", () => {
  it("focuses and waits for client-owned panel routes by default", async () => {
    vi.mocked(openPanel).mockResolvedValue({ id: "panel:about/browser-import-inspector" } as never);

    await expect(
      executeOnboardingSelection(onboardingInteraction("migration.browser-environment", "setup"))
    ).resolves.toEqual({
      handled: true,
      target: { via: "panel", path: "about/browser-import-inspector" },
      panelId: "panel:about/browser-import-inspector",
      readiness: "ready",
    });
    expect(openPanel).toHaveBeenCalledWith("about/browser-import-inspector", { focus: true });
  });

  it("opens client-owned shell and About routes", async () => {
    const deps = dependencies();

    await expect(
      executeOnboardingSelection(onboardingInteraction("connection.device", "setup"), deps)
    ).resolves.toEqual({
      handled: true,
      target: { via: "shell-navigation", target: "connection-settings" },
    });
    await executeOnboardingSelection(onboardingInteraction("connection.github", "inspect"), deps);
    await expect(
      executeOnboardingSelection(
        onboardingInteraction("migration.browser-environment", "setup"),
        deps
      )
    ).resolves.toEqual({
      handled: true,
      target: { via: "panel", path: "about/browser-import-inspector" },
      panelId: "panel:about/browser-import-inspector",
      readiness: "ready",
    });

    expect(deps.openShellSurface).toHaveBeenCalledWith("connection-settings");
    expect(deps.openWorkspacePanel).toHaveBeenCalledWith("about/credentials");
    expect(deps.openWorkspacePanel).toHaveBeenCalledWith("about/browser-import-inspector");
  });

  it("returns the committed panel receipt when readiness cannot be confirmed", async () => {
    const failure = panelFailure({
      code: "unknown_failure",
      stage: "runtime",
      message: "Readiness observation failed",
      provenance: {
        panelId: "panel:about/browser-import-inspector",
        runtimeEntityId: "panel:nav-browser-import",
        source: "about/browser-import-inspector",
        contextId: "ctx:onboarding",
        requestedRef: "latest",
      },
      details: { slotCommitted: true },
    });
    const deps = dependencies();
    deps.openWorkspacePanel.mockRejectedValueOnce(new PanelOperationError(failure));

    await expect(
      executeOnboardingSelection(
        onboardingInteraction("migration.browser-environment", "setup"),
        deps
      )
    ).resolves.toEqual({
      handled: true,
      target: { via: "panel", path: "about/browser-import-inspector" },
      panelId: "panel:about/browser-import-inspector",
      readiness: "unconfirmed",
      failure,
    });
    expect(deps.openWorkspacePanel).toHaveBeenCalledOnce();
  });

  it("returns existing owner workflows and rejects retired IDs", async () => {
    const deps = dependencies();

    await expect(
      executeOnboardingSelection(onboardingInteraction("connection.github", "setup"), deps)
    ).resolves.toEqual({
      handled: false,
      target: { via: "owner-skill" },
      ownerSkillPath: "skills/github/SKILL.md",
    });
    await expect(
      executeOnboardingSelection(onboardingInteraction("connection.retired", "setup"), deps)
    ).rejects.toThrow("Unknown or retired onboarding capability");
  });
});
