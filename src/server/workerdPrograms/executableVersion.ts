/** Exact code and object configuration selected at authenticated host dispatch. */
/**
 * A class's own storage engine, from its manifest (`durable.classes[].storage`).
 * Fixed when an object is created: UniversalDO starts the object's cell as a Dolt
 * facet and imports a legacy SQLite facet once (docs/dolt-redesign.md §9.2).
 */
export interface DoEngineAdmission {
  readonly storage: "dolt";
  /** SQL name patterns kept out of every commit, fork and reset (framework patterns included). */
  readonly doltLocal: readonly string[];
}

export interface DoExecutableAdmission {
  readonly executableVersion: string;
  readonly incarnationVersion: string;
  /** Null is the default SQLite facet. */
  readonly engine?: DoEngineAdmission | null;
  readonly props: {
    readonly nativeOwner:
      | import("@vibestudio/shared/runtime/entitySpec").NativeOwnerAdmission
      | null;
    readonly stateArgs: Readonly<Record<string, unknown>> | null;
    readonly image: { readonly effectiveVersion: string; readonly sourceRef: string } | null;
  };
}

export const DO_EXECUTABLE_VERSION_HEADER = "X-Vibestudio-Executable-Version";
export const DO_INCARNATION_VERSION_HEADER = "X-Vibestudio-Incarnation-Version";

/** The runtime grants a hosted class's loaded unit and facet carry. */
export interface HostedCodeGrants {
  readonly codegen: boolean;
  readonly residency: boolean;
  readonly storage: "dolt" | null;
  readonly doltLocal: readonly string[];
  /** Bounded CPU time per invocation of the loaded unit, in milliseconds. */
  readonly cpuMs: number | null;
}

/**
 * What the host admits when an entity hosts a class in its own cell
 * (`hostCode`): the exact code and the grants its manifests permit. The
 * entity's identity is the hosted class's identity on outbound calls
 * (`props.host`): a hosted class acts as the entity that hosts it.
 */
export interface HostedCodeAdmission {
  readonly executableVersion: string;
  readonly grants: HostedCodeGrants;
  readonly props: DoExecutableAdmission["props"] & {
    readonly host: { readonly entityId: string; readonly token: string };
  };
}
