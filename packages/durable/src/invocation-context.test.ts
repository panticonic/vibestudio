import { describe, expect, it } from "vitest";
import { InvocationContext } from "./invocation-context.js";

describe("InvocationContext", () => {
  it("keeps overlapping durable invocations isolated without serializing them", async () => {
    const context = new InvocationContext<string>();
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondStarted = false;

    const first = context.run("first", async () => {
      expect(context.current()).toBe("first");
      await firstCanFinish;
      expect(context.current()).toBe("first");
      return "first";
    });
    const second = context.run("second", async () => {
      secondStarted = true;
      await Promise.resolve();
      expect(context.current()).toBe("second");
      return "second";
    });

    await Promise.resolve();
    expect(secondStarted).toBe(true);
    await expect(second).resolves.toBe("second");
    releaseFirst();
    await expect(first).resolves.toBe("first");
    expect(context.current()).toBeUndefined();
  });

  it("clears a failed invocation without affecting another invocation", async () => {
    const context = new InvocationContext<string>();
    const failed = context.run("failed", async () => {
      expect(context.current()).toBe("failed");
      throw new Error("boom");
    });
    const next = context.run("next", async () => {
      expect(context.current()).toBe("next");
      return "ok";
    });

    await expect(failed).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
    expect(context.current()).toBeUndefined();
  });
});
