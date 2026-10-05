import { createHash } from "node:crypto";
import { openSync, readSync, closeSync, readFileSync } from "node:fs";
import path from "node:path";
import { availableParallelism } from "node:os";
import koffi from "koffi";
import { fiveValuePlanes, float16Array, integerTable, readContainer } from "./container.mjs";
import { audioWindows, logMel } from "./frontend.mjs";

function verify(file, expected) {
  const hash = createHash("sha256");
  const descriptor = openSync(file, "r");
  const chunk = Buffer.alloc(1024 * 1024);
  try {
    for (;;) {
      const count = readSync(descriptor, chunk, 0, chunk.length, null);
      if (!count) break;
      hash.update(chunk.subarray(0, count));
    }
  } finally {
    closeSync(descriptor);
  }
  if (hash.digest("hex") !== expected)
    throw new Error(`Phonon resource checksum mismatch: ${path.basename(file)}`);
}

export function selectKernels(target, features) {
  if (!target.baselineEncoder) return { encoder: target.encoder, decoder: target.decoder };
  const required = target.arch === "arm64" ? (1 << 1) | (1 << 4) : 1 << 9;
  const fast = (features & required) === required;
  return {
    encoder: fast ? target.encoder : target.baselineEncoder,
    decoder: fast ? target.decoder : target.baselineDecoder,
  };
}

const matrices = [
  "feed_forward1.linear1",
  "feed_forward1.linear2",
  "self_attn.q_proj",
  "self_attn.k_proj",
  "self_attn.v_proj",
  "self_attn.o_proj",
  "self_attn.relative_k_proj",
  "conv.pointwise_conv1",
  "conv.pointwise_conv2",
  "feed_forward2.linear1",
  "feed_forward2.linear2",
];
const vectors = [
  "norm_feed_forward1.weight",
  "norm_feed_forward1.bias",
  "norm_self_att.weight",
  "norm_self_att.bias",
  "norm_conv.weight",
  "norm_conv.bias",
  "norm_feed_forward2.weight",
  "norm_feed_forward2.bias",
  "norm_out.weight",
  "norm_out.bias",
  "self_attn.bias_u",
  "self_attn.bias_v",
  "conv.depthwise_conv.weight",
  "conv.norm.weight",
  "conv.norm.bias",
  "conv.norm.running_mean",
  "conv.norm.running_var",
];
const pointer = "void *";

/** A model instance is confined to its owning Node subprocess. Native handles
 * never cross the extension RPC boundary. All kernels and weights are baked
 * immutable resources; this module performs no network or package installation. */
