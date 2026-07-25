import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const netMock = vi.hoisted(() => ({
  nextPort: 41000,
  createServer: vi.fn(() => {
    let allocatedPort = 0;
    const server = {
      unref: vi.fn(),
      on: vi.fn((_event: string, _callback: (error: Error) => void) => server),
      listen: vi.fn((_port: number, _host: string, callback: () => void) => {
        allocatedPort = netMock.nextPort;
        netMock.nextPort += 1;
        callback();
        return server;
      }),
      address: vi.fn(() => ({ address: "127.0.0.1", family: "IPv4", port: allocatedPort })),
      close: vi.fn((callback?: (error?: Error) => void) => {
        callback?.();
        return server;
      }),
    };
    return server;
  }),
}));

vi.mock("node:net", () => ({
  createServer: netMock.createServer,
}));

import {
  createServerSupervisor,
  type SupervisorAdminTransport,
  type SupervisorDeps,
} from "./supervisor.js";
import {
  FALLBACK_MODEL,
  ROOT_LAYOUT,
  type EngineState,
  type ModelRecord,
  type ServerKind,
} from "./types.js";

interface SpawnCall {
  bin: string;
  args: string[];
  opts: Parameters<SupervisorDeps["spawn"]>[2];
  pid: number;
  killed: string[];
  stdout(line: string): void;
  stderr(line: string): void;
  exit(code: number | null): void;
}

class ManualTimers {
  now = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  readonly setTimeout: typeof setTimeout = ((
    callback: Parameters<typeof setTimeout>[0],
    timeout?: Parameters<typeof setTimeout>[1],
    ..._args: unknown[]
  ) => {
    const id = this.nextId;
    this.nextId += 1;
    const runnable =
      typeof callback === "function"
        ? () => {
            callback();
          }
        : () => {
            throw new Error("string timers are not supported in tests");
          };
    this.timers.set(id, { at: this.now + (timeout ?? 0), callback: runnable });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  readonly clearTimeout: typeof clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    this.timers.delete(handle as unknown as number);
  }) as typeof clearTimeout;

  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    while (true) {
      const next = Array.from(this.timers.entries())
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.now = timer.at;
      timer.callback();
      await flushAsync();
    }
    this.now = target;
    await flushAsync();
  }
}

interface Harness {
  rootDir: string;
  timers: ManualTimers;
  deps: SupervisorDeps;
  spawns: SpawnCall[];
  events: Array<Parameters<SupervisorDeps["emit"]>[0]>;
  models: Map<string, ModelRecord>;
  supervisor: ReturnType<typeof createServerSupervisor>;
}

const roots: string[] = [];
const adminEndpoints = new Map<
  number,
  {
    apiKey: string;
    handler: Parameters<SupervisorAdminTransport["listen"]>[2];
  }
>();

const adminTransport: SupervisorAdminTransport = {
  async listen(port, apiKey, handler) {
    if (adminEndpoints.has(port))
      throw Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" });
    const endpoint = { apiKey, handler };
    adminEndpoints.set(port, endpoint);
    return {
      close: () => {
        if (adminEndpoints.get(port) === endpoint) adminEndpoints.delete(port);
      },
    };
  },
  async request(port, apiKey, command) {
    const endpoint = adminEndpoints.get(port);
    if (!endpoint) throw new Error("admin endpoint is unavailable");
    if (endpoint.apiKey !== apiKey) throw new Error("unauthorized");
    return endpoint.handler(command);
  },
};

