import { createServer, request } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { describe, it, expect } from "vitest";
import { ChromiumNetworkProxy } from "./chromiumNetworkProxy.js";

async function get(proxy: string, url: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    request(proxy, { path: url }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    })
      .on("error", reject)
      .end();
  });
}
describe("ChromiumNetworkProxy", () => {
  it("denies loopback under public authority before the endpoint sees a request", async () => {
    let requests = 0;
    const endpoint = createServer((_req, res) => {
      requests++;
      res.end("private");
    });
    await new Promise<void>((r) => endpoint.listen(0, "127.0.0.1", r));
    const port = (endpoint.address() as { port: number }).port;
    const proxy = new ChromiumNetworkProxy();
    try {
      expect((await get(await proxy.ready, `http://127.0.0.1:${port}/`)).status).toBe(403);
      expect(requests).toBe(0);
    } finally {
      await proxy.close();
      await new Promise<void>((r) => endpoint.close(() => r()));
    }
  });
  it("permits precisely an explicitly granted loopback origin and reevaluates every destination", async () => {
    const endpoint = createServer((req, res) => res.end(req.url));
    await new Promise<void>((r) => endpoint.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(endpoint.address() as { port: number }).port}`;
    const proxy = new ChromiumNetworkProxy({ kind: "internal-loopback", origin });
    try {
      const address = await proxy.ready;
      expect(await get(address, `${origin}/source`)).toEqual({ status: 200, body: "/source" });
      expect((await get(address, "http://127.0.0.1:1/redirect-or-subresource")).status).toBe(403);
      expect((await get(address, "http://169.254.169.254/metadata")).status).toBe(403);
    } finally {
      await proxy.close();
      await new Promise<void>((r) => endpoint.close(() => r()));
    }
  });
  it("tunnels CONNECT only to the vetted granted origin and retires both sockets", async () => {
    const endpoint = createTcpServer((socket) => socket.pipe(socket));
    await new Promise<void>((r) => endpoint.listen(0, "127.0.0.1", r));
    const port = (endpoint.address() as { port: number }).port;
    const proxy = new ChromiumNetworkProxy({
      kind: "internal-loopback",
      origin: `https://127.0.0.1:${port}`,
    });
    const address = new URL(await proxy.ready);
    const socket = connect(Number(address.port), address.hostname);
    try {
      const reply = await new Promise<string>((resolve, reject) => {
        let data = "";
        socket.on("error", reject);
        socket.on("data", (chunk) => {
          data += chunk;
          if (data.includes("payload")) resolve(data);
        });
        socket.write(
          `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\npayload`
        );
      });
      expect(reply).toContain("200 Connection Established");
      expect(reply).toContain("payload");
    } finally {
      socket.destroy();
      await proxy.close();
      await new Promise<void>((r) => endpoint.close(() => r()));
    }
  });

  it("rejects private CONNECT destinations and retires live listener sockets", async () => {
    const proxy = new ChromiumNetworkProxy();
    const url = new URL(await proxy.ready);
    const socket = connect(Number(url.port), url.hostname);
    try {
      const head = await new Promise<string>((resolve, reject) => {
        socket.on("error", reject);
        socket.once("data", (chunk) => resolve(chunk.toString()));
        socket.write("CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n");
      });
      expect(head).toContain("403 Forbidden");
    } finally {
      socket.destroy();
      await proxy.close();
    }
  });
});
