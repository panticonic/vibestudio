import type { FrameworkAdapter } from "./types.js";
import { reactAdapter } from "./react.js";
import { vanillaAdapter } from "./vanilla.js";
import { svelteAdapter } from "./svelte.js";

const adapters = new Map<string, FrameworkAdapter>([
  ["react", reactAdapter],
  ["vanilla", vanillaAdapter],
  ["svelte", svelteAdapter],
]);

/** Every registered framework id. The wrapper-protocol fingerprint iterates
 *  this list, so a newly registered adapter invalidates its builds by
 *  construction rather than by someone remembering a second list. */
export function adapterFrameworks(): string[] {
  return [...adapters.keys()];
}

/**
 * Get the framework adapter for the given framework ID.
 * Throws if the framework is not registered.
 */
export function getAdapter(framework: string): FrameworkAdapter {
  const adapter = adapters.get(framework);
  if (!adapter) {
    throw new Error(
      `Unknown framework adapter: "${framework}". Available: ${[...adapters.keys()].join(", ")}`
    );
  }
  return adapter;
}

export type { FrameworkAdapter } from "./types.js";
