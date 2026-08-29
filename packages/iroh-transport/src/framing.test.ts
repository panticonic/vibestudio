import { describe, expect, it, vi } from "vitest";
import { readToEnd, writeChunked } from "./framing.js";

describe("FIN-delimited Iroh payloads", () => {
  it("reads every chunk without imposing a total payload ceiling", async () => {
    const chunks = [[1, 2], [3], [4, 5, 6], []];
    const read = vi.fn(async () => chunks.shift() ?? []);

    await expect(readToEnd({ read }, 2)).resolves.toEqual(Uint8Array.of(1, 2, 3, 4, 5, 6));
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("writes bounded working chunks while leaving total size unrestricted", async () => {
    const writes: number[][] = [];
    await writeChunked(
      {
        writeAll: async (bytes) => {
          writes.push(bytes);
        },
      },
      Uint8Array.of(1, 2, 3, 4, 5),
      2
    );

    expect(writes).toEqual([[1, 2], [3, 4], [5]]);
  });
});
