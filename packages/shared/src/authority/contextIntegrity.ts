import type { ContextIntegrityFact } from "@vibestudio/rpc";

export type ContentClass = "internal" | "external";
export type LineageKey = string & { readonly __lineageKey: unique symbol };

export interface LineageEntry {
  key: LineageKey;
  class: ContentClass;
  firstSeen: string;
  via: string;
  count: number;
}

export interface ContextIntegrityLatchState {
  class: ContentClass;
  latchEpoch: number;
  sources: readonly LineageEntry[];
}

const CONTENT_ADDRESSED = /^(repo:.+@[^@]+|pkg:[^:]+:.+@[^#]+#[^#]+|blob:[0-9a-f]{64}|file:[^/]+\/[^@]+@.+)$/;
const LINEAGE_PATTERNS = [
  /^web:[a-z0-9.-]+$/,
  /^api:[^:]+(?::[^:]+)?$/,
  /^mail:[^:]+:.+$/,
  /^repo:[^/]+\/.+\/.+@[^@]+$/,
  /^pkg:[^:]+:.+@[^#]+#[^#]+$/,
  /^blob:[0-9a-f]{64}$/,
  /^file:[^/]+\/[^@]+@.+$/,
  /^msg:[^/]+\/.+$/,
  /^log:.+$/,
  /^session:.+$/,
] as const;

export function parseLineageKey(value: string): LineageKey {
  if (!value || value !== value.trim() || value.includes("\0") || !LINEAGE_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new Error(`Invalid lineage key: ${JSON.stringify(value)}`);
  }
  return value as LineageKey;
}

export function isContentAddressedLineageKey(value: string): boolean {
  return CONTENT_ADDRESSED.test(value);
}

export class ContextIntegrityLatch {
  static readonly MAX_DISTINCT_KEYS = 256;
  #state: ContextIntegrityLatchState;

  constructor(initial?: ContextIntegrityLatchState) {
    this.#state = initial ? parseLatchState(initial) : { class: "internal", latchEpoch: 0, sources: [] };
  }

  ingest(input: { key: string; class: ContentClass; via: string; at?: Date }): ContextIntegrityLatchState {
    const key = parseLineageKey(input.key);
    if (!input.via.trim()) throw new Error("Lineage ingestion requires a chokepoint id");
    const sources = this.#state.sources.map((entry) => ({ ...entry }));
    const existing = sources.find((entry) => entry.key === key);
    if (existing) {
      existing.count += 1;
      if (input.class === "external") existing.class = "external";
      this.#state = {
        ...this.#state,
        class: this.#state.class === "external" || input.class === "external" ? "external" : "internal",
        sources,
      };
      return this.snapshot();
    }

    if (sources.length >= ContextIntegrityLatch.MAX_DISTINCT_KEYS) {
      const internalIndex = sources.findIndex((entry) => entry.class === "internal");
      if (internalIndex >= 0) sources.splice(internalIndex, 1);
      else throw new Error("Context lineage contains 256 outside sources; further ingestion is refused");
    }
    sources.push({
      key,
      class: input.class,
      firstSeen: (input.at ?? new Date()).toISOString(),
      via: input.via,
      count: 1,
    });
    this.#state = {
      class: this.#state.class === "external" || input.class === "external" ? "external" : "internal",
      latchEpoch: this.#state.latchEpoch + 1,
      sources,
    };
    return this.snapshot();
  }

  snapshot(): ContextIntegrityLatchState {
    return {
      class: this.#state.class,
      latchEpoch: this.#state.latchEpoch,
      sources: this.#state.sources.map((entry) => ({ ...entry })),
    };
  }

  fact(): ContextIntegrityFact {
    return {
      class: this.#state.class,
      latchEpoch: this.#state.latchEpoch,
      externalKeys: this.#state.sources
        .filter((entry) => entry.class === "external")
        .map((entry) => entry.key),
    };
  }
}

export function joinContextIntegrity(
  left: ContextIntegrityFact | null,
  right: ContextIntegrityFact | null
): ContextIntegrityFact | null {
  if (!left) return right ? copyFact(right) : null;
  if (!right) return copyFact(left);
  if (left.class === "not-applicable") return copyFact(right);
  if (right.class === "not-applicable") return copyFact(left);
  return {
    class: left.class === "external" || right.class === "external" ? "external" : "internal",
    latchEpoch: Math.max(left.latchEpoch, right.latchEpoch),
    externalKeys: [...new Set([...left.externalKeys, ...right.externalKeys])],
  };
}

function copyFact(fact: ContextIntegrityFact): ContextIntegrityFact {
  return { ...fact, externalKeys: [...fact.externalKeys] };
}

function parseLatchState(value: ContextIntegrityLatchState): ContextIntegrityLatchState {
  if (!Number.isSafeInteger(value.latchEpoch) || value.latchEpoch < 0) {
    throw new Error("Context latch epoch must be a non-negative integer");
  }
  if (value.sources.length > ContextIntegrityLatch.MAX_DISTINCT_KEYS) {
    throw new Error("Context latch contains too many lineage keys");
  }
  const keys = new Set<string>();
  const sources = value.sources.map((entry) => {
    const key = parseLineageKey(entry.key);
    if (keys.has(key)) throw new Error(`Duplicate context lineage key ${key}`);
    keys.add(key);
    if (!Number.isSafeInteger(entry.count) || entry.count < 1 || !entry.via.trim()) {
      throw new Error(`Invalid context lineage entry ${key}`);
    }
    return { ...entry, key };
  });
  const derivedClass = sources.some((entry) => entry.class === "external") ? "external" : "internal";
  if (value.class !== derivedClass) throw new Error("Context latch class disagrees with its lineage entries");
  return { class: value.class, latchEpoch: value.latchEpoch, sources };
}
