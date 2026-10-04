#!/usr/bin/env node
/**
 * Checks that the app really works offline, in a real Chrome with the network really cut.
 *
 * Why it exists: the service worker does not run under Vite, and it does not run in the
 * Browser pane on localhost, and a page-level `fetch` shim cannot cut the worker's own
 * network. So what the worker, its caches and the local library do when the connection goes
 * was only ever checked by hand, in airplane mode on a phone. This drives a headless Chrome
 * over the DevTools protocol instead and takes the connection away with
 * `Network.emulateNetworkConditions` on the page *and* on the service-worker target, which
 * is the only way the worker's own requests are cut too.
 *
 * It signs in as the demo account, opens a receipt that carries two PDFs and an image, and
 * then checks, in order: the worker is installed and in control; a file that is not on the
 * device says so at once; the worker, its caches and the library survive being offline; a
 * file opened online draws again offline; and a file added offline goes to the device
 * and uploads when the connection returns. Then search, offline: a phrase from a note's
 * body finds the note; a phrase that is only in a PDF finds nothing while its notebook is
 * not kept offline, and the line under the results says files went unsearched; once the
 * notebook is kept it finds the note; and when the connection returns the server's answer
 * replaces the device's in the row already on screen. Each check prints one PASS or FAIL
 * line, and the exit code is 0 only if every one passed.
 *
 *   pnpm dev                              # in another terminal
 *   pnpm seed:demo                        # once
 *   pnpm --filter @unbent/web build       # the Worker serves apps/web/dist
 *   pnpm gate:offline
 *
 * `BASE` aims it at another Worker (default: this checkout's API port, which serves the
 * built app beside the API); `CHROME` names the browser. Never point it at Vite's port: Vite
 * does not run the worker, so every check would fail for a reason that is not the app's.
 *
 * It leaves nothing behind: a throwaway Chrome profile, removed at the end, and the test
 * note's body and the file it adds are put back.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { portsFor } from './ports.mjs';

// The demo account `pnpm seed:demo` makes; the same constants as scripts/seed-demo.mjs.
const EMAIL = 'demo@example.com';
const PASSWORD = 'demo-password-1234';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Not 9222, which is where a person's own debugging Chrome usually is.
const DEBUG_PORT = 9445;
const FILE = 'gate-photo.png';

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * This checkout's usual API port, from `portsFor` rather than assumed: a worktree's ports
 * are derived from its name (AGENTS.md). The usual pair, not the next free one the
 * `ports.mjs` command line prints — with the dev server up, that pair is the one it is
 * on, and "next free" is by definition where nothing is listening. When `pnpm dev` said
 * its usual pair was taken and moved, pass what it printed as `BASE`.
 */
function baseUrl() {
  if (process.env.BASE) return process.env.BASE.replace(/\/$/, '');
  return `http://localhost:${portsFor(path.dirname(here)).api}`;
}

/*
 * What the search checks look for, from `packages/seed`: a word in the body of a
 * showcase note, and a line that is on a coupon's PDF and nowhere in its note.
 */
const BODY_QUERY = 'crumb';
const BODY_TITLE = 'Sourdough';
const PDF_QUERY = 'take 15% off your order';
const PDF_TITLE = 'Acme Outfitters';
const PDF_NOTEBOOK = 'Coupons';

const results = [];
const logs = [];
/** Answers seen from the route that hands a device files' text, which is how the gate knows the index has been fed. */
let textsAnswered = 0;

