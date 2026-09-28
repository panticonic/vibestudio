/** Canned model output, deliberately using the real runtime from the iframe. */
const invention = `<!doctype html><html><head><title>Moon Permit Office</title><style>
body{font:18px Georgia;background:#201b30;color:#fff2d9;padding:32px}input,button{font:inherit;padding:12px;margin:8px 0;display:block}section{white-space:pre-wrap;border:1px solid #dba77a;padding:24px;margin-top:24px}
</style></head><body><h1>Moon Permit Office</h1><label>Request<input id="request"></label><button id="submit">Petition the moon</button><p id="status">Ready</p><section aria-label="Moon verdict" id="verdict"></section><script type="module">
const workspace=parent.inventionWorkspace;
const client=workspace.createConversationClient(workspace.rpc);
const storageKey='smoke-moon:{{directory}}';
let state=JSON.parse(localStorage.getItem(storageKey)||'null')||{key:'moon-'+crypto.randomUUID()};
const save=()=>localStorage.setItem(storageKey,JSON.stringify(state));save();
let controller;
const button=document.getElementById('submit');
const status=document.getElementById('status');
async function refresh(){
 if(!state.target||!state.receipt)return;
 const history=await client.history(state.target);
 const reply=history.logEvents.find(row=>row.id>state.receipt.id&&row.payload?.actor?.id===state.participant&&row.payload?.kind==='message.completed'&&row.payload.payload.role==='assistant'&&row.payload.payload.tier==='primary');
 if(reply){document.getElementById('verdict').textContent=reply.payload.payload.blocks.filter(b=>b.type==='text').map(b=>b.content).join('\\n');button.disabled=false;status.textContent='Permit issued';}
}
async function observe(){controller?.abort();controller=new AbortController();void client.subscribe(state.target,workspace.rpc.selfId,{},refresh,{signal:controller.signal}).catch(error=>{if(!controller.signal.aborted)status.textContent=error.message;});await refresh();}
button.onclick=async()=>{button.disabled=true;status.textContent='Consulting the lunar clerk';try{
 const channel=await workspace.rpc.call('main','runtime.createEntity',[{kind:'do',execution:{surface:'code',source:'workers/pubsub-channel'},className:'PubSubChannel',key:state.key,contextId:workspace.contextId}]);
 state.target=channel.targetId;
 const agent=await workspace.launchAgentIntoChannel(workspace.rpc,{source:'workers/agent-worker',className:'AiChatWorker',key:state.key+'-clerk',contextId:workspace.contextId,channelId:state.key,replay:true});
 state.participant=agent.subscription.participantId;
 state.receipt=await client.send(state.target,'SMOKE_MOON_REQUEST:'+document.getElementById('request').value,{to:[{kind:'participant',participantId:state.participant}],idempotencyKey:crypto.randomUUID()});save();await observe();
}catch(error){status.textContent=error.message;button.disabled=false;}};
if(state.target)await observe();
addEventListener('pagehide',()=>controller?.abort());
</script></body></html>`;

export const inventorModelScript = {
  rules: [
    {
      match: "HTML at (?<directory>projects/impossible-inventions/[a-z0-9-]+)/index\\.html",
      steps: [
        { tool: "read", arguments: { path: "skills/workspace-dev/SKILL.md" } },
        {
          tool: "eval",
          arguments: {
            code: `import { launchAgentIntoChannel, createConversationClient } from '@workspace/runtime'; if(typeof launchAgentIntoChannel !== 'function' || typeof createConversationClient !== 'function') throw new Error('Portable agent helpers unavailable'); import { createProjects } from '@workspace-skills/workspace-dev'; return await createProjects([{projectType:'project',name:'impossible-inventions',title:'Impossible Inventions',icon:'🌙'}]);`,
          },
        },
        { tool: "write", arguments: { path: "{{directory}}/index.html", content: invention } },
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
