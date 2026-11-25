import path from "node:path";
import base from "../vitest.host.config.js";
export default {...base,root:path.resolve(__dirname,".."),test:{...base.test,
  include:["tests/fixtures/evalLibraryBoundary.case.ts"],exclude:[],reporters:["default"],
  maxWorkers:1,fileParallelism:false,testTimeout:180_000,
}};
