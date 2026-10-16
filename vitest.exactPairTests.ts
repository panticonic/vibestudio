import testOwnership from "./vitest.exactPairTests.json";

type TestOwnership = { path: string; template: string };

/**
 * Host tests whose subject is the exact host/template composition.
 *
 * Templates are independent repositories, so a pair test also names which
 * composed workspace it needs: one that reads `clients/mobile-browser` only holds where
 * System is composed, and running it against Base alone asserts nothing except
 * that the directory is missing.
 */
export const exactPairTests: ReadonlyArray<TestOwnership> = testOwnership.exactPairTests;

/** Workspace-integration tests that need a template other than the default. */
export const templateScopedIntegrationTests: ReadonlyArray<TestOwnership> =
  testOwnership.templateScopedIntegrationTests;

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
