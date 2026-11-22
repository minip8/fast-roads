#!/usr/bin/env node
// The installed policies in a real browser engine: node ai/rl/browser_stint.mjs [car lcgt3] [laps 3] [track ...]
//
// Node and Chromium differ in the last bit of Math.atan2 / sin / tanh for some inputs, and a lap is chaotic, so a
// policy's lap in the browser is another lap than the tests' (test/policyLap.ts): this drives each circuit's policy
// from a fresh page load, as ?autopilot=rl does, for some laps on end in headless Chromium and prints each lap's time
// and validity and the automatic resets. Needs the dev server (npm run dev -- --port 5199 --strictPort) and a
// headless Chromium with WebGL (CHROME=<binary>; default Playwright's chrome-headless-shell under ~/.cache).
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [car = 'lcgt3', lapsArg = '3', ...only] = process.argv.slice(2);
const LAPS = Number(lapsArg), URL = process.env.GAME_URL ?? 'http://localhost:5199/', PORT = 9334;
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(readFileSync(join(root, 'public/ai/policies.json'), 'utf8'))[car] ?? {};
const tracks = only.length ? only : Object.keys(manifest.tracks ?? {});
const cache = join(process.env.HOME, '.cache/ms-playwright');
const bin = process.env.CHROME ?? join(cache, readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell')).sort().pop(), 'chrome-headless-shell-linux64/chrome-headless-shell');
const profile = mkdtempSync(join(tmpdir(), 'browser-stint-'));
const proc = spawn(bin, ['--headless', `--remote-debugging-port=${PORT}`, '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
  '--window-size=640,360', '--no-first-run', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
try {
  let targets;
  for (let k = 0; k < 50 && !targets; k++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); } catch { await sleep(200); } }
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  await send('Runtime.enable'); await send('Page.enable');
  console.log((await send('Browser.getVersion')).result.product);
  let script = null;
  for (const track of tracks) {
    // the circuit and car are saved settings; no ?autopilot in the URL, so the menu stays open and only simulate() ticks
    const settings = { track, car, tc: 'on', gearbox: 'auto', shadows: 'off', scenery: 'low', resolution: 50, weather: 'off', sound: 'off', ghost: 'off', mirror: 'off' };
    if (script) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: script });
    script = (await send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.clear(); localStorage.setItem('fastroads.settings', ${JSON.stringify(JSON.stringify(settings))}); } catch {}` })).result.identifier;
    await send('Page.navigate', { url: URL });
    let ready = false;
    for (let k = 0; k < 240 && !ready; k++) { await sleep(500); ready = await ev('!!window.__game').catch(() => false); }
    if (!ready || !(await ev(`__game.setAutopilot('rl')`))) { console.log(`${track.padEnd(12)} ${ready ? 'no policy loaded' : 'the page did not start'}   <<<`); bad++; continue; }
    const file = await ev('__game.policy.file'), resets0 = await ev('__game.session.resets');
    let n = 0;
    for (let chunk = 0; chunk < LAPS * 12 && n < LAPS; chunk++) n = await ev(`(() => { const g = __game; for (let k = 0; k < 200 && g.timing.laps.length < ${LAPS}; k++) g.simulate(0.1, 'rl'); return g.timing.laps.length; })()`);
    const laps = await ev(`__game.timing.laps.map((l) => [l.time, l.valid]).reverse()`), resets = (await ev('__game.session.resets')) - resets0;
    const ok = laps.length === LAPS && laps.every((l) => l[1]) && !resets;
    bad += !ok;
    console.log(`${track.padEnd(12)} ${file.padEnd(24)} ${laps.map(([t, v]) => t.toFixed(3) + (v ? '' : '!')).join('  ')}  resets ${resets}${ok ? '' : '   <<<'}`);
  }
  ws.close();
  console.log(`${tracks.length - bad}/${tracks.length} circuits: ${LAPS} valid laps on end, no resets`);
} finally {
  proc.kill('SIGKILL');
  rmSync(profile, { recursive: true, force: true });
}
process.exit(bad ? 1 : 0);