export class PhononEngine {
  constructor(root, progress = () => {}) {
    this.handles = [];
    this.backing = [];
    this.libraries = [];
    this.encoder = null;
    this.decoder = null;
    this.closed = false;
    try {
      const distribution = JSON.parse(readFileSync(path.join(root, "distribution.json"), "utf8"));
      const target = distribution.targets.find(
        (t) => t.platform === process.platform && t.arch === process.arch
      );
      if (!target) throw new Error(`Phonon does not support ${process.platform}/${process.arch}`);
      const load = (name) => {
        const file = path.join(root, "kernels", name);
        // Kernel bytes are verified by the bake and afterPack, before platform
        // signing. Signing can legitimately change Mach-O bytes; installed
        // code follows the same application trust boundary as the runner/FFI.
        const library = koffi.load(file);
        this.libraries.push(library);
        return library;
      };
      const baseline = load(target.baselineEncoder ?? target.encoder);
      const features = target.baselineEncoder
        ? baseline.func("phonon2_cpu_features", "uint32", [])()
        : 0;
      const selected = selectKernels(target, features);
      this.lib =
        selected.encoder === (target.baselineEncoder ?? target.encoder)
          ? baseline
          : load(selected.encoder);
      this.tdt = load(selected.decoder);
      const fn = (name, result, args) => this.lib.func(name, result, args);
      const df = (name, result, args) => this.tdt.func(name, result, args);
      if (
        fn("phonon2_cpu_abi_version", "int", [])() !== 1 ||
        fn("phonon2_enc_abi_version", "int", [])() !== 1 ||
        df("phonon2_tdt_abi_version", "int", [])() !== 2
      )
        throw new Error("Unsupported Phonon native ABI");
      const threads = Math.min(availableParallelism(), 16);
      fn("phonon2_cpu_set_threads", "void", ["int"])(threads);
      df("phonon2_tdt_set_threads", "void", ["int"])(threads);
      this.destroyMatrix = fn("phonon2_cpu_destroy", "void", [pointer]);
      this.destroyEncoder = fn("phonon2_enc_destroy", "void", [pointer]);
      this.destroyDecoder = df("phonon2_tdt_destroy", "void", [pointer]);
      const create = fn("phonon2_cpu_create", pointer, [
        "int",
        "int",
        pointer,
        pointer,
        pointer,
        pointer,
        "int",
      ]);
      const onedot = fn("phonon2_cpu_enable_onedot", "float", [pointer]);
      const packed = new Map();
      const weights = new Map();
      const raw = new Map();
      progress("Checking voice model…");
      const model = path.join(root, "model.fermion");
      const configFile = path.join(root, "config.json");
      verify(model, distribution.model.files["model.fermion"]);
      verify(configFile, distribution.model.files["config.json"]);
      const config = JSON.parse(readFileSync(configFile, "utf8"));
      if (
        config.encoder.d_model !== 1024 ||
        config.encoder.n_layers !== 24 ||
        config.labels.length !== 8192 ||
        config.sample_rate !== 16000
      )
        throw new Error("Unsupported Phonon-2 architecture");
      this.vocabulary = config.labels;
      progress("Loading voice model…");
      readContainer(model, (record, bytes, amount) => {
        if (record.k === "five_value") {
          const [rows, columns] = record.shape;
          const planes = fiveValuePlanes(bytes, rows, columns);
          const handle = create(rows, columns, ...planes, 0);
          if (!handle) throw new Error(`Native matrix allocation failed: ${record.n}`);
          this.handles.push(handle);
          this.backing.push(...planes);
          onedot(handle);
          packed.set(record.n, handle);
        } else if (record.k === "fp16") {
          weights.set(record.n, float16Array(bytes));
          raw.set(record.n, { bytes });
        } else if (record.k === "int6" || record.k === "int8") {
          const table = integerTable(bytes, record.shape, Number(record.k.slice(3)));
          weights.set(record.n, table.dense);
          raw.set(record.n, table);
        } else throw new Error(`Unsupported weight encoding: ${record.k}`);
        progress("Loading voice model…", amount);
      });
      if (packed.size !== 264) throw new Error("Incomplete Phonon-2 encoder");
      const weight = (name) => {
        const value = weights.get(name);
        if (!value) throw new Error(`Missing Phonon tensor: ${name}`);
        return value;
      };
      progress("Preparing speech recognition…");
      this.encoder = fn("phonon2_enc_create", pointer, Array(7).fill("int"))(
        24,
        1024,
        4096,
        8,
        9,
        128,
        256
      );
      if (!this.encoder) throw new Error("Native encoder allocation failed");
      const sub = [];
      for (const index of [0, 2, 3, 5, 6])
        sub.push(
          weight(`encoder.subsampling.layers.${index}.weight`),
          weight(`encoder.subsampling.layers.${index}.bias`)
        );
      sub.push(
        weight("encoder.subsampling.linear.weight"),
        weight("encoder.subsampling.linear.bias"),
        Float32Array.from({ length: 512 }, (_, i) => 1 / 10000 ** ((2 * i) / 1024))
      );
      if (fn("phonon2_enc_set_subsampling", "int", Array(14).fill(pointer))(this.encoder, ...sub))
        throw new Error("Native subsampling initialization failed");
      const setLayer = fn("phonon2_enc_set_layer", "int", [pointer, "int", "void **", "void **"]);
      for (let layer = 0; layer < 24; layer++) {
        const prefix = `encoder.layers.${layer}.`;
        const handles = matrices.map((name) => {
          const handle = packed.get(prefix + name);
          if (!handle) throw new Error(`Missing native matrix: ${prefix + name}`);
          return handle;
        });
        const layerVectors = vectors.map((name) => weight(prefix + name));
        this.backing.push(...layerVectors);
        if (
          setLayer(
            this.encoder,
            layer,
            handles,
            layerVectors.map((value) => koffi.as(value, pointer))
          )
        )
          throw new Error(`Native layer ${layer} initialization failed`);
      }
      const decoderArguments = [];
      const table = (name) => {
        const value = raw.get(name);
        if (!value?.values || !value.scales) throw new Error(`Missing decoder table: ${name}`);
        decoderArguments.push(value.values, value.scales);
      };
      const bias = (name) => {
        const value = raw.get(name);
        if (!value?.bytes) throw new Error(`Missing decoder bias: ${name}`);
        decoderArguments.push(value.bytes);
      };
      table("decoder.embedding.weight");
      for (const layer of [0, 1]) {
        table(`decoder.lstm.weight_ih_l${layer}`);
        bias(`decoder.lstm.bias_ih_l${layer}`);
        table(`decoder.lstm.weight_hh_l${layer}`);
        bias(`decoder.lstm.bias_hh_l${layer}`);
      }
      table("decoder.decoder_projector.weight");
      bias("decoder.decoder_projector.bias");
      table("joint.head.weight");
      bias("joint.head.bias");
      const durations = Int32Array.of(0, 1, 2, 3, 4);
      this.decoder = df("phonon2_tdt_create", pointer, [
        ...Array(5).fill("int"),
        pointer,
        "int",
        "int",
        ...Array(20).fill(pointer),
      ])(8193, 640, 640, 8198, 5, durations, 8192, 10, ...decoderArguments);
      if (!this.decoder) throw new Error("Native decoder allocation failed");
      // Preserve every borrowed native input until its owning handle is destroyed.
      this.backing.push(...sub, ...decoderArguments, durations);
      this.projection = weight("encoder_projector.weight");
      this.projectionBias = weight("encoder_projector.bias");
      this.outputLength = fn("phonon2_enc_out_len", "int", [pointer, "int"]);
      this.forward = fn("phonon2_enc_forward", "int", [pointer, pointer, "int", pointer]);
      this.decode = df("phonon2_tdt_decode_timed", "int", [
        pointer,
        pointer,
        "int",
        pointer,
        pointer,
        pointer,
        "int",
      ]);
      this.description = {
        model: "phonon-2",
        language: "en",
        platform: process.platform,
        arch: process.arch,
        threads,
        ...selected,
      };
    } catch (error) {
      this.close();
      throw error;
    }
  }

