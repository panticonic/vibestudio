import type { ChatMessage } from "@workspace/agentic-core";
import type { HeadlessSession, SessionSnapshot } from "@workspace/agentic-session";
import type { HeadlessRunner } from "./runner.js";
import type { SystemTestFailure } from "./structured-error.js";
import type { WorkspaceRepoFixtureSpec } from "./workspace-repo-fixture.js";
import type { AgentExecutionTestPolicySpec } from "@vibestudio/shared/authority/testPolicy";

export type {
  StructuredSystemTestError,
  SystemTestFailure,
  SystemTestJsonValue,
} from "./structured-error.js";
export type {
  WorkspaceRepoCreationScope,
  WorkspaceRepoFixtureSpec,
} from "./workspace-repo-fixture.js";

export const CONTENT_WORKSPACE_REPO_FIXTURE = {
  kind: "content",
  section: "projects",
} as const satisfies WorkspaceRepoFixtureSpec;

export const BUILDABLE_PACKAGE_WORKSPACE_REPO_FIXTURE = {
  kind: "buildable-package",
  section: "packages",
} as const satisfies WorkspaceRepoFixtureSpec;

export const BUILDABLE_WORKER_WORKSPACE_REPO_FIXTURE = {
  kind: "buildable-worker",
  section: "workers",
} as const satisfies WorkspaceRepoFixtureSpec;

export const BUILDABLE_REGULAR_WORKER_WORKSPACE_REPO_FIXTURE = {
  kind: "buildable-regular-worker",
  section: "workers",
} as const satisfies WorkspaceRepoFixtureSpec;

export const CREATED_PANEL_WORKSPACE_REPO_FIXTURE = {
  kind: "created-repository",
  section: "panels",
} as const satisfies WorkspaceRepoFixtureSpec;

export const CREATED_PACKAGE_WORKSPACE_REPO_FIXTURE = {
  kind: "created-repository",
  section: "packages",
} as const satisfies WorkspaceRepoFixtureSpec;

export const BUILDABLE_PANEL_WITH_DERIVED_WORKSPACE_REPO_FIXTURE = {
  kind: "buildable-panel-with-derived",
  section: "panels",
} as const satisfies WorkspaceRepoFixtureSpec;

export interface ToolFailureSummary {
  id?: string;
  name: string;
  status?: string;
  terminalOutcome?: string;
  terminalReasonCode?: string;
  error?: string;
  resultSummary?: string;
  /** True when the test explicitly exercises this failure mode. */
  expected?: boolean;
  /** Why a recorded failure is diagnostic-only rather than a failed platform effect. */
  classification?: "argument-rejection" | "domain-rejection";
  source: "message" | "snapshot";
}

export interface ExpectedToolFailure {
  name: string;
  /** Optional case-insensitive discriminator in the error/result text. */
  errorIncludes?: string;
}

export interface TestCase {
  name: string;
  description: string;
  category: string;
  /** Natural language task prompt sent to the test agent */
  prompt: string;
  /**
   * Scenario-specific prompt decisions. The runner adds only its exact model
   * credential baseline; every other promptable request must be listed here.
   */
  authorityPolicy?: Omit<AgentExecutionTestPolicySpec, "testId" | "unexpectedPrompts">;
  /** Tool errors deliberately induced by this test, not infrastructure defects. */
  expectedToolFailures?: ExpectedToolFailure[];
  /**
   * Shared mutable platform resources this case uses. Cases with an
   * overlapping resource are serialized even when the suite has spare
   * concurrency; disjoint cases still run in parallel.
   */
  resources?: string[];
  /**
   * Give tests that create/publish workspace repos one fresh semantic task
   * context and a typed repository creation scope. Depending on the selected
   * sum member, setup either seeds one exact local repository, seeds no
   * repository and expects exactly one task-created repository in a declared
   * section, or seeds a buildable panel and expects exactly one derived panel.
   * Cleanup derives identities only from the task's exact first-parent work and
   * touches protected main only when a task event is reachable from it.
   * The runner derives a repository-qualified `workspace-main-advance`
   * authority rule from this same scope; unexpected publication outside the
   * fixture remains an immediate test-policy failure.
   *
   * The runner also derives the shared `vcs:protected-main` scheduler resource
   * from this fixture. Task contexts are isolated, but publication and cleanup
   * counteraction still advance the one protected branch, so fixture cases
   * serialize while disjoint tests remain concurrent.
   * This keeps fixture mechanics out of the user-like prompt.
   */
  workspaceRepoFixture?: WorkspaceRepoFixtureSpec;
  /**
   * Optional custom orchestration for tests that need multiple independent
   * headless agents, ordered phases, or other harness-level setup that a single
   * agent should not fake from inside one context.
   */
  orchestrate?: (context: TestOrchestrationContext) => Promise<TestExecutionResult>;
  /** Validate the test execution result */
  validate: (result: TestExecutionResult) => TestResult;
}

export interface TestOrchestrationContext {
  runner: HeadlessRunner;
  /** Milliseconds left in this test's one agent-turn budget, or undefined when unbounded. */
  remainingTimeMs(): number | undefined;
  sendAndWait(session: HeadlessSession, prompt: string, phase: string): Promise<void>;
}

export interface TestExecutionResult {
  /** Stable identifiers for inspecting the spawned test trajectory after completion. */
  provenance?: {
    channelId: string | null;
    branchId: string | null;
    agentEntityId: string | null;
    agentTargetId: string | null;
    contextId: string | null;
  };
  /** Full conversation messages */
  messages: ChatMessage[];
  /** Wall-clock duration in ms */
  duration: number;
  /** Transport/session-level error (if the session itself failed) */
  error?: string;
  /** Schema-safe structured evidence for the primary failure. */
  failure?: SystemTestFailure;
  /** Cleanup errors from closing the headless session or retiring its agent */
  cleanupErrors?: string[];
  /** Schema-safe structured evidence for cleanup failures. */
  cleanupFailures?: SystemTestFailure[];
  /** Full diagnostic snapshot from the session (invocations, debug events, participants) */
  snapshot?: SessionSnapshot;
  /** Journal-derived proof of provider/model requests and completed usage. */
  modelExecutionEvidence?: unknown;
  /** Runtime/GAD diagnostics collected automatically when a test errors. */
  diagnostics?: Record<string, unknown>;
  /** Non-fatal tool-call failures observed during the turn. */
  toolFailures?: ToolFailureSummary[];
}

export interface TestResult {
  passed: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface TestSuiteResultEntry {
  test: { name: string; category: string; description: string; prompt: string };
  result: TestResult;
  execution: TestExecutionResult;
}

export interface TestSuiteResult {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  /** Total unexpected failed tool calls observed, independent from pass/fail status. */
  toolFailureCount?: number;
  /** Number of tests that observed at least one unexpected failed tool call. */
  testsWithToolFailures?: number;
  skipped: number;
  duration: number;
  results: TestSuiteResultEntry[];
}
