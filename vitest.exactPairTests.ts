/**
 * Host tests whose subject is the exact host/template composition.
 *
 * Templates are independent repositories, so a pair test also names which
 * composed workspace it needs: one that reads `apps/mobile` only holds where
 * System is composed, and running it against Base alone asserts nothing except
 * that the directory is missing.
 */
export const exactPairTests: ReadonlyArray<{ path: string; template: string }> = [
  { path: "tests/invocation-terminal-outcome.test.ts", template: "base" },
  { path: "tests/mobile-native-asset-store.test.ts", template: "system" },
  { path: "tests/onboardingTemplate.test.ts", template: "personal" },
  { path: "tests/remote-overhaul-skill-guard.test.ts", template: "base" },
  { path: "tests/typed-service-client-guard.test.ts", template: "base" },
  { path: "tests/vcs-skill-release-generator.test.ts", template: "base" },
  { path: "tests/workspace-boundary.test.ts", template: "base" },
  { path: "tests/workspace-global-access.guard.test.ts", template: "base" },
  { path: "tests/workspacePackageGraph.test.ts", template: "base" },
  { path: "packages/typecheck/src/userland-policy.test.ts", template: "base" },
  { path: "packages/shared/src/channelEnvelopeSkillDocs.test.ts", template: "base" },
  { path: "src/server/mobileMetroNativeBoundary.test.ts", template: "system" },
  { path: "src/server/buildV2/builder.terminalWorker.test.ts", template: "system" },
  { path: "src/server/buildV2/cdpClientBuild.test.ts", template: "base" },
  { path: "src/server/buildV2/index.librarySubpath.test.ts", template: "base" },
  { path: "src/server/buildV2/scaffoldAcceptance.test.ts", template: "base" },
];

/** Workspace-integration tests that need a template other than the default. */
export const templateScopedIntegrationTests: ReadonlyArray<{ path: string; template: string }> = [
  { path: "tests/workspace-integration/mobile-appUpdatePrompt.test.ts", template: "system" },
];

/** Every pair test, whichever template it needs: the host excludes them all. */
export const exactPairTestPaths: readonly string[] = exactPairTests.map((entry) => entry.path);

export function exactPairTestsFor(template: string): string[] {
  return exactPairTests.filter((entry) => entry.template === template).map((entry) => entry.path);
}

/** Integration tests to keep out of a template that cannot supply their units. */
export function excludedIntegrationTestsFor(template: string): string[] {
  return templateScopedIntegrationTests
    .filter((entry) => entry.template !== template)
    .map((entry) => entry.path);
}
