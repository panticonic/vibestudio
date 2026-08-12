---
name: workspace-test-runner
description: Run focused Vitest tests for workspace panels, packages, workers, or extensions through the context-aware verify tool.
---

# Workspace Test Runner

Use `verify`, the first-class verification boundary. It preserves the conversation's
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
