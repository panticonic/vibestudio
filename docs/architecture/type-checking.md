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

The React Native config declares its Node, React, and React Native ambient type
sets explicitly. This makes its environment reproducible instead of depending
on TypeScript 5's incidental type-package discovery.

## Runtime compiler API

`@vibestudio/typecheck` owns native TypeScript 7 project lifetimes. A
`TypeCheckService` maintains unsaved file overlays and workspace package mounts,
then publishes immutable native snapshots for diagnostics, completion, quick
information, definitions, and semantic analysis. Module resolution remains the
compiler's responsibility; Vibestudio only projects materialized workspace and
external package roots into its filesystem view.

Compiler-API consumers receive a native `Project`, not a detached legacy
`Program`. Symbols expose project-scoped node handles, so authority analysis
resolves declarations inside the same immutable snapshot. Services are disposed
at their build, test, or analysis boundary, which also terminates the native
compiler child and prevents the host-process heap growth caused by the old
JavaScript language service.

Syntax-only repository folds use `TypeScriptSyntaxService`. It reuses one native
project during a synchronous scan and releases it on the next event-loop turn.
Simple module-export and host-boundary censuses use the existing Babel syntax
parser; they do not construct a semantic compiler project.

## Linting

Oxlint replaces ESLint and `typescript-eslint`. Type-aware operation is backed by
`oxlint-tsgolint@7.0.2001`, which matches TypeScript 7.0.2. The initial ruleset
preserves the repository's explicit unused-variable, empty-block, dynamic-delete,
and non-null-assertion policy without enabling thousands of new recommended-rule
findings as an accidental part of the compiler migration.

## Browser standard libraries

Monaco still receives standard-library declaration text as a generated bundle.
`packages/typecheck/scripts/bundle-ts-libs.ts` reads those declarations from the
platform-specific `@typescript/typescript-<platform>-<arch>` package installed by
TypeScript 7. Server-side native projects read the compiler's standard libraries
directly and do not consume the Monaco bundle.
