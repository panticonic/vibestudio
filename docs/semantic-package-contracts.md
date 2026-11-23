# Semantic workspace package contract audit

A compiled worker does not exercise imports inside generated utility source. The semantic outcome helper therefore needs a public package export even when its producer worker builds. `scripts/audit-semantic-package-contracts.mjs` checks both static module imports and literal imports in emitted source against the shared production export resolver. Static imports need an actual runtime dependency edge; emitted programs own their own dependencies.

The reviewed source inventory spans eight templates, 270 packages, 3,218 source files and 2,686 workspace edges, including 246 emitted imports. It reports zero missing installed runtime contracts after exporting the semantic outcome helper. The real `@workspace-skills/system-testing` root builds as a worker library; its semantic outcome subpath builds and executes for worker and panel consumers.

## Context classifications

An initial worker/browser-only scan flagged 31 references. These do not call for exposing test APIs to production:

| References | Actual context and source evidence |
| --- | --- |
| 26 imports in the 13 suites listed below | Standalone evaluation companions. Base `packages/natlang/src/programs.ts:39–42,87` explicitly excludes `suite.ts` from loaded programs. Base `packages/natlang/package.json:17–21` declares their evaluation/model exports under the `types` condition. These retain their evaluation data and are not imports from the 116 application entry executions. |
| Base `packages/agentic-chat/hooks/__tests__/transcriptTestHarness.ts:7` | Vitest helper. Its callers are `childTranscript.store.test.ts:8` and `chatSession.store.test.ts:23` in the same `__tests__` directory. |
| Base `packages/agentic-do/src/testing/native-vessel.ts:1` | Explicit test-support export (`packages/agentic-do/package.json:37`); current callers are worker/package `.test.ts` files and generated project tests. It imports the Node-only fixture surface. |
| Base `packages/testkit/src/native-channel-provider.ts:1` | `packages/testkit/package.json:23–27` exposes this helper only to `types` and `node`, with `default: null`. |
| Base `packages/runtime/src/worker/index.ts:140` | A comment instructing Vitest-only imports; it explicitly says the helper must not be bundled into production workers. This is not an executable module import. |
| Base `panels/natlang/src/vendor.d.ts:7` | Ambient dashboard declarations. Base `packages/natlang/package.json:14–15` provides the exact `types` export. |

Evaluation companion locations:

- `base/skills/messaging/alert/suite.ts:1,2`
- `base/skills/problem-reporting/natlang/suite.ts:1,2`
- `base/skills/sandbox/claims/suite.ts:1,2`
- `base/skills/sandbox/help/suite.ts:4,8`
- `base/skills/sandbox/natlang/suite.ts:1,2`
- `base/skills/templates/suite.ts:1,2`
- `base/skills/vibestudio-vcs/changes/suite.ts:1,5`
- `base/skills/visualize/suite.ts:1,2`
- `base/skills/web-research/research/suite.ts:1,5`
- `base/skills/workspace-dev/natlang/suite.ts:3,4`
- `personal/skills/github/natlang/suite.ts:1,2`
- `personal/skills/memory/recall/suite.ts:1,5`
- `system-testing/skills/system-testing/triage/suite.ts:1,5`

The additional generated project reference in SST `skills/system-testing/atomic-panel-store-fixture.ts:66` targets a worker created by that same fixture (`projectType`/`name` at lines 82–83, contract export at line 96, source file alongside it). It is reported as an authored project dependency rather than an absent installed package.

The executable audit preserves these contexts in its report. It still rejects runtime consumers of private Node-only helpers, absent source manifests, absent exported helpers, missing export targets and missing static runtime ownership. Three focused audit tests cover those boundaries.
