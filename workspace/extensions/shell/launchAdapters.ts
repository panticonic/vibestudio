/**
 * Launch-adapter registry — the shell extension's single mechanism for
 * "recognize and optionally enrich agent launches" (plan §4.3).
 *
 * Replaces the old hardcoded `detectAgent` regex table. Each adapter matches a
 * regex against the resolved `argv.join(" ")` and may carry:
 *  - `detect`: metadata surfaced as `SessionInfo.detectedAgent` (the tagging
 *    that used to be baked into `detectAgent`);
 *  - `handler`: an extension method invoked BEFORE spawn for context-scoped
 *    sessions, which may rewrite env/argv (e.g. the claude-code extension wiring
 *    a bare `claude` into a connected linked agent).
 *
 * The registry is in-memory and per-process: extensions re-register on
 * activation (all extensions have activationEvents "*"). Built-in detect-only
 * adapters are seeded at shell activation so tagging works with zero
 * registrants.
 */

import type { LaunchAdapter } from "./types.js";

/** The built-in detect-only adapters (former `detectAgent` table, §4.3). */
export const BUILTIN_LAUNCH_ADAPTERS: readonly LaunchAdapter[] = [
  { id: "builtin:claude-code", match: { pattern: "\\bclaude(-code)?\\b" }, detect: { kind: "claude-code", title: "Claude Code" } },
  { id: "builtin:codex", match: { pattern: "\\bcodex\\b" }, detect: { kind: "codex", title: "Codex" } },
  { id: "builtin:aider", match: { pattern: "\\baider\\b" }, detect: { kind: "aider", title: "Aider" } },
  { id: "builtin:opencode", match: { pattern: "\\bopencode\\b" }, detect: { kind: "opencode", title: "OpenCode" } },
  { id: "builtin:test-runner", match: { pattern: "\\b(vitest|jest|pnpm test)\\b" }, detect: { kind: "test-runner", title: "Tests" } },
  { id: "builtin:dev-server", match: { pattern: "\\b(vite|next dev|tsx watch)\\b" }, detect: { kind: "dev-server", title: "Dev server" } },
];

interface CompiledAdapter {
  adapter: LaunchAdapter;
  regex: RegExp;
}

export class LaunchAdapterRegistry {
  /** Insertion-ordered by id; first match wins. */
  private readonly adapters = new Map<string, CompiledAdapter>();

  constructor(seed: readonly LaunchAdapter[] = BUILTIN_LAUNCH_ADAPTERS) {
    for (const adapter of seed) this.register(adapter);
  }

  /**
   * Register (or replace) an adapter by id. Re-registration is idempotent-by-id
   * so a re-activating extension refreshes its own entry without duplicating.
   * A malformed regex throws so the registrant sees the failure immediately.
   */
  register(adapter: LaunchAdapter): void {
    const regex = new RegExp(adapter.match.pattern);
    this.adapters.set(adapter.id, { adapter, regex });
  }

  unregister(id: string): void {
    this.adapters.delete(id);
  }

  private firstMatch(argv: string[]): CompiledAdapter | undefined {
    const joined = argv.join(" ");
    // Newest-first: a later registration (e.g. the claude-code extension's
    // handler adapter) takes precedence over an earlier one (the built-in
    // detect-only seed), so extensions can fully own an agent's launch — both
    // its detection AND its enrichment — by matching the same command line.
    const entries = [...this.adapters.values()].reverse();
    for (const entry of entries) {
      if (entry.regex.test(joined)) return entry;
    }
    return undefined;
  }

  /** Detection metadata for the first matching adapter, or undefined. */
  detect(argv: string[]): { kind: string; title?: string } | undefined {
    const match = this.firstMatch(argv);
    return match?.adapter.detect ? { ...match.adapter.detect } : undefined;
  }

  /** The handler of the first matching adapter (if any), for context launches. */
  matchHandler(argv: string[]): { extension: string; method: string } | undefined {
    const match = this.firstMatch(argv);
    return match?.adapter.handler ? { ...match.adapter.handler } : undefined;
  }
}
