// The Hermes program is checked against the platform an installed client runs
// on: the standard APIs the host's native polyfills install before any client
// code runs. Client entries import this themselves; a package checked without
// its client (a renderer) gets the same platform here.
import "@vibestudio/rn-client-api/polyfills";
