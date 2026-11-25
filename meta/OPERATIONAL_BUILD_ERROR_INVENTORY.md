# Build operational failure inventory (before edits)

Actual Source35 cold terminal compilation produced fs.watch EMFILE, surfaced as ordinary build diagnostics. This investigation does not infer which OS quota was exhausted or that a failed immutable artifact was cached.

- buildV2/builder.ts2440–2583: stored artifacts are reused by exact key; in-flight promises are removed in finally. Failed compilation rejects and does not publish an artifact.
- buildV2/buildStore.ts606–786,1032+,1316+: completed metadata/artifact publication and exact verified reads. There is no failed-artifact record publication path found here.
- buildV2/index.ts1781–1835: a bundling exception sets reusable=false. 2151–2187 propagates validation reusability;3471 caches only reusable reports. Therefore the observed bundling exception alone does not establish poisoned build-result reuse.
- buildV2/index.ts1848–1980: source validation marks explicit infrastructure diagnostics non-reusable, but a BuildDiagnosticsError catch can preserve reusable=true. All results pass through UnitValidationStore.
- buildV2/unitValidationStore.ts20–61: persisted compiler diagnostics are accepted on key/schema identity alone, and writes trust compute().reusable. It needs a canonical infrastructure diagnostic exclusion on both read and write; deterministic compiler diagnostics remain reusable.
- buildV2/diagnostics.ts267–316: structured compiler diagnostics are preserved; every unstructured error is instead flattened to source esbuild/message, losing operational identity/cause. esbuild Message.detail may also carry a native operational error. This can misrepresent capacity/IO/ownership failures as authored compiler defects.
- buildV2/diagnosticsStore.ts: bounded most-recent diagnostics are display history, not a build-admission result cache. Keep failures visible until a new actual result replaces them.
- server/clients/clientRegistry.ts and server/workerdManager.ts consume exact stored builds/readiness. Their error handling and latest-state retry semantics remain under inspection; no failure-cache conclusion is asserted yet.
- packages/service-schemas/src/build.ts616+: strict shared diagnostic RPC wire schema; diagnostics.ts mirrors its type. Structured safe operational evidence must survive this boundary and exact validation persistence.
- packages/rpc/src/operationalErrorMetadata.ts: existing bounded descriptor-only allowlist for operational error identity/cause. Reuse this observation mechanism; do not read getters/toJSON or add arbitrary error data.
- All builder targets (worker/panel/client/Node/extension/test/library), explicit/state-trigger reports and typecheck folding consume the shared diagnostic projection. Installed/prepared completed artifacts remain exact immutable inputs. Model engines consume model protocols, not workspace compiler result caches (docs/ENGINE_PARITY.md9–12); no engine retry/model/transport changes apply.

No cache deletion, sysctl change, new retry, forced compile, model call or production-source mutation is authorized by this finding. Focused conventional tests will establish transient recomputation and retained deterministic error caching, not historical quota attribution.

## Implemented checkpoint

Unstructured build exceptions now produce infrastructure diagnostics with the existing bounded descriptor-safe operational metadata. Native errors inside an esbuild message detail retain their operational identity; real structured compiler messages remain compiler diagnostics. The strict diagnostic wire schema carries only the allowlisted operational fields, without messages, headers, bodies or arbitrary error data inside that metadata. Display messages remain the existing build diagnostic content.

UnitValidationStore independently refuses to retain or reuse infrastructure diagnostic records even if a compute callback mistakenly says reusable. An actual later validation request recomputes the same source coordinate and may retain a deterministic compiler result. No retry loop, timeout, cache deletion or source-identity waiver is added.

Final validation `vibe-operational-build-diagnostics-final-20261125a`: 29 component tests passed (diagnostics11,wire schema13,validationstore5), scoped lint zero warnings/errors, scoped formatting/diff checks and a real transitive TypeScript check of the new operational schema module passed,4.7seconds/955.7MiB peak. The first schema typecheck found an actual conditional-spread Zod inference issue, repaired with typed base/extension construction; no type assertion or diagnostic suppression was added. Full Host transitive typing/build/live compilation remains unchecked here.

The original two0066 terminal packets independently retain EMFILE on build-results/.storage as source esbuild with no structured code. This proves the classification loss, not cache poisoning or the historical OS quota. ClientRegistry.ensureActivated has a separate settled-application rejection lifetime concern: it joins a retained UnitHost application before its existing fresh-error-status activation path. That lifecycle issue is not silently declared solved by this checkpoint and is being investigated separately. Existing UnitHost.whenReviewed must continue preserving genuine application failures.