beforeEach(() => {
  roots.length = 0;
  adminEndpoints.clear();
  netMock.nextPort = 41000;
  netMock.createServer.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("createServerSupervisor", () => {
  it("acquires the owner lock for the first supervisor and attaches the second", async () => {
    const rootDir = tempRoot();
    const owner = makeHarness({ rootDir, workspaceId: "owner-ws" });
    await owner.supervisor.activate();

    expect(owner.supervisor.role()).toBe("owner");
    expect(owner.supervisor.ownerInfo()).toMatchObject({ workspaceId: "owner-ws" });
    // Lazy floor (design §5): activation acquires the lock but leaves the
    // utility server cold — it warms only on the first fallback demand.
    expect(owner.spawns.filter((spawn) => serverKind(spawn) === "utility")).toHaveLength(0);
    await owner.supervisor.ensureLoaded(FALLBACK_MODEL.slug);
    expect(owner.spawns.filter((spawn) => serverKind(spawn) === "utility")).toHaveLength(1);

    const attached = makeHarness({ rootDir, workspaceId: "attached-ws" });
    await attached.supervisor.activate();

    expect(attached.supervisor.role()).toBe("attached");
    expect(attached.supervisor.ownerInfo()).toMatchObject({ workspaceId: "owner-ws" });
    expect(attached.spawns).toHaveLength(0);
  });

  it("reallocates the admin endpoint when its persisted candidate is occupied", async () => {
    adminEndpoints.set(41002, {
      apiKey: "other-owner",
      handler: async () => ({ ok: true }),
    });
    const harness = makeHarness();

    await harness.supervisor.activate();

    expect(readConfig(harness.rootDir).adminPort).toBe(41003);
    expect(harness.supervisor.ownerInfo()?.adminPort).toBe(41003);
  });

  it("forwards attached fallback loads while the owner's utility server is cold", async () => {
    const rootDir = tempRoot();
    const owner = makeHarness({ rootDir, workspaceId: "owner-ws" });
    await owner.supervisor.activate();

    const attached = makeHarness({ rootDir, workspaceId: "attached-ws" });
    await attached.supervisor.activate();

    await expect(attached.supervisor.ensureLoaded(FALLBACK_MODEL.slug)).resolves.toEqual(
      expect.objectContaining({ baseUrl: expect.stringContaining("/v1") })
    );
    expect(attached.spawns).toHaveLength(0);
    expect(owner.spawns.filter((spawn) => serverKind(spawn) === "utility")).toHaveLength(1);
  });

  it("forwards attached main-model loads while the owner's main server is cold", async () => {
    const rootDir = tempRoot();
    const owner = makeHarness({ rootDir, workspaceId: "owner-ws" });
    owner.models.set("toy", modelRecord("toy"));
    await owner.supervisor.activate();

    const attached = makeHarness({ rootDir, workspaceId: "attached-ws" });
    attached.models.set("toy", modelRecord("toy"));
    await attached.supervisor.activate();

    await expect(attached.supervisor.ensureLoaded("toy")).resolves.toEqual(
      expect.objectContaining({ baseUrl: expect.stringContaining("/v1") })
    );
    expect(attached.spawns).toHaveLength(0);
    expect(owner.spawns.filter((spawn) => serverKind(spawn) === "main")).toHaveLength(1);
  });

  it("returns an attached fallback URL when the owner utility server is warm", async () => {
    const rootDir = tempRoot();
    const owner = makeHarness({ rootDir, workspaceId: "owner-ws" });
    await owner.supervisor.activate();
    const ownerLoaded = await owner.supervisor.ensureLoaded(FALLBACK_MODEL.slug);
    const utilityPid = lastSpawn(owner, "utility").pid;
    vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
      if (signal === 0 && (pid === process.pid || pid === utilityPid)) return true;
      if (signal === 0) throw Object.assign(new Error("dead"), { code: "ESRCH" });
      return true;
    });

    const attached = makeHarness({ rootDir, workspaceId: "attached-ws" });
    await attached.supervisor.activate();

    await expect(attached.supervisor.ensureLoaded(FALLBACK_MODEL.slug)).resolves.toEqual(
      ownerLoaded
    );
    expect(attached.spawns).toHaveLength(0);
  });

  it("takes over a stale lock when the owner pid is dead", async () => {
    const rootDir = tempRoot();
    writeFileSync(
      join(rootDir, ROOT_LAYOUT.ownerLock),
      JSON.stringify({ pid: 42424242, bootId: "old" })
    );
    writeFileSync(
      join(rootDir, ROOT_LAYOUT.ownerInfo),
      JSON.stringify({
        pid: 42424242,
        bootId: "old",
        ports: { utility: 32111, main: 32112 },
        workspaceId: "old-ws",
        since: 1,
      })
    );
    writeFileSync(join(rootDir, ROOT_LAYOUT.authKey), "stale-key", { mode: 0o600 });
    vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
      if (pid === 42424242 && signal === 0) {
        throw Object.assign(new Error("dead"), { code: "ESRCH" });
      }
      return true;
    });

    const harness = makeHarness({
      rootDir,
      workspaceId: "new-ws",
      fetch: async () => {
        throw new Error("connection refused");
      },
    });
    await harness.supervisor.activate();

    expect(harness.supervisor.role()).toBe("owner");
    expect(harness.supervisor.ownerInfo()).toMatchObject({ workspaceId: "new-ws" });
    expect(readJson(join(rootDir, ROOT_LAYOUT.ownerInfo))).toMatchObject({ workspaceId: "new-ws" });
    // Lazy floor (design §5): takeover claims ownership without warming utility.
    expect(harness.spawns.filter((spawn) => serverKind(spawn) === "utility")).toHaveLength(0);
  });

  it("creates a 0600 api-key file and never passes the key in spawn args", async () => {
    const harness = makeHarness();
    await harness.supervisor.activate();
    await harness.supervisor.ensureLoaded(FALLBACK_MODEL.slug); // warm utility to inspect its args

    const keyPath = join(harness.rootDir, ROOT_LAYOUT.authKey);
    const key = readFileSync(keyPath, "utf8");
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);

    const allArgs = harness.spawns.flatMap((spawn) => spawn.args);
    expect(allArgs).not.toContain(key);
    expect(allArgs).not.toContain("--api-key");
    expect(allArgs).toContain("--api-key-file");
    expect(allArgs).toContain(keyPath);
    const utilityArgs = lastSpawn(harness, "utility").args;
    expect(utilityArgs[utilityArgs.indexOf("-c") + 1]).toBe(
      String(modelRecord(FALLBACK_MODEL.slug).trainedContextLength)
    );
    expect(utilityArgs).not.toContain("--chat-template-file");
    expect(utilityArgs).not.toContain("--temp");
    expect(utilityArgs).not.toContain("--top-k");
    expect(utilityArgs).not.toContain("--repeat-penalty");
    expect(lastSpawn(harness, "utility").bin).toBe("/engines/gpu/llama-server");
  });

  it("uses the fastest validated utility engine and degrades to CPU after a failure", async () => {
    const harness = makeHarness();
    await harness.supervisor.activate();
    await harness.supervisor.ensureLoaded(FALLBACK_MODEL.slug);

    expect(lastSpawn(harness, "utility").bin).toBe("/engines/gpu/llama-server");

    lastSpawn(harness, "utility").exit(1);
    await harness.timers.advance(backoffFor(1, "utility"));

    expect(lastSpawn(harness, "utility").bin).toBe("/engines/cpu/llama-server");
    expect(harness.supervisor.tailLog("utility")).toContainEqual(
      expect.stringContaining("accelerated utility server failed; degrading to CPU")
    );
  });

  it("rejects a tools-capable model when its template drops assistant tool-call history", async () => {
    const harness = makeHarness({
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/props")) {
          return Response.json({
            chat_template_caps: {
              supports_tools: true,
              supports_tool_calls: true,
              supports_object_arguments: true,
            },
          });
        }
        if (url.includes("/apply-template")) {
          return Response.json({ prompt: "assistant call was silently omitted" });
        }
        if (url.includes("/v1/chat/completions")) return runtimeProbeResponse();
        return new Response("ok", { status: 200 });
      }),
    });

    await expect(harness.supervisor.validateModel(FALLBACK_MODEL.slug)).rejects.toThrow(
      /drops assistant tool calls/
    );
  });

  it("does not run compatibility probes from the normal model invocation path", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/props")) {
        return Response.json({
          chat_template_caps: {
            supports_tools: true,
            supports_tool_calls: true,
            supports_object_arguments: true,
          },
        });
      }
      if (url.includes("/apply-template")) {
        return Response.json({ prompt: "vibestudio-assistant-call-sentinel" });
      }
      if (url.includes("/v1/chat/completions")) return runtimeProbeResponse();
      return new Response("ok", { status: 200 });
    });
    const harness = makeHarness({ fetch });

    await harness.supervisor.ensureLoaded(FALLBACK_MODEL.slug);
    expect(fetch.mock.calls.map(([input]) => String(input))).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("/props"),
        expect.stringContaining("/apply-template"),
        expect.stringContaining("/v1/chat/completions"),
      ])
    );

    await harness.supervisor.validateModel(FALLBACK_MODEL.slug);
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/props"),
        expect.stringContaining("/apply-template"),
        expect.stringContaining("/v1/chat/completions"),
      ])
    );
  });

  it("rejects a tools-capable model when llama.cpp cannot parse its generated call", async () => {
    const harness = makeHarness({
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/props")) {
          return Response.json({
            chat_template_caps: {
              supports_tools: true,
              supports_tool_calls: true,
              supports_object_arguments: true,
            },
          });
        }
        if (url.includes("/v1/chat/completions")) {
          return Response.json({
            choices: [{ message: { content: "I cannot use tools." } }],
          });
        }
        return new Response("ok", { status: 200 });
      }),
    });

    await expect(harness.supervisor.validateModel(FALLBACK_MODEL.slug)).rejects.toThrow(
      /could not reliably select/
    );
  });

  it("qualifies tool selection against the full agent tool surface with the target last", async () => {
    let requestBody: {
      tools?: Array<{ function?: { name?: string } }>;
      tool_choice?: string;
      max_tokens?: number;
    } | null = null;
    const harness = makeHarness({
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/props")) {
          return Response.json({
            chat_template_caps: {
              supports_tools: true,
              supports_tool_calls: true,
              supports_object_arguments: true,
            },
          });
        }
        if (url.includes("/v1/chat/completions")) {
          requestBody = JSON.parse(String(init?.body)) as typeof requestBody;
          return runtimeProbeResponse();
        }
        if (url.includes("/apply-template")) {
          return Response.json({ prompt: "vibestudio-assistant-call-sentinel" });
        }
        return new Response("ok", { status: 200 });
      }),
    });

    await harness.supervisor.validateModel(FALLBACK_MODEL.slug);

    expect(requestBody?.tools).toHaveLength(39);
    expect(requestBody?.tools?.at(-1)?.function?.name).toBe("vibestudio_runtime_probe");
    expect(requestBody?.tool_choice).toBe("required");
    expect(requestBody?.max_tokens).toBeUndefined();
  });

  it("runs isolated add-time validation from an attached workspace", async () => {
    const rootDir = tempRoot();
    const owner = makeHarness({ rootDir, workspaceId: "owner" });
    await owner.supervisor.activate();
    const attached = makeHarness({ rootDir, workspaceId: "attached" });
    await attached.supervisor.activate();

    expect(attached.supervisor.role()).toBe("attached");
    await expect(attached.supervisor.validateModel(FALLBACK_MODEL.slug)).resolves.toEqual(
      expect.objectContaining({ baseUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/u) })
    );
    expect(attached.spawns).toHaveLength(1);
    expect(attached.spawns[0]?.args).toEqual(
      expect.arrayContaining(["-m", `/models/${FALLBACK_MODEL.slug}.gguf`, "-np", "1"])
    );
  });

  it("uses model metadata without family-specific router overrides", async () => {
    const harness = makeHarness();
    const routed = modelRecord("metadata-owned-model");
    harness.models.set(routed.slug, routed);

    await harness.supervisor.ensureLoaded(routed.slug);

    const mainArgs = lastSpawn(harness, "main").args;
    const presetPath = mainArgs[mainArgs.indexOf("--models-preset") + 1]!;
    const preset = readFileSync(presetPath, "utf8");
    expect(preset).toContain("[metadata-owned-model]");
    expect(preset).toContain("ctx-size = 65536");
    expect(preset).not.toContain("chat-template-file");
    expect(preset).not.toContain("temp =");
    expect(preset).not.toContain("top-k =");
    expect(preset).not.toContain("repeat-penalty =");
  });

  it("persists ports across restart", async () => {
    const harness = makeHarness();
    await harness.supervisor.activate();
    await harness.supervisor.ensureLoaded(FALLBACK_MODEL.slug); // warm utility so restart re-launches it

    const firstConfig = readConfig(harness.rootDir);
    const firstPort = portArg(lastSpawn(harness, "utility"));
    await harness.supervisor.restart("utility");

    const secondConfig = readConfig(harness.rootDir);
    const secondPort = portArg(lastSpawn(harness, "utility"));
    expect(secondConfig).toEqual(firstConfig);
    expect(secondPort).toBe(firstPort);
  });

  it("forwards attached restart requests to the owner", async () => {
    const rootDir = tempRoot();
    const owner = makeHarness({ rootDir, workspaceId: "owner-ws" });
    await owner.supervisor.ensureLoaded(FALLBACK_MODEL.slug);
    const firstUtility = lastSpawn(owner, "utility");

    const attached = makeHarness({ rootDir, workspaceId: "attached-ws" });
    await attached.supervisor.restart("utility");

    expect(attached.spawns).toHaveLength(0);
    expect(firstUtility.killed).toContain("SIGTERM");
    expect(owner.spawns.filter((spawn) => serverKind(spawn) === "utility")).toHaveLength(2);
  });

  it("reallocates on EADDRINUSE and ensureLoaded returns the live port", async () => {
    const harness = makeHarness();
    harness.models.set("toy", modelRecord("toy"));
    await harness.supervisor.activate();

    const first = await harness.supervisor.ensureLoaded("toy");
    const firstPort = Number(new URL(first.baseUrl).port);
    const main = lastSpawn(harness, "main");
    main.stderr("listen EADDRINUSE");
    main.exit(1);
    await flushAsync();

    const second = await harness.supervisor.ensureLoaded("toy");
    const secondPort = Number(new URL(second.baseUrl).port);
    const config = readConfig(harness.rootDir);

    expect(secondPort).not.toBe(firstPort);
    expect(config.mainPort).toBe(secondPort);
    expect(portArg(lastSpawn(harness, "main"))).toBe(secondPort);
  });

  it("passes each library model's declared context window to the router", async () => {
    const harness = makeHarness();
    harness.models.set("toy", modelRecord("toy"));
    await harness.supervisor.activate();
    await harness.supervisor.ensureLoaded("toy");

    expect(readFileSync(join(harness.rootDir, "router-preset.ini"), "utf8")).toContain(
      "ctx-size = 65536"
    );
  });

  it("refreshes a warm router before loading a model added after startup", async () => {
    const fetch = vi.fn(async () => new Response("ok", { status: 200 }));
    const harness = makeHarness({ fetch });
    harness.models.set("toy", modelRecord("toy"));

    await harness.supervisor.ensureLoaded("toy");
    expect(harness.supervisor.status().main).toMatchObject({
      state: "running",
      loadedModels: ["toy"],
    });

    harness.models.set("new-model", modelRecord("new-model"));
    await harness.supervisor.ensureLoaded("new-model");

    expect(harness.spawns.filter((spawn) => serverKind(spawn) === "main")).toHaveLength(1);
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/models?reload=1"),
        expect.stringContaining("/models/load"),
      ])
    );
    expect(readFileSync(join(harness.rootDir, "router-preset.ini"), "utf8")).toContain(
      "[new-model]"
    );
    expect(harness.supervisor.status().main).toMatchObject({
      state: "running",
      loadedModels: ["new-model"],
    });
  });

  it("restarts utility forever but puts main in error after five failures in-window", async () => {
    const harness = makeHarness();
    harness.models.set("toy", modelRecord("toy"));
    await harness.supervisor.activate();
    await harness.supervisor.ensureLoaded(FALLBACK_MODEL.slug); // warm utility, then crash it repeatedly

    for (let index = 0; index < 6; index += 1) {
      lastSpawn(harness, "utility").exit(1);
      await harness.timers.advance(backoffFor(index + 1, "utility"));
    }
    expect(harness.supervisor.status().utility.state).toBe("running");
    expect(harness.spawns.filter((spawn) => serverKind(spawn) === "utility")).toHaveLength(7);

    await harness.supervisor.ensureLoaded("toy");
    for (let index = 0; index < 5; index += 1) {
      lastSpawn(harness, "main").stderr(`main failure ${index}`);
      lastSpawn(harness, "main").exit(1);
      if (index < 4) await harness.timers.advance(backoffFor(index + 1, "main"));
    }

    const mainState = harness.supervisor.status().main;
    expect(mainState.state).toBe("error");
    if (mainState.state === "error") expect(mainState.logTail.at(-1)).toContain("main failure 4");
  });

  it("stops main and utility servers after fifteen minutes of model idleness", async () => {
    const harness = makeHarness();
    harness.models.set("toy", modelRecord("toy"));
    await harness.supervisor.activate();
    await harness.supervisor.ensureLoaded("toy");
    await harness.supervisor.ensureLoaded(FALLBACK_MODEL.slug);

    const firstMain = lastSpawn(harness, "main");
    const firstUtility = lastSpawn(harness, "utility");
    const mainSpawnCount = harness.spawns.filter((spawn) => serverKind(spawn) === "main").length;
    const utilitySpawnCount = harness.spawns.filter(
      (spawn) => serverKind(spawn) === "utility"
    ).length;
    await harness.timers.advance(15 * 60_000 - 1);
    expect(firstMain.killed).toHaveLength(0);
    expect(firstUtility.killed).toHaveLength(0);

    await harness.timers.advance(1);
    expect(firstMain.killed).toContain("SIGTERM");
    expect(firstUtility.killed).toContain("SIGTERM");
    expect(harness.spawns.filter((spawn) => serverKind(spawn) === "main")).toHaveLength(
      mainSpawnCount
    );
    expect(harness.spawns.filter((spawn) => serverKind(spawn) === "utility")).toHaveLength(
      utilitySpawnCount
    );
    expect(harness.supervisor.status().main.state).toBe("stopped");
    expect(harness.supervisor.status().utility.state).toBe("stopped");
  });

  it("lets an attached workspace re-warm an owner server after idle unload", async () => {
    const rootDir = tempRoot();
    const owner = makeHarness({ rootDir, workspaceId: "owner-ws" });
    await owner.supervisor.ensureLoaded(FALLBACK_MODEL.slug);
    await owner.timers.advance(15 * 60_000);
    expect(owner.supervisor.status().utility.state).toBe("stopped");

    const attached = makeHarness({ rootDir, workspaceId: "attached-ws" });
    await attached.supervisor.ensureLoaded(FALLBACK_MODEL.slug);

    expect(attached.spawns).toHaveLength(0);
    expect(owner.spawns.filter((spawn) => serverKind(spawn) === "utility")).toHaveLength(2);
    expect(owner.supervisor.status().utility.state).toBe("running");
  });

  it("keeps only the last 500 log lines and returns requested tails", async () => {
    const harness = makeHarness();
    await harness.supervisor.activate();
    await harness.supervisor.ensureLoaded(FALLBACK_MODEL.slug); // warm utility to feed its log ring
    const utility = lastSpawn(harness, "utility");

    for (let index = 0; index < 505; index += 1) utility.stdout(`line-${index}`);

    const fullTail = harness.supervisor.tailLog("utility");
    expect(fullTail).toHaveLength(500);
    expect(fullTail[0]).toBe("line-5");
    expect(harness.supervisor.tailLog("utility", 3)).toEqual(["line-502", "line-503", "line-504"]);
  });
});

