/**
 * Custom channel message-type registration for Spectrolite.
 *
 * Under the GAD-native rewrite there is no per-edit publish: autosave commits
 * silently and the scribe is invoked only by an explicit Send. The old
 * `kb.user_edit` / `kb.commit` row message types are gone, so there is nothing
 * to register today. The hook is kept (the session calls it on connect) so
 * future Spectrolite-specific message types have a single place to land.
 */

import type { PubSubClient } from "@workspace/pubsub";

export async function registerSpectroliteMessageTypes(_client: PubSubClient): Promise<void> {
  // No Spectrolite-specific message types at present.
}
