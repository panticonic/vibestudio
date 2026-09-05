import path from "node:path";
import type { ExecutionPolicy } from "./policy.js";

// SBPL is intentionally isolated here: it is a maintained platform backend,
// not an App Sandbox entitlement or a supported Apple configuration API.
function literal(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function darwinProfile(policy: ExecutionPolicy): string {
  const ancestors = new Set<string>();
  for (const resource of [...policy.read, ...policy.write, ...policy.sockets]) {
    let parent = path.posix.dirname(resource);
    while (!ancestors.has(parent)) {
      ancestors.add(parent);
      if (parent === "/") break;
      parent = path.posix.dirname(parent);
    }
  }
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow signal (target same-sandbox))",
    "(allow process-info* (target same-sandbox))",
    '(allow sysctl-read (sysctl-name "hw.ncpu") (sysctl-name "hw.activecpu") (sysctl-name "hw.memsize") (sysctl-name "hw.pagesize") (sysctl-name "kern.osrelease") (sysctl-name "kern.osversion") (sysctl-name "kern.ostype"))',
    '(allow file-read* (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))',
    '(allow file-write-data (literal "/dev/null"))',
    ...[...ancestors].map(
      (resource) => `(allow file-read-metadata (literal ${literal(resource)}))`
    ),
    ...policy.read.map((resource) => `(allow file-read* (subpath ${literal(resource)}))`),
    ...policy.write.map(
      (resource) =>
        `(allow file-read* (subpath ${literal(resource)}))\n(allow file-write* (require-all (subpath ${literal(resource)}) (require-not (literal ${literal(resource)}))))`
    ),
    // Native commands share local IPC within their workspace's writable roots.
    // AF_UNIX creation has no pathname; bind/connect carry the resource check.
    "(allow system-socket (socket-domain AF_UNIX))",
    ...policy.write.flatMap((resource) => [
      `(allow network-bind (local unix-socket (subpath ${literal(resource)})))`,
      `(allow network-outbound (remote unix-socket (subpath ${literal(resource)})))`,
    ]),
    ...policy.sockets.map(
      (resource) => `(allow network-outbound (remote unix-socket (literal ${literal(resource)})))`
    ),
    "",
  ].join("\n");
}
