import { it, expect, vi } from "vitest";
import { createAnonymousStartupCounter } from "./anonymousStartup";
import { STARTUP_DESTINATION } from "@vibestudio/service-schemas/usageAnalytics";
it("sends one bare startup ping without a payload, identity, cookies, or reporting dependencies", async () => {
  const request = vi.fn(async () => new Response(null, { status: 204 }));
  const count = createAnonymousStartupCounter(request);
  await Promise.all([count(), count()]);
  await count();
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith(STARTUP_DESTINATION, {
    method: "POST",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    redirect: "error",
    signal: expect.any(AbortSignal),
  });
});
it("does not retry lost acknowledgements or let a failed ping affect application startup", async () => {
  const request = vi.fn(async () => {
    throw new Error("lost acknowledgement");
  });
  const count = createAnonymousStartupCounter(request);
  await expect(count()).resolves.toBeUndefined();
  await count();
  expect(request).toHaveBeenCalledTimes(1);
});
