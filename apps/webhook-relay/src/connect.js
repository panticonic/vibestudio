import { connectWorkspace, disconnectWorkspace, services, workspaceConnection } from "/runtime.js";

const button = document.querySelector("#workspace-connect-button");
const status = document.querySelector("#workspace-connection-status");
const lab = document.querySelector("#image-lab");
const prompt = document.querySelector("#lab-prompt");
const generate = document.querySelector("#lab-generate");
const labStatus = document.querySelector("#lab-status");
const artwork = document.querySelector("#lab-image");
const placeholder = document.querySelector("#lab-placeholder");
const caption = document.querySelector("#lab-preview-caption");
const download = document.querySelector("#lab-download");
let activeGeneration;
let selectedStyle = document.querySelector('.lab-styles [aria-pressed="true"]').dataset.style;

function setLabStatus(message, error = false) {
  labStatus.textContent = message;
  labStatus.dataset.error = String(error);
}

function renderConnection() {
  const connection = workspaceConnection;
  lab.hidden = !connection.connected;
  if (!connection.connected && activeGeneration) {
    activeGeneration.abort();
    activeGeneration = undefined;
    generate.disabled = false;
    generate.textContent = "Draw my workspace";
    setLabStatus("Connection ended. Reconnect to make something new.");
  }

  if (!connection.available) {
    button.textContent = "Open in Vibestudio to connect";
    button.disabled = true;
    status.textContent = "Open this page in Vibestudio to connect it to a workspace.";
  } else if (connection.connected) {
    button.textContent = "Disconnect";
    button.disabled = false;
    status.textContent = "Connected. You can draw a workspace poster below.";
  } else if (connection.status === "connecting") {
    button.textContent = "Waiting for approval";
    button.disabled = true;
    status.textContent = "Approve this connection in Vibestudio.";
  } else {
    button.textContent = "Connect to workspace";
    button.disabled = connection.status === "disconnecting";
    status.textContent = connection.error ?? "This page starts without workspace access.";
  }
}

workspaceConnection.subscribe(renderConnection);
button.addEventListener("click", async () => {
  if (workspaceConnection.connected) {
    try {
      await disconnectWorkspace();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    }
    return;
  }

  button.disabled = true;
  status.textContent = "Requesting a connection to this workspace…";
  try {
    await connectWorkspace();
    lab.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    renderConnection();
  }
});

for (const idea of document.querySelectorAll("[data-idea]")) {
  idea.addEventListener("click", () => {
    prompt.value = idea.dataset.idea;
    prompt.focus();
  });
}
for (const style of document.querySelectorAll("[data-style]")) {
  style.addEventListener("click", () => {
    selectedStyle = style.dataset.style;
    for (const choice of document.querySelectorAll("[data-style]"))
      choice.setAttribute("aria-pressed", String(choice === style));
  });
}

