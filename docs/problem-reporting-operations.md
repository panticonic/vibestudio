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

The private developer template was also installed through ordinary workspace
creation on 2026-09-30. Its service successfully read the live overview and
queried `sqlite_schema` through the host-held credential after normal
credential-use review. No bearer entered the workspace or evaluation code.

## Product release boundary

Source development instances use the current configured Base and System
checkouts. Packaged hosts use `build-resources/workspace-template-release.json`.
On 2026-09-30 ordinary template inspection, review, and publication produced
Base `v0.3.58` at `9343aa2e4a88da9f50af9e1072a2eee6cafec283` and System
`v0.3.68` at `740c6b00a747eb060565b825a39050feb1db46dd`. Their actual
publication receipts supply the packaged host pins. A main-branch push alone
does not update those pins. Never substitute fabricated receipts or moving
branch refs for that release boundary.

During this release, a template update from a moved `refs/heads/main` pin failed
while reconstructing its prior exact snapshot. This is a template refresh
limitation, not a reporting intake failure. The final releases came from fresh
authoring workspaces and preserved concurrent upstream changes; rejected stale
reviews were not published and no force push was used.
