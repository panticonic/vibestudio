# Userland test lanes

The userland Vitest configuration runs two disjoint projects over the same
composed template and dependency projection. Exact host/template pair tests from
`vitest.exactPairTests.ts` run first in the single-worker native integration
lane. Template-owned and ordinary workspace-integration tests then run with
four workers.

The pair lane contains real native build and composition work. Those operations
share compiler and CPU capacity with other tests; running them concurrently can
make an otherwise short build exceed its test-runner budget. Project ordering
serializes only that shared resource boundary. Both projects inherit the same
aliases, environment, setup, JSX transform, dependency projection, and cleanup
owner, and every test remains in exactly one lane.

Run the complete userland suite with `pnpm test:userland`. A focused template
test continues to select its natural project by path:

```sh
pnpm test:userland -- --template base --filter panels/terminal/notificationParser.test.ts
```

Exact host/template pair tests remain part of the same invocation and required
gate; the lane split changes scheduling, not coverage.
