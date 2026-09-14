/**
 * Whether this server was started to run system tests.
 *
 * Unattended test policies pre-approve gated capabilities without asking a
 * person, and harness-only seams like fault injection exist to be driven by a
 * test. Both are safe exactly when a developer started this server to run
 * tests, and unsafe otherwise — so the question is about the process, not
 * about which unit is calling.
 *
 * It was previously asked per call, as "is this caller's build on a reviewed
 * allowlist, content-hashed against the first-run snapshot" — an indirect and
 * expensive way to ask whether the server is a test server, and one that put a
 * trust relationship across the userland boundary to get an answer the process
 * already had. Workspace code cannot forge this because it is not a claim
 * anyone makes: it is read once, from the environment this process started in.
 */
export const SYSTEM_TEST_INSTANCE_ENV = "VIBESTUDIO_SYSTEM_TEST_INSTANCE";

export function readSystemTestInstanceMode(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment[SYSTEM_TEST_INSTANCE_ENV] === "1";
}
