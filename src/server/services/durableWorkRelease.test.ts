import { describe, expect, it } from "vitest";
import {
  drainDurableWorkDeliveryClosure,
  prepareDurableWorkOwnerRelease,
} from "./durableWorkRelease.js";
import type { HeldDoDispatcher } from "@vibestudio/shared/doDispatcher";

const owner = { source: "workers/channel", className: "ChannelDO", objectKey: "channel-one" };

describe("durable-work release scheduling", () => {
  it.each(["owner failure", "caller cancellation"] as const)(
    "cancels and joins held sibling waits on %s",
    async (reason) => {
      const controller = new AbortController();
      const original = new Error(reason);
      let fail!: () => void;
      let completeCleanup!: () => void;
      let entered!: () => void;
      const failureGate = new Promise<void>((resolve) => {
        fail = resolve;
      });
      const cleanup = new Promise<void>((resolve) => {
        completeCleanup = resolve;
      });
      const admitted = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const second = { ...owner, objectKey: "held-sibling" };
      let cancellationObserved = false;
      const dispatch: HeldDoDispatcher = {
        async dispatch() {
          return { queues: [], barrier: null };
        },
        async dispatchHeld() {
          throw new Error("Missing owned signal");
        },
        async dispatchHeldWithSignal(ref, signal, method, ...args) {
          if (method === "prepareDurableWorkRelease")
            return dispatch.dispatch(ref, method, ...args);
          if (ref.objectKey === owner.objectKey && reason === "owner failure") {
            await failureGate;
            throw original;
          }
          const aborted = new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
          if (ref.objectKey === second.objectKey) entered();
          await aborted;
          cancellationObserved = true;
          await cleanup;
          throw signal.reason;
        },
      };
      let settled = false;
      const closure = drainDurableWorkDeliveryClosure(
        [owner, second],
        dispatch,
        () => {},
        controller.signal
      );
      const result = closure.catch((error: unknown) => {
        settled = true;
        return error;
      });
      await admitted;
      if (reason === "owner failure") fail();
      else controller.abort(original);
      await new Promise((resolve) => setImmediate(resolve));
      expect(cancellationObserved).toBe(true);
      expect(settled).toBe(false);
      completeCleanup();
      const failure = await result;
      if (reason === "owner failure") expect(failure).toBe(original);
      else {
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).cause).toBe(original);
      }
    }
  );

  it("joins descendants admitted after another owner's empty capture", async () => {
    const source = { ...owner, objectKey: "source" };
    const child = { ...owner, objectKey: "child" };
    const revision = new Map([
      [source.objectKey, 1],
      [child.objectKey, 0],
    ]);
    let finishSource!: () => void;
    let finishChild!: () => void;
    const sourceWork = new Promise<void>((resolve) => {
      finishSource = resolve;
    });
    const childWork = new Promise<void>((resolve) => {
      finishChild = resolve;
    });
    const waited: string[] = [];
    const dispatch: HeldDoDispatcher = {
      async dispatch(ref, method, stage) {
        expect(method).toBe("prepareDurableWorkRelease");
        expect(stage).toBe("delivery");
        return {
          queues: ["channel-delivery"],
          barrier: { id: ref.objectKey, revision: revision.get(ref.objectKey)! },
        };
      },
      async dispatchHeldWithSignal(ref, _signal, method, stage, barrier) {
        if (method === "prepareDurableWorkRelease") return dispatch.dispatch(ref, method, stage);
        expect(method).toBe("waitDurableWorkRelease");
        expect(stage).toBe("delivery");
        waited.push(`${ref.objectKey}:${(barrier as { revision: number }).revision}`);
        if (ref.objectKey === source.objectKey) await sourceWork;
        if (ref.objectKey === child.objectKey && revision.get(child.objectKey) === 1)
          await childWork;
        return undefined;
      },
      async dispatchHeld() {
        throw new Error("Missing owned closure signal");
      },
    };
    let settled = false;
    const closure = drainDurableWorkDeliveryClosure([source, child], dispatch, () => {}).then(
      () => {
        settled = true;
      }
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(waited).toEqual(["source:1", "child:0"]);
    // The source's held callback commits a child publication after the child
    // owner already acknowledged its empty frontier.
    revision.set(child.objectKey, 1);
    finishSource();
    await new Promise((resolve) => setImmediate(resolve));
    expect(waited).toEqual(["source:1", "child:0", "source:1", "child:1"]);
    expect(settled).toBe(false);
    finishChild();
    await closure;
    expect(settled).toBe(true);
  });

  it("joins independent owners before propagating original cancelled delivery failure", async () => {
    const original = new Error("Original target disconnected");
    const controller = new AbortController();
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let otherJoined = false;
    const second = { ...owner, objectKey: "second" };
    const dispatch: HeldDoDispatcher = {
      async dispatch() {
        return { queues: [], barrier: null };
      },
      async dispatchHeld() {
        throw new Error("Missing actual signal");
      },
      async dispatchHeldWithSignal(ref, signal, method, ...args) {
        if (method === "prepareDurableWorkRelease") return dispatch.dispatch(ref, method, ...args);
        expect(signal.aborted).toBe(false);
        if (ref.objectKey === owner.objectKey) throw original;
        await held;
        otherJoined = true;
        return undefined;
      },
    };
    let settled = false;
    const closure = drainDurableWorkDeliveryClosure(
      [owner, second],
      dispatch,
      () => {},
      controller.signal
    );
    const observed = closure.catch((error: unknown) => {
      settled = true;
      return error;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    finish();
    expect(await observed).toBe(original);
    expect(otherJoined).toBe(true);
  });

  it("captures admission before scheduling and joins the original exact frontier", async () => {
    const barrier = { channelId: owner.objectKey, headSequence: 3, headHash: "retained-three" };
    const calls: string[] = [];
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const dispatch: HeldDoDispatcher = {
      async dispatch(ref, method) {
        expect(ref).toEqual(owner);
        expect(method).toBe("prepareDurableWorkRelease");
        calls.push("capture");
        return { queues: ["channel-observation"], barrier };
      },
      async dispatchHeld(ref, method, stage, value) {
        expect(ref).toEqual(owner);
        expect(method).toBe("waitDurableWorkRelease");
        expect(stage).toBe("owner");
        expect(value).toEqual(barrier);
        calls.push("join");
        await held;
      },
      async dispatchHeldWithSignal() {
        throw new Error("Unexpected signal dispatch");
      },
    };
    const release = prepareDurableWorkOwnerRelease(
      owner,
      dispatch,
      (hint) => {
        expect(hint).toEqual({ owner, queues: ["channel-observation"] });
        calls.push("schedule");
      },
      "owner"
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual(["capture", "schedule", "join"]);
    finish();
    await release;
  });

  it("propagates the original held failure and actual cancellation signal", async () => {
    const original = new Error("Observation provider disconnected");
    const controller = new AbortController();
    const dispatch: HeldDoDispatcher = {
      async dispatch() {
        return { queues: [], barrier: null };
      },
      async dispatchHeld() {
        throw new Error("Missing signal");
      },
      async dispatchHeldWithSignal(_ref, signal, method, stage, barrier) {
        if (method === "prepareDurableWorkRelease") return dispatch.dispatch(_ref, method, stage);
        expect(signal).toBe(controller.signal);
        expect(method).toBe("waitDurableWorkRelease");
        expect(stage).toBe("owner");
        expect(barrier).toBeNull();
        throw original;
      },
    };
    await expect(
      prepareDurableWorkOwnerRelease(owner, dispatch, () => {}, "owner", controller.signal)
    ).rejects.toBe(original);
  });
});
