// Host code and standalone CLI scripts share the same PID/birth and group contract.
export {
  captureOwnedProcessIdentity,
  observeOwnedProcess,
  observeOwnedProcessGroup,
  ownedProcessDescendsFrom,
  parseOwnedProcessIdentity,
  signalOwnedProcessIdentity,
} from "@vibestudio/shared/ownedProcessIdentity";
