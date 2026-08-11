---
name: workspace-test-runner
description: Run Vitest tests for workspace panels, packages, workers, or extensions through the first-class verify tool. Use when asked to run workspace unit tests without shell commands.
---

# Workspace Test Runner

Use the first-class verification boundary. It preserves the conversation's
exact semantic context, execution authority, cancellation, progress, and
bounded structured results:

```ts
verify({
  operation: "test",
  target: "extensions/test-runner",
  file: "index.test.ts",
});
```

`target` is a workspace repository path. `file` is relative to that target and
may select one file; `testName` optionally selects matching tests. The returned
details include a bounded report with `summary`, `passed`, `failed`, `total`,
`contextId`, `target`, `pattern`, and per-file results. A failing test run or
zero discovered tests is an explicit tool error with the report preserved for
diagnosis.

Tests execute code and therefore go through the approval service. Surface a
denial as a denial. Do not bypass `verify` with a shell command, generic `eval`,
or a direct extension invocation.