function makeHarness(
  opts: {
    rootDir?: string;
    workspaceId?: string;
    fetch?: typeof fetch;
  } = {}
): Harness {
  const rootDir = opts.rootDir ?? tempRoot();
  const timers = new ManualTimers();
  const spawns: SpawnCall[] = [];
  const events: Array<Parameters<SupervisorDeps["emit"]>[0]> = [];
  const models = new Map<string, ModelRecord>();
  let nextPid = 5000;

  const deps: SupervisorDeps = {
    rootDir,
    workspaceId: opts.workspaceId ?? "ws",
    spawn: vi.fn((bin, args, spawnOpts) => {
      const call: SpawnCall = {
        bin,
        args,
        opts: spawnOpts,
        pid: nextPid,
        killed: [],
        stdout: (line) => spawnOpts.onStdout(line),
        stderr: (line) => spawnOpts.onStderr(line),
        exit: (code) => spawnOpts.onExit(code),
      };
      nextPid += 1;
      const child = {
        pid: call.pid,
        kill: (signal?: string) => {
          call.killed.push(signal ?? "SIGTERM");
        },
      };
      spawns.push(call);
      return child;
    }),
    fetch:
      opts.fetch ??
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/props")) {
          return Response.json({
            chat_template_caps: {
              supports_tools: true,
              supports_tool_calls: true,
              supports_object_arguments: true,
            },
          });
        }
        if (url.includes("/apply-template")) {
          return Response.json({ prompt: "vibestudio-assistant-call-sentinel" });
        }
        if (url.includes("/v1/chat/completions")) return runtimeProbeResponse();
        return new Response("ok", { status: 200 });
      }),
    log: vi.fn(),
    emit: vi.fn((event) => {
      events.push(event);
    }),
    engines: vi.fn(() => engineState()),
    fallbackModel: vi.fn(async () => modelRecord(FALLBACK_MODEL.slug)),
    libraryModel: vi.fn(async (slug: string) => models.get(slug) ?? null),
    libraryModels: vi.fn(async () => [...models.values()]),
    now: () => timers.now,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    adminTransport,
  };

  return {
    rootDir,
    timers,
    deps,
    spawns,
    events,
    models,
    supervisor: createServerSupervisor(deps),
  };
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "local-models-supervisor-"));
  roots.push(root);
  return root;
}

