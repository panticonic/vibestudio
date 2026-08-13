import path from "node:path";
import { requireDevelopmentBaseCheckout } from "../src/dev/developmentBaseConfig.js";

export const exactUserlandRoot = path.resolve(requireDevelopmentBaseCheckout(process.cwd()));
