export type MainProcessErrorRecord = {
  timestamp: number;
  kind: "uncaughtException" | "unhandledRejection";
  message: string;
  stack?: string;
};

const records: MainProcessErrorRecord[] = [];

export function recordMainProcessError(kind: MainProcessErrorRecord["kind"], error: unknown): void {
  if (process.env["VIBESTUDIO_TEST_MODE"] !== "1") return;
  records.push({
    timestamp: Date.now(),
    kind,
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
  });
}

export function readMainProcessErrors(): MainProcessErrorRecord[] {
  return records.map((record) => ({ ...record }));
}

export function clearMainProcessErrors(): void {
  records.length = 0;
}
