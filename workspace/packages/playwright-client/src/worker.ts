type CdpResponse = {
  id?: number;
  result?: unknown;
  error?: { message?: string; data?: string };
};

type PendingCommand = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type WebSocketCtor = new (url: string) => WebSocket;

function getWebSocketCtor(): WebSocketCtor {
  const ctor = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
  if (!ctor) {
    throw new Error("WebSocket is not available in this worker runtime");
  }
  return ctor;
}

function once(
  ws: WebSocket,
  event: "open" | "message" | "error" | "close"
): Promise<Event | MessageEvent> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      ws.removeEventListener(event, handle);
      ws.removeEventListener("error", handleError);
      ws.removeEventListener("close", handleClose);
    };
    const handle = (ev: Event | MessageEvent) => {
      cleanup();
      resolve(ev);
    };
    const handleError = () => {
      cleanup();
      reject(new Error(`CDP WebSocket ${event} failed`));
    };
    const handleClose = () => {
      cleanup();
      reject(new Error(`CDP WebSocket closed before ${event}`));
    };
    ws.addEventListener(event, handle);
    if (event !== "error") ws.addEventListener("error", handleError);
    if (event !== "close") ws.addEventListener("close", handleClose);
  });
}

async function messageText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  if (data && typeof (data as Blob).text === "function") {
    return (data as Blob).text();
  }
  return String(data);
}

function decodeBase64(data: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  const bufferCtor = (globalThis as { Buffer?: { from(data: string, enc: string): Uint8Array } })
    .Buffer;
  if (bufferCtor) return bufferCtor.from(data, "base64");
  throw new Error("No base64 decoder is available in this runtime");
}

class CdpConnection {
  private nextId = 1;
  private pending = new Map<number, PendingCommand>();

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      void this.handleMessage(event.data);
    });
    ws.addEventListener("close", () => {
      const error = new Error("CDP WebSocket closed");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
  }

  static async connect(wsEndpoint: string, authToken?: string): Promise<CdpConnection> {
    const WebSocketImpl = getWebSocketCtor();
    const ws = new WebSocketImpl(wsEndpoint);
    await once(ws, "open");
    if (authToken) {
      ws.send(JSON.stringify({ type: "natstack:cdp-auth", token: authToken }));
      const event = (await once(ws, "message")) as MessageEvent;
      const parsed = JSON.parse(await messageText(event.data)) as { type?: string };
      if (parsed.type !== "natstack:cdp-auth-ok") {
        throw new Error("CDP authentication failed");
      }
    }
    return new CdpConnection(ws);
  }

  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const message = params ? { id, method, params } : { id, method };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(message));
    });
  }

  close(): void {
    this.ws.close();
  }

  private async handleMessage(data: unknown): Promise<void> {
    const parsed = JSON.parse(await messageText(data)) as CdpResponse;
    if (typeof parsed.id !== "number") return;
    const pending = this.pending.get(parsed.id);
    if (!pending) return;
    this.pending.delete(parsed.id);
    if (parsed.error) {
      pending.reject(new Error(parsed.error.message ?? parsed.error.data ?? "CDP command failed"));
      return;
    }
    pending.resolve(parsed.result);
  }
}

class WorkerCdpPage {
  constructor(private readonly connection: CdpConnection) {}

  async initialize(): Promise<void> {
    await Promise.allSettled([
      this.connection.send("Page.enable"),
      this.connection.send("Runtime.enable"),
      this.connection.send("DOM.enable"),
    ]);
  }

  async goto(url: string): Promise<unknown> {
    return this.connection.send("Page.navigate", { url });
  }

  async evaluate(pageFunction: string | ((arg?: unknown) => unknown), arg?: unknown): Promise<unknown> {
    const expression =
      typeof pageFunction === "function"
        ? `(${pageFunction.toString()})(${JSON.stringify(arg)})`
        : pageFunction;
    const result = (await this.connection.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? "Evaluation failed");
    }
    return result.result?.value;
  }

  async click(selector: string): Promise<void> {
    const point = (await this.evaluate(
      `(function(selector) {
        const el = document.querySelector(selector);
        if (!el) throw new Error("No element matches selector: " + selector);
        const rect = el.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })(${JSON.stringify(selector)})`
    )) as { x?: number; y?: number };
    if (typeof point?.x !== "number" || typeof point?.y !== "number") {
      throw new Error(`No clickable point for selector: ${selector}`);
    }
    await this.connection.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button: "none",
    });
    await this.connection.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    await this.connection.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
  }

  async screenshot(options: { type?: "png" | "jpeg"; quality?: number } = {}): Promise<Uint8Array> {
    const result = (await this.connection.send("Page.captureScreenshot", options)) as {
      data?: string;
    };
    if (!result.data) throw new Error("CDP screenshot did not return image data");
    return decodeBase64(result.data);
  }

  async waitForLoadState(): Promise<void> {
    await this.connection.send("Runtime.evaluate", {
      expression: "document.readyState",
      returnByValue: true,
    });
  }
}

class WorkerBrowser {
  constructor(private readonly page: WorkerCdpPage, private readonly connection: CdpConnection) {}

  contexts(): Array<{ pages(): WorkerCdpPage[] }> {
    return [{ pages: () => [this.page] }];
  }

  async close(): Promise<void> {
    this.connection.close();
  }
}

export const BrowserImpl = {
  async connect(
    wsEndpoint: string,
    options: { transportOptions?: { authToken?: string } } = {}
  ): Promise<WorkerBrowser> {
    const connection = await CdpConnection.connect(
      wsEndpoint,
      options.transportOptions?.authToken
    );
    const page = new WorkerCdpPage(connection);
    await page.initialize();
    return new WorkerBrowser(page, connection);
  },
};
