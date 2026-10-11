import { build } from "esbuild";
import { fileURLToPath } from "node:url";

let channelRpcReadBundle: Promise<string> | undefined;

export function getChannelRpcReadBundle(): Promise<string> {
  channelRpcReadBundle ??= build({
    absWorkingDir: process.cwd(),
    entryPoints: [fileURLToPath(new URL("./channelRpcReads.ts", import.meta.url))],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
  }).then((result) => {
    const output = result.outputFiles[0];
    if (!output) throw new Error("Channel RPC read bundle produced no browser output");
    return output.text;
  });
  return channelRpcReadBundle;
}