function engineState(): EngineState {
  return {
    pin: { buildTag: "b1", checksums: {} },
    cpu: {
      buildTag: "b1",
      backend: "cpu",
      dir: "/engines/cpu",
      serverBinPath: "/engines/cpu/llama-server",
      smokeTestedAt: 1,
    },
    gpu: {
      buildTag: "b1",
      backend: "cuda-12.4",
      dir: "/engines/gpu",
      serverBinPath: "/engines/gpu/llama-server",
      smokeTestedAt: 1,
    },
    degradedReason: null,
  };
}

function modelRecord(slug: string): ModelRecord {
  return {
    slug,
    displayName: slug,
    hfRepo: slug === FALLBACK_MODEL.slug ? FALLBACK_MODEL.hfRepo : "owner/repo",
    file: `/models/${slug}.gguf`,
    sizeBytes: 1,
    quant: "Q4_K_M",
    paramCount: "1B",
    arch: slug === FALLBACK_MODEL.slug ? "lfm2" : "llama",
    trainedContextLength: 65_536,
    toolsCapable: true,
    sha256: "0".repeat(64),
    importedInPlace: false,
    config: { contextLength: null, gpuLayers: null },
    addedAt: 1,
  };
}

function serverKind(spawn: SpawnCall): ServerKind {
  return spawn.args.includes("--models-preset") ? "main" : "utility";
}

function lastSpawn(harness: Harness, kind: ServerKind): SpawnCall {
  const spawn = harness.spawns.filter((call) => serverKind(call) === kind).at(-1);
  if (!spawn) throw new Error(`missing ${kind} spawn`);
  return spawn;
}

function portArg(spawn: SpawnCall): number {
  const index = spawn.args.indexOf("--port");
  return Number(spawn.args[index + 1]);
}

function readConfig(rootDir: string): { utilityPort: number; mainPort: number; adminPort: number } {
  return readJson(join(rootDir, ROOT_LAYOUT.config)) as {
    utilityPort: number;
    mainPort: number;
    adminPort: number;
  };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function runtimeProbeResponse(): Response {
  return Response.json({
    choices: [
      {
        message: {
          tool_calls: [
            {
              type: "function",
              function: {
                name: "vibestudio_runtime_probe",
                arguments: JSON.stringify({
                  value: "vibestudio-assistant-call-sentinel",
                }),
              },
            },
          ],
        },
      },
    ],
  });
}

function backoffFor(attempt: number, kind: ServerKind): number {
  const max = kind === "utility" ? 60_000 : 16_000;
  return Math.min(max, 1000 * 2 ** Math.max(0, attempt - 1));
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
