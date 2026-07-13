import type { TestCase } from "./types.js";

export { smokeTests } from "./tests/smoke.js";
export { filesystemTests } from "./tests/filesystem.js";
export { vcsTests } from "./tests/vcs.js";
export { panelTests } from "./tests/panels.js";
export { workerTests } from "./tests/workers.js";
export { buildTests } from "./tests/build.js";
export { oauthTests } from "./tests/oauth.js";
export { workspaceTests } from "./tests/workspace.js";
export { notificationTests } from "./tests/notifications.js";
export { skillTests } from "./tests/skills.js";
export { agentCapabilityTests } from "./tests/agent-capabilities.js";
export { rpcTests } from "./tests/rpc-communication.js";
export { edgeCaseTests } from "./tests/edge-cases.js";
export { agenticRuntimeTests } from "./tests/agentic-runtime.js";
export { interactionSurfaceTests } from "./tests/interaction-surfaces.js";
export { docsProbeTests } from "./tests/docs-probes.js";
export { projectLifecycleTests } from "./tests/project-lifecycle.js";
export { cdpGadDiagnosticTests } from "./tests/cdp-gad-diagnostics.js";
export { harnessResilienceTests } from "./tests/harness-resilience.js";
export { gitInteropTests } from "./tests/git-interop.js";
export { vcsAdvancedTests } from "./tests/vcs-advanced.js";
export { blobstoreTests } from "./tests/blobstore.js";
export { serverLogTests } from "./tests/server-logs.js";
export { unitDiagnosticsTests } from "./tests/unit-diagnostics.js";
export { multiUserTests } from "./tests/multi-user.js";
export { approvalPermissionTests } from "./tests/approvals-permissions.js";
export { evalLifecycleTests } from "./tests/eval-lifecycle.js";
export { docsDiscoveryTests } from "./tests/docs-discovery.js";
export { webhookTests } from "./tests/webhooks.js";
export { extensionSurfaceTests } from "./tests/extensions-surface.js";
export { harnessToolTests } from "./tests/harness-tools.js";
export { credentialTests } from "./tests/credentials.js";

import { smokeTests as _smoke } from "./tests/smoke.js";
import { filesystemTests as _fs } from "./tests/filesystem.js";
import { vcsTests as _vcs } from "./tests/vcs.js";
import { panelTests as _panels } from "./tests/panels.js";
import { workerTests as _workers } from "./tests/workers.js";
import { buildTests as _build } from "./tests/build.js";
import { oauthTests as _oauth } from "./tests/oauth.js";
import { workspaceTests as _ws } from "./tests/workspace.js";
import { notificationTests as _notif } from "./tests/notifications.js";
import { skillTests as _skills } from "./tests/skills.js";
import { agentCapabilityTests as _agent } from "./tests/agent-capabilities.js";
import { rpcTests as _rpc } from "./tests/rpc-communication.js";
import { edgeCaseTests as _edge } from "./tests/edge-cases.js";
import { agenticRuntimeTests as _agenticRuntime } from "./tests/agentic-runtime.js";
import { interactionSurfaceTests as _interaction } from "./tests/interaction-surfaces.js";
import { docsProbeTests as _docs } from "./tests/docs-probes.js";
import { projectLifecycleTests as _projectLifecycle } from "./tests/project-lifecycle.js";
import { cdpGadDiagnosticTests as _cdpGad } from "./tests/cdp-gad-diagnostics.js";
import { harnessResilienceTests as _harnessResilience } from "./tests/harness-resilience.js";
import { gitInteropTests as _gitInterop } from "./tests/git-interop.js";
import { vcsAdvancedTests as _vcsAdvanced } from "./tests/vcs-advanced.js";
import { blobstoreTests as _blobstore } from "./tests/blobstore.js";
import { serverLogTests as _serverLogs } from "./tests/server-logs.js";
import { unitDiagnosticsTests as _unitDiagnostics } from "./tests/unit-diagnostics.js";
import { multiUserTests as _multiUser } from "./tests/multi-user.js";
import { approvalPermissionTests as _approvals } from "./tests/approvals-permissions.js";
import { evalLifecycleTests as _evalLifecycle } from "./tests/eval-lifecycle.js";
import { docsDiscoveryTests as _docsDiscovery } from "./tests/docs-discovery.js";
import { webhookTests as _webhooks } from "./tests/webhooks.js";
import { extensionSurfaceTests as _extensionSurface } from "./tests/extensions-surface.js";
import { harnessToolTests as _harnessTools } from "./tests/harness-tools.js";
import { credentialTests as _credentials } from "./tests/credentials.js";
import { deterministicTestCases as _deterministic } from "./deterministic.js";

