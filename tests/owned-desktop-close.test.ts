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
  const app = { close: vi.fn(() => closing.promise) };
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
  joining.resolve();
  await operation;
});

it("contains an actually failed close protocol and retains its original error until physical retirement joins", async () => {
  const failure = new Error("Original close protocol failed");
  const retirement = deferred();
  const owner = { join: vi.fn(async () => {}), retire: vi.fn(() => retirement.promise) };
  const operation = closeOwnedDesktop(
    {
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
