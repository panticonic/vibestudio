import { describe, expect, it, vi } from "vitest";
import { readToEnd, writeChunked } from "./framing.js";

describe("FIN-delimited Iroh payloads", () => {
  it("reads every chunk without imposing a total payload ceiling", async () => {
    const chunks = [
      Uint8Array.of(1, 2),
      Uint8Array.of(3),
      Uint8Array.of(4, 5, 6),
      new Uint8Array(),
    ];
    const read = vi.fn(async () => chunks.shift() ?? new Uint8Array());

    await expect(readToEnd({ read }, 2)).resolves.toEqual(Uint8Array.of(1, 2, 3, 4, 5, 6));
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("writes bounded working chunks while leaving total size unrestricted", async () => {
    const writes: Uint8Array[] = [];
    await writeChunked(
      {
        writeAll: async (bytes) => {
          writes.push(bytes);
        },
      },
      Uint8Array.of(1, 2, 3, 4, 5),
      2
    );

    expect(writes).toEqual([Uint8Array.of(1, 2), Uint8Array.of(3, 4), Uint8Array.of(5)]);
  });
});