  transcribe(audio) {
    if (this.closed) throw new Error("Phonon engine is closed");
    const text = [];
    for (const window of audioWindows(audio)) {
      const { features, frames } = logMel(window);
      const length = this.outputLength(this.encoder, frames);
      if (length <= 0 || length > frames) throw new Error("Invalid native encoder output length");
      const encoded = new Float32Array(length * 1024);
      if (this.forward(this.encoder, features, frames, encoded))
        throw new Error("Native Phonon encoder failed");
      const projected = new Float32Array(length * 640);
      for (let t = 0; t < length; t++) {
        for (let row = 0; row < 640; row++) {
          let sum = this.projectionBias[row];
          for (let column = 0; column < 1024; column++)
            sum += encoded[t * 1024 + column] * this.projection[row * 1024 + column];
          projected[t * 640 + row] = sum;
        }
      }
      const capacity = Math.max(64, 12 * length);
      const tokens = new Int32Array(capacity);
      const starts = new Int32Array(capacity);
      const durations = new Int32Array(capacity);
      const count = this.decode(
        this.decoder,
        projected,
        length,
        tokens,
        starts,
        durations,
        capacity
      );
      if (count < 0 || count >= capacity)
        throw new Error("Native Phonon decoder failed or exhausted its output buffer");
      const pieces = [];
      for (const token of tokens.subarray(0, count)) {
        if (token < 0 || token > 8192) throw new Error("Invalid native Phonon token");
        const piece = this.vocabulary[token];
        if (piece && !/^<.*>$/u.test(piece)) pieces.push(piece);
      }
      text.push(pieces.join("").replaceAll("▁", " ").trim());
    }
    return { text: text.filter(Boolean).join(" "), model: "phonon-2", language: "en" };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.decoder) this.destroyDecoder(this.decoder);
    if (this.encoder) this.destroyEncoder(this.encoder);
    for (const handle of this.handles) this.destroyMatrix(handle);
    this.backing.length = 0;
    // Kernels own process-wide worker pools. Their code stays loaded until the
    // owned inference process exits, after all model handles are destroyed.
  }
}
