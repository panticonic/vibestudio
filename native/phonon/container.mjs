import { openSync, closeSync, readSync } from "node:fs";

export function float16(bits) {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >>> 10) & 31;
  const fraction = bits & 1023;
  return (
    sign *
    (exponent === 0
      ? 2 ** -24 * fraction
      : exponent === 31
        ? fraction
          ? NaN
          : Infinity
        : 2 ** (exponent - 15) * (1 + fraction / 1024))
  );
}
export function float16Array(bytes) {
  if (bytes.length % 2) throw new Error("Invalid float16 tensor length");
  const result = new Float32Array(bytes.length / 2);
  for (let i = 0; i < result.length; i++) result[i] = float16(bytes.readUInt16LE(2 * i));
  return result;
}
const trits = Uint8Array.from(
  { length: 243 * 5 },
  (_, i) => Math.floor(Math.floor(i / 5) / 3 ** (i % 5)) % 3
);

/** Repack the original five-value encoding into the C kernel's two 2-bit
 * planes. This is lossless unpacking at load time, not model quantization. */
export function fiveValuePlanes(bytes, rows, columns) {
  if (columns % 4) throw new Error("Native five-value columns must be divisible by four");
  const rowBytes = Math.ceil(columns / 5);
  const tritBytes = rows * rowBytes;
  let nonzero = 0;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const byte = bytes[row * rowBytes + Math.floor(column / 5)];
      if (byte >= 243) throw new Error("Invalid base-three weight");
      if (trits[byte * 5 + (column % 5)] !== 1) nonzero++;
    }
  }
  const scales = tritBytes + Math.ceil(nonzero / 8);
  if (scales + 4 * rows !== bytes.length) throw new Error("Invalid five-value record length");
  const planeA = Buffer.alloc((rows * columns) / 4);
  const planeB = Buffer.alloc(planeA.length);
  let bit = 0;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const code = trits[bytes[row * rowBytes + Math.floor(column / 5)] * 5 + (column % 5)];
      let high = false;
      if (code !== 1) {
        high = !!(bytes[tritBytes + (bit >>> 3)] & (1 << (bit % 8)));
        bit++;
      }
      const index = (row * columns) / 4 + (column >>> 2);
      const shift = (column % 4) * 2;
      planeA[index] |= code << shift;
      planeB[index] |= (high ? code : 1) << shift;
    }
  }
  return [
    planeA,
    planeB,
    Buffer.from(bytes.subarray(scales, scales + 2 * rows)),
    Buffer.from(bytes.subarray(scales + 2 * rows)),
  ];
}

export function integerTable(bytes, shape, bits) {
  const total = shape.reduce((a, b) => a * b, 1);
  const rows = shape[0];
  const columns = total / rows;
  const bodyBytes = bits === 6 ? Math.ceil(total / 4) * 3 : total;
  if (![6, 8].includes(bits) || bodyBytes + 2 * rows !== bytes.length)
    throw new Error("Invalid integer table length");
  const scales = Buffer.from(bytes.subarray(bodyBytes));
  const scaleValues = float16Array(scales);
  const values = new Int8Array(total);
  const dense = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const group = Math.floor(i / 4) * 3;
    values[i] =
      bits === 8
        ? bytes.readInt8(i)
        : (((bytes[group] | (bytes[group + 1] << 8) | (bytes[group + 2] << 16)) >>> ((i % 4) * 6)) &
            63) -
          32;
    dense[i] = values[i] * scaleValues[Math.floor(i / columns)];
  }
  return { values, scales, dense, shape };
}

/** Read one record at a time: never expand all encoder weights to a dense
 * state dictionary or keep a second complete copy of the model archive. */
export function readContainer(file, consume) {
  const descriptor = openSync(file, "r");
  try {
    const read = (length) => {
      const buffer = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const count = readSync(descriptor, buffer, offset, length - offset, null);
        if (!count) throw new Error("Truncated Phonon container");
        offset += count;
      }
      return buffer;
    };
    const headerLength = Number(read(8).readBigUInt64LE());
    if (!Number.isSafeInteger(headerLength) || headerLength <= 0 || headerLength > 1024 * 1024)
      throw new Error("Invalid container header length");
    const header = JSON.parse(read(headerLength).toString("utf8"));
    if (header.format !== "fermion-five-value-parakeet-v1" || !Array.isArray(header.index))
      throw new Error("Unsupported Phonon container");
    const names = new Set();
    const total = header.index.reduce((sum, record) => sum + record.b, 0);
    let completed = 0;
    for (const record of header.index) {
      if (
        typeof record.n !== "string" ||
        names.has(record.n) ||
        !Array.isArray(record.shape) ||
        record.shape.some((x) => !Number.isSafeInteger(x) || x <= 0) ||
        !Number.isSafeInteger(record.b) ||
        record.b <= 0 ||
        record.b > 32 * 1024 * 1024
      )
        throw new Error("Invalid Phonon tensor index");
      names.add(record.n);
      completed += record.b;
      consume(record, read(record.b), { completed, total });
    }
    if (readSync(descriptor, Buffer.alloc(1), 0, 1, null))
      throw new Error("Trailing Phonon container bytes");
  } finally {
    closeSync(descriptor);
  }
}
