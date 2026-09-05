# Navigation and Miniflare dependency upgrade — 2026-09-05

Both targeted advisories are removed. Production and full dependency audits now
report three high findings: two for `image-size` and one for `extract-zip`.
Neither audit has critical, moderate, or low findings. These counts describe
installed dependency advisories, not demonstrated application exploits.

## Navigation

The host and Base mobile app now use Navigation native 7.3.18, drawer 7.13.10,
stack 7.10.24, core 7.21.13, query-string 9.5.1, and decode-uri-component 0.5.0.
Stable Navigation 7 still declares query-string 7 and imports its API as a
namespace. Query-string 9 exports a default object. The source patch changes
only the two imports in source and published JavaScript, matching upstream's
next-major import form. No wrapper, alternate parser, or input restriction was
introduced. Core is pinned to the exact patched version.

Base's `@workspace/mobile-navigation` owns the dependency policy and exports the
APIs used by the app. Its declared patch roots ensure separately materialized
bundles receive the repair. Host pnpm carries the same patch and query override.
The mobile seed record was regenerated after changing the app imports.

Checkout validation previously excluded only the mobile app directory from its
desktop dependency install. A native library exposed that omission by pulling
in incompatible React/RN peers. Native toolchain ownership now follows direct
and peer React Native dependencies and their internal consumers. Native source
remains available for export resolution and is checked in the mobile TypeScript
program; its registry packages come from the native host toolchain.

References: [Navigation's query import](https://github.com/react-navigation/react-navigation/blob/main/packages/core/src/getStateFromPath.tsx),
[query-string's ESM migration](https://github.com/sindresorhus/query-string/releases/tag/v8.0.0).

## Miniflare

Wrangler 4.116.0 supplies Miniflare 4.20260730.0 and Sharp 0.35.2 as an upstream
matched set. Cloudflare worker types were raised to the corresponding 5.x
release. Wrangler is pinned because subsequent releases adopt Miniflare 5 alpha;
this update deliberately stays on the stable Miniflare 4 line. The repository's
existing Node minimum satisfies the new toolchain.

No forced Sharp override or application image restriction is required.
[Wrangler release](https://github.com/cloudflare/workers-sdk/releases/tag/wrangler%404.116.0).

## Verification

- 104 focused host tests passed: navigation queries, native dependency ownership,
  dependency installation/graph behavior, and webhook relay behavior.
- All 318 mobile tests passed across 48 suites.
- All three Base TypeScript configurations passed.
- Host commit checks passed, including types, lint, formatting, dependency
  ownership, and signed product seed validation.
- Wrangler's relay deployment dry run and relay typecheck passed. Nothing was deployed.
- A real Miniflare image binding resized PNG input into JPEG, WebP, and AVIF;
  decoded output dimensions matched the requested 8×6 pixels.
- The built relay returned HTTP 200 from `/healthz` in Miniflare.
- A fresh Base navigation dependency realm applied the declared patch and passed
  Unicode/repeated-query parse/serialize round trips. Its cache lease was released.

The first standalone relay probe omitted Miniflare's module root for a bundle
outside the working directory. Supplying its actual `modulesRoot` resolved the
startup failure. A native dependency install hit `ENETUNREACH`; its npm process
was stopped and the unrestricted retry passed. All probe runtimes were disposed.
No physical Android/iOS device or production Cloudflare deployment was exercised.

Base commit: `b70fc5d`. Validation ownership repair: `0de64e5b3`.
