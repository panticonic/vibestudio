import type {
  ReadableStream as PolyfillReadableStream,
  ReadableStreamDefaultReader as PolyfillReader,
  ReadableStreamDefaultController as PolyfillController,
  ReadableStreamDefaultReadResult as PolyfillReadResult,
} from "web-streams-polyfill/ponyfill";

/** Exact Hermes + installed mobile-iroh platform surface. No DOM, Node, or
 * uninstalled stream constructors are made available to native consumers. */
declare global {
  // Hermes pinned by RN 0.79: GlobalObject.cpp creates TextEncoder and atob/btoa.
  interface TextEncoderEncodeIntoResult {
    read: number;
    written: number;
  }
  interface TextEncoder {
    readonly encoding: string;
    encode(input?: string): Uint8Array;
    encodeInto(source: string, destination: Uint8Array): TextEncoderEncodeIntoResult;
  }
  var TextEncoder: { prototype: TextEncoder; new (): TextEncoder };
  function atob(data: string): string;
  function btoa(data: string): string;

  interface TextDecoderOptions {
    fatal?: boolean;
    ignoreBOM?: boolean;
  }
  interface TextDecodeOptions {
    stream?: boolean;
  }
  type BufferSource = ArrayBufferView | ArrayBuffer;
  interface TextDecoder {
    readonly encoding: string;
    readonly fatal: boolean;
    readonly ignoreBOM: boolean;
    decode(input?: BufferSource | ArrayBufferLike, options?: TextDecodeOptions): string;
  }
  var TextDecoder: typeof import("@kayahr/text-encoding/no-encodings").TextDecoder;

  interface ReadableStream<R = any> extends PolyfillReadableStream<R> {}
  var ReadableStream: typeof PolyfillReadableStream;
  interface ReadableStreamDefaultReader<R = any> extends PolyfillReader<R> {}
  interface ReadableStreamDefaultController<R = any> extends PolyfillController<R> {}
  type ReadableStreamReadResult<T> = PolyfillReadResult<T>;
}
