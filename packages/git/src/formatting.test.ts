import { afterEach, describe, expect, it, vi } from "vitest";
import { formatRelativeTime } from "./formatting.js";

describe("formatRelativeTime", () => {
  afterEach(() => vi.useRealTimers());

  it("uses compact units across the supported ranges", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T12:00:00Z"));
    const now = Date.now();

    expect(formatRelativeTime(undefined)).toBe("never");
    expect(formatRelativeTime(now - 20_000)).toBe("just now");
    expect(formatRelativeTime(now - 5 * 60_000)).toBe("5m ago");
    expect(formatRelativeTime(now - 3 * 60 * 60_000)).toBe("3h ago");
    expect(formatRelativeTime(now - 2 * 24 * 60 * 60_000)).toBe("2d ago");
  });
});
