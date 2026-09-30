/**
 * Encode a browser-owned capture as standard bytes for fetch/RPC streams.
 * Owns the supplied tracks: stop, cancellation, encoder failure, or a source
 * ending releases them. Clone tracks first if another consumer must retain them.
 * Slow consumers fail closed rather than growing an unbounded recording buffer.
 */
export function recordMediaStream(
  media: MediaStream,
  options: MediaRecorderOptions & { signal?: AbortSignal; maxBufferedBytes?: number } = {}
): { body: ReadableStream<Uint8Array>; contentType: string; stop(): void } {
  const { signal, maxBufferedBytes = 8 * 1024 * 1024, ...encoderOptions } = options;
  const tracks = media.getTracks();
  const releaseTracks = () => {
    for (const track of tracks) track.stop();
  };
  if (!Number.isFinite(maxBufferedBytes) || maxBufferedBytes <= 0) {
    releaseTracks();
    throw new RangeError("Media buffer size must be positive and finite");
  }
  let pendingBytes = 0;
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(media, encoderOptions);
  } catch (error) {
    releaseTracks();
    throw error;
  }
  let cancelled = false;
  let writes = Promise.resolve();
  const stop = () => {
    if (recorder.state !== "inactive") recorder.stop();
    releaseTracks();
  };
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const cleanup = () => {
          signal?.removeEventListener("abort", abort);
          for (const track of tracks) track.removeEventListener("ended", stop);
        };
        const fail = (error: unknown) => {
          if (cancelled) return;
          cancelled = true;
          controller.error(error);
          stop();
          cleanup();
        };
        const abort = () =>
          fail(signal?.reason ?? new DOMException("Capture cancelled", "AbortError"));
        recorder.addEventListener("dataavailable", (event) => {
          if (cancelled || event.data.size === 0) return;
          if (pendingBytes + event.data.size > (controller.desiredSize ?? 0)) {
            return fail(new Error("Media consumer could not keep up; capture stopped"));
          }
          pendingBytes += event.data.size;
          writes = writes
            .then(async () => {
              if (cancelled || event.data.size === 0) return;
              const bytes = new Uint8Array(await event.data.arrayBuffer());
              pendingBytes -= event.data.size;
              if (!cancelled) controller.enqueue(bytes);
            })
            .catch(fail);
        });
        recorder.addEventListener("error", () => fail(new Error("Media encoding failed")));
        recorder.addEventListener(
          "stop",
          () => {
            releaseTracks();
            cleanup();
            void writes.then(() => {
              if (!cancelled) {
                cancelled = true;
                controller.close();
              }
            });
          },
          { once: true }
        );
        signal?.addEventListener("abort", abort, { once: true });
        for (const track of tracks) track.addEventListener("ended", stop, { once: true });
        if (signal?.aborted) return abort();
        try {
          recorder.start(250);
        } catch (error) {
          fail(error);
        }
      },
      cancel() {
        cancelled = true;
        stop();
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: maxBufferedBytes })
  );
  return {
    body,
    get contentType() {
      return recorder.mimeType || "application/octet-stream";
    },
    stop,
  };
}
