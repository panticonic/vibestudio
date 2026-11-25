export function installedPackageGraphHashSync(
  nodeModulesRoot: string | Array<{ name: string; directory: string }>,
  localSourceNames: ReadonlySet<string>,
  options: { tree: (root: string) => string }
): string;
export function installedPackageGraphHash(
  nodeModulesRoot: string,
  localSourceNames: ReadonlySet<string>,
  options: {
    tree: (root: string) => Promise<string>;
    io: { run<T>(operation: () => Promise<T>): Promise<T> };
  }
): Promise<string>;
