import {execFile} from "node:child_process";
import {promisify} from "node:util";
import path from "node:path";
import {it} from "vitest";

// EvalDO's real loader requires a realm with code generation disabled. The
// standalone child owns that irreversible repair; it must never mutate the
// Vitest worker shared with unrelated test files.
it("loads real eval libraries under their separate shared/run-local boundaries",async()=>{
  const host=path.resolve(__dirname,"../../..");
  await promisify(execFile)(process.execPath,[
    path.join(host,"node_modules/vitest/vitest.mjs"),"run","--config",
    path.join(host,"tests/evalLibraryBoundary.config.ts"),
  ],{cwd:process.cwd(),env:process.env,maxBuffer:2*1024*1024});
},200_000);
