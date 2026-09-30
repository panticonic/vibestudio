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

## Headless server consent

Users see one reporting choice, not separate device and server controls. App/browser and workspace/agent capture still have installation/user-scoped stores internally. A saved choice initializes an undecided connected capture store without another prompt, including after headless setup or reconnect. Only when neither has a saved choice does the two-sentence first-start prompt appear.

Settings has one shared control; subsequent unit audits show the previous choice inline. An explicit edit updates both connected stores, while cancelling an audit saves nothing. Existing mixed preferences are preserved until explicitly edited. Propagation failures retain the saved decision and offer retry rather than another consent question. Agents cannot answer the reporting choice.

## Product release boundary

Source development instances use the current configured Base and System
checkouts. Packaged hosts use `build-resources/workspace-template-release.json`.
On 2026-09-30 ordinary template inspection, review, and publication produced
Base `v0.3.59` at `00ede7f7b669422a3f71b171b75a979e16f82353` and System
`v0.3.73` at `d82d9f0b4db34ad2574163e2d4a9e08a1bd3e29c`. Their actual
publication receipts supply the packaged host pins. A main-branch push alone
does not update those pins. Never substitute fabricated receipts or moving
branch refs for that release boundary. System `v0.3.73` provides agent-led reporting, one shared settings control, a two-sentence first-use explanation, and inherited saved consent without a second prompt. Base `v0.3.59` supplies the reporting skill and persisted-draft handoff. Its publication finalized after the normal
workspace build/typecheck gate passed; the host pin was adopted from that
publication receipt.

During this release, a template update from a moved `refs/heads/main` pin failed
while reconstructing its prior exact snapshot. This is a template refresh
limitation, not a reporting intake failure. The final releases came from fresh
authoring workspaces and preserved concurrent upstream changes; rejected stale
reviews were not published and no force push was used.

The conversational reporting follow-up passed 41 focused host tests, 59 shell tests, host TypeScript, and Base plus System desktop/mobile projection typechecks. A real headless agent saved substantial narrative without submitting when asked to save only (`st_0ac7420b1a3f422897fc103d9b5d9102`), with zero failed tool calls. Submission tests verify targeted approval while automatic reporting is off, ownership/digest checks, denial, and edits or cancellation while approval is pending. Large narrative handoff preserves the full selected content and uses only a draft reference in the launch prompt.

The simplified consent follow-up passed 61 reporting/audit tests and the System desktop/mobile composition typecheck. Coverage includes reusing both on and off server choices without another dialog, retrying inherited-choice persistence without a consent question, and changing both capture locations through the single settings control. System v0.3.73 completed the canonical protected publication build/typecheck gate; the packaged pin comes from its actual receipt.
