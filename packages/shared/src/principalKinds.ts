import type { CallerKind as RpcCallerKind } from "@vibestudio/rpc";

export const PRINCIPAL_KIND_REGISTRY = {
  panel: {
    callerKind: "panel",
    codeIdentity: true,
  },
  app: {
    callerKind: "app",
    codeIdentity: true,
  },
  worker: {
    callerKind: "worker",
    codeIdentity: true,
  },
  do: {
    callerKind: "do",
    codeIdentity: true,
  },
  extension: {
    callerKind: "extension",
    codeIdentity: true,
  },
  shell: {
    callerKind: "shell",
    codeIdentity: false,
  },
  server: {
    callerKind: "server",
    codeIdentity: false,
  },
  agent: {
    callerKind: "agent",
    codeIdentity: false,
  },
} as const;

export type PrincipalKind = keyof typeof PRINCIPAL_KIND_REGISTRY;

/**
 * `CallerKind` is canonically defined in `@vibestudio/rpc` (the lowest layer).
 * We re-export it here so the registry, server, and bridge share one type. The
 * registry below remains the runtime source for richer per-kind metadata
 * (currently code identity); the compile-time guard keeps the two in
 * sync — adding/removing a kind in either place fails the build.
 */
export type CallerKind = RpcCallerKind;

// Union the registry actually produces (kept internal, only for the guard).
type RegistryCallerKind = (typeof PRINCIPAL_KIND_REGISTRY)[PrincipalKind]["callerKind"];

// Parity guard: the registry must cover exactly the canonical rpc CallerKind.
type Assert<Cond extends true> = Cond;
type _registryCoversRpc = Assert<RpcCallerKind extends RegistryCallerKind ? true : never>;
type _rpcCoversRegistry = Assert<RegistryCallerKind extends RpcCallerKind ? true : never>;

export type CodeIdentityCallerKind = {
  [Kind in PrincipalKind]: (typeof PRINCIPAL_KIND_REGISTRY)[Kind]["codeIdentity"] extends true
    ? (typeof PRINCIPAL_KIND_REGISTRY)[Kind]["callerKind"]
    : never;
}[PrincipalKind];

export function isPrincipalKind(value: string | null | undefined): value is PrincipalKind {
  return Boolean(value && value in PRINCIPAL_KIND_REGISTRY);
}

export function isCallerKind(value: string | null | undefined): value is CallerKind {
  if (!value) return false;
  return Object.values(PRINCIPAL_KIND_REGISTRY).some((entry) => entry.callerKind === value);
}

export function isCodeIdentityCallerKind(
  value: string | null | undefined
): value is CodeIdentityCallerKind {
  if (!value || !isPrincipalKind(value)) return false;
  return PRINCIPAL_KIND_REGISTRY[value].codeIdentity;
}

export function callerKindForPrincipalKind(kind: string | null | undefined): CallerKind {
  if (!isPrincipalKind(kind)) {
    throw new Error(`Unknown principal kind: ${String(kind)}`);
  }
  const entry = PRINCIPAL_KIND_REGISTRY[kind];
  return entry.callerKind;
}
