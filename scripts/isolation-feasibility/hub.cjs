const fs = require('node:fs');
const { spawn } = require('node:child_process');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  const child = spawn('/usr/bin/strace', ['-f', '-e', 'trace=network', '-o', '/state/network.trace', process.execPath, '/app/dist/server.mjs', '--app-root', '/app', '--ready-file', '/state/hub-ready.json'], {
    env: { ...process.env, VIBESTUDIO_INSTANCE: 'isolation-feasibility', VIBESTUDIO_INSTANCE_ROOT: '/state/instance', XDG_CONFIG_HOME: '/state/config' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', b => log += b);
  const closed = new Promise(r => child.on('close', (code, signal) => r({ code, signal })));
  let ready = false;
  try {
    for (let i = 0; i < 180; i++) { if (fs.existsSync('/state/hub-ready.json')) { ready = true; break; } if (child.exitCode !== null || child.signalCode !== null) break; await wait(100); }
  } finally {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    const exit = await closed; clearTimeout(timer);
    // Keep raw logs in private scratch. Ready files may contain pairing secrets.
    fs.writeFileSync('/state/hub.log', log, { mode: 0o600 });
    const errors = log.split('\n').filter(l => /error|failed|cannot|ENOENT|denied|EACCES|EROFS/i.test(l)).slice(-12);
    const network = [...new Set(fs.readFileSync('/state/network.trace', 'utf8').split('\n').filter(l => /ENETUNREACH|ECONNREFUSED|EACCES|EPERM/.test(l)).map(l => l.slice(l.indexOf('{sa_family='))).filter(l => l.startsWith('{sa_family=')))];
    console.log(JSON.stringify({ hubReady: ready, exit, errors, startupTail: log.split('\n').slice(-15), network }));
  }
}
main().catch(e => { console.error(e.stack); process.exit(1); });
