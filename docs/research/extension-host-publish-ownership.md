# Owned extension-host publication output

Pre-edit mechanism inventory, Source34de90272. One writer creates
packages/extension-host/dist-publish: extension-host/build.mjs under
VIBESTUDIO_EXTHOST_PUBLISH=1. One caller sets that mode:
build-server-npm-package.mjs buildSelfContainedExtensionHost. stageServer /
vendorExtensionHost copy it into the public package; no other runtime export
consumes it (extension-host package.json exports dist/ only). Infrastructure
cache and source-policy scanners ignore historical dist-publish; their normal
build path is dist/, not the public publisher. No template, inference engine or
model transport owns this directory.

Host build localSourceTreeHash and effectiveVersion.localPackageTreeHash both
hash editable package trees without inheriting the monorepo ignore scope. The
main input inventory omits ignored dist-publish, so its count stays2850 while
both dependency identities change. Do not weaken these conservative guards.
Actual production failure: publishing added four8.7MiB files, host identity
4e928 became be166 and app dependency a851 became784cb6. All server/main bytes
were unchanged. Same24.22 Node reproduced be166, ruling out the Node24.21
hypothesis. After exact hashes proved both staged vendor and installed consumer
retained all four files and the synchronous writer/copy had joined, retiring
only that owned output restored both original identities exactly. Original
runtime/release pins were unchanged; canonical readiness restoration followed.

Repair the writer: the package operation owns external scratch via ownedEntry,
passes an explicit absolute publish directory to the same extension build, and
stages only that output. Publish output inside the checkout is refused. Compiler
children use Ownership.spawn and join; scratch survives until copying completes
and is retired after owned work joins on success, failure, cancellation or owner
loss. Existing VIBESTUDIO_KEEP_SCRATCH provides the explicit diagnostic opt-out.
The ordinary dist build and all fingerprint/dependency guards stay unchanged.

Verification: vibe-extension-publish-ownership-final-20261125b passed all 12
focused Node tests, formatting, scoped lint, syntax and diff checks (236.1MiB
peak; LOW2GiB/reserve5.5GiB). Controls exercise both actual fingerprint
consumers, the actual self-contained compiler, original child failure,
cancellation with process join, and automatic SIGKILL retirement with a live
compiler. The public package's separate npm pack failure remains open; these
checks do not claim an installed-package or full-release qualification.
