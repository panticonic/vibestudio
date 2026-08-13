export const runtimeFoundationEvidence = Object.freeze({
  tests: Object.freeze({
    "execution.durable-object-push-rebuild": {
      path: "src/server/dynamicWorkerHost.test.ts",
    },
    "execution.electron-app": {
      path: "src/server/appHost.test.ts",
    },
    "execution.ensure-durable-object": {
      path: "src/server/universalDoHost.test.ts",
    },
    "execution.panel": {
      path: "src/main/panelOrchestrator.test.ts",
    },
    "execution.eval-do": {
      path: "src/server/services/evalService.test.ts",
    },
    "execution.extension": {
      path: "packages/extension-host/src/service.test.ts",
    },
    "execution.react-native-app": {
      path: "src/server/appHost.test.ts",
    },
    "execution.runtime-create-entity": {
      path: "src/server/services/runtimeService.test.ts",
    },
    "execution.terminal-app": {
      path: "src/server/terminalAppRunner.test.ts",
    },
    "execution.vcs-store": {
      path: "packages/builtin/src/workspace-state/WorkspaceDO.test.ts",
    },
    "execution.worker-push-rebuild": {
      path: "src/server/workerdManager.test.ts",
    },
    "execution.workerd-start-worker": {
      path: "src/server/workerdManager.test.ts",
    },
  }),
  sourceContracts: Object.freeze({}),
});
