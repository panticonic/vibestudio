/**
 * A trusted input can request connection once. Browser transient activation alone
 * lasts across tasks, so it cannot prevent a denied page from reopening consent
 * in a background loop. The isolated preload owns this input budget; page code
 * cannot manufacture trusted DOM input or reset the consumed generation.
 */
export function createWebsiteConnectionIntent(
  document: Pick<Document, "addEventListener" | "removeEventListener">,
  hasTransientActivation: () => boolean
): { consume(): void; close(): void } {
  let input = 0;
  let consumed = 0;
  let closed = false;
  const onInput = (event: Event) => {
    if (!event.isTrusted || (event.type === "keydown" && (event as KeyboardEvent).repeat)) return;
    ++input;
  };
  document.addEventListener("click", onInput, true);
  document.addEventListener("keydown", onInput, true);
  return {
    consume() {
      if (closed || input === consumed || !hasTransientActivation())
        throw Object.assign(new Error("Choose Connect on this page to request workspace access"), {
          code: "EWORKSPACE_USER_ACTION_REQUIRED",
        });
      consumed = input;
    },
    close() {
      closed = true;
      document.removeEventListener("click", onInput, true);
      document.removeEventListener("keydown", onInput, true);
    },
  };
}
