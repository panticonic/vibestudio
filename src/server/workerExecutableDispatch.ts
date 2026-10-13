/** One host-selected lifetime/configuration snapshot for regular-worker dispatch. */
export interface WorkerExecutableAdmission {
  name: string;
  version: string;
  /** Retains this exact selection until its dispatch reaches a terminal event. */
  release?: () => void;
}

export const WORKER_EXECUTABLE_VERSION_HEADER = "X-Vibestudio-Worker-Version";

export function workerExecutableHeaders(
  admission: WorkerExecutableAdmission
): Record<string, string> {
  return { [WORKER_EXECUTABLE_VERSION_HEADER]: admission.version };
}
