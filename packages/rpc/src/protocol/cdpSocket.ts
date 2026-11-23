import { webSocketAuthProtocol } from "./webSocketAuthProtocol.js";
export type CdpSocketPlatform = { WebSocket?: WebSocketCtor; WebSocketPair?: unknown; fetch?: typeof fetch };
export type CdpSocketOpener = (endpoint: string, token?: string, preferFetchUpgrade?: boolean, signal?: AbortSignal) =>
  Promise<{ socket: WorkerClientWebSocket; waitForOpen: boolean }>;

export type WebSocketCtor = new (
  url: string,
  protocols?: string | string[],
) => WebSocket;

export type WorkerClientWebSocket = WebSocket & { accept?: () => void };


export async function openCdpWebSocket(
  wsEndpoint: string,
  authToken: string | undefined,
  preferFetchUpgrade = false,
  signal: AbortSignal | undefined,
  platform: CdpSocketPlatform,
): Promise<{ socket: WorkerClientWebSocket; waitForOpen: boolean }> {
  const ctor = platform.WebSocket;
  if (ctor && !preferFetchUpgrade && typeof platform.WebSocketPair !== "function") {
    return {
      socket: new ctor(
        wsEndpoint,
        authToken
          ? [webSocketAuthProtocol("inspection", authToken)]
          : undefined,
      ),
      waitForOpen: true,
    };
  }

  if (typeof platform.fetch !== "function") {
    throw new Error(
      "CDP WebSocket transport is unavailable: this runtime exposes neither WebSocket nor fetch",
    );
  }

  const upgradeUrl = new URL(wsEndpoint);
  if (upgradeUrl.protocol === "ws:") upgradeUrl.protocol = "http:";
  else if (upgradeUrl.protocol === "wss:") upgradeUrl.protocol = "https:";
  else {
    throw new Error(
      `CDP endpoint must use ws: or wss:, received ${upgradeUrl.protocol}`,
    );
  }
  if (authToken) {
    const headerPairs = JSON.stringify([["x-vibestudio-cdp-grant", authToken]]);
    const encoded = btoa(headerPairs)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    // Workerd's outbound WebSocket proxy cannot carry arbitrary upgrade
    // headers directly. This transport metadata is decoded by the egress
    // boundary, verified there, and removed before the upstream handshake.
    upgradeUrl.searchParams.set("__vibestudio_ws_headers", encoded);
  }

  const response = (await platform.fetch(upgradeUrl, {
    headers: { Upgrade: "websocket" },
    signal,
  })) as Response & { webSocket?: WorkerClientWebSocket | null };
  const socket = response.webSocket;
  if (!socket)
    throw new Error(
      `CDP WebSocket upgrade failed with HTTP ${response.status}: response contained no WebSocket`,
    );
  socket.accept?.();
  return { socket, waitForOpen: false };
}


export type CdpSocketBindingOptions = {
  platform: CdpSocketPlatform;
  /** The native owner checks its exact current execution, including completion. */
  assertActive?: () => void;
  signal?: AbortSignal;
  /** Native lifecycle registration; the raw socket is never passed to guests. */
  onSocket?: (socket: WorkerClientWebSocket) => void;
};

/** Bind a socket capability to one already-approved native endpoint/grant. */
export function bindCdpSocket(endpoint: {wsEndpoint:string;token?:string}, options: CdpSocketBindingOptions): CdpSocketOpener {
  const {wsEndpoint,token}=endpoint;
  if(!token)throw new Error("Native CDP transport requires an exact inspection grant");
  const source=options.platform;
  const platform:CdpSocketPlatform={WebSocket:source.WebSocket,WebSocketPair:source.WebSocketPair,
    fetch:typeof source.fetch==="function"?source.fetch.bind(source):undefined};
  let used=false;
  const guard=()=>{options.signal?.throwIfAborted();options.assertActive?.();};
  return async (requested,grant,prefer,signal)=>{
    if(requested!==wsEndpoint || grant!==token)throw new Error("CDP transport is bound to its approved endpoint and grant");
    guard();
    if(used)throw new Error("CDP endpoint grant has already been used; acquire a fresh approved endpoint");
    used=true;
    const activeSignal=signal && options.signal ? AbortSignal.any([signal,options.signal]) : signal ?? options.signal;
    activeSignal?.throwIfAborted();
    const opened=await openCdpWebSocket(requested,grant,prefer,activeSignal,platform);
    const native=opened.socket;
    try {guard();activeSignal?.throwIfAborted();options.onSocket?.(native);}catch(error){native.close();throw error;}
    // A raw native socket/event would expose its constructor or event.target.
    // Hand out only a null-prototype protocol facade with checked sends.
    const facade=Object.create(null) as WorkerClientWebSocket;
    const listeners=new Map<string,Map<unknown,Map<boolean,EventListener>>>();
    Object.defineProperty(facade,"readyState",{get:()=>native.readyState});
    facade.send=(data)=>{guard();activeSignal?.throwIfAborted();native.send(data);};
    facade.close=(code,reason)=>native.close(code,reason);
    facade.addEventListener=((type:string,listener:EventListenerOrEventListenerObject|null,settings?:boolean|AddEventListenerOptions)=>{
      guard();
      if(!listener)return;
      const capture=typeof settings==="boolean"?settings:settings?.capture??false;
      const byListener=listeners.get(type)??new Map();listeners.set(type,byListener);
      const byCapture=byListener.get(listener)??new Map();byListener.set(listener,byCapture);
      if(byCapture.has(capture))return;
      const wrapped:EventListener=(event)=>{
        if(typeof settings==="object" && settings.once)byCapture.delete(capture);
        try {
          // Cancellation must still settle pending commands through close/error.
          // Completion revokes every callback, including terminal notifications.
          options.assertActive?.();
          if(type!=="close" && type!=="error"){
            options.signal?.throwIfAborted();activeSignal?.throwIfAborted();
          }
        }catch{return;}
        const original=event as MessageEvent & CloseEvent;
        const safe=Object.assign(Object.create(null),{type:event.type,data:typeof original.data==="string"?original.data:undefined,code:original.code,reason:original.reason,
          wasClean:original.wasClean,target:facade,currentTarget:facade});
        if(typeof listener==="function")Reflect.apply(listener,facade,[safe]);else listener.handleEvent(safe);
      };
      byCapture.set(capture,wrapped);native.addEventListener(type,wrapped,settings);
    }) as typeof facade.addEventListener;
    facade.removeEventListener=((type:string,listener:EventListenerOrEventListenerObject|null,settings?:boolean|EventListenerOptions)=>{
      const capture=typeof settings==="boolean"?settings:settings?.capture??false;
      const byCapture=listeners.get(type)?.get(listener),wrapped=byCapture?.get(capture);
      if(wrapped){native.removeEventListener(type,wrapped,settings);byCapture?.delete(capture);}
    }) as typeof facade.removeEventListener;
    native.addEventListener("close",()=>queueMicrotask(()=>{
      for(const [type,byListener] of listeners)
        for(const byCapture of byListener.values())
          for(const [capture,listener] of byCapture)native.removeEventListener(type,listener,capture);
      listeners.clear();
    }),{once:true});
    return {socket:Object.freeze(facade),waitForOpen:opened.waitForOpen};
  };
}
