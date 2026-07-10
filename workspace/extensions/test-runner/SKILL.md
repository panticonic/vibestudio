---
name: workspace-test-runner
description: Run Vitest tests for workspace panels, packages, workers, or extensions through the supported @workspace-extensions/test-runner runtime extension. Use when asked to run workspace unit tests without shell commands.
---

# Workspace Test Runner

Run tests from server-side `eval` through the canonical extension name. Do not
guess from an `extensions.list()` display label; list entries use canonical
package names such as `@workspace-extensions/test-runner`.

```ts
import { extensions } from "@workspace/runtime";

const result = await extensions.invoke("@workspace-extensions/test-runner", "run", [
  {
    target: "extensions/test-runner",
    fileFilter: "index.test.ts",
  },
]);

return result;
```

`target` is a workspace repo path. `fileFilter` is relative to that target and
may select one file; `testName` optionally selects matching tests. The extension
infers the caller's current context. Its structured result contains `summary`,
`passed`, `failed`, `total`, `contextId`, `target`, `pattern`, and per-file
`details`.

Tests execute code and therefore go through the approval service. Surface a
denial as a denial; do not fall back to shell commands.
