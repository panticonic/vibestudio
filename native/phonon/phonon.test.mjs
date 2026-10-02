import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { float16, fiveValuePlanes, integerTable, readContainer } from "./container.mjs";
import { logMel, audioWindows } from "./frontend.mjs";
import { selectKernels } from "./engine.mjs";
import {
  PHONON_DISTRIBUTION,
  verifyPhononDownload,
} from "../../scripts/phonon-runtime-artifacts.mjs";

test("exact five-value weights, including magnitude bits crossing row boundaries", () => {
  // [-hi, 0, +lo, -lo], [+hi, 0, -lo, +hi]; high bits at indices 0, 3, 5.
  const bytes = Buffer.from([0 + 3 + 18, 2 + 3 + 0 + 54, 0b101001, 0, 60, 0, 60, 0, 64, 0, 64]);
  const [a, b, lo, hi] = fiveValuePlanes(bytes, 2, 4);
  assert.deepEqual([...a], [0b00100100, 0b10000110]);
  assert.deepEqual([...b], [0b01010100, 0b10010110]);
  assert.equal(float16(lo.readUInt16LE()), 1);
  assert.equal(float16(hi.readUInt16LE()), 2);
  assert.throws(() => fiveValuePlanes(bytes.subarray(0, -1), 2, 4), /length/);
});
test("six-bit signed tables and float16 row scales", () => {
  const packed = 0 | (31 << 6) | (32 << 12) | (63 << 18);
  const bytes = Buffer.from([packed & 255, (packed >>> 8) & 255, (packed >>> 16) & 255, 0, 56]);
  const table = integerTable(bytes, [1, 4], 6);
  assert.deepEqual([...table.values], [-32, -1, 0, 31]);
  assert.deepEqual([...table.dense], [-16, -0.5, 0, 15.5]);
  assert.equal(float16(1), 2 ** -24);
  assert.ok(Number.isNaN(float16(0x7e00)));
});
test("container accepts scalar tensors and rejects truncation", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "phonon-container-"));
  try {
    const header = Buffer.from(
      JSON.stringify({
        format: "fermion-five-value-parakeet-v1",
        index: [{ n: "scalar", k: "fp16", shape: [], b: 2 }],
      })
    );
    const size = Buffer.alloc(8);
    size.writeBigUInt64LE(BigInt(header.length));
    const file = path.join(root, "fixture");
    writeFileSync(file, Buffer.concat([size, header, Buffer.from([0, 60])]));
    let value;
    readContainer(file, (_, data) => {
      value = float16(data.readUInt16LE());
    });
    assert.equal(value, 1);
    writeFileSync(file, Buffer.concat([size, header, Buffer.from([0])]));
    assert.throws(() => readContainer(file, () => {}), /Truncated/);
  } finally {
    rmSync(root, { recursive: true });
  }
});
test("silence remains finite and long-window boundaries retain every sample", () => {
  assert.ok(logMel(new Float32Array(1600)).features.every(Number.isFinite));
  const audio = new Float32Array(480001);
  const windows = [...audioWindows(audio)];
  assert.equal(
    windows.reduce((n, w) => n + w.length, 0),
    audio.length
  );
  assert.ok(windows.every((w) => w.length >= 160 && w.length <= 480000));
});
test("ARM baseline requires neither dotprod nor LSE; optimization requires both", () => {
  const target = PHONON_DISTRIBUTION.targets.find(
    (t) => t.platform === "linux" && t.arch === "arm64"
  );
  for (const features of [0, 1, 1 << 1, 1 << 4])
    assert.equal(selectKernels(target, features).encoder, target.baselineEncoder);
  assert.equal(selectKernels(target, (1 << 1) | (1 << 4)).encoder, target.encoder);
  assert.throws(
    () => verifyPhononDownload(Buffer.from("substitute"), PHONON_DISTRIBUTION.model),
    /checksum/
  );
});
