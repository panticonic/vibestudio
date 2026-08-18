import { register } from "tsx/esm/api";

register();
await import("./sqliteIntegrityWorker.ts");
