/** Narrow host call surface onto the workspace's gad-store Durable Object. */
export interface VcsGadCaller {
  call<T = unknown>(
    method: string,
    input: unknown,
    opts?: { invocationToken?: string }
  ): Promise<T>;
}
