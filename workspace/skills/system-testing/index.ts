export { HeadlessRunner } from "./runner.js";
export { TestRunner } from "./test-runner.js";
export {
  failedSystemTestNames,
  getSystemTestRun,
  inspectSystemTestRun,
  listSystemTests,
  runSystemTests,
  systemTestDoctor,
  systemTestTrajectory,
} from "./cli.js";
export type {
  SystemTestDescriptor,
  SystemTestDoctorResult,
  SystemTestRunOptions,
  SystemTestRunProgress,
  SystemTestRunRecord,
  SystemTestRunSummary,
} from "./cli.js";
export { summarizeFailures, summarizeEntry } from "./diagnostics.js";
export type { FailureDiagnostic, FailureReport, DiagnosticLimits } from "./diagnostics.js";
export {
  BUILDABLE_PACKAGE_WORKSPACE_REPO_FIXTURE,
  CONTENT_WORKSPACE_REPO_FIXTURE,
} from "./types.js";
export type {
  TestCase,
  TestResult,
  TestSuiteResult,
  TestExecutionResult,
  TestOrchestrationContext,
  ExpectedToolFailure,
  StructuredSystemTestError,
  SystemTestFailure,
  SystemTestJsonValue,
  ToolFailureSummary,
  WorkspaceRepoFixtureSpec,
} from "./types.js";
export type { SessionSnapshot } from "@workspace/agentic-session";

// Stage report cards (runtime-safe: no value import of the .tsx renderer).
export { reportStage, ensureStageReportType, STAGE_REPORT_TYPE } from "./messages/report.js";
export type { StageReportState } from "./messages/report-types.js";

export {
  agentCapabilityTests,
  agenticRuntimeTests,
  allTests,
  buildTests,
  cdpGadDiagnosticTests,
  docsProbeTests,
  edgeCaseTests,
  filesystemTests,
  harnessResilienceTests,
  interactionSurfaceTests,
  nextSelectedStage,
  notificationTests,
  oauthTests,
  panelTests,
  projectLifecycleTests,
  rpcTests,
  selectedTestStages,
  skillTests,
  smokeTests,
  testCategories,
  testStageChoices,
  testStages,
  vcsTests,
  workerTests,
  workspaceTests,
} from "./stages.js";
export type { NextTestStage, TestStage, TestStageChoice, TestStageRunState } from "./stages.js";
