import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import {
  speechRecordingSchema,
  type SpeechRecording,
  type SpeechEvent,
} from "@vibestudio/service-schemas/speech";
type Pending = { resolve(value?: unknown): void; reject(error: Error): void };

/** One resident model per host speech service. Calls serialize; cancelling the active
 * call retires and joins its native process before another call can own it. */
export class SpeechRuntime {
  private child: ChildProcess | null = null;
  private closed: Promise<void> = Promise.resolve();
  private ready: Promise<void> | null = null;
  private pending: Pending | null = null;
  private emit: ((event: SpeechEvent) => void) | null = null;
  private tail: Promise<void> = Promise.resolve();
  private stopped = false;
  constructor(private readonly installation: { executable: string; entryRoot: string }) {}

  private launch(): Promise<void> {
    const child = spawn(
      this.installation.executable,
      [path.join(this.installation.entryRoot, "runner.mjs")],
      {
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        windowsHide: true,
        env: {
          LANG: "C.UTF-8",
          ...(process.platform === "win32" ? { SystemRoot: process.env["SystemRoot"] } : {}),
        },
      }
    );
    this.child = child;
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    let failure: Error | null = null;
    let stderr = "";
    const fail = (error: Error) => {
      failure = error;
      readyReject(error);
      this.pending?.reject(error);
      this.pending = null;
    };
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    child.on("error", fail);
    child.stdin!.on("error", fail);
    const lines = createInterface({
      input: child.stdout!,
      crlfDelay: Infinity,
    });
    lines.on("line", (line) => {
      try {
        const event = JSON.parse(line) as
          | SpeechEvent
          | { type: "ready" }
          | { type: "error"; message: string };
        if (event.type === "ready") readyResolve();
        else if (event.type === "progress") this.emit?.(event);
        else if (event.type === "result") {
          this.emit?.(event);
          this.pending?.resolve();
          this.pending = null;
        } else if (event.type === "error") fail(new Error(event.message));
        else throw new Error("Invalid speech runtime event");
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        child.kill("SIGKILL");
      }
    });
    this.closed = new Promise<void>((resolve) =>
      child.once("close", (code, signal) => {
        lines.close();
        fail(
          failure ??
            new Error(`Speech runtime exited (${signal ?? code}).${stderr ? ` ${stderr}` : ""}`)
        );
        if (this.child === child) {
          this.child = null;
          this.ready = null;
        }
        resolve();
      })
    );
    return this.ready;
  }

  transcribe(
    recording: SpeechRecording,
    signal: AbortSignal,
    emit: (event: SpeechEvent) => void
  ): Promise<void> {
    const work = this.tail.then(async () => {
      signal.throwIfAborted();
      if (this.stopped) throw new Error("Speech service has stopped");
      speechRecordingSchema.parse(recording);
      this.emit = emit;
      const abort = () => {
        this.child?.kill("SIGKILL");
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        await (this.ready ?? this.launch());
        signal.throwIfAborted();
        const result = new Promise<void>((resolve, reject) => {
          this.pending = { resolve, reject };
        });
        this.child!.stdin!.write(`${JSON.stringify(recording)}\n`, (error) => {
          if (error) this.pending?.reject(error);
        });
        await result;
      } catch (error) {
        this.child?.kill("SIGKILL");
        await this.closed;
        signal.throwIfAborted();
        throw error;
      } finally {
        signal.removeEventListener("abort", abort);
        this.pending = null;
        this.emit = null;
      }
    });
    this.tail = work.catch(() => {});
    return work;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.child?.kill("SIGKILL");
    await this.closed;
    await this.tail;
  }
}
