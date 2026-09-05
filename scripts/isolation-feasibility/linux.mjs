// Run with: node scripts/isolation-feasibility/linux.mjs
// Experimental Linux mechanism probes. Never used to launch the product.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
const fixture = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(fixture, '../..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibestudio-isolation-'));
const children = new Set();
const grants = new Set();
const report = { kind: 'mechanism feasibility, not production isolation certification', platform: os.platform(), release: os.release(), orchestratorNode: process.version, guestNode: spawnSync('/usr/bin/node', ['--version'], { encoding: 'utf8' }).stdout.trim(), bwrap: spawnSync('bwrap', ['--version'], { encoding: 'utf8' }).stdout.trim(), results: [] };
const wait = ms => new Promise(r => setTimeout(r, ms));
let listener, broker;
function launch(args) {
  const p = spawn('bwrap', args, { env: { PATH: '/usr/bin:/bin', ISOLATION_HOST_SECRET: 'synthetic-secret' }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(p);
  p.closed = new Promise(resolve => p.on('close', (code, signal) => { children.delete(p); resolve({ code, signal }); }));
  p.messages = []; p.stderrText = ''; let buffer = '';
  p.stdout.on('data', b => { buffer += b; let at; while ((at = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); try { p.messages.push(JSON.parse(line)); } catch { p.stderrText += line + '\n'; } } });
  p.stderr.on('data', b => p.stderrText += b);
  return p;
}
async function message(p, key) {
  for (let i = 0; i < 200; i++) { const m = p.messages.find(x => key in x); if (m) return m; if (p.exitCode !== null || p.signalCode !== null) break; await wait(100); }
  throw new Error(`Missing ${key}: ${p.stderrText.slice(-3000)}`);
}
function base(state) {
  return ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--clearenv',
    '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/run', '--ro-bind', fixture, '/fixture', '--ro-bind', path.join(repo, 'node_modules'), '/deps',
    '--bind', state, '/state', '--setenv', 'HOME', '/state', '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'LANG', 'C.UTF-8', '--chdir', '/state'];
}
try {
  await fs.writeFile(path.join(root, 'host-canary'), 'host-only');
  await fs.writeFile(path.join(root, 'selected-host-file'), 'selected-host-value');
  listener = http.createServer((req, res) => res.end('mediated-network-value'));
  await new Promise(r => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port;
  await new Promise((resolve, reject) => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); resolve(); }); s.on('error', reject); });
  broker = net.createServer({ allowHalfOpen: true }, s => {
    let data = ''; s.on('error', () => {}); s.on('data', b => data += b);
    s.on('end', async () => {
      try {
        const q = JSON.parse(data);
        if (!grants.has(q.token)) return s.end(JSON.stringify({ denied: true }));
        const value = q.resource === 'selected' ? await fs.readFile(path.join(root, 'selected-host-file'), 'utf8')
          : q.resource === 'network' ? await (await fetch(`http://127.0.0.1:${port}`)).text() : undefined;
        s.end(JSON.stringify(value !== undefined ? { value } : { denied: true }));
      } catch { s.destroy(); }
    });
  });
  await new Promise(r => broker.listen(path.join(root, 'broker.sock'), r));
  for (const scope of (process.argv.includes('--gui-only') || process.argv.includes('--hub-only') ? [] : ['different-workspaces', 'different-contexts'])) {
    const jobs = [];
    for (const label of ['A', 'B']) {
      const dir = path.join(root, `${scope}-${label}`); await fs.mkdir(dir); await fs.mkdir(path.join(dir, 'input')); await fs.mkdir(path.join(dir, 'state'));
      await fs.writeFile(path.join(dir, 'input/value'), label);
      const token = randomUUID(); grants.add(token);
      const args = [...base(path.join(dir, 'state')), '--ro-bind', path.join(dir, 'input'), '/input', '--ro-bind', path.join(root, 'broker.sock'), '/run/broker.sock'];
      const env = { JOB_LABEL: label, JOB_TOKEN: token, HOST_PID: String(process.pid), HOST_PORT: String(port), DENIED_PATHS: JSON.stringify({ 'host canary absent': path.join(root, 'host-canary'), 'sibling input absent': path.join(root, `${scope}-${label === 'A' ? 'B' : 'A'}/input/value`), 'host control socket absent': '/run/user/1000/bus', 'host X11 socket absent': '/tmp/.X11-unix/X1' }) };
      for (const [k, v] of Object.entries(env)) args.push('--setenv', k, v);
      const p = launch([...args, '--', '/usr/bin/node', '/fixture/guest.cjs']); jobs.push({ p, token, dir, args });
    }
    for (const [i, j] of jobs.entries()) report.results.push({ scope, job: i, ...(await message(j.p, 'ready')) });
    grants.delete(jobs[0].token); jobs[0].p.stdin.write('revoked\n');
    report.results.push({ scope, ...(await message(jobs[0].p, 'revoked')) });
    jobs[0].p.stdin.write('stop\n'); await jobs[0].p.closed;
    const heartbeat = path.join(jobs[0].dir, 'state/heartbeat');
    const before = (await fs.stat(heartbeat)).size; await wait(200); const after = (await fs.stat(heartbeat)).size;
    report.results.push({ scope, detachedDescendantRetired: before === after });
    jobs[1].p.stdin.write('ping\n'); report.results.push({ scope, peerUnaffected: (await message(jobs[1].p, 'alive')).alive });
    const restartArgs = jobs[0].args.slice(); const inputAt = restartArgs.indexOf('/input'); restartArgs.splice(inputAt - 2, 3);
    const restarted = launch([...restartArgs, '--', '/usr/bin/node', '-e', "const fs=require('fs');console.log(JSON.stringify({oldInputAbsent:!fs.existsSync('/input/value')}))"]);
    report.results.push({ scope, restart: await message(restarted, 'oldInputAbsent') }); await restarted.closed;
    jobs[1].p.stdin.write('stop\n'); await jobs[1].p.closed;
  }
  if (!process.argv.includes('--gui-only')) {
    const hubState = path.join(root, 'hub'); await fs.mkdir(hubState);
    const hub = launch([...base(hubState), '--ro-bind', repo, '/app', '--', '/usr/bin/node', '/fixture/hub.cjs']);
    const timer = setTimeout(() => hub.kill('SIGKILL'), 25000);
    const result = await hub.closed; clearTimeout(timer);
    report.results.push({ hubFixture: hub.messages, exit: result, log: hub.stderrText.slice(-3000), scope: 'prebuilt hub, no workspace bootstrap' });
  }
  if (!process.argv.includes('--hub-only')) {
  const guiState = path.join(root, 'gui'); await fs.mkdir(guiState);
  const gui = launch([...base(guiState), '--dir', '/tmp/.X11-unix', '--setenv', 'DISPLAY', ':99', '--setenv', 'HOST_PORT', String(port), '--setenv', 'HOST_CANARY', path.join(root, 'host-canary'), '--', '/bin/sh', '-c', 'Xvfb :99 -screen 0 800x600x24 -nolisten tcp -extension GLX & exec /deps/electron/dist/electron --disable-gpu /fixture/electron.cjs']);
  const timeout = setTimeout(() => gui.kill('SIGKILL'), 20000);
  const guiExit = await gui.closed; clearTimeout(timeout);
  report.results.push({ graphicalFixture: gui.messages, exit: guiExit, log: gui.stderrText.slice(-5000), scope: 'private Xvfb, no host desktop or GPU' });
  }
} catch (e) { report.error = e.stack; process.exitCode = 1; }
finally {
  for (const p of children) p.kill('SIGKILL');
  await Promise.all([...children].map(p => p.closed));
  if (broker) await new Promise(r => broker.close(r));
  if (listener) await new Promise(r => listener.close(r));
  await fs.rm(root, { recursive: true, force: true });
  report.cleanup = 'all owned bwrap processes awaited, fixture sockets closed, temporary directory removed';
  const failed = report.error || report.results.some(r => r.checks?.some(c => !c.ok) || r.revoked === false || r.detachedDescendantRetired === false || r.peerUnaffected === false || r.restart?.oldInputAbsent === false || (r.hubFixture && !r.hubFixture.some(x => x.hubReady)) || (r.graphicalFixture && (r.exit.code !== 0 || r.exit.signal !== null || !r.graphicalFixture.some(x => x.electron && x.rendererSandboxRequested === true && x.hostCanaryDeniedFromMain && x.hostLoopbackDeniedFromChromiumNetwork))));
  report.status = failed ? 'incomplete: at least one probed requirement failed' : 'selected mechanism probes passed; full U1 not established';
  if (failed) process.exitCode = 1;
  console.log(JSON.stringify(report, null, 2));
}
