const path = require("node:path");
const { app } = require("electron");

const packageRoot = path.dirname(require.resolve("@number0/iroh/package.json"));
const { Endpoint, RelayMode } = require(path.join(packageRoot, "index.js"));

const ALPN = [...Buffer.from("vibestudio-rpc/4", "utf8")];
const STREAM_COUNT = 320;
const streamWindow = BigInt(process.env.VIBESTUDIO_TEST_IROH_STREAM_WINDOW ?? "0");

async function bindServer() {
  const builder = Endpoint.builder();
  builder.applyMinimal();
  builder.alpns([ALPN]);
  builder.relayMode(RelayMode.disabled());
  return builder.bind();
}

async function bindClient() {
  const builder = Endpoint.builder();
  builder.applyMinimal();
  builder.relayMode(RelayMode.disabled());
  return builder.bind();
}

function configure(connection) {
  connection.setMaxConcurrentBiStreams(streamWindow);
  connection.setMaxConcurrentUniStreams(0n);
}

async function run() {
  if (streamWindow <= BigInt(STREAM_COUNT) || streamWindow >= 1n << 60n) {
    throw new Error(`invalid test stream window ${streamWindow}`);
  }

  const server = await bindServer();
  const client = await bindClient();
  let serverConnection;
  let clientConnection;
  try {
    const incomingPromise = server.acceptNext();
    const clientConnectionPromise = client.connect(server.addr(), ALPN);
    const incoming = await incomingPromise;
    if (!incoming) throw new Error("server endpoint closed before connection admission");
    const accepting = await incoming.accept();
    [serverConnection, clientConnection] = await Promise.all([
      accepting.connect(),
      clientConnectionPromise,
    ]);
    configure(serverConnection);
    configure(clientConnection);

    const serverStreams = Array.from({ length: STREAM_COUNT }, () => serverConnection.acceptBi());
    const clientStreams = await Promise.all(
      Array.from({ length: STREAM_COUNT }, () => clientConnection.openBi())
    );
    await Promise.all(clientStreams.map((stream) => stream.send.writeAll([1])));
    const acceptedStreams = await Promise.all(serverStreams);

    const interactiveAccept = serverConnection.acceptBi();
    const interactive = await clientConnection.openBi();
    await interactive.send.writeAll([42]);
    const acceptedInteractive = await interactiveAccept;
    const request = await acceptedInteractive.recv.readExact(1);
    await acceptedInteractive.send.writeAll(request);
    await acceptedInteractive.send.finish();
    await interactive.send.finish();
    const response = await interactive.recv.readExact(1);
    if (response[0] !== 42) throw new Error("interactive stream response was corrupted");

    await Promise.all(
      clientStreams.flatMap((stream) => [stream.send.reset(0n), stream.recv.stop(0n)])
    );
    await Promise.all(
      acceptedStreams.flatMap((stream) => [stream.send.reset(0n), stream.recv.stop(0n)])
    );
    console.log(
      JSON.stringify({ streamWindow: streamWindow.toString(), heldStreams: STREAM_COUNT })
    );
  } finally {
    clientConnection?.close(0n, []);
    serverConnection?.close(0n, []);
    await Promise.all([client.close(), server.close()]);
  }
}

app.whenReady().then(
  () =>
    run().then(
      () => app.exit(0),
      (error) => {
        console.error(error instanceof Error ? error.stack : String(error));
        app.exit(1);
      }
    ),
  (error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    app.exit(1);
  }
);
