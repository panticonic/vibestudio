/**
 * The one definition of a complete typed-receiver authority declaration.
 *
 * A Durable Object that dispatches through a wire schema (`static rpcMethods`)
 * takes that method's policy from the schema, not from its `@rpc` decorator, so
 * the schema entry must declare all of it. The runtime (`@vibestudio/durable`)
 * and the build (workspace RPC catalog) both ask this module, so a declaration
 * the build admits is exactly one the object can serve.
 */
import type { ResolvedRpcAuthority } from "@vibestudio/rpc";
import { allOf, anyOf, bindMethodCapability, capability } from "./authorization.js";
import type { MethodSchema } from "./typedServiceClient.js";

export type ReceiverAuthorityInput = Pick<
  MethodSchema,
  "authority" | "tier" | "access" | "directEffect" | "capability"
>;

export type ReceiverAuthorityField =
  | "authority"
  | "tier"
  | "access.sensitivity"
  | "directEffect or capability"
  | "capability (requirement-form authority binds a method capability)"
  | "capability (binds the code-source relationship of a code principal)";

export type ReceiverAuthorityValidation =
  | { ok: true }
  | { ok: false; missing: readonly ReceiverAuthorityField[] };

/**
 * Which required fields a receiver wire method does not declare. `codeSourceBound`
 * is true when the receiver binds this method's `code` principal to a provider
 * source (a runtime fact the build cannot know; it passes false).
 */
export function validateReceiverAuthority(
  method: ReceiverAuthorityInput,
  options: { codeSourceBound?: boolean } = {}
): ReceiverAuthorityValidation {
  const missing: ReceiverAuthorityField[] = [];
  const { authority } = method;
  if (!authority) missing.push("authority");
  if (!method.tier) missing.push("tier");
  if (!method.access?.sensitivity) missing.push("access.sensitivity");
  if (!method.directEffect && !method.capability) missing.push("directEffect or capability");
  if (authority && !method.capability) {
    if (!("principals" in authority)) {
      missing.push("capability (requirement-form authority binds a method capability)");
    } else if (options.codeSourceBound && authority.principals.includes("code")) {
      missing.push("capability (binds the code-source relationship of a code principal)");
    }
  }
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

/** The effect a complete declaration resolves to: explicit, else the receiver's host capability. */
export function receiverDirectEffect(
  method: Pick<MethodSchema, "directEffect" | "capability">
): NonNullable<MethodSchema["directEffect"]> {
  if (method.directEffect) return method.directEffect;
  if (!method.capability) throw new Error("receiver method declares neither directEffect nor capability");
  return {
    kind: "host-capability",
    capability: method.capability,
    resource: { kind: "receiver-object" },
  };
}

export interface IncompleteReceiverAuthority {
  /** `Class.method` */
  label: string;
  missing: readonly ReceiverAuthorityField[];
}

/** The one diagnostic for the runtime and the build; lists every offending method together. */
export function describeIncompleteReceiverAuthority(
  incomplete: readonly IncompleteReceiverAuthority[]
): string {
  const lines = incomplete.map(({ label, missing }) => `  ${label}: missing ${missing.join(", ")}`);
  return (
    `Incomplete typed receiver authority declaration:\n${lines.join("\n")}\n` +
    "A method listed in a schema table (static rpcMethods) takes its policy from that table, not from @rpc. " +
    "Fix: derive the contract with createReceiverRpcMethods<Pick<Receiver, ...>>([...]) and drop the schema table " +
    "so policy comes from @rpc, or declare authority, tier, access.sensitivity and directEffect/capability in each table entry."
  );
}

export interface ReceiverSchemaMethod {
  name: string;
  wireMethod: MethodSchema;
  /** The provider source this method's `code` principal is bound to, when the receiver binds one. */
  codeSource: string | null;
}

/**
 * Admit a receiver's schema-table policies together: one error listing every
 * incomplete method. Both Durable Object base classes call this before serving.
 */
export function assertReceiverAuthorityComplete(
  className: string,
  methods: Iterable<ReceiverSchemaMethod>
): void {
  const incomplete: IncompleteReceiverAuthority[] = [];
  for (const { name, wireMethod, codeSource } of methods) {
    const validation = validateReceiverAuthority(wireMethod, { codeSourceBound: !!codeSource });
    if (!validation.ok) incomplete.push({ label: `${className}.${name}`, missing: validation.missing });
  }
  if (incomplete.length > 0) throw new Error(describeIncompleteReceiverAuthority(incomplete));
}

/** Resolve a complete schema-table declaration to the authority the receiver enforces. */
export function resolveReceiverAuthority(
  className: string,
  method: string,
  wireMethod: MethodSchema,
  codeSource: string | null
): ResolvedRpcAuthority {
  assertReceiverAuthorityComplete(className, [{ name: method, wireMethod, codeSource }]);
  // The validation above guarantees these are present.
  const authority = wireMethod.authority!;
  const tier = wireMethod.tier!;
  const sensitivity = wireMethod.access!.sensitivity!;
  const methodCapability = wireMethod.capability;
  const common = {
    website: wireMethod.website,
    effect: receiverDirectEffect(wireMethod),
    tier: tier.tier,
    sensitivity,
    ...(tier.session === "codeOnly" ? { codeOnly: true } : {}),
    ...(wireMethod.crossWorkspace === true ? { crossWorkspace: true } : {}),
  };
  if (!("principals" in authority)) {
    if (authority.additional?.length || authority.prepared) {
      throw new Error(`${className}.${method} uses host-service-only prepared authority`);
    }
    return { requires: bindMethodCapability(authority.requirement, methodCapability!), ...common };
  }
  if (!codeSource || !authority.principals.includes("code")) {
    return { principals: authority.principals, ...common };
  }
  const unconstrained = authority.principals.filter((principal) => principal !== "code");
  return {
    requires: anyOf(
      ...unconstrained.map((principal) => capability(principal, methodCapability!)),
      allOf(capability("code", methodCapability!), {
        kind: "relationship",
        name: "code-source",
        value: codeSource,
      })
    ),
    ...common,
  };
}