function report(name, ok, why) {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` -- ${why}`}`);
}

function dumpLogs() {
  if (!logs.length) return;
  console.log('\nLast console errors from the page and the service worker:');
  for (const l of logs.slice(-10)) console.log(`  ${l}`);
}

/** Poll until `fn` returns something truthy or the deadline passes. Returns the last value. */
async function until(fn, ms) {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try {
      last = await fn();
    } catch (e) {
      last = String(e);
    }
    if (last && typeof last !== 'string') return last;
    if (typeof last === 'string' && last.startsWith('ok')) return last;
    if (Date.now() > end) return false;
    await sleep(300);
  }
}

async function main() {
  if (!fs.existsSync(CHROME)) {
    console.log(`FAIL  Chrome not found at ${CHROME}; set CHROME to its path`);
    return 1;
  }
  const BASE = baseUrl();
  try {
    const r = await fetch(`${BASE}/api/health`);
    if (!r.ok) throw new Error(String(r.status));
  } catch (e) {
    console.log(`FAIL  nothing answers at ${BASE} (${e.message}); start it with pnpm dev`);
    return 1;
  }
  const busy = await fetch(`http://localhost:${DEBUG_PORT}/json/version`).then(() => true, () => false);
  if (busy) {
    console.log(`FAIL  port ${DEBUG_PORT} is already serving a DevTools endpoint; close that Chrome first`);
    return 1;
  }

  // A fresh profile: the point is a note that was never opened here, and a worker and
  // library that start from nothing.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'unbent-gate-'));
  const chrome = spawn(
    CHROME,
    ['--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, '--window-size=420,900', 'about:blank'],
    { stdio: 'ignore' },
  );
  let ws;
  try {
    return await run(BASE, chrome, (w) => (ws = w));
  } finally {
    try { ws?.close(); } catch {}
    chrome.kill();
    // Chrome may still be flushing the profile as it exits.
    for (let i = 0; i < 10; i++) {
      try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(300); }
    }
  }
}

