# Reporting operations

The API is deployed with the existing apex Worker at
`https://vibestudio.app/v1/problem-reports`. Anonymous submissions require an
automatically generated Ed25519 machine signature, not a login, registration,
or developer bearer. The startup counter accepts a bodyless unsigned POST.
Developer reads and unrestricted SQL use the separate authenticated `/admin`
API. Secret material remains outside workspace source.

## Storage and deployment

The production `REPORT_DB` binding is D1 database `natlang-problem-reports`,
ID `d9b68f52-c075-4a51-93a9-314f0a552a8a`. `REPORT_BUNDLES` is private R2 bucket
`vibestudio-problem-report-bundles`. Both migrations are applied. The original
empty `natlang-problem-report-bundles` bucket is unused; it is not a second
reporting destination.

Run these from the host checkout, after reviewing the Worker change:

```sh
pnpm exec wrangler d1 migrations apply REPORT_DB --remote --config apps/webhook-relay/wrangler.toml
node apps/webhook-relay/build-website-assets.mjs
pnpm exec wrangler deploy --config apps/webhook-relay/wrangler.toml
```

Preserve existing relay bindings, routes, and secrets. Public submission,
receipt, mutation, and counter limits have independent namespaces. Developer
SQL has no application query, row, response-size, or request-rate cap.
Invocation logs and tracing remain disabled for anonymous counter requests.

## Developer credential

```sh
pnpm exec tsx scripts/provision-reporting-developer-key.ts
```

This initializes `vibestudio-reporting-developer` in the existing host-owned
encrypted credential store with an audience restricted to the reporting admin
path. The Worker receives only its SHA-256 digest in `REPORT_KEYS`. If the
existing credential is accepted, execution only verifies it. If the server
already has a different configured key, execution stops without replacing it.
Key rotation is deliberate: retain the keys still in use when updating the
Worker's digest list, install the corresponding credential through trusted
host input, and retire the old digest after verifying its replacement.

Create the developer workspace from the private
[`vibestudio-dev` template](https://github.com/panticonic/vibestudio-dev).
Its `meta/README.md` describes setup. Select **Connect saved key** in
`panels/error-dashboard`; normal host credential-use review controls its
injection. The workspace service stores only a credential reference. Its SQL
and agent workflow use the live canonical database rather than a mirrored store.

## Live verification

```sh
pnpm exec tsx scripts/smoke-reporting-deployment.ts
pnpm exec tsx scripts/smoke-reporting-deployment.ts --write-test-report
```

The first command verifies apex availability, denied anonymous administration,
accepted developer access, and a bodyless startup ping. The second additionally
uploads a synthetic signed bundle, checks exact bytes through authenticated
R2 retrieval, and deletes the test content in a cleanup block. No secret is
printed. Each invocation contributes a synthetic startup ping; a deleted test
report retains the normal replay-prevention tombstone until retention expires.

On 2026-09-30 the live checks returned 200 for apex, 401 for keyless admin,
200 for authenticated admin, 204 for the startup ping, 201 for signed report
acceptance, 200 for exact bundle retrieval, and 200 for deletion.

## Product release boundary

Source development instances use the current configured Base and System
checkouts. Packaged hosts use `build-resources/workspace-template-release.json`.
Before distributing a packaged host with these reporting features, publish
current Base/System through ordinary template author inspection, review, and
publication, then adopt their actual publication receipts with
`generate:workspace-template-release`. A main-branch push alone does not update
the packaged template pins. Never substitute fabricated receipts or moving
branch refs for that release boundary.
