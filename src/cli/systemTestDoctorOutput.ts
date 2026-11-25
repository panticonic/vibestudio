import type { SystemTestDoctorResult } from "@vibestudio/service-schemas/systemTestRunner";
import { printResult } from "./output.js";

/** The CLI and a managed launch print the same actual doctor receipt. */
export function printSystemTestDoctorResult(value: SystemTestDoctorResult, json: boolean): void {
  printResult(value, {
    json,
    human: () => {
      for (const check of value.checks)
        console.log(`${check.ok ? "PASS" : "FAIL"}\t${check.name}\t${check.detail}`);
    },
  });
}
