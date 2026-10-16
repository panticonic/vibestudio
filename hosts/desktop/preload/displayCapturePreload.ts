import { ipcRenderer } from "electron";

window.addEventListener("DOMContentLoaded", () => {
  const sources = document.getElementById("sources")!;
  const origin = document.getElementById("origin")!;
  const status = document.getElementById("status")!;
  const share = document.getElementById("share") as HTMLButtonElement;
  const audio = document.getElementById("audio") as HTMLInputElement;
  let selected: number | null = null;
  const cancel = () => void ipcRenderer.invoke("vibestudio:display-capture-picker", "choose", null);
  document.getElementById("cancel")!.addEventListener("click", cancel);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") cancel();
  });
  share.addEventListener("click", () => {
    share.disabled = true;
    void ipcRenderer
      .invoke("vibestudio:display-capture-picker", "choose", selected, audio.checked)
      .catch(() => {
        status.textContent = "Unable to share. Close this picker and try again.";
      });
  });
  void ipcRenderer
    .invoke("vibestudio:display-capture-picker", "snapshot")
    .then(
      (data: {
        origin: string;
        audioAvailable: boolean;
        sources: { index: number; name: string; kind: string; thumbnail: string }[];
      }) => {
        origin.textContent = `${data.origin} will receive the source you choose.`;
        document.getElementById("audio-row")!.hidden = !data.audioAvailable;
        for (const source of data.sources) {
          const button = document.createElement("button");
          button.className = "source";
          button.setAttribute("aria-pressed", "false");
          const image = document.createElement("img");
          image.src = source.thumbnail;
          image.alt = "";
          const title = document.createElement("span");
          title.textContent = `${source.kind} · ${source.name}`;
          button.append(image, title);
          button.addEventListener("click", () => {
            selected = source.index;
            for (const other of sources.querySelectorAll("button"))
              other.setAttribute("aria-pressed", String(other === button));
            share.disabled = false;
          });
          sources.append(button);
        }
        status.textContent = "Choose a window to share less of your desktop.";
      }
    )
    .catch(() => {
      status.textContent =
        "Unable to load sources. Check your screen-recording permission in system settings.";
    });
});
