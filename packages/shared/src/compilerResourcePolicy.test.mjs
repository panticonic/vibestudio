import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import {
  configureNativeCompilerMemory,
  configuredCompilerConcurrency,
} from "./compilerResourcePolicy.mjs";

test("the native compiler child receives its own collector policy", () => {
  const environment = { ...process.env };
  delete environment.GOMEMLIMIT;
  configureNativeCompilerMemory(environment);
  assert.equal(
    execFileSync(process.execPath, ["-e", "process.stdout.write(process.env.GOMEMLIMIT)"], {
      env: environment,
      encoding: "utf8",
    }),
    "2GiB"
  );
  assert.equal(environment.PATH, process.env.PATH);
});

test("an explicit native compiler policy, including off, is preserved", () => {
  for (const value of ["off", "512MiB", "6GiB", ""]) {
    const environment = { GOMEMLIMIT: value };
    configureNativeCompilerMemory(environment);
    assert.equal(environment.GOMEMLIMIT, value);
  }
});

test("every launcher shares the declared positive integer build budget", () => {
  assert.equal(configuredCompilerConcurrency(undefined), undefined);
  assert.equal(configuredCompilerConcurrency(""), undefined);
  assert.equal(configuredCompilerConcurrency(" 2 "), 2);
  for (const value of ["0", "-1", "3junk", "1.5", "9007199254740992"])
    assert.throws(() => configuredCompilerConcurrency(value), /positive safe integer/);
});
