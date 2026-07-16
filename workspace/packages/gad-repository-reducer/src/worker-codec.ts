import {
  bytesFromHex,
  bytesToHex,
} from "@vibestudio/shared/contentStore/exactContentStore";
import { canonicalJson } from "@vibestudio/shared/contentTree/canonicalJson";
import {
  createGadRepositoryManifestTemplateV1,
  createGadWorkingSnapshotManifestTemplateV1,
  type GadRepositoryManifestTemplateV1,
  type GadWorkingSnapshotManifestTemplateV1,
} from "@workspace/gad-repository-contract";
import {
  GAD_REPOSITORY_REDUCER_PROTOCOL_VERSION,
  asGadDoltCommitHash,
  type GadMergeConflictV1,
  type GadRepositoryDatabaseRefV1,
  type GadRepositoryReducerRequestV1,
} from "./types.js";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const BYTES_TAG = "$gad.bytes";
const MAX_CODEC_DEPTH = 64;
const MAX_CODEC_NODES = 100_000;

type JsonWireValue =
  | null
  | boolean
  | string
  | number
  | JsonWireValue[]
  | { [key: string]: JsonWireValue };

export interface GadReducerInvocationBundleV1 {
  readonly version: 1;
  readonly request: GadRepositoryReducerRequestV1;
}

export interface GadReducerSelectedSourceV1 {
  readonly kind: "input" | "output";
  readonly logicalName: string;
  readonly sqlAlias: string;
}

/**
 * Application payload emitted before workerd finalizes selected databases. Exact final database
 * refs are intentionally absent and are reconstructed from the native run result by the client.
 */
export interface GadReducerApplicationResultV1 {
  readonly version: 1;
  readonly repositorySource: GadReducerSelectedSourceV1;
  readonly workingSource: GadReducerSelectedSourceV1 | null;
  readonly repositoryManifest: GadRepositoryManifestTemplateV1;
  readonly workingManifest: GadWorkingSnapshotManifestTemplateV1 | null;
  readonly publication: {
    readonly targetRef: string;
    readonly expected: GadRepositoryDatabaseRefV1 | null;
    readonly reason: string;
  } | null;
  readonly mergeResults: readonly {
    readonly inputName: string;
    readonly status: "clean" | "conflicted" | "up-to-date" | "fast-forward";
    readonly baseCommitHash: string | null;
    readonly conflicts: readonly GadMergeConflictV1[];
  }[];
}

export function encodeGadReducerInvocationBundleV1(
  value: GadReducerInvocationBundleV1
): Uint8Array {
  if (value.version !== 1) throw new Error("Unsupported Gad reducer invocation bundle version");
  validateReducerRequest(value.request);
  return encodeCanonicalTaggedJson(value);
}

export function decodeGadReducerInvocationBundleV1(
  bytes: Uint8Array
): GadReducerInvocationBundleV1 {
  const value = decodeCanonicalTaggedJson(bytes);
  const record = requireRecord(value, "Gad reducer invocation bundle");
  requireExactKeys(record, ["request", "version"], "Gad reducer invocation bundle");
  if (record["version"] !== 1)
    throw new Error("Unsupported Gad reducer invocation bundle version");
  const request = record["request"] as GadRepositoryReducerRequestV1;
  validateReducerRequest(request);
  return { version: 1, request };
}

/** Canonical exact-ref bytes for application metadata and transport fixtures. */
export function encodeGadRepositoryDatabaseRefV1(
  value: GadRepositoryDatabaseRefV1
): Uint8Array {
  validateRepositoryRef(value);
  return encodeCanonicalTaggedJson(value);
}

export function decodeGadRepositoryDatabaseRefV1(
  bytes: Uint8Array
): GadRepositoryDatabaseRefV1 {
  const value = decodeCanonicalTaggedJson(bytes);
  validateRepositoryRef(value);
  return value as GadRepositoryDatabaseRefV1;
}

export function encodeGadReducerManifestTemplateV1(
  value: GadRepositoryManifestTemplateV1 | GadWorkingSnapshotManifestTemplateV1
): Uint8Array {
  if (value.kind === "gad.repository") validateRepositoryManifest(value);
  else validateWorkingManifest(value);
  return encodeCanonicalTaggedJson(value);
}

export function decodeGadReducerManifestTemplateV1(
  bytes: Uint8Array
): GadRepositoryManifestTemplateV1 | GadWorkingSnapshotManifestTemplateV1 {
  const value = decodeCanonicalTaggedJson(bytes);
  const record = requireRecord(value, "Gad manifest template");
  if (record["kind"] === "gad.repository") {
    validateRepositoryManifest(record);
    return record as unknown as GadRepositoryManifestTemplateV1;
  }
  validateWorkingManifest(record);
  return record as unknown as GadWorkingSnapshotManifestTemplateV1;
}

export function encodeGadReducerApplicationResultV1(
  value: GadReducerApplicationResultV1
): Uint8Array {
  validateApplicationResult(value);
  return encodeCanonicalTaggedJson(value);
}

