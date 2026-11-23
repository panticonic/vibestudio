import { createHash } from "node:crypto";

/** One workspace owner's cache. Only serialized frontend data crosses callers. */
export class NativeCompilerProducts {
  private readonly values = new Map<string, string>();
  private readonly flights = new Map<string, Promise<string>>();
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
    }) => Promise<unknown>,
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
    if (Buffer.byteLength(snapshot) > 32 * 1024 * 1024)
      throw new Error("Native compiler request exceeds32MiB");
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
        const value = JSON.stringify(await this.run(JSON.parse(snapshot)));
        if (typeof value !== "string") throw new Error("Native compiler returned no JSON product");
        const size = Buffer.byteLength(value);
        console.info(
          JSON.stringify({
            schema: "native.compiler-product/1",
            key,
            cache: "compiled",
            compileMs: performance.now() - started,
            productBytes: size,
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
        return value;
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
    return JSON.parse(await flight);
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
