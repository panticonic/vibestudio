# Type-checking architecture

Vibestudio has one TypeScript generation: stable TypeScript 7. The root host,
workerd entry programs, workspace packages, React Native app, package builds,
editor service, build diagnostics, and authority analyzers all resolve the same
exact `typescript@7.0.2` dependency.

## Command-line checks

- `pnpm type-check:host` checks the complete host graph and the separate
  workerd-entry graph with TypeScript 7's native `tsc`.
- `pnpm type-check:watch` uses the native compiler's watch mode.
- `pnpm type-check` adds the userland and React Native graphs.
- Package scripts invoke the normal `typescript/bin/tsc` entry point. There is
  no compiler alias or fallback generation.

Nested userland units are not pnpm workspace projects. The root lockfile owns
the host, platform packages, application targets, and the single `workspace`
checkout-tooling project; it does not lock panels, workers, extensions, skills,
or userland libraries. Their `package.json` manifests belong to semantic
workspace state and are resolved by the build system.

Checkout-wide userland checks intentionally inspect many semantic units in one
compiler process. `scripts/type-check-userland.ts` therefore asks the build
dependency resolver for one content-addressed aggregate external-dependency
projection, combines it with the host/tooling packages in a disposable source
view, and runs the existing tsconfigs unchanged. Vitest configs use the same
projection for userland imports. This is repository validation plumbing, not a
second userland lock: exact runtime builds still resolve only the target unit's
transitive semantic dependency closure.

`pnpm check:userland-package-manager-boundary` rejects nested `workspace/...`
patterns and lockfile importers. A userland dependency or patch must be handled
by semantic manifests and the in-app dependency system; adding it to the host
root merely to make a panel compile is a boundary violation.

The React Native config declares its Node, React, and React Native ambient type
sets explicitly. Node-shaped types are intentional: Metro maps the exact
`path`, `fs`, and `crypto` imports reachable through shared packages to mobile
shims. They describe that compatibility surface; they do not imply a Node
runtime. Metro's native-module boundary remains the runtime enforcement point.

## Runtime compiler API

`@vibestudio/typecheck` owns native TypeScript 7 project lifetimes. A
`TypeCheckService` maintains unsaved file overlays and workspace package mounts,
then publishes immutable native snapshots for diagnostics, completion, quick
information, definitions, and semantic analysis. Module resolution remains the
compiler's responsibility; Vibestudio only projects materialized workspace and
external package roots into its filesystem view.

The package name `typescript/unstable/*` belongs to TypeScript 7's new native
API. It means Microsoft has not frozen that API contract; it does not refer to
the legacy JavaScript compiler. Vibestudio pins one exact compiler version and
keeps native project construction in `@vibestudio/typecheck`, so an API change
is detected by package builds and contract tests rather than leaking across a
version range.

Compiler-API consumers receive a native `Project`, not a detached legacy
`Program`. Symbols expose project-scoped node handles, so authority analysis
resolves declarations inside the same immutable snapshot. Services are disposed
at their build, test, or analysis boundary, which also terminates the native
compiler child and prevents the host-process heap growth caused by the old
JavaScript language service.

The workspace typecheck extension keeps recently used projects warm in a
bounded LRU. Repeated diagnostics, hover, completion, definition, and reference
queries therefore reuse incremental snapshots, while eviction synchronously
closes the native compiler child. Native request timings are included in
authority-analysis phase logs; `TypeCheckService` also exposes opt-in CPU and
heap profiles for focused diagnostics.

Syntax-only repository folds use `TypeScriptSyntaxService`. It reuses one native
project during a synchronous scan and releases it on the next event-loop turn.
Simple module-export and host-boundary censuses use the existing Babel syntax
parser; they do not construct a semantic compiler project.

## Linting

Oxlint replaces ESLint and `typescript-eslint`. Type-aware operation is backed by
`oxlint-tsgolint@7.0.2001`, which matches TypeScript 7.0.2. Correctness rules are
enabled as errors. High-volume semantic rules that require existing repository
cleanup remain visible as warnings in production source and are disabled only
where test-double patterns make them inapplicable. Unused variables and empty
blocks remain hard failures; dynamic deletion and non-null assertions remain
warnings.

## Browser standard libraries

Monaco still receives standard-library declaration text as a generated bundle.
`packages/typecheck/scripts/bundle-ts-libs.ts` reads those declarations from the
platform-specific `@typescript/typescript-<platform>-<arch>` package installed by
TypeScript 7. Server-side native projects read the compiler's standard libraries
directly and do not consume the Monaco bundle.