export function decodeGadReducerApplicationResultV1(
  bytes: Uint8Array
): GadReducerApplicationResultV1 {
  const value = decodeCanonicalTaggedJson(bytes) as GadReducerApplicationResultV1;
  validateApplicationResult(value);
  return value;
}

/** The workerd canonical-value representation of a single Uint8Array. */
export function encodeDatabaseReducerByteString(value: Uint8Array): Uint8Array {
  const header = encodeCborLength(2, value.byteLength);
  const result = new Uint8Array(header.byteLength + value.byteLength);
  result.set(header, 0);
  result.set(value, header.byteLength);
  return result;
}

export function decodeDatabaseReducerByteString(value: Uint8Array): Uint8Array {
  if (value.byteLength === 0 || value[0] === undefined || value[0] >> 5 !== 2) {
    throw new Error("Database reducer canonical value is not a byte string");
  }
  const decoded = decodeCborLength(value);
  if (decoded.major !== 2 || decoded.offset + decoded.length !== value.byteLength) {
    throw new Error("Invalid database reducer canonical byte string");
  }
  const canonicalHeader = encodeCborLength(2, decoded.length);
  if (canonicalHeader.byteLength !== decoded.offset) {
    throw new Error("Non-canonical database reducer byte string length");
  }
  for (let index = 0; index < canonicalHeader.byteLength; index += 1) {
    if (canonicalHeader[index] !== value[index]) {
      throw new Error("Non-canonical database reducer byte string length");
    }
  }
  return value.slice(decoded.offset);
}

function encodeCanonicalTaggedJson(value: unknown): Uint8Array {
  return utf8Encoder.encode(canonicalJson(toWireValue(value, 0, { nodes: 0 })));
}

function decodeCanonicalTaggedJson(bytes: Uint8Array): unknown {
  const text = utf8Decoder.decode(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Invalid canonical Gad reducer JSON");
  }
  if (canonicalJson(parsed) !== text) throw new Error("Non-canonical Gad reducer JSON");
  return fromWireValue(parsed, 0, { nodes: 0 });
}

function toWireValue(
  value: unknown,
  depth: number,
  state: { nodes: number }
): JsonWireValue {
  countCodecNode(depth, state);
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error("Gad reducer canonical JSON requires finite non-negative-zero numbers");
    }
    return value;
  }
  if (value instanceof Uint8Array) return { [BYTES_TAG]: bytesToHex(value) };
  if (Array.isArray(value)) {
    return value.map((child) => {
      if (child === undefined) throw new Error("Undefined Gad reducer array value");
      return toWireValue(child, depth + 1, state);
    });
  }
  if (value && typeof value === "object") {
    const result: { [key: string]: JsonWireValue } = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (key === BYTES_TAG) throw new Error("Reserved Gad reducer codec key");
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) result[key] = toWireValue(child, depth + 1, state);
    }
    return result;
  }
  throw new Error("Unsupported Gad reducer canonical JSON value");
}

function fromWireValue(
  value: unknown,
  depth: number,
  state: { nodes: number }
): unknown {
  countCodecNode(depth, state);
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error("Invalid Gad reducer canonical number");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((child) => fromWireValue(child, depth + 1, state));
  }
  const record = requireRecord(value, "Gad reducer canonical object");
  if (BYTES_TAG in record) {
    requireExactKeys(record, [BYTES_TAG], "Gad reducer byte string");
    if (typeof record[BYTES_TAG] !== "string") throw new Error("Invalid Gad reducer byte string");
    return bytesFromHex(record[BYTES_TAG]);
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    result[key] = fromWireValue(child, depth + 1, state);
  }
  return result;
}

function countCodecNode(depth: number, state: { nodes: number }): void {
  if (depth > MAX_CODEC_DEPTH) throw new Error("Gad reducer value exceeds codec depth limit");
  state.nodes += 1;
  if (state.nodes > MAX_CODEC_NODES) throw new Error("Gad reducer value exceeds codec node limit");
}

function validateReducerRequest(value: GadRepositoryReducerRequestV1): void {
  const request = requireRecord(value, "Gad reducer request");
  if (request["protocolVersion"] !== GAD_REPOSITORY_REDUCER_PROTOCOL_VERSION) {
    throw new Error("Unsupported Gad reducer request protocol version");
  }
  const inputs = requireRecord(request["inputs"], "Gad reducer request inputs");
  if (!Array.isArray(inputs["merges"]))
    throw new Error("Gad reducer merge inputs must be an array");
  requireRecord(request["operation"], "Gad reducer operation");
  if (request["publication"] !== null)
    requireRecord(request["publication"], "Gad publication request");
}

