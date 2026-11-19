import { deploy, main, parseArgs, REQUIRED_NODE_VERSION } from "../scripts/cli/remote-deploy.mjs";
import { bindRemoteDeployment } from "../scripts/cli/remote-deployment-workflow.mjs";
import { afterEach, describe, expect, it, vi } from "vitest";

type RunCall = { command: string; args: string[]; options?: { input?: string } };

afterEach(() => vi.restoreAllMocks());

describe("remote-deploy CLI", () => {
  it("requires an explicit file for an artifact argument", async () => {
    expect(() => parseArgs(["local", "--artifact"])).toThrow(/requires a file path/u);
    await expect(deploy(parseArgs(["local", "--artifact", "."]))).rejects.toThrow(
      /artifact is not a file/u
    );
  });

  it("uses the production relay set unless explicit canonical relays are supplied", () => {
    expect(parseArgs(["host"]).relayUrls).toEqual([
      "https://use1-1.relay.n0.iroh.link/",
      "https://euc1-1.relay.n0.iroh.link/",
    ]);
    expect(
      parseArgs([
        "host",
        "--relay-url",
        "https://one.example/",
        "--relay-url",
        "https://two.example/",
      ]).relayUrls
    ).toEqual(["https://one.example/", "https://two.example/"]);
    expect(() => parseArgs(["host", "--relay-url", "http://relay.example/"])).toThrow(
      /canonical.*HTTPS/
    );
    expect(() => parseArgs(["host", "--relay-url", "https://user:secret@relay.example/"])).toThrow(
      /canonical.*HTTPS/
    );
  });

  it("installs an explicit Iroh relay set in the systemd service and doctors both endpoints", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const calls: RunCall[] = [];
    await deploy(
      {
        verb: "deploy",
        target: "deploy@example.test",
        artifact: null,
        relayUrls: ["https://one.example/", "https://two.example/"],
        port: "3035",
        purge: false,
        help: false,
      },
      {
        run: async (command: string, args: string[], options?: { input?: string }) =>
          void calls.push({ command, args, options }),
      }
    );
    expect(REQUIRED_NODE_VERSION).toEqual([22, 19, 0]);
    const scripts = calls.map((call) => call.options?.input ?? "");
    expect(scripts.join("\n")).toContain(
      'Environment="VIBESTUDIO_IROH_RELAYS=https://one.example/,https://two.example/"'
    );
    expect(scripts.join("\n")).toContain(
      "remote doctor --relay-url 'https://one.example/' --relay-url 'https://two.example/'"
    );
    expect(scripts.join("\n")).toContain(
      "remote doctor --relay-url 'https://one.example/' --relay-url 'https://two.example/' --workspace default"
    );
    expect(scripts.join("\n")).not.toContain("signal-url");
  });

  it("routes service status through the isolated target shell", async () => {
    const calls: RunCall[] = [];
    await main(["status", "deploy@example.test"], {
      run: async (command: string, args: string[], options?: { input?: string }) =>
        void calls.push({ command, args, options }),
    });
    expect(calls).toEqual([
      {
        command: "ssh",
        args: ["deploy@example.test", "bash", "-l", "-s"],
        options: { input: "systemctl --user --no-pager status vibestudio-server.service" },
      },
    ]);
  });

  it("purges only workspace endpoint secrets and leaves hub trust intact", async () => {
    const calls: RunCall[] = [];
    await main(["remove", "host", "--purge"], {
      run: async (command: string, args: string[], options?: { input?: string }) =>
        void calls.push({ command, args, options }),
    });
    const script = calls[0]?.options?.input ?? "";
    expect(script).toContain("*/reach/iroh/endpoint.key");
    expect(script).not.toContain("server-auth/iroh");
  });
});

describe("Natlang deployment binding", () => {
  const identity = { serverId: "server", bootId: "boot", buildId: "build", workspaceId: "child" };
  const ready = { state: "ready", identity };

  function fixture(observations: unknown[]) {
    const installer: string[] = [];
    const run = vi.fn(
      async (_command: string, args: string[], options?: { capture?: boolean; input?: string }) => {
        expect(args[0]).toBe("deploy@example.test");
        if (options?.capture) {
          expect(options.input).toContain("ActiveState");
          return JSON.stringify(observations.shift());
        }
        installer.push(options?.input ?? "");
        return undefined;
      }
    );
    return { installer, run };
  }

  it("uses the existing update installer without publishing invite material, then checks identity and boot", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { installer, run } = fixture([
      ready,
      ready,
      { state: "ready", identity: { ...identity, bootId: "fresh" } },
    ]);
    const { request, services } = bindRemoteDeployment(["update", "deploy@example.test"], { run });
    const baseline = await services.remoteDeploymentRead.observe(request.operationId);
    expect(baseline).toMatchObject({ intent: "update", state: "ready" });
    await expect(services.remoteDeploymentApply.apply("foreign")).rejects.toThrow(
      /current attempt/u
    );
    const attempted = await services.remoteDeploymentApply.apply(baseline.receipt);
    expect(attempted.state).toBe("applied");
    expect(installer.join("\n")).toContain("systemctl --user restart vibestudio-server.service");
    expect(installer.join("\n")).not.toContain("remote deploy pairing local");
    expect(installer.join("\n")).toContain("remote doctor");
    await expect(services.remoteDeploymentVerify.verify(attempted.receipt)).resolves.toMatchObject({
      state: "verified",
      identity: { ...identity, bootId: "fresh" },
    });
  });

  it("refuses an update if the server changed between observation and installation", async () => {
    const { installer, run } = fixture([
      ready,
      { state: "ready", identity: { ...identity, bootId: "raced" } },
    ]);
    const { request, services } = bindRemoteDeployment(["update", "deploy@example.test"], { run });
    const baseline = await services.remoteDeploymentRead.observe(request.operationId);
    await expect(services.remoteDeploymentApply.apply(baseline.receipt)).resolves.toMatchObject({
      state: "baseline-changed",
    });
    expect(installer).toEqual([]);
  });

  it("updates a stopped deployment when the protected record identifies the existing server", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stopped = { state: "inactive", identity };
    const { run } = fixture([
      stopped,
      stopped,
      { state: "ready", identity: { ...identity, bootId: "successor" } },
    ]);
    const { request, services } = bindRemoteDeployment(["update", "deploy@example.test"], { run });
    const baseline = await services.remoteDeploymentRead.observe(request.operationId);
    expect(baseline).toMatchObject({ state: "inactive", hasPriorIdentity: true });
    const attempt = await services.remoteDeploymentApply.apply(baseline.receipt);
    await expect(services.remoteDeploymentVerify.verify(attempt.receipt)).resolves.toMatchObject({
      state: "verified",
    });
  });

  it.each([
    [identity, "unchanged-boot"],
    [{ ...identity, bootId: "fresh", serverId: "replacement" }, "identity-changed"],
    [{ ...identity, bootId: "fresh", workspaceId: "other-child" }, "identity-changed"],
  ])(
    "rejects post-update evidence that does not establish a successor (%s)",
    async (after, state) => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { run } = fixture([ready, ready, { state: "ready", identity: after }]);
      const { request, services } = bindRemoteDeployment(["update", "deploy@example.test"], {
        run,
      });
      const baseline = await services.remoteDeploymentRead.observe(request.operationId);
      const attempt = await services.remoteDeploymentApply.apply(baseline.receipt);
      await expect(services.remoteDeploymentVerify.verify(attempt.receipt)).resolves.toMatchObject({
        state,
        identity: null,
      });
    }
  );
});
