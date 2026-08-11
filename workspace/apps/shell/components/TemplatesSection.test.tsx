// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TemplatesSection } from "./TemplatesSection";

const clients = vi.hoisted(() => ({
  templates: {
    status: vi.fn(),
    operations: vi.fn(),
    catalog: vi.fn(),
    check: vi.fn(),
    pull: vi.fn(),
    remove: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    decideSuggestion: vi.fn(),
  },
  credentials: { requestCredentialInput: vi.fn() },
  panel: { createPanel: vi.fn() },
  vcs: { compareDelta: vi.fn(), integrateDelta: vi.fn() },
}));

vi.mock("../shell/client", () => clients);

const row = {
  nodeId: "node-github",
  alias: "github",
  url: "git+https://example.test/github.git",
  ref: "refs/tags/v1",
  commit: "1".repeat(40),
  direct: true,
  state: "current" as const,
  contributedParts: 2,
  pendingReviews: 0,
  suggestions: [],
};

function draw() {
  return render(
    <Theme>
      <TemplatesSection />
    </Theme>
  );
}

describe("TemplatesSection mutation refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clients.templates.status.mockResolvedValue([row]);
    clients.templates.operations.mockResolvedValue([]);
    clients.templates.catalog.mockResolvedValue({
      version: 1,
      revision: "registry-v1",
      systemEpoch: 1,
      entries: [],
      coordinates: {
        url: "git+https://example.test/registry.git",
        ref: "refs/heads/main",
        commit: "2".repeat(40),
        snapshot: `v1-sha256:${"2".repeat(64)}`,
      },
      stale: false,
    });
    clients.templates.check.mockResolvedValue([]);
    clients.panel.createPanel.mockResolvedValue({ id: "upgrade-chat" });
  });

  afterEach(cleanup);

  it("refreshes status and pending operations after an update request", async () => {
    clients.templates.pull.mockResolvedValue({
      operationId: "pull-github",
      state: "pending",
      affectedParts: [],
    });
    const view = draw();
    fireEvent.click(await view.findByRole("button", { name: "Check for updates" }));

    await waitFor(() => expect(clients.templates.pull).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(clients.templates.operations).toHaveBeenCalledTimes(2));
    expect(clients.templates.status).toHaveBeenCalledTimes(4);
  });

  it("refreshes away a relationship after removal", async () => {
    let removed = false;
    clients.templates.status.mockImplementation(async () => (removed ? [] : [row]));
    clients.templates.remove.mockImplementation(async () => {
      removed = true;
      return {
        operationId: "remove-github",
        state: "applied",
        affectedParts: ["extensions/github"],
      };
    });
    const view = draw();
    fireEvent.click(await view.findByRole("button", { name: "Remove" }));

    expect(await view.findByText("No committed template relationships yet.")).toBeTruthy();
    expect(clients.templates.operations).toHaveBeenCalledTimes(2);
  });

  it("opens a host migration in its retained context without offering cancellation", async () => {
    clients.templates.operations.mockResolvedValue([
      {
        operationId: "host-release-v2",
        kind: "pull",
        contextId: "template-operation-v2",
        initiator: "host-release",
        target: { alias: "workspace-base", ref: "refs/tags/v2" },
        state: "repairing",
        fingerprint: `v1-sha256:${"a".repeat(64)}`,
        migration: {
          facets: ["system"],
          notes: [
            {
              path: "migrations/system/runtime.md",
              title: "Runtime contract",
              degradedOk: false,
            },
          ],
        },
        repair: { contextId: "template-operation-v2", failures: [] },
      },
    ]);
    const view = draw();

    fireEvent.click(await view.findByRole("button", { name: "Continue upgrade" }));
    await waitFor(() => expect(clients.panel.createPanel).toHaveBeenCalledTimes(1));
    expect(clients.panel.createPanel).toHaveBeenCalledWith(
      "panels/chat",
      expect.objectContaining({
        contextId: "template-operation-v2",
        stateArgs: { initialPrompt: expect.stringContaining("Use the Templates skill") },
      })
    );
    expect(view.queryByRole("button", { name: "Discard" })).toBeNull();
  });
});
