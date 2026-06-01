/**
 * Drop-in replacement for `yoga-layout` inside workerd.
 *
 * The stock `yoga-layout` entry instantiates its WASM with the async
 * `WebAssembly.instantiate(bytes)` path (emscripten). workerd rejects that:
 * a top-level await on async WASM *compilation* never settles during module
 * startup, and compiling bytes inside a request is "code generation disallowed
 * by embedder". The only supported path is to hand workerd a pre-compiled
 * `WebAssembly.Module` (a `wasm` module binding) and instantiate it
 * *synchronously*.
 *
 * This module mirrors `yoga-layout/dist/src/index.js` but routes instantiation
 * through emscripten's `instantiateWasm` hook using the embedder-provided
 * module (`yoga.wasm`, supplied by workerdManager as a module binding). Because
 * there is no async *compile*, the top-level await settles at startup, so Ink's
 * `import Yoga from 'yoga-layout'` continues to receive a ready instance and
 * Ink itself needs no changes.
 *
 * The build pipeline (`buildWorker`) aliases bare `yoga-layout` to this file for
 * terminal workers, resolves the deep `yoga-layout/dist/*` specifiers below to
 * the real package files (bypassing yoga's `exports` map), and marks `yoga.wasm`
 * external so workerd resolves it from the module binding. Proven end-to-end
 * against the real workerd binary.
 */
// @ts-ignore — deep import resolved by the terminal-worker build plugin
import factory from "yoga-layout/dist/binaries/yoga-wasm-base64-esm.js";
// @ts-ignore — deep import resolved by the terminal-worker build plugin
import wrapAssembly from "yoga-layout/dist/src/wrapAssembly.js";
// @ts-ignore — workerd-provided, pre-compiled WebAssembly.Module
import YOGA_MODULE from "yoga.wasm";

const lib = await factory({
  // Synchronous instantiation from the embedder-compiled module. emscripten
  // calls this instead of its own async compile, so the wrapping top-level
  // await resolves on a microtask (settles during workerd startup).
  instantiateWasm: (
    imports: WebAssembly.Imports,
    done: (instance: WebAssembly.Instance) => void,
  ): WebAssembly.Exports => {
    const instance = new WebAssembly.Instance(YOGA_MODULE as WebAssembly.Module, imports);
    done(instance);
    return instance.exports;
  },
});

const Yoga = wrapAssembly(lib);
export default Yoga;
// Re-export the layout enums (Direction, FlexDirection, …) like the real entry.
// @ts-ignore — deep import resolved by the terminal-worker build plugin
export * from "yoga-layout/dist/src/generated/YGEnums.js";
