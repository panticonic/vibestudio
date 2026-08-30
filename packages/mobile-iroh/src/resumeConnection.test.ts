import { describe, expect, it, vi } from "vitest";
import { restoreRoutedConnectionPair } from "./resumeConnection.js";

describe("returning mobile Iroh connection pair", () => {
  it("starts hub and workspace restoration concurrently", async () => {
    let resolveControl!: (value: { close(): Promise<void> }) => void;
    let resolveWorkspace!: (value: { close(): Promise<void> }) => void;
    const control = { close: vi.fn(async () => undefined) };
    const workspace = { close: vi.fn(async () => undefined) };
    const openControl = vi.fn(
      () => new Promise<{ close(): Promise<void> }>((resolve) => (resolveControl = resolve))
    );
    const openWorkspace = vi.fn(
      () => new Promise<{ close(): Promise<void> }>((resolve) => (resolveWorkspace = resolve))
    );

    const restoring = restoreRoutedConnectionPair(openControl, openWorkspace);
    expect(openControl).toHaveBeenCalledTimes(1);
    expect(openWorkspace).toHaveBeenCalledTimes(1);
    resolveControl(control);
    resolveWorkspace(workspace);

    await expect(restoring).resolves.toEqual({ control, workspace });
  });

  it("closes a successful half and preserves dial and cleanup failures", async () => {
    const closeFailure = new Error("control cleanup failed");
    const control = { close: vi.fn(async () => Promise.reject(closeFailure)) };
    const workspaceFailure = new Error("workspace dial failed");

    const failure = await restoreRoutedConnectionPair(
      async () => control,
      async () => Promise.reject(workspaceFailure)
    ).catch((error: unknown) => error);

    expect(control.close).toHaveBeenCalledTimes(1);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([workspaceFailure, closeFailure]);
  });
});
