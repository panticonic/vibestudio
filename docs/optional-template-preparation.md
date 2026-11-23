# Optional-template preparation inventory

- Source selection: scripts/lib/development-template-set.mjs:7-23 exports all reviewed source pins as acquisition inputs but only three default roots as preparation inputs.
- Producer: src/server/workspaceTemplatePreparation.ts:88 and roles loops materialize/build only base/personal/system. BuildStore shared derived cache and processOwner remain canonical; extending selected roots reuses their exact build keys.
- Immutable source cache: src/server/preparedWorkspaceSourceCache.ts:25-53 restricts identity/record maps to three roots. Generalize exact-key inventory; preserve atomic publication and owned leases.
- Release publication/admission: src/server/preparedWorkspaceRelease.ts:41-95,128,219-314 restrict role names/record count and provenance validation. Generalize selected exact-root maps with all default roots still required; validate full key sets and every descriptor.
- Existing complete-release cache: src/server/preparedWorkspaceReleaseCache.ts:93-116 keys exact selected template/layer maps already; no alternative cache needed.
- Runtime template installation: src/server/preparedWorkspaceTemplate.ts uses preparedWorkspaceTemplatePath(resources,pin,purpose) and exact pins, independent of role names. No runtime ABI change required.
- Packaged/source release verifier: scripts/prebuild-release-userland.mjs:769-848 verifies only three built-ins. Iterate actual prepared roots, explicitly create optional verification workspaces with their exact template pins; never add them to ensure-user-workspaces.
- Default installation: packages/workspace/src/templateRelease.ts:64-72 and readWorkspaceCreationTemplate retain exactly three built-in defaults. Preparation selection is a separate Host build input, not a changed creation policy.
- Engines/teacher/learner: none compile workspace release templates; they consume runtime-produced calls/IR. No engine, capture, masking, model, or training schema change.

V15 uses a fresh Host successor and output root. Frozen active v14 sources/release/proofs remain untouched. Pop prebuild waits for App's one 4 GiB/reserve3 oracle retry. No paid probes.

## Use

The canonical development release command prepares every exact selected template by default:

```
NODE_ENV=development node scripts/prepare-development-workspace-release.mjs \
  --template-checkouts /path/to/complete/selection \
  --output /path/to/new/release --scratch /path/to/private/scratch
```

`--default-templates-only` limits this producer to the three built-ins. It does not alter which workspaces are created for a user. Generic producer callers can provide the exact named preparation roots in `VIBESTUDIO_PREPARE_WORKSPACE_TEMPLATES`; the built-in coordinates must agree with their ordinary defaults. Development selection transports this map automatically.

The same source cache, native build owner, BuildStore keys, release publication and verifier serve every selected root. Root admission remains bounded to three concurrent source/runtime consumers and the normal shared compiler budget. Complete inventories are validated against all selected roots, never a guessed binding count. Runtime installation remains an exact-pin lookup.

Targeted qualification: 55 producer/source-cache/release/selection tests, 35 installed-artifact verifier tests, and changed production modules' semantic TypeScript diagnostics all pass. Unit cache-retention fixtures supply deterministic free-space observations; real disk-pressure eviction remains covered separately and unchanged. Tick was below the existing 10 GiB cache-free-space floor, which explains the retained-cache fixtures' initial eviction failures. This does not establish the cause of the separately observed Personal startup cache miss or OOM.

All optional preparation uses a new immutable Host/release. The currently activated v14 release and its source/proofs are retained unchanged.

Developer-instance and product launch environment builders also transport the complete preparation map, including when an optional root is the initial target. They clear stale inherited preparation selectors, while default creation retains its three built-in pins. Additional-workspace startup therefore asks for the same exact selected preparation inventory as the producer.

Identity rejection uses the existing RPC error-data channel: `EWORKSPACE_RELEASE_INPUTS` carries `vibestudio.workspace-release-input-mismatch/1`, with each mismatching `appDependencyFingerprint`, `hostBuild`, `compilerProtocol`, `templates`, or `layers` value shown as expected/current input and actual/prepared artifact. No mismatch is waived. The human-readable message names the differing dimensions. Actual launch-environment and serialized rejection regressions pass (49 tests); changed production modules' semantic diagnostics pass as well.
