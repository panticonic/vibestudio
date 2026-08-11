// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  status: Promise.resolve([{ metric: "Log events", value: 1 }]),
  gitStatus: Promise.resolve([] as unknown[]),
  files: [
    {
      path: "src/hello.ts",
      fileId: "file:internal-id",
      contentHash: "abcdef1234567890",
      mode: "100644",
      size: 28,
      binary: false,
    },
  ],
}));

vi.mock("@workspace/runtime", () => ({
  contextId: "context:test",
  blobstore: { getText: vi.fn(async () => "export const hello = 'world';") },
  gad: {
    status: vi.fn(() => fixture.status),
    listTrajectoryBranches: vi.fn(async () => [
      { branch_id: "branch:one", name: "Build the greeting", updated_at: new Date().toISOString() },
    ]),
    listTrajectoryEvents: vi.fn(async () => []),
    listTrajectoryInvocations: vi.fn(async () => []),
    listChannelEnvelopes: vi.fn(async () => []),
    listTrajectoryApprovals: vi.fn(async () => []),
    checkGadIntegrity: vi.fn(async () => ({ ok: true, errors: [] })),
    validateGadHashes: vi.fn(async () => ({ ok: true, errors: [] })),
    rebuildTrajectoryProjections: vi.fn(async () => ({ replayed: 0 })),
  },
  git: {
    upstreamStatus: vi.fn(() => fixture.gitStatus),
    pushUpstream: vi.fn(),
    pullUpstream: vi.fn(),
    setAutoPush: vi.fn(),
    removeUpstream: vi.fn(),
  },
  vcs: {
    status: vi.fn(async () => ({ workingHead: { kind: "state", stateHash: "state:one" } })),
    neighbors: vi.fn(async () => ({
      edges: [
        {
          kind: "contains-repository",
          from: { kind: "state", stateHash: "state:one" },
          to: { kind: "repository", repositoryId: "repository:secret-internal-id" },
        },
      ],
      nextCursor: null,
    })),
    inspect: vi.fn(async () => ({
      node: {
        kind: "repository",
        value: {
          kind: "present",
          repositoryId: "repository:secret-internal-id",
          repoPath: "packages/greeting",
        },
      },
    })),
    listFiles: vi.fn(async () => ({ files: fixture.files, nextCursor: null })),
  },
  workspace: { getInfo: vi.fn(async () => ({ config: { id: "workspace:test" } })) },
  rpc: { call: vi.fn(async () => []) },
}));

vi.mock("@workspace/react", () => ({
  useIsMobile: () => false,
  usePaletteCommands: () => undefined,
  usePanelTheme: () => "dark",
  usePanelThemeConfig: () => ({}),
  useStateArgs: () => ({}),
}));

vi.mock("@workspace/ui/diff", () => ({
  DiffViewer: () => null,
}));

vi.mock("@workspace/ui/layout", () => ({
  PanelChrome: ({
    header,
    headerActions,
    children,
  }: React.PropsWithChildren<{ header: React.ReactNode; headerActions?: React.ReactNode }>) => (
    <main>
      {header}
      {headerActions}
      {children}
    </main>
  ),
}));

import { App } from "./index.js";

describe("Workspace History panel", () => {
  beforeEach(() => {
    fixture.status = Promise.resolve([{ metric: "Log events", value: 1 }]);
    fixture.gitStatus = Promise.resolve([]);
    fixture.files = [
      {
        path: "src/hello.ts",
        fileId: "file:internal-id",
        contentHash: "abcdef1234567890",
        mode: "100644",
        size: 28,
        binary: false,
      },
    ];
  });

  it("distinguishes the initial load from an empty workspace", () => {
    fixture.status = new Promise(() => {});
    fixture.gitStatus = new Promise(() => {});
    render(<App />);
    expect(screen.getByRole("status").textContent).toContain("Loading workspace history");
    expect(screen.queryByText("No rows")).toBeNull();
  });

  it("browses files by human-readable path and previews their content", async () => {
    render(<App />);
    await screen.findByText("Workspace history", {}, { timeout: 2_000 });
    fireEvent.click(screen.getByRole("button", { name: /Browse workspace files/ }));

    expect(await screen.findByText("packages/greeting")).toBeTruthy();
    expect(screen.getByText("hello.ts")).toBeTruthy();
    expect(screen.getByText("src")).toBeTruthy();
    expect(screen.queryByText(/secret-internal-id/)).toBeNull();

    fireEvent.click(screen.getByText("hello.ts"));
    await waitFor(() => expect(screen.getByText("export const hello = 'world';")).toBeTruthy());
  });
});
