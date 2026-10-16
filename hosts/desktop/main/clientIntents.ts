/**
 * Foreground intents reach a client window as events (docs/client-hosts-and-clients-plan.md
 * §4.7.1). A window that has not mounted its listener yet holds them in order, and the
 * renderer takes them the moment it subscribes; after that they are delivered live. A
 * document replacement (a swap to a new build) forgets the subscription, because the new
 * document has not subscribed.
 */

export interface ClientIntent {
  name: string;
  params: Record<string, string>;
}

type Send = (intent: ClientIntent) => void;

export class IntentInbox {
  private readonly queues = new Map<string, ClientIntent[]>();
  private readonly listening = new Map<string, Send>();

  /** Deliver an intent to a window: live when its renderer subscribed, else held for it. */
  deliver(windowId: string, intent: ClientIntent): void {
    const live = this.listening.get(windowId);
    if (live) {
      live(intent);
      return;
    }
    const queue = this.queues.get(windowId) ?? [];
    queue.push(intent);
    this.queues.set(windowId, queue);
  }

  /** The window's renderer subscribed: hand it everything held, in order, then go live. */
  subscribe(windowId: string, send: Send): void {
    this.listening.set(windowId, send);
    const held = this.queues.get(windowId) ?? [];
    this.queues.delete(windowId);
    for (const intent of held) send(intent);
  }

  /** The window's document was replaced or went away. */
  reset(windowId: string): void {
    this.listening.delete(windowId);
  }

  retire(windowId: string): void {
    this.listening.delete(windowId);
    this.queues.delete(windowId);
  }
}
