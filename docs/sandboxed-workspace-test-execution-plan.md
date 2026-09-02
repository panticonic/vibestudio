# Production-Runtime Workspace Test Execution

## Status

Implemented for `verify({ operation: "test" })`.

Repository-maintainer commands such as `pnpm test` remain native development
commands. This design governs workspace-authored tests invoked from the in-app
agent tool.

## Problem

The old Verify path materialized workspace source and sent every test to a
native extension running Vitest. That made ordinary panel and worker tests ask
for native-code authority, while also testing them in a runtime unlike the one
that executes the product code. An intermediate design used a private browser
realm inside Testbench; that duplicated panel hosting, omitted normal panel
injections, and produced false incompatibilities for imports handled by the
production builders.

The correct boundary is the existing executable-unit boundary:

- a panel suite executes as a panel;
- a worker suite executes as a worker;
- only deliberately native behavior executes through the native extension.

## Invariants

1. Tests execute against the requesting conversation's exact semantic state.
2. Runtime selection is manifest-reviewed source and never inferred by retry.
3. Browser suites are valid only on panels; workerd suites are valid only on
   workers. Native suites may cover packages, extensions, or other genuinely
   native contracts.
4. A test artifact is an immutable normal panel or worker build, not source or
   a bundle returned to the agent.
5. Panel tests receive the production panel bootstrap, document, RPC transport,
   authority, dependency closure, and normal `fs`/`path` shims.
6. Worker tests receive the production workerd loader, RPC transport, authority,
   dependency closure, and normal workerd Node-compatibility surface.
7. Browser hosting uses an interactive client when available and the existing
   headless client as fallback. There is no hidden renderer or test-only iframe.
8. Testbench is the visible coordinator and results UI. It does not evaluate
   target code.
9. Browser and workerd suites never fall back to native execution. Only an
   explicitly declared native suite can request native-test authority.
10. Zero discovered tests is not success, and all model-facing diagnostics are
    bounded while receipts retain exact evidence identity.

## Manifest contract

Suites are declared under `package.json#vibestudio.tests`:

```json
{
  "vibestudio": {
    "tests": [
      {
        "name": "unit",
        "runtime": "browser",
        "include": ["**/*.test.ts", "**/*.test.tsx"]
      }
    ]
  }
}
```

The supported runtimes are `browser`, `workerd`, and `native`. Files may belong
to only one suite. `verify.file` must remain inside the target and match the
selected suite. If a unit declares several suites, `verify.suite` is required.

Panel and worker suite files import the portable primitives from
`@workspace/test-runtime`. Executable units declare both their normal runtime
dependency and the test runtime as production `workspace:*` dependencies,
because the sealed artifact uses the same executable dependency projection as
the production build. Native suites may use Vitest.

## Build and execution flow

```text
verify(test)
  -> resolve manifest suite at ctx:<conversation>
  -> validate suite runtime against target kind
  -> discover the declared files
  -> generate a portable test entry
  -> build with the normal panel or worker builder
  -> seal { buildKey, executionDigest }
  -> open/focus about/testbench
  -> launch exact artifact in a fresh production runtime entity
  -> call tests.run on that entity
  -> validate and record the structured result
  -> retire disposable worker entity
```

The BuildV2 artifact response contains only its sealed identity and metadata:
target, suite, runtime, and selected files. It does not expose executable bytes.
Runtime entity specifications accept an exact artifact selector, and the host
checks that the selected build belongs to the requested source and is a test
artifact for that runtime before activation.

### Panel execution

BuildV2 generates a panel entry that registers the selected test modules,
exposes `tests.run` through the normal panel RPC transport, and renders compact
live status into the panel document. The artifact otherwise follows the normal
panel build and asset-hosting path.

Verify opens a fresh visible target panel as a child of the stable Testbench
panel. The usual panel lifecycle chooses an interactive or headless holder and
waits for readiness before the RPC call. The target panel remains visible and
inspectable after the run; Testbench retains the structured file results.

### Worker execution

BuildV2 generates a worker entry that initializes `createWorkerRuntime`,
registers the selected modules, exposes `tests.run`, and routes requests through
`handleWorkerRpc`. The artifact otherwise follows the normal worker build and
workerd module-loading path.

Verify creates a fresh worker entity from the exact artifact, invokes the test
method, and retires the entity in a `finally` path. Imports such as
`node:async_hooks` are treated exactly as they are for the worker's production
build rather than rejected by a separate test bundler.

### Native execution

The Base `test-runner` extension is now only a native adapter. It rechecks that
the exact materialized manifest declares the selected suite as native, then
spawns Vitest in a fresh permission-constrained child process with a scratch
directory and a bounded environment. Its capability is narrowly named
`native.code.execute-tests`, so ordinary Verify calls do not prompt.

## Testbench responsibilities

`about/testbench` unifies two kinds of testing UX:

- its existing Base system-suite, history, and profiling views;
- a Workspace view for the latest Verify run, including artifact, runtime
  entity, selected files, durations, and bounded errors.

The `tests.record` RPC updates presentation state only. Keeping execution out of
Testbench prevents a second browser-runtime implementation and ensures the
target's own runtime remains the source of truth.

## Static verification alignment

The workspace-internal build report and the Base repository checks consume the
same manifest graph and strict TypeScript policy. The implementation does not
relax Base's compiler settings. Build diagnostics include TypeScript and
authority errors before execution, while production-runtime artifact building
removes false errors caused by the former test-only import policy.

## Verification coverage

The change is covered at four levels:

- manifest parsing, suite selection, overlap, and target-kind validation;
- immutable artifact construction, including panel `fs`/`path` shims and
  workerd `node:async_hooks` compatibility;
- exact-artifact panel and worker entity creation, readiness, identity, and
  system-owned child-panel authorization;
- managed headless system scenarios for a visible complete panel runtime and a
  disposable complete workerd runtime, with no native-extension invocation.

Native adapter tests separately prove refusal of browser/workerd suites,
context containment, bounded subprocess permissions, cancellation, and result
normalization.
