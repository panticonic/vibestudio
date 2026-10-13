import { runEmbeddedMoonPermit } from "./embeddedMoonPermit";

const embeddedProgram = `
const workspace = parent.inventionWorkspace;
const status = document.getElementById("status");
void (${runEmbeddedMoonPermit.toString()})(workspace, document.documentElement.dataset.directory)
  .catch((error) => {
    status.dataset.state = "failed";
    status.textContent = workspace.formatRpcFailure(error);
    document.getElementById("submit").disabled = false;
  });
`.replaceAll("</script", "<\\/script");

/** Canned model output, deliberately using the real runtime from the iframe. */
const invention = `<!doctype html><html data-directory="{{directory}}"><head><title>Moon Permit Office</title><style>
body{font:18px Georgia;background:#201b30;color:#fff2d9;padding:32px}input,button{font:inherit;padding:12px;margin:8px 0;display:block}section{white-space:pre-wrap;border:1px solid #dba77a;padding:24px;margin-top:24px}
</style></head><body><h1>Moon Permit Office</h1><label>Request<input id="request"></label><button id="submit">Petition the moon</button><p id="status" data-state="idle">Ready</p><section aria-label="Moon verdict" id="verdict"></section><script type="module">${embeddedProgram}</script></body></html>`;

export const inventorModelScript = {
  rules: [
    {
      match: "HTML at (?<directory>projects/impossible-inventions/[a-z0-9-]+)/index\\.html",
      steps: [
        { tool: "read", arguments: { path: "skills/workspace-dev/SKILL.md" } },
        {
          tool: "eval",
          arguments: {
            code: `import { launchAgentIntoChannel, createConversationClient } from '@workspace/runtime'; if(typeof launchAgentIntoChannel !== 'function' || typeof createConversationClient !== 'function') throw new Error('Portable agent helpers unavailable'); import { prepareProjects } from '@workspace-skills/workspace-dev'; return await prepareProjects([{projectType:'project',name:'impossible-inventions',title:'Impossible Inventions',icon:'🌙'}]);`,
          },
        },
        { tool: "write", arguments: { path: "{{directory}}/index.html", content: invention } },
        {
          tool: "vcs",
          arguments: { operation: "commit", message: "Create the Moon Permit Office" },
        },
        { tool: "vcs", arguments: { operation: "push" } },
      ],
      reply: "The Moon Permit Office is ready. Petition the moon for a most improbable permit.",
    },
    {
      match: "Revise (?<directory>projects/impossible-inventions/[a-z0-9-]+)/index\\.html",
      steps: [
        { tool: "read", arguments: { path: "{{directory}}/index.html" } },
        {
          tool: "write",
          arguments: {
            path: "{{directory}}/index.html",
            content: invention.replaceAll(
              "Moon Permit Office",
              "Department of Unlikely Permissions"
            ),
          },
        },
      ],
      reply:
        "The Department of Unlikely Permissions is open. The lunar clerk still awaits your petitions.",
    },
    {
      match: "^SMOKE_MOON_REQUEST:(?<request>.+)$",
      steps: [],
      reply:
        "LUNAR PERMIT 001. The moon hereby authorizes: {{request}}. Valid until Tuesday learns to fly; please return all borrowed clouds.",
    },
  ],
};
