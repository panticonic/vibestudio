import { afterEach, describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { createWorkerLogService } from "./workerLogService.js";

describe("workerLogService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("keeps worker debug output out of the normal host log level", async () => {
    vi.stubEnv("VIBESTUDIO_LOG_LEVEL", "info");
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const service = createWorkerLogService();

    await service.handler({ caller: createVerifiedCaller("worker:my_worker", "worker") }, "write", [
      "debug",
      "heartbeat detail",
    ]);

    expect(debug).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("uses explicit worker source fields when regular workers forward console output", async () => {
    const onLog = vi.fn();
    const service = createWorkerLogService({ onLog });

    await service.handler({ caller: createVerifiedCaller("worker:my_worker", "worker") }, "write", [
      "error",
      "boom",
      { source: "workers/my-worker" },
    ]);

    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "workers/my-worker",
        callerId: "worker:my_worker",
        level: "error",
        message: "boom",
      })
    );
  });
});
