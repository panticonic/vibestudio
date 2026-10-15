/**
 * React Native (Hermes) web-API polyfills the Iroh pipe's codec depends on.
 * Imported FIRST by `connect.ts` (before any `@vibestudio/rpc` module loads) so
 * both bundles that use this package — the native host bootstrap and the
 * post-reload workspace shell app — get them. All guarded: a future Hermes that
 * ships a native implementation wins.
 *
 *  - `ReadableStream` — streamed responses (`gateway.fetch`, the bundle-activation
 *    fetch) decode into a `ReadableStream<Uint8Array>`. RN's whatwg-fetch
 *    `Response` cannot consume a ReadableStream body, so the host reads the
 *    decoded stream directly via `getReader()` (`rpc.streamReadable`).
 *  - `TextDecoder` — Hermes has `TextEncoder` but not `TextDecoder`; the control-
 *    frame codec decodes UTF-8 JSON via `new TextDecoder().decode(bytes)`
 *    (`@vibestudio/rpc` `streamCodec`), and the module throws on load without it.
 */

import { ReadableStream as PonyfillReadableStream } from "web-streams-polyfill/ponyfill";
import { TextDecoder as StandardTextDecoder } from "@kayahr/text-encoding/no-encodings";
import "./whatwgFetchTypes.js";
import { DOMException } from "whatwg-fetch";
import { installStandardAbortController } from "./abortController.js";

installStandardAbortController(AbortController, AbortSignal, DOMException);

{
  const g = globalThis as { ReadableStream?: unknown };
  if (typeof g.ReadableStream === "undefined") {
    g.ReadableStream = PonyfillReadableStream;
  }
}

if (typeof (globalThis as { TextDecoder?: unknown }).TextDecoder === "undefined") {
  (globalThis as { TextDecoder?: unknown }).TextDecoder = StandardTextDecoder;
}
