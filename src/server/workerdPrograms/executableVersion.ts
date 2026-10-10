/** Exact code and object configuration selected at authenticated host dispatch. */
export interface DoExecutableAdmission {
  readonly executableVersion: string;
  readonly incarnationVersion: string;
  readonly props: {
    readonly stateArgs: Readonly<Record<string, unknown>> | null;
    readonly image: { readonly effectiveVersion: string; readonly sourceRef: string } | null;
  };
}

export const DO_EXECUTABLE_VERSION_HEADER = "X-Vibestudio-Executable-Version";
export const DO_INCARNATION_VERSION_HEADER = "X-Vibestudio-Incarnation-Version";
