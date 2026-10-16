/**
 * System-template directories whose tests are Jest suites over React Native
 * mocks. `jest.config.cjs` runs exactly these; the userland Vitest projection
 * excludes exactly these. One list, so a new React Native client cannot fall
 * into the wrong runner.
 */
module.exports = {
  REACT_NATIVE_JEST_SUITE_ROOTS: [
    "clients/mobile-browser",
    "clients/chat-mobile",
    "packages/client-kit-native",
  ],
};
