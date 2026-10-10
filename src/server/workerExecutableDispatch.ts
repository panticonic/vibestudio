/** One host-selected lifetime/configuration snapshot for regular-worker dispatch. */
export interface WorkerExecutableAdmission {
  name: string;
  version: string;
}

export const WORKER_EXECUTABLE_VERSION_HEADER = "X-Vibestudio-Worker-Version";

export function workerExecutableHeaders(
  admission: WorkerExecutableAdmission
): Record<string, string> {
  return { [WORKER_EXECUTABLE_VERSION_HEADER]: admission.version };
}
