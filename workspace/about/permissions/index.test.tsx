// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AboutPanelRoot from "./index";

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  onFocus: vi.fn(),
  resolveService: vi.fn(),
}));

vi.mock("@workspace/runtime", () => ({
  panel: { onFocus: mocks.onFocus },
  rpc: { call: mocks.call },
  workers: { resolveService: mocks.resolveService },
}));

vi.mock("../../packages/about-shared/ui", () => ({
  AboutThemeRoot: ({ children }: { children: ReactNode }) => <>{children}</>,
  AboutPage: ({ children, actions }: { children: ReactNode; actions?: ReactNode }) => (
    <main>
      {actions}
      {children}
    </main>
  ),
  Section: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));

let focus: () => void;
let blockRefresh = false;

describe("Permissions primary loading lifecycle", () => {
  beforeEach(() => {
    blockRefresh = false;
    mocks.onFocus.mockReset().mockImplementation((callback: () => void) => {
      focus = callback;
      return () => {};
    });
    mocks.resolveService.mockReset().mockResolvedValue({
      kind: "durable-object",
      targetId: "missions-target",
    });
    mocks.call.mockReset().mockImplementation((target: string, method: string) => {
      if (blockRefresh && target === "main") return new Promise(() => {});
      if (target === "missions-target" && method === "list") {
        return Promise.resolve([
          {
            missionId: "mission-1",
            name: "Mission",
            revision: 1,
            state: "active",
            revisionDigest: "digest-1",
            updatedAt: 1,
            charter: {
              taskSpec: "Keep the workspace tidy",
              trigger: { kind: "manual" },
              toolExposure: { services: [], evalNetwork: "none", declaredOrigins: [] },
              declaredLineageClasses: [],
            },
            permissions: [],
          },
        ]);
      }
      if (target === "missions-target" && method === "listRuns") return new Promise(() => {});
      if (method === "permissions.safetyStatus") {
        return Promise.resolve({
          workspaceLocked: false,
          activeAgentCount: 0,
          pendingAcquisitionCount: 0,
        });
      }
      return Promise.resolve([]);
    });
  });

  it("publishes an empty primary snapshot without waiting for mission enrichment or focus refresh", async () => {
    render(<AboutPanelRoot />);

    expect(screen.getByLabelText("Loading permissions")).toBeTruthy();
    expect(await screen.findByLabelText("Permission view")).toBeTruthy();
    await waitFor(() => expect(screen.queryByLabelText("Loading permissions")).toBeNull());

    blockRefresh = true;
    act(() => focus());

    expect(screen.queryByLabelText("Loading permissions")).toBeNull();
    expect(screen.getByLabelText("Permission view")).toBeTruthy();
  });
});
