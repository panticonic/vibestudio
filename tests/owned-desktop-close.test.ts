import { expect, it, vi } from "vitest";
import { closeOwnedDesktop } from "../scripts/lib/owned-desktop-close.mjs";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

it("keeps application close as the only graceful writer and joins the actual process owner afterward", async () => {
  const closing = deferred();
  const joining = deferred();
  const child = { exitCode: null as number | null, signalCode: null };
  const app = {
    close: vi.fn(() => closing.promise),
    process: vi.fn(() => {
      expect(app.close).not.toHaveBeenCalled();
      return child;
    }),
  };
  const owner = { join: vi.fn(() => joining.promise), retire: vi.fn(async () => {}) };
  let settled = false;
  const operation = closeOwnedDesktop(app, owner).then(() => {
    settled = true;
  });
  expect(app.close).toHaveBeenCalledOnce();
  expect(owner.join).not.toHaveBeenCalled();
  expect(owner.retire).not.toHaveBeenCalled();
  closing.resolve();
  await Promise.resolve();
  expect(owner.join).toHaveBeenCalledOnce();
  expect(owner.retire).not.toHaveBeenCalled();
  expect(settled).toBe(false);
  child.exitCode = 0;
  joining.resolve();
  await operation;
});

it("contains an actually failed close protocol and retains its original error until physical retirement joins", async () => {
  const failure = new Error("Original close protocol failed");
  const retirement = deferred();
  const owner = { join: vi.fn(async () => {}), retire: vi.fn(() => retirement.promise) };
  const operation = closeOwnedDesktop(
    {
      process: () => ({ exitCode: null, signalCode: null }),
      close: async () => {
        throw failure;
      },
    },
    owner
  );
  const observed = operation.catch((error) => error);
  await Promise.resolve();
  expect(owner.retire).toHaveBeenCalledWith("SIGKILL");
  retirement.resolve();
  expect(await observed).toBe(failure);
  expect(owner.join).not.toHaveBeenCalled();
});

it("preserves close and containment failures together", async () => {
  const original = new Error("Original close failure");
  const cleanup = new Error("Exact process ownership lost");
  const owner = {
    join: async () => {},
    retire: async () => {
      throw cleanup;
    },
  };
  const error = await closeOwnedDesktop(
    {
      process: () => ({ exitCode: null, signalCode: null }),
      close: async () => {
        throw original;
      },
    },
    owner
  ).catch((error) => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.cause).toBe(original);
  expect(error.errors).toEqual([original, cleanup]);
});

it.each([
  { exitCode: 1, signalCode: null, message: "Desktop exited with code 1" },
  { exitCode: null, signalCode: "SIGSEGV", message: "Desktop exited with signal SIGSEGV" },
])("rejects an unclean desktop exit after joining its process: $message", async (child) => {
  const app = { process: () => child, close: vi.fn(async () => {}) };
  const owner = { join: vi.fn(async () => {}), retire: vi.fn(async () => {}) };
  await expect(closeOwnedDesktop(app, owner)).rejects.toThrow(child.message);
  expect(owner.join).toHaveBeenCalledOnce();
  expect(owner.retire).not.toHaveBeenCalled();
});