function validateApplicationResult(value: GadReducerApplicationResultV1): void {
  const record = requireRecord(value, "Gad reducer application result");
  requireExactKeys(
    record,
    [
      "mergeResults",
      "publication",
      "repositoryManifest",
      "repositorySource",
      "version",
      "workingManifest",
      "workingSource",
    ],
    "Gad reducer application result"
  );
  if (record["version"] !== 1)
    throw new Error("Unsupported Gad reducer application result version");
  validateSelectedSource(record["repositorySource"], "Gad repository source");
  if (record["workingSource"] !== null)
    validateSelectedSource(record["workingSource"], "Gad working source");
  validateRepositoryManifest(record["repositoryManifest"]);
  if (record["workingManifest"] !== null) validateWorkingManifest(record["workingManifest"]);
  if (record["publication"] !== null) {
    const publication = requireRecord(record["publication"], "Gad publication result");
    requireExactKeys(publication, ["expected", "reason", "targetRef"], "Gad publication result");
    if (typeof publication["targetRef"] !== "string" || publication["targetRef"].length === 0) {
      throw new Error("Invalid Gad publication target");
    }
    if (typeof publication["reason"] !== "string")
      throw new Error("Invalid Gad publication reason");
    if (publication["expected"] !== null) validateRepositoryRef(publication["expected"]);
  }
  if (!Array.isArray(record["mergeResults"])) throw new Error("Invalid Gad merge result list");
  for (const item of record["mergeResults"]) {
    const merge = requireRecord(item, "Gad merge result");
    if (typeof merge["inputName"] !== "string" || !Array.isArray(merge["conflicts"])) {
      throw new Error("Invalid Gad merge result");
    }
    if (
      !["clean", "conflicted", "up-to-date", "fast-forward"].includes(String(merge["status"]))
    ) {
      throw new Error("Invalid Gad merge status");
    }
    if (merge["baseCommitHash"] !== null)
      asGadDoltCommitHash(String(merge["baseCommitHash"]));
  }
}

function validateSelectedSource(value: unknown, label: string): void {
  const source = requireRecord(value, label);
  requireExactKeys(source, ["kind", "logicalName", "sqlAlias"], label);
  if (source["kind"] !== "input" && source["kind"] !== "output")
    throw new Error(`Invalid ${label} kind`);
  if (typeof source["logicalName"] !== "string" || typeof source["sqlAlias"] !== "string") {
    throw new Error(`Invalid ${label}`);
  }
}

function validateRepositoryManifest(value: unknown): void {
  const manifest = requireRecord(value, "Gad repository manifest");
  if (manifest["kind"] !== "gad.repository" || manifest["schemaVersion"] !== 1) {
    throw new Error("Invalid Gad repository manifest kind/version");
  }
  createGadRepositoryManifestTemplateV1(
    manifest as unknown as Omit<GadRepositoryManifestTemplateV1, "kind" | "schemaVersion">
  );
}

function validateWorkingManifest(value: unknown): void {
  const manifest = requireRecord(value, "Gad working manifest");
  if (manifest["kind"] !== "gad.workingSnapshot" || manifest["schemaVersion"] !== 1) {
    throw new Error("Invalid Gad working manifest kind/version");
  }
  createGadWorkingSnapshotManifestTemplateV1(
    manifest as unknown as Omit<GadWorkingSnapshotManifestTemplateV1, "kind" | "schemaVersion">
  );
}

function validateRepositoryRef(value: unknown): void {
  const ref = requireRecord(value, "Gad repository database ref");
  if (ref["kind"] !== "gad.repositoryDatabase")
    throw new Error("Invalid Gad repository ref kind");
  asGadDoltCommitHash(String(ref["commitHash"]));
  const object = requireRecord(ref["database"], "Gad repository root");
  for (const field of ["storeIdHex", "digestHex"] as const) {
    const bytes = object[field];
    if (typeof bytes !== "string" || bytes.length === 0) throw new Error("Invalid Gad repository root");
    bytesFromHex(bytes);
  }
  for (const field of ["codecNumber", "codecVersion", "hashAlgorithm"] as const) {
    if (!Number.isSafeInteger(object[field]) || Number(object[field]) < 0) {
      throw new Error("Invalid Gad repository root");
    }
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function encodeCborLength(major: number, length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0) throw new Error("Invalid CBOR byte length");
  if (length < 24) return Uint8Array.of((major << 5) | length);
  if (length <= 0xff) return Uint8Array.of((major << 5) | 24, length);
  if (length <= 0xffff) return Uint8Array.of((major << 5) | 25, length >>> 8, length & 0xff);
  if (length <= 0xffff_ffff) {
    return Uint8Array.of(
      (major << 5) | 26,
      (length >>> 24) & 0xff,
      (length >>> 16) & 0xff,
      (length >>> 8) & 0xff,
      length & 0xff
    );
  }
  throw new Error("CBOR byte string exceeds supported length");
}

function decodeCborLength(value: Uint8Array): { major: number; length: number; offset: number } {
  const initial = value[0];
  if (initial === undefined) throw new Error("Truncated CBOR value");
  const major = initial >> 5;
  const additional = initial & 31;
  if (additional < 24) return { major, length: additional, offset: 1 };
  const width = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : 0;
  if (width === 0 || value.byteLength < 1 + width) throw new Error("Invalid CBOR byte length");
  let length = 0;
  for (let index = 0; index < width; index += 1) {
    length = length * 256 + (value[1 + index] ?? 0);
  }
  return { major, length, offset: 1 + width };
}
