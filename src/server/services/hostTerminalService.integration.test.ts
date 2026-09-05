import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { createHostTerminalService } from "./hostTerminalService.js";

it("runs an approved real PTY with host access outside its initial directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-terminal-pty-"));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const canary = join(root, "host-canary");
  await writeFile(canary, "host-access-verified");
  const script = join(root, "fixture.cjs");
  await writeFile(
    script,
    `process.stdout.write(require('node:fs').readFileSync(process.argv[2], 'utf8') + '\\n'); process.stdin.on('data', () => process.exit(0));`
  );
  const service = createHostTerminalService({
    workspaceId: "test",
    host: "fixture",
    shell: process.execPath,
    args: [script, canary],
    cwd,
    environment: { ...process.env },
    recordContextIngestion: async () => {},
  });
  const connection = new AbortController();
  const ctx: ServiceContext = {
    caller: createVerifiedCaller("panel:fixture", "panel", undefined, null, {
      userId: "test",
      handle: "test",
    }),
    connectionSignal: connection.signal,
  };
  try {
    // Dispatcher approval semantics are covered separately; this fixture exercises
    // the actual native receiver and PTY on each platform.
    const prepared = await service.authorityPreparation!["hostTerminal.open"]!(ctx, [
      { columns: 80, rows: 24 },
    ]);
    ctx.preparedAuthority = {
      resolver: "hostTerminal.open",
      digest: "fixture",
      payload: prepared.payload,
    };
    const { terminalSessionId } = (await service.handler(ctx, "open", [
      { columns: 80, rows: 24 },
    ])) as { terminalSessionId: string };
    await expect
      .poll(
        async () =>
          (
            (await service.handler(ctx, "read", [{ terminalSessionId, after: 0 }])) as {
              text: string;
            }
          ).text
      )
      .toContain("host-access-verified");
    await service.handler(ctx, "write", [{ terminalSessionId, sequence: 1, data: "exit\r" }]);
    await expect
      .poll(
        async () =>
          (
            (await service.handler(ctx, "read", [{ terminalSessionId, after: 0 }])) as {
              alive: boolean;
            }
          ).alive
      )
      .toBe(false);
    expect(await service.handler(ctx, "close", [{ terminalSessionId }])).toEqual({
      processExited: true,
      descendantCleanup: "unverified",
    });
  } finally {
    connection.abort();
    await service.stop();
    await rm(root, { recursive: true, force: true });
  }
});
