import { launchManagedServerOwner } from "../managedServerLease.js";
const [instance, directory, root, log] = process.argv.slice(2) as [string, string, string, string];
const owner = launchManagedServerOwner(instance, directory, root, log);
process.send!({ kind: "started", ownerPid: owner.pid });
const ready = await owner.ready;
process.send!({ kind: "ready", ownerPid: owner.pid, helperPids: ready.helperPids });
// Deliberately no shutdown handler: the regression kills this client with SIGKILL.
