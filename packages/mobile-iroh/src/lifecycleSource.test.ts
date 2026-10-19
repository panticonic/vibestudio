import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
  NativeModules: {},
}));
vi.mock("react-native-keychain", () => ({}));

describe("driven lifecycle source", () => {
  it("reports changes only, to every subscriber, until unsubscribed", async () => {
    const { createDrivenLifecycleSource } = await import("./connect.js");
    const source = createDrivenLifecycleSource(true);
    const seen: boolean[] = [];
    const stop = source.subscribe((foreground) => seen.push(foreground));
    source.set(true);
    source.set(false);
    source.set(false);
    source.set(true);
    stop();
    source.set(false);
    expect(seen).toEqual([false, true]);
    expect(source.current()).toBe(false);
  });
});