function drawConstellation(title, surfaces, atmosphere) {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot draw the poster.");
  const palettes = {
    nebula: ["#1a202a", "#323e4e", "#f4f5f6", "#dc9584", "#496fa8"],
    aurora: ["#081d27", "#164f5b", "#a9efcf", "#70cde7", "#f8dfaa"],
    blueprint: ["#0a1737", "#193a75", "#c4dbff", "#77a3ef", "#e5f0ff"],
  };
  const [dark, glow, ink, accent, gold] = palettes[atmosphere];
  let seed = [...title, ...surfaces.flatMap((row) => [...row.surface, String(row.count)])]
    .reduce((value, letter) => (Math.imul(value, 31) + letter.charCodeAt(0)) >>> 0, 2166136261);
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const background = ctx.createLinearGradient(0, 0, 1024, 1024);
  background.addColorStop(0, glow);
  background.addColorStop(0.58, dark);
  background.addColorStop(1, dark);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, 1024, 1024);
  const haze = ctx.createRadialGradient(520, 418, 20, 520, 418, 460);
  haze.addColorStop(0, accent + "75");
  haze.addColorStop(1, accent + "00");
  ctx.fillStyle = haze;
  ctx.fillRect(0, 0, 1024, 900);
  for (let index = 0; index < 210; index++) {
    ctx.globalAlpha = 0.15 + random() * 0.65;
    ctx.fillStyle = index % 9 === 0 ? gold : ink;
    ctx.beginPath();
    ctx.arc(random() * 1024, random() * 1024, random() * 1.8 + 0.35, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = "center";
  ctx.fillStyle = ink;
  ctx.font = "600 17px monospace";
  ctx.fillText("VIBESTUDIO  /  CONNECTED WORKSPACE", 512, 81);
  const rows = [...surfaces].sort((a, b) => a.surface.localeCompare(b.surface));
  const centerX = 512;
  const centerY = 465;
  const radii = [155, 260, 365];
  rows.slice(0, 3).forEach((row, ring) => {
    const radius = radii[ring];
    ctx.strokeStyle = accent + (ring === 0 ? "7a" : "52");
    ctx.lineWidth = ring === 0 ? 2 : 1.5;
    ctx.beginPath();
    ctx.ellipse(centerX, centerY, radius, radius * 0.76, -0.32, 0, Math.PI * 2);
    ctx.stroke();
    const dots = Math.max(3, Math.min(17, Math.ceil(Math.sqrt(row.count))));
    const offset = random() * Math.PI * 2;
    for (let dot = 0; dot < dots; dot++) {
      const angle = (dot / dots) * Math.PI * 2 + offset;
      const x = centerX + radius * Math.cos(angle) * 0.95;
      const y = centerY + radius * Math.sin(angle) * 0.72 - radius * Math.cos(angle) * 0.31;
      ctx.shadowColor = gold;
      ctx.shadowBlur = dot === 0 ? 22 : 10;
      ctx.fillStyle = dot === 0 ? gold : ink;
      ctx.beginPath();
      ctx.arc(x, y, dot === 0 ? 7 : 2.5 + random() * 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  });
  const core = ctx.createRadialGradient(centerX - 40, centerY - 45, 5, centerX, centerY, 105);
  core.addColorStop(0, "#fff8ed");
  core.addColorStop(0.24, gold);
  core.addColorStop(0.65, accent);
  core.addColorStop(1, glow);
  ctx.shadowColor = accent;
  ctx.shadowBlur = 55;
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(centerX, centerY, 94, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = dark;
  ctx.font = "700 25px system-ui";
  ctx.fillText("YOU", centerX, centerY + 9);
  ctx.fillStyle = ink;
  ctx.font = "600 42px system-ui";
  const words = title.split(/\s+/);
  const lines = [""];
  for (const word of words) {
    const last = lines.length - 1;
    const candidate = lines[last] ? lines[last] + " " + word : word;
    if (ctx.measureText(candidate).width > 820 && lines[last]) lines.push(word);
    else lines[last] = candidate;
  }
  lines.slice(0, 2).forEach((line, index) => ctx.fillText(line, 512, 833 + index * 50, 880));
  ctx.font = "16px monospace";
  ctx.fillStyle = gold;
  const counts = rows.map((row) => `${row.surface.toUpperCase()} ${row.count}`).join("   ·   ");
  ctx.fillText(counts, 512, 952, 930);
  return canvas.toDataURL("image/png");
}

generate.addEventListener("click", async () => {
  const title = prompt.value.trim();
  if (!title) {
    setLabStatus("Give your universe a name first.", true);
    prompt.focus();
    return;
  }
  if (!workspaceConnection.connected || activeGeneration) return;

  const operation = new AbortController();
  activeGeneration = operation;
  generate.disabled = true;
  generate.textContent = "Reading your workspace…";
  setLabStatus("Reading the live capability catalog…");
  try {
    const surfaces = await services.docs.listSurfaces();
    if (operation.signal.aborted) return;
    const url = drawConstellation(title, surfaces, selectedStyle);
    artwork.src = url;
    artwork.alt = `Constellation poster for ${title}, based on ${surfaces.length} workspace capability surfaces`;
    artwork.hidden = false;
    placeholder.hidden = true;
    caption.textContent = title;
    download.href = url;
    download.hidden = false;
    setLabStatus("A snapshot of what this page can see in your workspace. Save it or draw another.");
  } catch (error) {
    if (!operation.signal.aborted)
      setLabStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    if (activeGeneration === operation) {
      activeGeneration = undefined;
      generate.disabled = false;
      generate.textContent = "Draw my workspace";
    }
  }
});

renderConnection();
