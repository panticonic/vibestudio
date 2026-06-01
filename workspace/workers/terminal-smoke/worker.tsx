import React from "react";
import { Box, Text, render } from "ink";
import { createInkTerminalSession } from "@workspace/terminal-shim";

/**
 * Minimal Ink-in-workerd smoke worker (M0 verification + example). On fetch it
 * renders a live Ink counter to in-memory shim streams and returns the richest
 * frame, proving: yoga loads via the embedder wasm module, Ink renders, and the
 * terminal-shim streams carry output. No host/RPC needed.
 */
export class TerminalSmokeWorker {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(_ctx: any, _env: any) {}

  async fetch(_req: Request): Promise<Response> {
    try {
      const frames: string[] = [];
      const decoder = new TextDecoder();
      const session = createInkTerminalSession({
        sessionId: "smoke",
        sink: { write: (_stream, bytes) => frames.push(decoder.decode(bytes)) },
        initialSize: { columns: 60, rows: 12 },
      });

      let setN: ((n: number) => void) | null = null;
      function App(): React.ReactElement {
        const [n, _setN] = React.useState(0);
        setN = _setN;
        return (
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Text color="green">terminal-shim smoke</Text>
            <Text>counter = {n}</Text>
            <Text color="cyan">{"#".repeat(n)}</Text>
          </Box>
        );
      }

      // Ink's RenderOptions type the streams as full Node TTY streams; our
      // duck-typed shims satisfy what Ink actually uses at runtime (proven), so
      // cast through unknown.
      const inst = render(<App />, {
        stdin: session.stdin as unknown as NodeJS.ReadStream,
        stdout: session.stdout as unknown as NodeJS.WriteStream,
        stderr: session.stderr as unknown as NodeJS.WriteStream,
        patchConsole: false,
        exitOnCtrlC: false,
      });
      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
      for (let i = 1; i <= 3; i++) {
        // setN is assigned inside the App closure, which TS can't see for
        // narrowing — cast back to the declared union.
        (setN as ((n: number) => void) | null)?.(i);
        await sleep(20);
      }
      await sleep(20);
      inst.unmount();
      session.dispose();

      const richest = frames.reduce((a, b) => (b.length > a.length ? b : a), "");
      const stripped = richest.replace(/\[[0-9;?]*[A-Za-z]/g, "");
      return new Response(
        JSON.stringify({ ok: true, frameCount: frames.length, frame: stripped }, null, 2),
        { headers: { "content-type": "application/json" } },
      );
    } catch (e) {
      return new Response(
        JSON.stringify({ ok: false, error: String((e as Error)?.stack ?? e) }, null, 2),
        { status: 500 },
      );
    }
  }
}
