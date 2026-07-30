<script lang="ts">
  // The neutral runtime, surfaced as idiomatic Svelte stores. No React, no Radix.
  import { theme, panelId, contextId, stateArgs } from "@workspace/svelte";

  // Svelte 5 runes: local reactive state and a value derived from it.
  let count = $state(0);
  let doubled = $derived(count * 2);
</script>

<!--
  `$theme`, `$panelId`, `$contextId`, `$stateArgs` are auto-subscribed store
  reads. `$theme` is reactive, so the `dark` class (and the styles below) update
  live when the host switches appearance.
-->
<main class="panel" class:dark={$theme === "dark"}>
  <header>
    <h1>Hello, Svelte 5 👋</h1>
    <p class="subtitle">
      A Vibestudio panel rendered with the neutral <code>@workspace/runtime</code>
      under Svelte — bundled by the <code>esbuild-svelte</code> framework adapter.
    </p>
  </header>

  <section class="card">
    <h2>Reactive counter (<code>$state</code> / <code>$derived</code>)</h2>
    <div class="counter">
      <button class="btn" onclick={() => (count -= 1)} aria-label="decrement">−</button>
      <span class="count">{count}</span>
      <button class="btn" onclick={() => (count += 1)} aria-label="increment">+</button>
    </div>
    <p class="muted">Doubled: {doubled}</p>
    <button class="btn ghost" onclick={() => (count = 0)} disabled={count === 0}>
      Reset
    </button>
  </section>

  <section class="card">
    <h2>Runtime stores</h2>
    <dl>
      <dt>Theme</dt>
      <dd>{$theme}</dd>
      <dt>Panel ID</dt>
      <dd><code>{$panelId}</code></dd>
      <dt>Context ID</dt>
      <dd><code>{$contextId}</code></dd>
      <dt>State args</dt>
      <dd><code>{JSON.stringify($stateArgs)}</code></dd>
    </dl>
  </section>
</main>

<style>
  .panel {
    /* Light theme palette (default). */
    --bg: #ffffff;
    --fg: #1a1a1a;
    --muted: #5f6571;
    --card-bg: #f6f7f9;
    --border: #e2e4e8;
    --accent: var(--accent-9, #6d28d9);
    --accent-fg: var(--accent-contrast, #ffffff);
    --code-bg: rgba(0, 0, 0, 0.06);

    box-sizing: border-box;
    min-height: 100vh;
    margin: 0;
    padding: 24px;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    background: var(--bg);
    color: var(--fg);
    line-height: 1.5;
  }

  .panel.dark {
    /* Dark theme palette — driven reactively by the `$theme` store. */
    --bg: #14161a;
    --fg: #e8eaed;
    --muted: #9aa0a6;
    --card-bg: #1e2127;
    --border: #2c2f36;
    --accent: var(--accent-9, #a874ff);
    --accent-fg: var(--accent-contrast, #14161a);
    --code-bg: rgba(255, 255, 255, 0.1);
  }

  h1 {
    font-size: 1.6rem;
    margin: 0 0 4px;
  }

  .subtitle {
    color: var(--muted);
    margin: 0 0 24px;
    max-width: 52ch;
  }

  .card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px 20px;
    margin-bottom: 16px;
  }

  .card h2 {
    font-size: 1rem;
    margin: 0 0 12px;
  }

  .counter {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .count {
    font-size: 2rem;
    font-variant-numeric: tabular-nums;
    min-width: 3ch;
    text-align: center;
  }

  .btn {
    font: inherit;
    cursor: pointer;
    border: none;
    border-radius: 8px;
    padding: 8px 16px;
    background: var(--accent);
    color: var(--accent-fg);
    transition: opacity 0.15s ease;
  }

  .btn:hover {
    opacity: 0.85;
  }

  .btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .btn.ghost {
    background: transparent;
    color: var(--accent);
    border: 1px solid var(--accent);
    margin-top: 12px;
  }

  .muted {
    color: var(--muted);
    margin: 12px 0 0;
  }

  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 6px 16px;
    margin: 0;
  }

  dt {
    color: var(--muted);
  }

  dd {
    margin: 0;
    word-break: break-all;
  }

  code {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 0.9em;
    background: var(--code-bg);
    padding: 1px 5px;
    border-radius: 5px;
  }
</style>
