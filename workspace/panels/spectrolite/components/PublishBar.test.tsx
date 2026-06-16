// @vitest-environment jsdom

import { Theme } from "@radix-ui/themes";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppProvider } from "../app/context";
import type { SpectroliteApp } from "../app/createApp";
import type { PublishSnapshot } from "../app/publishController";
import { vaultPathMapping } from "../app/vaultContext";
import { PublishBar } from "./PublishBar";

function renderPublishBar(snapshot: PublishSnapshot) {
  const openFile = vi.fn();
  const abort = vi.fn(async () => undefined);
  const publishStore = {
    subscribe: vi.fn(() => () => undefined),
    getSnapshot: vi.fn(() => snapshot),
    publish: vi.fn(async () => ({ status: "published" as const })),
    abort,
  };
  const app = {
    publish: publishStore,
    vault: {
      mapping: () => vaultPathMapping("projects/notes"),
    },
    openFile,
  } as unknown as SpectroliteApp;

  render(
    <Theme>
      <AppProvider value={app}>
        <PublishBar />
      </AppProvider>
    </Theme>
  );

  return { abort, openFile };
}

describe("PublishBar", () => {
  it("surfaces pending conflict kinds and opens mapped vault files", () => {
    const snapshot: PublishSnapshot = {
      ahead: 1,
      files: [],
      publishing: false,
      pending: {
        theirsHead: "main",
        conflicts: [
          { path: "projects/notes/Chapter.mdx", kind: "content" },
          { path: "projects/notes/cover.png", kind: "binary" },
          { path: "projects/other/Foreign.mdx", kind: "delete-vs-change" },
        ],
      },
      lastError: null,
    };

    const { openFile } = renderPublishBar(snapshot);

    expect(screen.getByTestId("spectrolite-publish-conflict-kind-0").textContent).toBe("content");
    expect(screen.getByTestId("spectrolite-publish-conflict-kind-1").textContent).toBe("binary");
    expect(screen.getByTestId("spectrolite-publish-conflict-kind-2").textContent).toBe("delete-vs-change");
    expect(screen.getByText("Chapter.mdx")).toBeTruthy();
    expect(screen.getByText("cover.png")).toBeTruthy();
    expect(screen.getByText("Not openable")).toBeTruthy();

    fireEvent.click(screen.getByTestId("spectrolite-publish-resolve"));
    expect(openFile).toHaveBeenCalledWith("Chapter.mdx");

    fireEvent.click(screen.getByTestId("spectrolite-publish-open-1"));
    expect(openFile).toHaveBeenCalledWith("cover.png");
  });

  it("keeps abort available for pending conflicts", () => {
    const snapshot: PublishSnapshot = {
      ahead: 0,
      files: [],
      publishing: false,
      pending: {
        theirsHead: "main",
        conflicts: [{ path: "projects/notes/Chapter.mdx", kind: "mode" }],
      },
      lastError: null,
    };

    const { abort } = renderPublishBar(snapshot);

    fireEvent.click(screen.getByTestId("spectrolite-publish-abort"));
    expect(abort).toHaveBeenCalledTimes(1);
  });
});
