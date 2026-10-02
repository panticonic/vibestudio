import { speechMethods, type SpeechRecording } from "@vibestudio/service-schemas/speech";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import {
  getInstalledNodeRuntime,
  getInstalledSpeechRuntime,
} from "@vibestudio/shared/runtimePaths";
import { SpeechRuntime } from "./speechRuntime.js";

/** Host-owned model resources and inference lifecycle. This service never
 * captures a microphone or persists invocation audio/transcripts. */
export function createSpeechService(deps: {
  appRoot: string;
}): ServiceDefinition & { stop(): Promise<void> } {
  let runtime: SpeechRuntime | null = null;
  let stopped = false;
  const transcribe = (ctx: ServiceContext, recording: SpeechRecording): Response => {
    if (stopped) throw new Error("Speech service has stopped");
    if (!runtime) {
      const speech = getInstalledSpeechRuntime(deps.appRoot);
      runtime = new SpeechRuntime({
        executable: getInstalledNodeRuntime(deps.appRoot).executable,
        entryRoot: speech.entryRoot,
      });
    }
    const cancellation = new AbortController();
    const caller = AbortSignal.any(
      [ctx.signal, ctx.connectionSignal].filter((signal): signal is AbortSignal => !!signal)
    );
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const abort = () => {
      cancellation.abort(caller.reason);
      controller?.error(caller.reason ?? new Error("Dictation cancelled"));
    };
    caller.addEventListener("abort", abort, { once: true });
    if (caller.aborted) abort();
    let work: Promise<void> = Promise.resolve();
    const encoder = new TextEncoder();
    const owner = runtime;
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        controller = stream;
        if (cancellation.signal.aborted) {
          stream.error(cancellation.signal.reason);
          return;
        }
        work = owner
          .transcribe(recording, cancellation.signal, (event) => {
            if (!cancellation.signal.aborted)
              stream.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          })
          .then(
            () => {
              if (!cancellation.signal.aborted) stream.close();
            },
            (error: unknown) => {
              if (!cancellation.signal.aborted) stream.error(error);
            }
          )
          .finally(() => {
            controller = null;
            caller.removeEventListener("abort", abort);
          });
      },
      async cancel(reason) {
        controller = null;
        cancellation.abort(reason);
        await work;
      },
    });
    return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
  };
  return {
    name: "speech",
    description: "Bundled offline speech recognition",
    authority: { principals: ["host", "user", "code", "website"] },
    methods: speechMethods,
    handler: defineServiceHandler("speech", speechMethods, {
      transcribe: (ctx, [recording]) => transcribe(ctx, recording),
    }),
    async stop() {
      stopped = true;
      await runtime?.stop();
      runtime = null;
    },
  };
}