export type TestStage = {
  index: number;
  name: string;
  category: string;
  tests: TestCase[];
};

export type TestStageChoice = {
  value: string;
  label: string;
};

export type TestStageRunState = {
  selectedStageIndexes?: number[];
  completedStages?: number[];
};

export type NextTestStage = {
  stage: TestStage;
  stagePosition: number;
  selectedStages: TestStage[];
  remainingStages: number;
};

export function allTests(): TestCase[] {
  return [
    ..._smoke,
    ..._fs,
    ..._vcs,
    ..._vcsAdvanced,
    ..._gitInterop,
    ..._panels,
    ..._workers,
    ..._build,
    ..._oauth,
    ..._credentials,
    ..._ws,
    ..._unitDiagnostics,
    ..._multiUser,
    ..._approvals,
    ..._notif,
    ..._skills,
    ..._agent,
    ..._rpc,
    ..._edge,
    ..._agenticRuntime,
    ..._evalLifecycle,
    ..._blobstore,
    ..._serverLogs,
    ..._webhooks,
    ..._extensionSurface,
    ..._harnessTools,
    ..._docsDiscovery,
    ..._interaction,
    ..._projectLifecycle,
    ..._cdpGad,
    ..._harnessResilience,
    ..._docs,
    ..._deterministic(),
  ];
}

export function testCategories(tests: TestCase[] = allTests()): string[] {
  return [...new Set(tests.map((test) => test.category))];
}

export function testStages(tests: TestCase[] = allTests(), maxTestsPerStage?: number): TestStage[] {
  const stages: TestStage[] = [];
  for (const category of testCategories(tests)) {
    const categoryTests = tests.filter((test) => test.category === category);
    const stageSize = Number.isFinite(maxTestsPerStage)
      ? Math.max(1, Math.floor(maxTestsPerStage!))
      : Math.max(1, categoryTests.length);
    const chunks = Math.ceil(categoryTests.length / stageSize);
    for (let offset = 0; offset < categoryTests.length; offset += stageSize) {
      const stageNumber = Math.floor(offset / stageSize) + 1;
      stages.push({
        index: stages.length,
        name: chunks > 1 ? `${category} ${stageNumber}/${chunks}` : category,
        category,
        tests: categoryTests.slice(offset, offset + stageSize),
      });
    }
  }
  return stages;
}

export function testStageChoices(stages: TestStage[] = testStages()): TestStageChoice[] {
  return stages.map((stage) => ({
    value: String(stage.index),
    label: `${stage.name} (${stage.tests.length} tests)`,
  }));
}

export function selectedTestStages(
  tests: TestCase[] = allTests(),
  run?: TestStageRunState | null
): TestStage[] {
  const stages = testStages(tests);
  const allIndexes = stages.map((stage) => stage.index);
  const selectedIndexes = new Set(
    Array.isArray(run?.selectedStageIndexes) && run.selectedStageIndexes.length > 0
      ? run.selectedStageIndexes.filter((value) => allIndexes.includes(value))
      : allIndexes
  );
  return stages.filter((stage) => selectedIndexes.has(stage.index));
}

export function nextSelectedStage(
  tests: TestCase[] = allTests(),
  run?: TestStageRunState | null
): NextTestStage | null {
  const selectedStages = selectedTestStages(tests, run);
  const completed = new Set(Array.isArray(run?.completedStages) ? run.completedStages : []);
  const stage = selectedStages.find((item) => !completed.has(item.index));
  if (!stage) return null;
  const stagePosition = selectedStages.findIndex((item) => item.index === stage.index) + 1;
  const remainingStages = selectedStages.filter((item) => !completed.has(item.index)).length;
  return {
    stage,
    stagePosition,
    selectedStages,
    remainingStages,
  };
}
