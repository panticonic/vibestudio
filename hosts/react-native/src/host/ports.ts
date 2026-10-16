/** Small interfaces the host runtime's pure logic is written against; adapters wire the real modules. */

/** Durable string storage owned by the host (AsyncStorage on device). */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** Every stored key that starts with `prefix`. */
  keys(prefix: string): Promise<string[]>;
}

export class BrokerError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "BrokerError";
  }
}
