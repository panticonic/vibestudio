import type { ExecutionPolicy } from "./policy.js";

// SBPL is intentionally isolated here: it is a maintained platform backend,
// not an App Sandbox entitlement or a supported Apple configuration API.
function literal(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function darwinProfile(policy: ExecutionPolicy): string {
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
    ...policy.read.map((resource) => `(allow file-read* (subpath ${literal(resource)}))`),
    ...policy.write.map(
      (resource) => `(allow file-read* file-write* (subpath ${literal(resource)}))`
    ),
    ...policy.sockets.map((resource) => `(allow network-outbound (literal ${literal(resource)}))`),
    "",
  ].join("\n");
}
