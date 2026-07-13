export interface WorkerdProgramSources {
  readonly router: string;
  readonly workerHost: string;
  readonly universalDo: string;
}

export interface BuildWorkerdProgramsOptions {
  outdir?: string;
  write?: boolean;
  minify?: boolean;
  logOverride?: Record<string, string>;
}

export function buildWorkerdPrograms(
  options?: BuildWorkerdProgramsOptions
): Promise<WorkerdProgramSources>;
