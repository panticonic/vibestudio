import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installStandardAbortController } from "./abortController.js";

const require = createRequire(import.meta.url);
function legacyPlatform() {
  // Isolate the actual RN 0.79 dependency's constructors/prototypes per case.
  const resolved = require.resolve("abort-controller");
  delete require.cache[resolved];
  const legacy = require("abort-controller") as typeof import("abort-controller");
  const platform = { AbortController: legacy.AbortController, AbortSignal: legacy.AbortSignal };
  installStandardAbortController(platform.AbortController, platform.AbortSignal, DOMException);
  // The installer has now implemented the standard API. This assertion is
  // confined to the fixture boundary; each supplied operation is tested below.
  return {
    platform: platform as unknown as {
      AbortController: typeof AbortController;
      AbortSignal: typeof AbortSignal & { any(signals: Iterable<AbortSignal>): AbortSignal };
    },
    legacy,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("React Native standard cancellation platform", () => {
  it("exposes the installed native APIs in an actual ES2022/RN program without browser globals", () => {
    const parent = path.resolve(".cache");
    fs.mkdirSync(parent, { recursive: true });
    const root = fs.mkdtempSync(path.join(parent, "native-abort-types-"));
    try {
      fs.writeFileSync(
        path.join(root, "input.ts"),
        `
        import "@vibestudio/rn-client-api/polyfills";
        const controller = new AbortController();
        controller.abort(new Error("closed"));
        controller.signal.throwIfAborted();
        const reason: unknown = controller.signal.reason;
        const combined: AbortSignal = AbortSignal.any([controller.signal]);
        const immediate: AbortSignal = AbortSignal.abort(reason);
        void combined; void immediate;
        const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
        decoder.decode(Uint8Array.of(0xe2), { stream: true });
        decoder.decode();
        new TextEncoder().encodeInto("native", new Uint8Array(16));
        // @ts-expect-error Hermes implements the standard UTF-8-only constructor.
        new TextEncoder("latin1");
        const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
        const reader: ReadableStreamDefaultReader<Uint8Array> = stream.getReader();
        void reader; btoa(atob("eA=="));
        // @ts-expect-error The native cancellation contract does not invent DOM.
        document.createElement("div");
        // @ts-expect-error Native fetch does not expose a web-stream response body.
        new Response().body.getReader();
      `
      );
      fs.writeFileSync(
        path.join(root, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "bundler",
            lib: ["ES2022"],
            types: ["react", "react-native"],
            customConditions: ["react-native"],
            strict: true,
            noEmit: true,
            // This matches the authored native app's existing declaration policy.
            skipLibCheck: true,
          },
          files: ["input.ts"],
        })
      );
      execFileSync(
        process.execPath,
        [
          path.join(path.dirname(require.resolve("typescript/package.json")), "bin/tsc"),
          "--project",
          path.join(root, "tsconfig.json"),
          "--pretty",
          "false",
        ],
        { stdio: "inherit" }
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves native event/signal identity and publishes the exact first reason before dispatch", () => {
    const { platform, legacy } = legacyPlatform();
    const controller = new platform.AbortController();
    expect(controller).toBeInstanceOf(legacy.AbortController);
    expect(controller.signal).toBeInstanceOf(legacy.AbortSignal);
    const reason = new Error("owner closed");
    const observed = vi.fn(() => {
      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toBe(reason);
      expect(() => controller.signal.throwIfAborted()).toThrow(reason);
    });
    controller.signal.addEventListener("abort", observed, { once: true });
    controller.abort(reason);
    controller.abort(new Error("must not replace reason"));
    expect(observed).toHaveBeenCalledOnce();
    expect(controller.signal.reason).toBe(reason);
  });

  it("upgrades cached constructors and already-created controllers in place", () => {
    const resolved = require.resolve("abort-controller");
    delete require.cache[resolved];
    const legacy = require("abort-controller") as typeof import("abort-controller");
    const cachedConstructor = legacy.AbortController;
    const existing = new cachedConstructor();
    const platform = { AbortController: cachedConstructor, AbortSignal: legacy.AbortSignal };
    installStandardAbortController(platform.AbortController, platform.AbortSignal, DOMException);
    expect(platform.AbortController).toBe(cachedConstructor);
    const reason = new Error("existing owner retired");
    const observed = vi.fn(() => {
      expect(Reflect.get(existing.signal, "reason")).toBe(reason);
    });
    existing.signal.addEventListener("abort", observed);
    Reflect.apply(platform.AbortController.prototype.abort, existing, [reason]);
    expect(observed).toHaveBeenCalledOnce();
    expect(Reflect.get(existing.signal, "reason")).toBe(reason);
  });

  it.each([undefined, null, false, 0, "cancel"])(
    "implements standard abort reason %s",
    (reason) => {
      const { platform } = legacyPlatform();
      const controller = new platform.AbortController();
      expect(controller.signal.reason).toBeUndefined();
      expect(() => controller.signal.throwIfAborted()).not.toThrow();
      controller.abort(reason);
      if (reason === undefined) {
        expect(controller.signal.reason).toBeInstanceOf(DOMException);
        expect(controller.signal.reason.name).toBe("AbortError");
      } else expect(controller.signal.reason).toBe(reason);
      let thrown: unknown;
      try {
        controller.signal.throwIfAborted();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(controller.signal.reason);
      expect(platform.AbortSignal.abort(reason).reason).toEqual(controller.signal.reason);
    }
  );

  it("chooses the first already-aborted input without admitting listeners", () => {
    const { platform } = legacyPlatform();
    const live = new platform.AbortController();
    const first = platform.AbortSignal.abort(new Error("first"));
    const second = platform.AbortSignal.abort(new Error("second"));
    const add = vi.spyOn(live.signal, "addEventListener");
    const result = platform.AbortSignal.any([live.signal, first, second]);
    expect(result.aborted).toBe(true);
    expect(result.reason).toBe(first.reason);
    expect(add).not.toHaveBeenCalled();
  });

  it("coalesces duplicate signals and retires every losing listener on cancellation", () => {
    const { platform } = legacyPlatform();
    const first = new platform.AbortController();
    const second = new platform.AbortController();
    const add = vi.spyOn(first.signal, "addEventListener");
    const removeFirst = vi.spyOn(first.signal, "removeEventListener");
    const removeSecond = vi.spyOn(second.signal, "removeEventListener");
    const result = platform.AbortSignal.any([first.signal, first.signal, second.signal]);
    expect(add).toHaveBeenCalledOnce();
    const reason = new Error("second cancelled");
    second.abort(reason);
    expect(result.reason).toBe(reason);
    expect(removeFirst).toHaveBeenCalledOnce();
    expect(removeSecond).toHaveBeenCalledOnce();
    first.abort(new Error("late"));
    expect(result.reason).toBe(reason);
  });

  it("leaves no listener behind after iterable conversion or input validation fails", () => {
    const { platform } = legacyPlatform();
    const controller = new platform.AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const failure = new Error("iterator failed");
    const inputs = {
      *[Symbol.iterator]() {
        yield controller.signal;
        throw failure;
      },
    };
    expect(() => platform.AbortSignal.any(inputs)).toThrow(failure);
    expect(add).not.toHaveBeenCalled();
    const invalid: unknown = {};
    expect(() => platform.AbortSignal.any([controller.signal, invalid as AbortSignal])).toThrow(
      TypeError
    );
    expect(add).not.toHaveBeenCalled();
  });

  it("retires already admitted listeners if a later source rejects listener admission", () => {
    const { platform } = legacyPlatform();
    const first = new platform.AbortController();
    const second = new platform.AbortController();
    const original = new Error("listener admission failed");
    const remove = vi.spyOn(first.signal, "removeEventListener");
    vi.spyOn(second.signal, "addEventListener").mockImplementation(() => {
      throw original;
    });
    expect(() => platform.AbortSignal.any([first.signal, second.signal])).toThrow(original);
    expect(remove).toHaveBeenCalledOnce();
  });

  it("leaves a genuinely modern platform unchanged and repeated installation is idempotent", () => {
    const modern = { AbortController, AbortSignal };
    installStandardAbortController(modern.AbortController, modern.AbortSignal, DOMException);
    expect(modern.AbortController).toBe(AbortController);
    expect(modern.AbortSignal).toBe(AbortSignal);
    const { platform } = legacyPlatform();
    const installed = platform.AbortController;
    installStandardAbortController(platform.AbortController, platform.AbortSignal, DOMException);
    expect(platform.AbortController).toBe(installed);
  });

  it("remains interoperable with React Native's actual whatwg-fetch XHR cancellation", async () => {
    const { platform } = legacyPlatform();
    const aborted = vi.fn();
    class XHR {
      responseType = "";
      withCredentials = false;
      onabort?: () => void;
      open() {}
      setRequestHeader() {}
      send() {}
      abort() {
        aborted();
        this.onabort?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", XHR);
    const fetchModule = require("whatwg-fetch") as {
      fetch(input: string, init: { signal: AbortSignal }): Promise<unknown>;
    };
    const controller = new platform.AbortController();
    const pending = fetchModule.fetch("https://native.test/resource", {
      signal: controller.signal,
    });
    const outcome = pending.catch((error: unknown) => error);
    const reason = new Error("request retired");
    controller.abort(reason);
    expect(aborted).toHaveBeenCalledOnce();
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(controller.signal.reason).toBe(reason);
  });
});
