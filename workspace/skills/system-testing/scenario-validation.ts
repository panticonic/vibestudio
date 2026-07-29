/**
 * Public validator primitives for feature-owned system-test declarations.
 *
 * Optional outcome repositories import this surface instead of reaching into
 * core's private scenario modules.
 */
export { findLastAgentMessage } from "./tests/_helpers.js";
export {
  completedScenarioEvidence,
  requireCodeOperations,
  walkRecords,
} from "./tests/_scenario-evidence.js";
