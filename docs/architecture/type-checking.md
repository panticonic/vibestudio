# Type-checking architecture

The host repository uses TypeScript 7's native compiler for command-line type
checking. The complete host graph remains one authoritative TypeScript program:
all production and test files under `src/` and `packages/` are checked together
according to the root `tsconfig.json`.

## Why two TypeScript packages are installed

The root keeps both compiler generations during the TypeScript 7 ecosystem
transition:

- `typescript` is TypeScript 5.9. It remains available to ESLint and tools that
  consume the JavaScript compiler API. The current `typescript-eslint` release
  declares support for TypeScript versions below 6.
- `typescript-native` is an npm alias for stable `typescript@7.0.2`. Type-check
  scripts invoke its native `tsc` executable directly.

The alias avoids replacing the compiler API underneath ESLint while still using
the native compiler for the performance-sensitive validation path. Remove the
TypeScript 5.9 installation once all compiler-API consumers declare TypeScript 7
support; at that point the alias can become the normal `typescript` dependency.

## Commands

- `pnpm type-check:host` checks the complete host graph and the separate workerd
  entry program graph with the native compiler.
- `pnpm type-check:watch` watches the complete host graph with the native
  compiler.
- `pnpm type-check` additionally runs userland with the native compiler and the
  mobile check with TypeScript 5.9.

The root and workerd configs use explicit relative path targets. TypeScript 7
removed `baseUrl`, and explicit paths make the resolution base unambiguous to
both compiler generations.

## Remaining TypeScript 5 consumers

Production build and authority analysis still use the TypeScript 5 compiler API.
The native TypeScript 7 API cannot yet replace the required surface: the
typecheck service depends on language-service definitions and quick info,
custom compiler hosts, module resolution, and virtual `createProgram` flows that
the stable native package does not expose. Recreating those operations or
keeping parallel analyzers would be a feature-loss compatibility layer, so the
runtime stays on its one existing compiler implementation until the native API
offers the complete contract.

The React Native project also remains on TypeScript 5. Its deliberately
DOM-free, Node-free ambient environment does not currently resolve equivalently
under TypeScript 7; adding host libraries would weaken the boundary that the
mobile project is intended to verify.

Do not split the host into overlapping compiler programs merely to reduce the
JavaScript compiler's heap use. Source path aliases cause each program to reload
and recheck much of the same transitive graph, increasing total validation time.
If the native compiler regresses, compare diagnostics against TypeScript 5.9 and
investigate the concrete compiler or type-level hotspot before changing project
coverage.
