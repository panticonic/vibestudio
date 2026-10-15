import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcClient } from "@vibestudio/rpc";
import { createTerminalFiles } from "./terminalFiles.js";

const filesystem = vi.hoisted(() => ({ open: vi.fn(), link: vi.fn(), unlink: vi.fn() }));
vi.mock("node:fs/promises", () => filesystem);

beforeEach(() => vi.resetAllMocks());

describe("terminal upload file ownership", () => {
  const upload = () =>
    createTerminalFiles(
      { call: vi.fn() } as unknown as Pick<RpcClient, "call">,
      new AbortController().signal
    ).upload({ contextId: "ctx", localPath: "/fixture", workspacePath: "upload" });

  it("preserves the read failure and an independent descriptor-close failure", async () => {
    const readFailure = new Error("read failed");
    const closeFailure = new Error("descriptor close failed");
    const close = vi.fn().mockRejectedValue(closeFailure);
    filesystem.open.mockResolvedValue({ stat: vi.fn().mockRejectedValue(readFailure), close });
    const failure = await upload().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([readFailure, closeFailure]);
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not settle a failed upload before its descriptor closes", async () => {
    const readFailure = new Error("read failed");
    let closeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      closeStarted = resolve;
    });
    let finishClose!: () => void;
    const closed = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    filesystem.open.mockResolvedValue({
      stat: vi.fn().mockRejectedValue(readFailure),
      close: () => {
        closeStarted();
        return closed;
      },
    });
    let settled = false;
    const result = upload().catch((error: unknown) => {
      settled = true;
      return error;
    });
    await started;
    try {
      expect(settled).toBe(false);
    } finally {
      finishClose();
      await result;
    }
    await expect(result).resolves.toBe(readFailure);
  });
});
