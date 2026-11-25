# Production policy forward integration

Inventory before API adaptation, 2026-11-25. Integrate production
1900e9719c1b3a74cc010f1ac8bafe959b8df51d into modern origin/main
213c94ec487bfb82fa775f6fe57d2537f80e5cd8 by ordinary merge in an isolated
worktree. Canonical staged exporter work, production V28/V29 source and all
external template selections remain untouched.

- Shared lifecycle commits 011dea54e, 8bad1d413 and 15c2ef7e1 are already
  ancestors of modern main. Its RuntimeManager/Celld protocol and intentional
  deletion of builtin EvalDO stay intact; this merge does not recreate them.
- New shared DNS admission is packages/shared/src/networkDestination.ts;
  credential HTTP and WebSocket consumers use its validated destination. Only
  EAI_AGAIN resolution retries before connection are added, retaining cancellation
  and all-address public-IP checks.
- Authenticated model preparation is credentialService.prepareNativeModel; its
  resolved native invocation identity and case/owned-host route checks precede
  credential lookup. The shared service covers agent/delegated/ModelGateway
  requests; no per-engine model replacement or stream replay is introduced.
- runtimeService applyAgentModelPolicy and admitCaseContext cover native entity
  defaults/explicit child configuration and create/reserve/explicit context
  ownership. agentExecutionSessionRegistry guards case identity inheritance.
  Modern retained execution authority, context edges and service dispatch remain
  the existing mechanisms.
- hostedModelRoute parses optional owned-instance policy; ordinary profiles
  remain unchanged when unset. Development environment preserves the route.
  owned-deployment-target, remote-deploy and server package capability metadata
  preserve/refuse the same policy at installed local/remote spawn boundaries.
- Client diagnostics review admission binds observed native answers and handoff
  readback in source-claim-admission and the exporter. It does not import any old
  template bytes or regenerate goals.
- Standalone Node reviewer backend is explicitly selected outside the Host
  credential service (review-live-workflow-teacher.mjs); local inference and
  Python training engines do not consume Host hosted-model credential admission.
  Their serving protocols are unchanged.

No merge conflicts were reported. Focused modern Host component tests are the
verification boundary; this does not qualify old corpus templates against modern
Celld/Dolt or authorize release activation with mixed source pins.

Verification on the merged modern source:

- 243 Host component tests PASS, plus seven real Node review/installed-target
  tests PASS, unit vibe-modern-production-model-policy-20261125c. Peak878.4MiB,
  LOW2GiB/reserve7.5. Component setup retains canonical ownedTestWorker and
  vitestTempRoot; it omits only the unused desktop-artifact lookup. The initial
  default setup stopped before tests because this worktree has no desktop build.
- RuntimeService native-clone test inherited from main contradicted its title,
  snapshot provenance and the unchanged all-DO clone loop: it expected one copy
  and forbade the native copy. It now asserts both copies and the exact native
  source/key/requested commit. No cloning product behavior was changed.
- Scoped Prettier, TypeScript syntax lint and modified script syntax PASS
  (zero errors, 29 advisory warnings). Full transitive types, desktop build and
  model/native generation were not run or claimed.
- The merge preserves modern main as first parent and production1900 as second
  parent. It includes neither a template/corpus migration nor frozen source edits.
