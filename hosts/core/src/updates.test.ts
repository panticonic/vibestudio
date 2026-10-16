import { describe, expect, it } from "vitest";
import type { SupervisionChange } from "@vibestudio/shared/events";
import { ClientUpdateObserver, type SupervisionEvents, type UpdatePolicy } from "./updates.js";

function fakeEvents() {
  const listeners = new Set<(c: SupervisionChange) => void>();
  const events: SupervisionEvents & { emit(c: SupervisionChange): void; subs: number } = {
    subs: 0,
    async subscribe() {
      events.subs += 1;
    },
    async unsubscribe() {
      events.subs -= 1;
    },
    on(_e, l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    emit: (c) => listeners.forEach((l) => l(c)),
  };
  return events;
}

const change = (over: Partial<SupervisionChange> & { buildKey?: string } = {}): SupervisionChange =>
  ({
    identity: { kind: "app", entityId: "chat" },
    source: "clients/chat",
    status: "running",
    lastError: null,
    artifact: { effectiveVersion: "2", buildKey: over.buildKey ?? "b2", executionDigest: null },
    canRollback: true,
    change: "adopted",
    previousBuildKey: "b1",
    previousEffectiveVersion: "1",
    adoption: null,
    ...over,
  }) as SupervisionChange;

function setup(opts: { policy: UpdatePolicy; dev?: boolean }) {
  const events = fakeEvents();
  const seen: [string, UpdatePolicy][] = [];
  const errors: unknown[] = [];
  const observer = new ClientUpdateObserver({
    events,
    source: "clients/chat",
    buildKey: "b1",
    policy: () => opts.policy,
    developmentMode: () => opts.dev ?? false,
    onUpdate: (u, p) => void seen.push([u.buildKey, p]),
    onError: (e) => errors.push(e),
  });
  return { events, observer, seen, errors };
}

describe("ClientUpdateObserver", () => {
  it("hands a newer ready build to the host with its policy", async () => {
    const { events, observer, seen } = setup({ policy: "prompt" });
    await observer.start();
    events.emit(change());
    expect(seen).toEqual([["b2", "prompt"]]);
  });

  it("development mode turns any policy into immediate", async () => {
    for (const policy of ["prompt", "restart-at-safe-point", "immediate"] as const) {
      const { events, observer, seen } = setup({ policy, dev: true });
      await observer.start();
      events.emit(change());
      expect(seen).toEqual([["b2", "immediate"]]);
    }
  });

  it("ignores other sources, the current build, and non-adopting changes", async () => {
    const { events, observer, seen } = setup({ policy: "prompt" });
    await observer.start();
    events.emit(change({ source: "clients/other" }));
    events.emit(change({ buildKey: "b1" }));
    events.emit(change({ change: "status" }));
    events.emit(change({ change: "update-rejected" }));
    events.emit(change({ status: "error" }));
    expect(seen).toEqual([]);
  });

  it("measures updates against the build the host adopted", async () => {
    const { events, observer, seen } = setup({ policy: "prompt" });
    await observer.start();
    observer.adopted("b2");
    events.emit(change());
    events.emit(change({ buildKey: "b3" }));
    expect(seen).toEqual([["b3", "prompt"]]);
  });

  it("stop unsubscribes and silences", async () => {
    const { events, observer, seen } = setup({ policy: "prompt" });
    await observer.start();
    await observer.stop();
    events.emit(change());
    expect(seen).toEqual([]);
    expect(events.subs).toBe(0);
  });

  it("surfaces a failing policy callback", async () => {
    const events = fakeEvents();
    const errors: unknown[] = [];
    const observer = new ClientUpdateObserver({
      events,
      source: "clients/chat",
      buildKey: "b1",
      policy: () => "prompt",
      developmentMode: () => false,
      onUpdate: async () => {
        throw new Error("boom");
      },
      onError: (e) => errors.push(e),
    });
    await observer.start();
    events.emit(change());
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(1);
  });
});
