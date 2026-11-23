/** Compiler children do not inherit the host V8 flags. Keep their frontend heap
 * explicit and bounded; the ledger/cgroup still bounds the entire workspace. */
export function compilerProductExecArgv(environment: NodeJS.ProcessEnv = process.env): string[] {
  const value = environment["VIBESTUDIO_COMPILER_HEAP_MIB"] ?? "3072";
  if (!/^(0|[1-9][0-9]*)$/.test(value))
    throw new Error("VIBESTUDIO_COMPILER_HEAP_MIB must be 0 or an integer from64 to8192");
  const mib = Number(value);
  if (mib === 0) return [];
  if (mib < 64 || mib > 8192)
    throw new Error("VIBESTUDIO_COMPILER_HEAP_MIB must be 0 or an integer from64 to8192");
  return [`--max-old-space-size=${mib}`];
}

import { createHash } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { open } from "node:fs/promises";
import { constants as bufferConstants } from "node:buffer";

/** Native jobs own resource limits. Cache capacity must never become a compiler
 * correctness limit; retain only the runtime's actual decoding/allocation bounds. */
export async function readCompilerProductResult(resultPath: string): Promise<string> {
  const file = await open(resultPath, fileConstants.O_RDONLY | (fileConstants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat({ bigint: true });
    const limit = BigInt(
      Math.min(bufferConstants.MAX_LENGTH, bufferConstants.MAX_STRING_LENGTH * 3)
    );
    if (!info.isFile() || info.size > limit) {
      console.error(
        JSON.stringify({
          schema: "native.compiler-product-result/1",
          status: "rejected",
          bytes: String(info.size),
          regular: info.isFile(),
          runtimeByteLimit: String(limit),
        })
      );
      throw new Error(
        `Invalid native compiler product file: bytes=${info.size}, regular=${info.isFile()}, runtimeByteLimit=${limit}`
      );
    }
    const data = Buffer.alloc(Number(info.size));
    let offset = 0;
    while (offset < data.length) {
      const part = await file.read(data, offset, data.length - offset, offset);
      if (!part.bytesRead) break;
      offset += part.bytesRead;
    }
    const extra = await file.read(Buffer.alloc(1), 0, 1, offset);
    const after = await file.stat({ bigint: true });
    if (
      offset !== data.length ||
      extra.bytesRead ||
      after.size !== info.size ||
      after.mtimeNs !== info.mtimeNs ||
      after.ctimeNs !== info.ctimeNs
    )
      throw new Error("Native compiler product changed after completion");
    const serialized = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
    console.info(
      JSON.stringify({
        schema: "native.compiler-product-result/1",
        status: "read",
        bytes: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
      })
    );
    return serialized;
  } finally {
    await file.close();
  }
}

interface CompiledProduct {
  serialized: string;
  initialValue: unknown;
  claimed: boolean;
}

/** One workspace owner's cache. Only serialized frontend data crosses callers. */
export class NativeCompilerProducts {
  private readonly values = new Map<string, string>();
  private readonly flights = new Map<string, Promise<CompiledProduct>>();
  private tail = Promise.resolve();
  private bytes = 0;
  private closed = false;
  close(): Promise<void> {
    this.closed = true;
    this.values.clear();
    this.bytes = 0;
    return this.tail;
  }
  constructor(
    private readonly run: (request: {
      bundle: string;
      format: "cjs" | "async-cjs";
      input: unknown;
    }) => Promise<string>,
    private readonly maximumBytes = 64 * 1024 * 1024
  ) {}
  async compile(request: {
    bundle: string;
    format: "cjs" | "async-cjs";
    input: unknown;
  }): Promise<unknown> {
    if (this.closed) throw new Error("Native compiler owner retired");
    // Clone/snapshot before queue admission: later caller mutation cannot change the computation.
    const snapshot = JSON.stringify(request);
    const key = createHash("sha256").update(snapshot).digest("hex");
    const cache = process.env["VIBESTUDIO_CACHE_COMPILER_PRODUCTS"] !== "0";
    const prior = cache ? this.values.get(key) : undefined;
    if (prior !== undefined) {
      this.values.delete(key);
      this.values.set(key, prior);
      console.info(JSON.stringify({ schema: "native.compiler-product/1", key, cache: "hit" }));
      return JSON.parse(prior);
    }
    let flight = cache ? this.flights.get(key) : undefined;
    if (flight)
      console.info(JSON.stringify({ schema: "native.compiler-product/1", key, cache: "joined" }));
    if (!flight) {
      const admitted = performance.now();
      flight = this.tail.then(async () => {
        if (this.closed) throw new Error("Native compiler owner retired");
        const started = performance.now();
        console.info(
          JSON.stringify({
            schema: "native.compiler-product/1",
            key,
            cache: "miss",
            queueMs: started - admitted,
          })
        );
        const value = await this.run(JSON.parse(snapshot));
        if (typeof value !== "string") throw new Error("Native compiler returned no JSON product");
        // Parse before admitting the serialized cache entry; malformed output
        // must release its flight for a subsequent corrected compiler job.
        const initialValue: unknown = JSON.parse(value);
        const size = Buffer.byteLength(value);
        console.info(
          JSON.stringify({
            schema: "native.compiler-product/1",
            key,
            cache: "compiled",
            compileMs: performance.now() - started,
            productBytes: size,
            productSha256: createHash("sha256").update(value).digest("hex"),
            retained: cache && !this.closed && size <= this.maximumBytes,
          })
        );
        if (cache && !this.closed && size <= this.maximumBytes) {
          this.values.set(key, value);
          this.bytes += size;
          while (this.bytes > this.maximumBytes || this.values.size > 32) {
            const oldest = this.values.keys().next().value!;
            this.bytes -= Buffer.byteLength(this.values.get(oldest)!);
            this.values.delete(oldest);
          }
        }
        return { serialized: value, initialValue, claimed: false };
      });
      this.tail = flight.then(
        () => undefined,
        () => undefined
      );
      if (cache) {
        this.flights.set(key, flight);
        void flight.finally(() => this.flights.delete(key)).catch(() => {});
      }
    }
    const product = await flight;
    if (!product.claimed) {
      product.claimed = true;
      const value = product.initialValue;
      product.initialValue = undefined;
      return value;
    }
    return JSON.parse(product.serialized);
  }
}

/** Executed inside the existing native workspace sandbox, never the host JS realm. */
export function compilerProductDriver(
  input: unknown,
  resultPath: string,
  format: "cjs" | "async-cjs"
): string {
  return `import {readFile,writeFile} from "node:fs/promises";
import {createRequire} from "node:module";
const bundlePath=process.env.VIBESTUDIO_EXTENSION_SMOKE_BUNDLE;
const require=createRequire(bundlePath),module={exports:{}};
const source=await readFile(bundlePath,"utf8");
await new Function("require","module","exports",${JSON.stringify(format === "async-cjs" ? "return (async()=>{\n" : "")}+source+${JSON.stringify(format === "async-cjs" ? "\n})();" : "")})(require,module,module.exports);
if(typeof module.exports.compileVirtualProjectProduct!=="function")throw new Error("Compiler library has no pure product export");
const request=${JSON.stringify(input)};
const product=await module.exports.compileVirtualProjectProduct(request.project,request.options);
await writeFile(${JSON.stringify(resultPath)},JSON.stringify(product),{flag:"wx"});
`;
}
