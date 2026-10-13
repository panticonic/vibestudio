# Userland test lanes

The userland Vitest configuration runs two disjoint projects over the same
composed template and dependency projection. Exact host/template pair ownership
is declared once in `vitest.exactPairTests.json`; `vitest.exactPairTests.ts`
derives the Vitest lanes from it, and the focused-test runner uses it to resolve
those tests from the host repository. Pair tests run first in the single-worker
native integration lane. Template-owned and ordinary workspace-integration
tests then run with four workers.

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
gate. A focused pair test names the same template composition but resolves the
test itself from the host repository:

```sh
pnpm test:userland -- --template base --filter tests/vcs-skill-release-generator.test.ts
```

The lane split changes scheduling, not coverage or source ownership.