async function run(BASE, chrome, keepSocket) {
  let version;
  for (let i = 0; i < 60 && !version; i++) {
    try { version = await (await fetch(`http://localhost:${DEBUG_PORT}/json/version`)).json(); } catch { await sleep(250); }
  }
  if (!version) {
    console.log('FAIL  Chrome started but its DevTools endpoint never answered');
    return 1;
  }
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  keepSocket(ws);
  await new Promise((r) => (ws.onopen = r));

  let id = 0;
  const waiting = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); return; }
    if (d.method === 'Network.responseReceived' && d.params.response.url.includes('/api/attachments/texts') && d.params.response.status === 200) textsAnswered += 1;
    if (d.method === 'ServiceWorker.workerErrorReported') logs.push(`worker error: ${d.params.errorMessage.errorMessage.slice(0, 300)}`);
    else if (d.method === 'Runtime.exceptionThrown') logs.push(`exception: ${(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text).slice(0, 300)}`);
    else if (d.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(d.params.type)) logs.push(`console.${d.params.type}: ${d.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 300)}`);
  };
  // A timeout on every call: Network.enable and friends hang forever on some target types,
  // and a hang must be a failure, not a stuck process.
  const send = (method, params = {}, sessionId) =>
    new Promise((res) => {
      const i = ++id;
      waiting.set(i, res);
      setTimeout(() => { if (waiting.delete(i)) res({ timeout: true }); }, 20000);
      ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const created = await send('Target.createTarget', { url: `${BASE}/login` });
  const targetId = created.result?.targetId;
  const attached = targetId && (await send('Target.attachToTarget', { targetId, flatten: true }));
  const page = attached?.result?.sessionId;
  if (!page) {
    console.log('FAIL  could not open a page in Chrome');
    return 1;
  }
  for (const m of ['Runtime.enable', 'Page.enable', 'Network.enable', 'ServiceWorker.enable']) await send(m, {}, page);

  /** Evaluate in the page; a throw comes back as a string beginning "ERR". */
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, page);
    if (r.timeout) return 'ERR timeout';
    if (r.result?.exceptionDetails) return `ERR ${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text}`.slice(0, 300);
    return r.result?.result?.value;
  };
  const goto = (url) => send('Page.navigate', { url }, page);

  // Emulation is per session, so each target is attached once and its session reused; a
  // second attach would leave the first one's conditions in force. Workers (type `worker`)
  // are skipped: they hang on Network.enable.
  const sessions = new Map([[targetId, page]]);
  async function network(offline) {
    const r = await send('Target.getTargets');
    for (const t of r.result?.targetInfos ?? []) {
      if (!['page', 'service_worker'].includes(t.type) || !t.url.startsWith(BASE)) continue;
      if (!sessions.has(t.targetId)) {
        const a = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
        if (!a.result) continue;
        sessions.set(t.targetId, a.result.sessionId);
        await send('Network.enable', {}, a.result.sessionId);
        await send('Runtime.enable', {}, a.result.sessionId);
      }
      await send('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, sessions.get(t.targetId));
    }
  }
  /** Navigation can bring a new service-worker target, so cut again after it. */
  async function offlineAt(url) {
    await network(true);
    await goto(url);
    await sleep(500);
    await network(true);
  }

  // Sign in from the page, so the cookie is the page's own.
  await sleep(1500);
  const status = await ev(`fetch('/api/auth/sign-in/email',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:${JSON.stringify(EMAIL)},password:${JSON.stringify(PASSWORD)}})}).then(r=>r.status)`);
  if (status !== 200) {
    console.log(`FAIL  sign-in as ${EMAIL} answered ${status}; run pnpm seed:demo first`);
    return 1;
  }

  // The test note: a receipt with at least one PDF and one image.
  const note = await ev(`(async()=>{const r=await fetch('/api/notes?notebook=Receipts&limit=50');const j=await r.json();const list=Array.isArray(j)?j:(j.notes??j.items??[]);const n=list.find(n=>(n.attachments??[]).some(a=>a.mimeType==='application/pdf'||a.contentType==='application/pdf')&&(n.attachments??[]).some(a=>(a.mimeType??a.contentType??'').startsWith('image/')));return n?{id:n.id,title:n.title}:null})()`);
  if (!note || typeof note !== 'object') {
    console.log(`FAIL  no note in Receipts with a PDF and an image (${note}); run pnpm seed:demo first`);
    return 1;
  }
  const noteUrl = `${BASE}/notes/${note.id}`;
  const original = await ev(`fetch('/api/notes/${note.id}').then(r=>r.json()).then(n=>n.body)`);
  if (typeof original !== 'string' || original.startsWith('ERR')) {
    console.log(`FAIL  could not read the test note's body (${original})`);
    return 1;
  }
  // A previous run that died halfway may have left the file behind.
  await ev(`fetch('/api/notes/${note.id}/files/${FILE}',{method:'DELETE'}).then(r=>r.status)`);

  // The first load registers the worker; it controls the page only from the next one.
  await goto(`${BASE}/notes`);
  await sleep(4000);
  await goto(`${BASE}/notes`);
  const libraryReady = () => ev(`document.querySelectorAll('a[href^="/notes/"]').length>0`);

  const state = () => ev(`(async()=>{const out={};for(const n of await caches.keys())if(n.startsWith('workbox-precache'))out.precache=(await (await caches.open(n)).keys()).length;const regs=await navigator.serviceWorker.getRegistrations();const root=await navigator.storage.getDirectory();const opfs=[];for await (const [n] of root.entries())opfs.push(n);return {controlled:!!navigator.serviceWorker.controller,active:regs.some(r=>r.active?.state==='activated'),precache:out.precache??0,sqlite:opfs.some(n=>n.endsWith('.sqlite')),opfs}})()`);

  let precache = 0;
  try {
    // 1
    {
      const s = await until(async () => {
        const v = await state();
        return v && typeof v === 'object' && v.controlled && v.active && v.precache > 100 && (await libraryReady()) ? v : null;
      }, 30000);
      const v = s || (await state());
      report('worker installed and in control', !!s, `state ${JSON.stringify(v)}${await libraryReady() ? '' : ', note list never rendered'}`);
      if (!s) { dumpLogs(); return 1; }
      precache = s.precache;
    }

    // 2
    {
      await offlineAt(noteUrl);
      const look = () => ev(`(()=>{const pdfs=[...document.querySelectorAll('.cm-md-pdf')];const imgs=[...document.querySelectorAll('.cm-md-image')];return {pdfs:pdfs.map(w=>w.querySelector('.file-unavailable')?.textContent??'',),rendering:pdfs.some(w=>/Rendering/.test(w.textContent)),imgs:imgs.map(w=>!!w.querySelector('.file-unavailable'))}})()`);
      const ok = await until(async () => {
        const v = await look();
        return v && typeof v === 'object' && v.pdfs.length > 0 && v.pdfs.every((t) => /Not available offline/.test(t)) && !v.rendering && v.imgs.length > 0 && v.imgs.every(Boolean) ? v : null;
      }, 10000);
      report('a file that is not on the device says so, at once', !!ok, `saw ${JSON.stringify(await look())}`);
    }

    // 3
    {
      for (let i = 0; i < 5; i++) { await sleep(3000); await network(true); }
      const v = await state();
      const good = v && typeof v === 'object' && v.active && v.precache === precache && v.sqlite;
      report('the worker, its caches and the library survive being offline', !!good, `precache ${precache} -> ${v?.precache}, active ${v?.active}, sqlite ${v?.sqlite}, opfs ${JSON.stringify(v?.opfs)}`);
    }

    // 4
    {
      const drawn = () => ev(`(()=>{const pdfs=[...document.querySelectorAll('.cm-md-pdf')];const imgs=[...document.querySelectorAll('.cm-md-image img')];return pdfs.length>0&&imgs.length>0&&pdfs.every(w=>!w.querySelector('.cm-md-pdf-status, .file-unavailable')&&(w.querySelector('canvas')?.width??0)>300)&&imgs.every(i=>i.naturalWidth>0)?'ok':JSON.stringify({pdfs:pdfs.map(w=>w.querySelector('.cm-md-pdf-status, .file-unavailable')?.textContent??(w.querySelector('canvas')?.width??'no canvas')),imgs:imgs.map(i=>i.naturalWidth)})})()`);
      await network(false);
      await goto(noteUrl);
      const online = await until(drawn, 30000);
      let result = false;
      if (online) {
        await offlineAt(noteUrl);
        result = await until(drawn, 10000);
      }
      report('a file opened online draws again offline', !!result, online ? `offline: ${await drawn()}` : `never drew online: ${await drawn()}`);
    }

    // 5
    {
      const pendingHas = () => ev(`(async()=>{try{const root=await navigator.storage.getDirectory();for await (const [n,h] of root.entries()){if(!n.startsWith('unbent-files-'))continue;const p=await h.getDirectoryHandle('pending');const d=await p.getDirectoryHandle(${JSON.stringify(note.id)});await d.getFileHandle(${JSON.stringify(FILE)});return true}}catch(e){}return false})()`);
      // The drop edits the body (it inserts a link); the original is restored below.
      await ev(`(async()=>{const png=await (await fetch('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')).blob();const dt=new DataTransfer();dt.items.add(new File([png],${JSON.stringify(FILE)},{type:'image/png'}));const content=document.querySelector('.cm-content');const first=content.querySelector('.cm-line').getBoundingClientRect();content.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true,clientX:first.right-2,clientY:first.top+5}))})()`);
      const fileUrl = `/api/notes/${note.id}/files/${FILE}`;
      const onDevice = await until(async () => {
        if (!(await pendingHas())) return null;
        const served = await ev(`fetch(${JSON.stringify(fileUrl)}).then(r=>r.status+' '+r.headers.get('X-Unbent-Served'))`);
        const head = await ev(`document.querySelector('.workspace-status')?.textContent?.trim()`);
        return served === '200 device' && head === 'Saved' ? { served, head } : null;
      }, 8000);
      let why = '';
      if (!onDevice) {
        why = `pending file ${await pendingHas()}, served ${await ev(`fetch(${JSON.stringify(fileUrl)}).then(r=>r.status+' '+r.headers.get('X-Unbent-Served'),e=>String(e))`)}, head ${JSON.stringify(await ev(`document.querySelector('.workspace-status')?.textContent?.trim()`))}`;
      }
      await network(false);
      const uploaded = onDevice
        ? await until(async () => {
            const listed = await ev(`fetch('/api/notes/${note.id}/files').then(r=>r.text())`);
            return typeof listed === 'string' && listed.includes(FILE) && !(await pendingHas()) ? true : null;
          }, 20000)
        : false;
      if (onDevice && !uploaded) why = `after going online: listed ${String(await ev(`fetch('/api/notes/${note.id}/files').then(r=>r.text())`)).includes(FILE)}, still pending ${await pendingHas()}`;
      report('a file added offline uploads when the connection returns', !!uploaded, why);
    }

    // Search with no connection. What the list shows for a query, read from the page.
    const searched = () => ev(`(()=>{const hits=[...document.querySelectorAll('.note-list a.note-item')].map(a=>a.textContent);return {hits,empty:[...document.querySelectorAll('.note-list .empty')].map(e=>e.textContent).join(' '),covered:document.querySelector('.search-coverage')?.textContent??null,count:document.querySelector('.note-list')?.getAttribute('aria-busy')??''}})()`);
    const searchUrl = (q) => `${BASE}/notes?q=${encodeURIComponent(q)}`;

    // 6
    {
      // Online first, so the index has had a pass over the library before the network goes.
      await goto(`${BASE}/notes`);
      await until(libraryReady, 10000);
      await sleep(4000);
      await offlineAt(searchUrl(BODY_QUERY));
      const ok = await until(async () => {
        const v = await searched();
        return v && typeof v === 'object' && v.hits.some((t) => t.includes(BODY_TITLE)) && /^Searched on this device/.test(v.covered ?? '') ? v : null;
      }, 15000);
      report('offline, a phrase from a note body finds the note', !!ok, `saw ${JSON.stringify(await searched())}`);
    }

    // 7
    {
      await offlineAt(searchUrl(PDF_QUERY));
      const ok = await until(async () => {
        const v = await searched();
        return v && typeof v === 'object' && v.hits.length === 0 && /No matches/.test(v.empty) && /without the text inside/.test(v.covered ?? '') ? v : null;
      }, 15000);
      report('offline, a phrase from a PDF in a notebook that is not kept finds nothing, and says files went unsearched', !!ok, `saw ${JSON.stringify(await searched())}`);
    }

    // 8
    {
      await network(false);
      const notebookId = await ev(`fetch('/api/notebooks').then(r=>r.json()).then(j=>(Array.isArray(j)?j:(j.notebooks??[])).find(n=>n.name===${JSON.stringify(PDF_NOTEBOOK)})?.id??null)`);
      const before = textsAnswered;
      await goto(`${BASE}/settings/notebooks/${notebookId}`);
      // The button, then the confirmation it opens, which offers the same words.
      const press = () => ev(`(()=>{const b=[...document.querySelectorAll('button')].filter(b=>b.textContent.trim()==='Keep offline'&&!b.disabled);b.at(-1)?.click();return b.length})()`);
      const asked = await until(async () => ((await press()) > 0 ? true : null), 15000);
      await sleep(500);
      await press();
      const kept = asked && (await until(() => ev(`/is kept on this device/.test(document.body.textContent)`), 10000));
      // The files' text is asked for once the notebook is kept; a moment more for it to be indexed.
      const fed = kept && (await until(async () => (textsAnswered > before ? true : null), 20000));
      await sleep(2000);
      let ok = false;
      if (fed) {
        await offlineAt(searchUrl(PDF_QUERY));
        ok = await until(async () => {
          const v = await searched();
          return v && typeof v === 'object' && v.hits.some((t) => t.includes(PDF_TITLE) && /\.pdf/.test(t)) ? v : null;
        }, 15000);
      }
      report('offline, the same phrase finds its note once the notebook is kept', !!ok, !asked ? `no Keep offline button on the notebook's page (notebook ${notebookId})` : !kept ? 'the notebook was never kept' : !fed ? 'the text of its files was never asked for' : `saw ${JSON.stringify(await searched())}`);
    }

    // 9
    {
      // The row on screen is remembered by identity: the server's answer has to land in it,
      // not in a list drawn again under the pointer.
      const marked = await ev(`(()=>{const a=[...document.querySelectorAll('.note-list a.note-item')].find(a=>a.textContent.includes(${JSON.stringify(PDF_TITLE)}));window.__gateHit=a;return !!a&&!!document.querySelector('.search-coverage')})()`);
      await network(false);
      const ok = marked === true && (await until(() => ev(`!document.querySelector('.search-coverage')&&document.contains(window.__gateHit)&&window.__gateHit.textContent.includes(${JSON.stringify(PDF_TITLE)})?'ok':'coverage '+!!document.querySelector('.search-coverage')+', row kept '+document.contains(window.__gateHit)`), 30000));
      report('back online, the server answers the same search in the rows already on screen', !!ok, marked === true ? String(await ev(`'coverage line '+!!document.querySelector('.search-coverage')+', row kept '+document.contains(window.__gateHit)`)) : 'no offline result on screen to compare with');
    }
  } finally {
    // Back to how the demo account was found, whatever happened above.
    await network(false);
    await ev(`fetch('/api/notes/${note.id}/files/${FILE}',{method:'DELETE'}).then(r=>r.status)`);
    await ev(`fetch('/api/notes/${note.id}',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({body:${JSON.stringify(original)}})}).then(r=>r.status)`);
  }

  const failed = results.some((ok) => !ok);
  if (failed) dumpLogs();
  return failed ? 1 : 0;
}

const code = await main().catch((e) => {
  console.log(`FAIL  gate crashed: ${e?.stack ?? e}`);
  dumpLogs();
  return 1;
});
process.exit(code);
