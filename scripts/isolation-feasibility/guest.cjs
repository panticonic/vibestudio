// Mechanism fixture, not a production security policy or launcher.
const fs = require('node:fs');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline');
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(detail ? { detail } : {}) });
const absent = p => { try { fs.readFileSync(p); return false; } catch (e) { return ['ENOENT', 'EACCES', 'EPERM'].includes(e.code); } };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function broker(resource) {
  return new Promise((resolve, reject) => {
    const s = net.connect('/run/broker.sock');
    s.setTimeout(3000, () => s.destroy(new Error('broker timeout')));
    let data = '';
    s.on('error', reject).on('data', b => data += b).on('end', () => resolve(JSON.parse(data)));
    s.on('connect', () => s.end(JSON.stringify({ token: process.env.JOB_TOKEN, resource })));
  });
}
async function socketDenied(port) {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.setTimeout(1500, () => { s.destroy(); resolve(true); });
    s.on('connect', () => { s.destroy(); resolve(false); }).on('error', () => resolve(true));
  });
}
async function main() {
  check('selected input readable', fs.readFileSync('/input/value', 'utf8') === process.env.JOB_LABEL);
  try { fs.writeFileSync('/input/value', 'bad'); check('input read only', false); }
  catch (e) { check('input read only', e.code === 'EROFS', e.code); }
  fs.writeFileSync('/state/value', process.env.JOB_LABEL);
  check('private state writable', fs.readFileSync('/state/value', 'utf8') === process.env.JOB_LABEL);
  for (const [name, path] of Object.entries(JSON.parse(process.env.DENIED_PATHS))) check(name, absent(path));
  check('host environment absent', process.env.ISOLATION_HOST_SECRET === undefined);
  check('host process absent', !fs.existsSync(`/proc/${process.env.HOST_PID}/cmdline`));
  check('host loopback denied', await socketDenied(Number(process.env.HOST_PORT)));
  const generated = "const fs=require('fs');try{fs.readFileSync(process.argv[2]);process.exit(9)}catch(e){process.exit(['ENOENT','EACCES','EPERM'].includes(e.code)?0:8)}";
  fs.writeFileSync('/state/generated.cjs', generated);
  const child = spawnSync(process.execPath, ['/state/generated.cjs', JSON.parse(process.env.DENIED_PATHS)['host canary absent']], { encoding: 'utf8' });
  check('generated child preserves scope', child.status === 0, child.stderr);
  const rg = spawnSync('/deps/@vscode/ripgrep-linux-x64/bin/rg', ['--no-config', process.env.JOB_LABEL, '/input'], { encoding: 'utf8' });
  check('installed ripgrep', rg.status === 0, rg.stderr);
  try {
    const pty = require('/deps/node-pty');
    const outcome = await new Promise(resolve => {
      let output = '';
      const p = pty.spawn('/bin/bash', ['--noprofile', '--norc', '-c', 'printf pty-ok'], { cwd: '/state', env: { PATH: '/usr/bin:/bin', HOME: '/state' } });
      const timer = setTimeout(() => { p.kill(); resolve({ ok: false, output: 'timeout' }); }, 5000);
      p.onData(s => output += s);
      p.onExit(e => { clearTimeout(timer); resolve({ ok: e.exitCode === 0 && output.includes('pty-ok'), output }); });
    });
    check('installed node-pty and bash', outcome.ok, outcome.output);
  } catch (e) { check('installed node-pty and bash', false, e.message); }
  const worker = spawn('/deps/@cloudflare/workerd-linux-64/bin/workerd', ['serve', '/fixture/worker.capnp'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let workerLog = ''; worker.stderr.on('data', b => workerLog += b);
  const workerClosed = new Promise(r => worker.on('close', r));
  try {
    let answer;
    for (let i = 0; i < 50; i++) {
      try { answer = await (await fetch('http://127.0.0.1:18080')).text(); break; } catch { await wait(100); }
      if (worker.exitCode !== null) break;
    }
    check('installed workerd serves in private network', answer === 'worker-ok', workerLog.slice(-1500));
  } finally { worker.kill(); await workerClosed; }
  check('broker selected file', (await broker('selected')).value === 'selected-host-value');
  check('broker mediated network', (await broker('network')).value === 'mediated-network-value');
  check('broker wrong resource denied', (await broker('other')).denied === true);
  // A detached descendant keeps writing until the containing PID namespace dies.
  const daemon = spawn(process.execPath, ['-e', "const fs=require('fs');setInterval(()=>fs.appendFileSync('/state/heartbeat','x'),30)"], { detached: true, stdio: 'ignore' });
  daemon.unref();
  const commands = readline.createInterface({ input: process.stdin });
  console.log(JSON.stringify({ ready: true, checks }));
  commands.on('line', async line => {
    if (line === 'revoked') console.log(JSON.stringify({ revoked: (await broker('selected')).denied === true }));
    if (line === 'ping') console.log(JSON.stringify({ alive: fs.readFileSync('/state/value', 'utf8') === process.env.JOB_LABEL }));
    if (line === 'stop') process.exit(0);
  });
}
main().catch(e => { console.error(e.stack); process.exit(1); });
