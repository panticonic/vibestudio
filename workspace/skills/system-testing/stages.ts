import type { TestCase } from "./types.js";
import { assertSystemTestDeclaration } from "./prompt-contract.js";
import { deterministicTestCases } from "./deterministic.js";
import { smokeTests } from "./tests/smoke.js";
import { filesystemTests } from "./tests/filesystem.js";
import { vcsTests } from "./tests/vcs.js";
import { panelTests } from "./tests/panels.js";
import { workerTests } from "./tests/workers.js";
import { buildTests } from "./tests/build.js";
import { oauthTests } from "./tests/oauth.js";
import { workspaceTests } from "./tests/workspace.js";
import { notificationTests } from "./tests/notifications.js";
import { skillTests } from "./tests/skills.js";
import { agentCapabilityTests } from "./tests/agent-capabilities.js";
import { rpcTests } from "./tests/rpc-communication.js";
import { edgeCaseTests } from "./tests/edge-cases.js";
import { agenticRuntimeTests } from "./tests/agentic-runtime.js";
import { interactionSurfaceTests } from "./tests/interaction-surfaces.js";
import { docsProbeTests } from "./tests/docs-probes.js";
import { projectLifecycleTests } from "./tests/project-lifecycle.js";
import { scaffoldMatrixTests } from "./tests/scaffold-matrix.js";
import { developerErgonomicsTests } from "./tests/developer-ergonomics.js";
import { cdpGadDiagnosticTests } from "./tests/cdp-gad-diagnostics.js";
import { harnessResilienceTests } from "./tests/harness-resilience.js";
import { gitInteropTests } from "./tests/git-interop.js";
import { templateTests } from "./tests/templates.js";
import { vcsAdvancedTests } from "./tests/vcs-advanced.js";
import { blobstoreTests } from "./tests/blobstore.js";
import { serverLogTests } from "./tests/server-logs.js";
import { unitDiagnosticsTests } from "./tests/unit-diagnostics.js";
import { multiUserTests } from "./tests/multi-user.js";
import { approvalPermissionTests } from "./tests/approvals-permissions.js";
import { evalLifecycleTests } from "./tests/eval-lifecycle.js";
import { selfDevelopmentTests } from "./tests/self-development.js";
import { docsDiscoveryTests } from "./tests/docs-discovery.js";
import { webhookTests } from "./tests/webhooks.js";
import { extensionSurfaceTests } from "./tests/extensions-surface.js";
import { trustedUnitAuthoringTests } from "./tests/trusted-unit-authoring.js";
import { localModelTests } from "./tests/local-models.js";
import { harnessToolTests } from "./tests/harness-tools.js";
import { credentialTests } from "./tests/credentials.js";
import { agentOrchestrationTests } from "./tests/agent-orchestration.js";
import { mobileTests } from "./tests/mobile.js";
import { deliveryHardeningTests } from "./tests/delivery-hardening.js";
import { intentDiscoveryTests } from "./tests/intent-discovery.js";

export {
  agentCapabilityTests,
  agenticRuntimeTests,
  agentOrchestrationTests,
  approvalPermissionTests,
  blobstoreTests,
  buildTests,
  cdpGadDiagnosticTests,
  credentialTests,
  deliveryHardeningTests,
  developerErgonomicsTests,
  docsDiscoveryTests,
  docsProbeTests,
  edgeCaseTests,
  evalLifecycleTests,
  extensionSurfaceTests,
  filesystemTests,
  gitInteropTests,
  harnessResilienceTests,
  harnessToolTests,
  intentDiscoveryTests,
  interactionSurfaceTests,
  localModelTests,
  mobileTests,
  multiUserTests,
  notificationTests,
  oauthTests,
  panelTests,
  projectLifecycleTests,
  rpcTests,
  scaffoldMatrixTests,
  selfDevelopmentTests,
  serverLogTests,
  skillTests,
  smokeTests,
  templateTests,
  trustedUnitAuthoringTests,
  unitDiagnosticsTests,
  vcsAdvancedTests,
  vcsTests,
  webhookTests,
  workerTests,
  workspaceTests,
};

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
  const tests = [
    ...smokeTests,
    ...filesystemTests,
    ...vcsTests,
    ...vcsAdvancedTests,
    ...gitInteropTests,
    ...templateTests,
    ...panelTests,
    ...workerTests,
    ...buildTests,
    ...oauthTests,
    ...credentialTests,
    ...workspaceTests,
    ...unitDiagnosticsTests,
    ...multiUserTests,
    ...approvalPermissionTests,
    ...notificationTests,
    ...skillTests,
    ...agentCapabilityTests,
    ...rpcTests,
    ...edgeCaseTests,
    ...agenticRuntimeTests,
    ...agentOrchestrationTests,
    ...evalLifecycleTests,
    ...selfDevelopmentTests,
    ...blobstoreTests,
    ...serverLogTests,
    ...webhookTests,
    ...extensionSurfaceTests,
    ...trustedUnitAuthoringTests,
    ...localModelTests,
    ...harnessToolTests,
    ...mobileTests,
    ...deliveryHardeningTests,
    ...intentDiscoveryTests,
    ...docsDiscoveryTests,
    ...interactionSurfaceTests,
    ...projectLifecycleTests,
    ...scaffoldMatrixTests,
    ...developerErgonomicsTests,
    ...cdpGadDiagnosticTests,
    ...harnessResilienceTests,
    ...docsProbeTests,
    ...deterministicTestCases(),
  ];
  for (const test of tests) assertSystemTestDeclaration(test);
  return tests;
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
