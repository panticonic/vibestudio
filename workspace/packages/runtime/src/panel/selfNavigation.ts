export interface ReopenPanelOptions {
  source?: string;
  ref?: string;
  stateArgs?: Record<string, unknown>;
}

interface SelfNavigationRpc {
  call(target: string, method: string, args: unknown[]): Promise<unknown>;
}

export function createPanelSelfNavigation(options: { rpc: SelfNavigationRpc; slotId: string }): {
  reopen(opts?: ReopenPanelOptions): Promise<{ id: string; title: string }>;
  switchContext(
    nextContextId: string,
    opts?: ReopenPanelOptions
  ): Promise<{ id: string; title: string }>;
} {
  const navigate = async (
    input: ReopenPanelOptions & { contextId?: string }
  ): Promise<{ id: string; title: string }> => {
    let source = input.source;
    if (!source) {
      const metadata = (await options.rpc.call("main", "panelTree.metadata", [options.slotId])) as {
        source?: string;
      } | null;
      source = metadata?.source;
      if (!source) throw new Error("reopen: could not resolve the current panel source");
    }
    return options.rpc.call("main", "panelTree.navigate", [
      options.slotId,
      source,
      {
        ...(input.contextId ? { contextId: input.contextId } : {}),
        ...(input.ref ? { ref: input.ref } : {}),
        ...(input.stateArgs ? { stateArgs: input.stateArgs } : {}),
      },
    ]) as Promise<{ id: string; title: string }>;
  };

  return {
    /** Reopen this panel without changing its workspace branch. */
    reopen: (input = {}) => navigate(input),
    /**
     * Explicitly move this panel to an already-created workspace branch.
     * State args are ordinary application state and cannot select a context.
     */
    switchContext(nextContextId, input = {}) {
      const next = nextContextId.trim();
      if (!next) throw new Error("switchContext: contextId must be non-empty");
      return navigate({ ...input, contextId: next });
    },
  };
}
