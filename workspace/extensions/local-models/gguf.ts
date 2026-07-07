export interface GgufMeta {
  arch: string;
  paramCountLabel: string | null;
  contextLength: number | null;
  chatTemplate: string | null;
  quantLabel: string | null;
}

type GgufValue = string | number | bigint | boolean | GgufValue[];

const GGUF_MAGIC = [0x47, 0x47, 0x55, 0x46] as const;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

const VALUE_TYPE = {
  uint8: 0,
  int8: 1,
  uint16: 2,
  int16: 3,
  uint32: 4,
  int32: 5,
  float32: 6,
  bool: 7,
  string: 8,
  array: 9,
  uint64: 10,
  int64: 11,
  float64: 12,
} as const;

const FILE_TYPE_LABELS: Record<number, string> = {
  0: "F32",
  1: "F16",
  2: "Q4_0",
  3: "Q4_1",
  7: "Q8_0",
  8: "Q5_0",
  9: "Q5_1",
  10: "Q2_K",
  11: "Q3_K_S",
  12: "Q3_K_M",
  13: "Q3_K_L",
  14: "Q4_K_S",
  15: "Q4_K_M",
  16: "Q5_K_S",
  17: "Q5_K_M",
  18: "Q6_K",
  19: "IQ2_XXS",
  20: "IQ2_XS",
  21: "Q2_K_S",
  22: "IQ3_XS",
  23: "IQ3_XXS",
  24: "IQ1_S",
  25: "IQ4_NL",
  26: "IQ3_S",
  27: "IQ3_M",
  28: "IQ2_S",
  29: "IQ2_M",
  30: "IQ4_XS",
  31: "IQ1_M",
  32: "BF16",
  33: "Q4_0_4_4",
  34: "Q4_0_4_8",
  35: "Q4_0_8_8",
  36: "TQ1_0",
  37: "TQ2_0",
};

class GgufReader {
  private readonly view: DataView;
  private readonly decoder = new TextDecoder();
  private offset = 0;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  remaining(): number {
    return this.buf.byteLength - this.offset;
  }

  readBytes(length: number): Uint8Array {
    this.ensure(length);
    const start = this.offset;
    this.offset += length;
    return this.buf.subarray(start, start + length);
  }

  readUint8(): number {
    this.ensure(1);
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  readInt8(): number {
    this.ensure(1);
    const value = this.view.getInt8(this.offset);
    this.offset += 1;
    return value;
  }

  readUint16(): number {
    this.ensure(2);
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  readInt16(): number {
    this.ensure(2);
    const value = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return value;
  }

  readUint32(): number {
    this.ensure(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readInt32(): number {
    this.ensure(4);
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readFloat32(): number {
    this.ensure(4);
    const value = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readFloat64(): number {
    this.ensure(8);
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }

  readUint64(): bigint {
    this.ensure(8);
    const value = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return value;
  }

  readInt64(): bigint {
    this.ensure(8);
    const value = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return value;
  }

  readUint64Number(label: string): number {
    const value = this.readUint64();
    if (value > MAX_SAFE_BIGINT) {
      throw new Error(`${label} exceeds JavaScript's safe integer range`);
    }
    return Number(value);
  }

  readString(): string {
    const length = this.readUint64Number("GGUF string length");
    return this.decoder.decode(this.readBytes(length));
  }

  private ensure(length: number): void {
    if (length < 0 || this.remaining() < length) {
      throw new Error("Truncated GGUF metadata header");
    }
  }
}

export function parseGgufHeader(buf: Uint8Array): GgufMeta {
  const reader = new GgufReader(buf);
  const magic = reader.readBytes(4);
  for (let index = 0; index < GGUF_MAGIC.length; index += 1) {
    if (magic[index] !== GGUF_MAGIC[index]) {
      throw new Error("Invalid GGUF magic");
    }
  }

  const version = reader.readUint32();
  if (version !== 3) {
    throw new Error(`Unsupported GGUF version ${version}`);
  }

  reader.readUint64Number("GGUF tensor count");
  const kvCount = reader.readUint64Number("GGUF metadata key-value count");

  let arch = "unknown";
  let paramCountLabel: string | null = null;
  let contextLength: number | null = null;
  let chatTemplate: string | null = null;
  let quantLabel: string | null = null;
  const contextByArch = new Map<string, number>();

  for (let index = 0; index < kvCount; index += 1) {
    const key = reader.readString();
    const type = reader.readUint32();
    const value = readValue(reader, type);

    if (key === "general.architecture" && typeof value === "string") {
      arch = value || "unknown";
      contextLength = contextByArch.get(arch) ?? contextLength;
      continue;
    }

    if (key === "general.size_label" && typeof value === "string") {
      paramCountLabel = value;
      continue;
    }

    if (key === "tokenizer.chat_template" && typeof value === "string") {
      chatTemplate = value;
      continue;
    }

    if (key === "general.file_type") {
      const numeric = numericValue(value);
      quantLabel = numeric === null ? quantLabel : FILE_TYPE_LABELS[numeric] ?? null;
      continue;
    }

    if (key.endsWith(".context_length")) {
      const numeric = numericValue(value);
      if (numeric !== null) {
        const keyArch = key.slice(0, -".context_length".length);
        contextByArch.set(keyArch, numeric);
        if (keyArch === arch) {
          contextLength = numeric;
        }
      }
    }
  }

  return { arch, paramCountLabel, contextLength, chatTemplate, quantLabel };
}

export function detectToolsCapable(chatTemplate: string | null): boolean {
  if (chatTemplate === null) {
    return false;
  }

  const text = chatTemplate.toLowerCase();
  return [
    /<\|tool_call_start\|>/,
    /<tool_call>/,
    /\btool_calls?\b/,
    /\bfunction_call\b/,
    /\bavailable_tools\b/,
    /\btools\b/,
  ].some((pattern) => pattern.test(text));
}

function readValue(reader: GgufReader, type: number): GgufValue {
  switch (type) {
    case VALUE_TYPE.uint8:
      return reader.readUint8();
    case VALUE_TYPE.int8:
      return reader.readInt8();
    case VALUE_TYPE.uint16:
      return reader.readUint16();
    case VALUE_TYPE.int16:
      return reader.readInt16();
    case VALUE_TYPE.uint32:
      return reader.readUint32();
    case VALUE_TYPE.int32:
      return reader.readInt32();
    case VALUE_TYPE.float32:
      return reader.readFloat32();
    case VALUE_TYPE.bool:
      return reader.readUint8() !== 0;
    case VALUE_TYPE.string:
      return reader.readString();
    case VALUE_TYPE.array:
      return readArray(reader);
    case VALUE_TYPE.uint64:
      return reader.readUint64();
    case VALUE_TYPE.int64:
      return reader.readInt64();
    case VALUE_TYPE.float64:
      return reader.readFloat64();
    default:
      throw new Error(`Unsupported GGUF metadata value type ${type}`);
  }
}

function readArray(reader: GgufReader): GgufValue[] {
  const elementType = reader.readUint32();
  const length = reader.readUint64Number("GGUF array length");
  const values: GgufValue[] = [];
  for (let index = 0; index < length; index += 1) {
    values.push(readValue(reader, elementType));
  }
  return values;
}

function numericValue(value: GgufValue): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === "bigint" && value <= MAX_SAFE_BIGINT && value >= -MAX_SAFE_BIGINT) {
    return Number(value);
  }

  return null;
}
