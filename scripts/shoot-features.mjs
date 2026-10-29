#!/usr/bin/env node
/**
 * Takes the pictures and clips the features page (`/features`) shows, from the demo
 * library on a local instance, in both themes, and writes them to
 * `apps/web/public/features/`.
 *
 * Why a script: the front page's two screenshots were taken by hand (2026-10-17), and two
 * was about the most anyone would take by hand twice over, once a theme. The features
 * page shows thirteen pictures and four clips, and a page of stale pictures is worse than
 * one with none: it shows a control that has moved and a layout that has changed, and
 * the person who notices is the one deciding whether to trust the rest of the page. So
 * every picture is a scene here, and the whole set is one command to take again.
 *
 * Headless Chrome over the DevTools protocol, the offline gate's shape
 * (`offline-gate.mjs`), against this checkout's Vite port: nothing here needs the service
 * worker. The theme is emulated (`prefers-color-scheme`), never set in the app, so each
 * scene is taken twice and the page shows the one that matches its reader. A still is a
 * screenshot turned into WebP by ffmpeg; a clip is the page's screencast, sampled at a
 * steady frame rate, with the waits nobody should sit through (an Auto-fill's round trip)
 * cut to a moment, and encoded as VP9 and H.264, with its first frame as the poster.
 * ffmpeg is the one tool outside the repo it needs, and `brew install ffmpeg` is how it
 * gets there.
 *
 * The pointer in a clip is drawn by the page, not by Chrome: headless Chrome draws none,
 * and a clip where fields fill themselves with nothing pressing anything reads as magic
 * rather than as a feature. `__cursor` is an arrow the script moves before each click.
 * A scene's chrome that is the dev server's and not the product's (the instance ribbon)
 * is hidden the same way. Both live only in the throwaway profile this starts.
 *
 * What a run changes in the demo account it puts back: the files the drop clip adds
 * become notes, which are purged at the end of the theme's run, and the edit that gives a
 * note a history is made and then unmade.
 *
 *   pnpm dev                              # in another terminal
 *   pnpm seed:demo                        # once
 *   pnpm shoot:features                   # every scene, both themes
 *   pnpm shoot:features search table      # only these scenes
 *   pnpm shoot:features --theme dark      # one theme
 *   pnpm shoot:features --list            # the scene names, and nothing taken
 *
 * `BASE` aims it at another instance (default: this checkout's web port); `CHROME` names
 * the browser; `KEEP_FRAMES` leaves a clip's frames on disk for a look.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { portsFor } from './ports.mjs';

// The demo account `pnpm seed:demo` makes; the same constants as scripts/seed-demo.mjs.
const EMAIL = 'demo@example.com';
const PASSWORD = 'demo-password-1234';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Not 9222 (a person's own debugging Chrome) and not the gate's 9445, so the two can run at once.
const DEBUG_PORT = 9446;
const FPS = 30;
/** The WebP's quality; 80 keeps the text of a screenshot crisp at a quarter of the PNG. */
const WEBP_QUALITY = 80;

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
/**
 * The ids of the notes the drop clip made, written as soon as they are known and removed
 * once they are purged: a run that dies in between leaves the file, and the next run
 * purges them from it. Finding them again by their file names would mean reading every
 * note's files, since Auto-fill can refile the one it names into any notebook. Named
 * for the checkout, since each worktree's instance is its own.
 */
const DROPPED_FILE = path.join(os.tmpdir(), `unbent-shoot-features-dropped-${path.basename(root)}.json`);
const OUT = path.join(root, 'apps/web/public/features');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The two frames every scene is taken in. Desktop is the front page's 1280 by 800 at a
 * device pixel ratio of 2, so the picture is sharp on the screens that show it; the phone
 * is a 390-wide viewport, which is what the front page's phone shot is too.
 */
const DEVICES = {
  desktop: { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false },
  phone: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
};
const THEMES = ['light', 'dark'];

/**
 * Loopback only, as `seed:demo` is: this signs in with the password written in the seed
 * script, edits a note and purges notes, and aimed at a shared instance where that
 * account exists it would do all of that there.
 */
function baseUrl() {
  const base = (process.env.BASE ?? `http://localhost:${portsFor(root).web}`).replace(/\/$/, '');
  const host = new URL(base).hostname;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) throw new Error(`BASE must be loopback, not ${host}`);
  return base;
}

/**
 * The scenes. Each takes one picture, or one clip, in one device frame; a scene that is
 * wanted at both widths is two entries, so the phone one can be a different screen
 * (the list and the note are two screens there).
 *
 * `run` drives the page to the state the picture shows, from the scene's address, with
 * the helpers in `page`. A clip's `run` is recorded from its first line to its last;
 * `page.hold` runs a wait inside it that the clip keeps only a moment of. `after` undoes
 * what `run` did to the profile, which the next theme's scenes share.
 *
 * The order is the order a run takes them: the drop and Auto-fill first, since Auto-fill
 * wants the dropped note, and the dropped notes purged after the two (`purgeAfter`), so
 * no still shows them.
 */
const SCENES = [
  {
    name: 'drop',
    clip: true,
    device: 'desktop',
    url: '/notes?notebook=Receipts&view=list',
    run: async (p, data) => {
      data.before = await p.ev(`window.__notes('notebook=Receipts&limit=50').then((notes) => notes.map((n) => n.id))`);
      await p.cursor(640, 120);
      await sleep(600);
      // Three of the seed's receipt scans, under the names a scanner gives them, carried
      // as a real `DataTransfer` of files: the list's drop zone reads nothing else.
      await p.ev(`window.__drag(${JSON.stringify(data.dropFiles)})`);
      for (const [x, y] of [[560, 200], [520, 300], [500, 360]]) {
        await p.cursor(x, y, 350);
        await p.ev(`window.__dragOver(${x}, ${y})`);
      }
      await sleep(1200);
      await p.ev('window.__drop()');
      await p.cursor(760, 360, 400);
      // The three notes land in the list as their uploads go; give them the time.
      await p.waitFor(`document.body.innerText.includes(${JSON.stringify(data.dropTitles[2])})`, 15000);
      await sleep(2500);
      data.dropped = await p.ev(`window.__notes('notebook=Receipts&limit=50').then((notes) => notes.filter((n) => !${JSON.stringify(data.before)}.includes(n.id)).map((n) => n.id))`);
      fs.writeFileSync(DROPPED_FILE, JSON.stringify(data.dropped));
    },
  },
  {
    name: 'autofill',
    clip: true,
    device: 'desktop',
    // The dropped notes go once this clip has them: every still after it is of the
    // library as the seed made it, with no "Scan 2026-10-21" at the top of the list.
    purgeAfter: true,
    url: (data) => `/notes/${data.dropped?.[0] ?? ''}?notebook=Receipts`,
    run: async (p) => {
      await p.waitFor(`!!document.querySelector('[aria-label="Auto-fill"]')`);
      // The first press on a device explains what Auto-fill sends and asks once
      // (`autofill-notice.ts`); the clip is of the press after that one.
      await p.ev(`fetch('/api/auth/get-session').then(r => r.json()).then(s => localStorage.setItem('unbent.autofillExplained.' + s.user.id, new Date().toISOString()))`);
      // The editor shows the source of the line its cursor is on, and a fresh note's
      // cursor is on the file's link; nothing in the clip types, so the editor is left.
      await p.ev('document.activeElement?.blur()');
      // The indexer reads the scan's text in the page after the upload, and the editor
      // draws the file's preview under its link; a moment for both.
      await sleep(2500);
      await p.cursor(640, 400);
      await sleep(800);
      await p.click('[aria-label="Auto-fill"]');
      // The round trip to the model is seconds; the clip keeps a moment of "Reading…".
      await p.hold(() => p.waitFor(`!document.querySelector('.autofill-btn.busy')`, 60000), 1.2);
      await sleep(3500);
    },
  },
  {
    name: 'search',
    clip: true,
    device: 'desktop',
    url: '/notes',
    run: async (p) => {
      await p.cursor(640, 300);
      await sleep(500);
      await p.click('[aria-label="Search notes"]');
      await sleep(400);
      // A word that is on the photo of the receipt and nowhere else in the library.
      await p.type('dumplings', 90);
      await p.waitFor(`document.body.innerText.includes('Blue Fern')`, 10000);
      await sleep(1800);
      await p.click('aside a[href*="/notes/"]', 'Blue Fern Noodle Bar: $');
      await p.waitFor(`!!document.querySelector('img[src*="blue-fern"]')`, 10000).catch(() => {});
      await sleep(2500);
    },
  },
  {
    name: 'views',
    clip: true,
    device: 'desktop',
    url: '/notes?notebook=Receipts&view=list',
    run: async (p) => {
      await p.cursor(640, 400);
      await sleep(600);
      await p.click('[aria-label="Navigation"] button, [aria-label="Navigation"] a', 'Not reimbursed');
      await p.waitFor(`!!document.querySelector('table')`, 10000);
      await sleep(2000);
      await p.click('[aria-label="Navigation"] button, [aria-label="Navigation"] a', 'Dining');
      await sleep(2500);
    },
  },
  { name: 'list', device: 'phone', url: '/notes?view=list' },
  { name: 'note', device: 'desktop', url: (data) => `/notes/${data.receipt.id}?notebook=Receipts` },
  { name: 'note', device: 'phone', url: (data) => `/notes/${data.receipt.id}?notebook=Receipts` },
  { name: 'table', device: 'desktop', url: '/notes?notebook=Receipts&view=table' },
  { name: 'cards', device: 'desktop', url: '/notes?notebook=Restaurants&view=cards' },
  { name: 'cards', device: 'phone', url: '/notes?notebook=Restaurants&view=cards' },
  {
    name: 'select',
    device: 'desktop',
    url: '/notes?notebook=Receipts&view=list',
    run: async (p) => {
      const rows = await p.ev(`[...document.querySelectorAll('aside a[href*="/notes/"]')].slice(1, 4).map(a => { const r = a.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })`);
      for (const [x, y] of rows) await p.clickAt(x, y, { meta: true });
      await sleep(600);
    },
  },
  {
    name: 'history',
    device: 'desktop',
    url: (data) => `/notes/${data.edited.id}?notebook=Recipes`,
    run: async (p) => {
      await p.click('[aria-label="More actions"]');
      await sleep(300);
      await p.click('[role="menuitem"], button', 'History');
      await p.waitFor(`!!document.querySelector('.history-sheet li button')`, 10000);
      await p.click('.history-sheet li button');
      await sleep(400);
      await p.click('.history-sheet [role="radio"]', 'Changes');
      await sleep(800);
    },
  },
  { name: 'notebook', device: 'desktop', url: (data) => `/settings/notebooks/${data.receiptsId}` },
  { name: 'import', device: 'desktop', url: '/settings/import' },
  { name: 'export', device: 'desktop', url: '/settings/export' },
  {
    name: 'offline',
    device: 'desktop',
    url: (data) => `/settings/notebooks/${data.receiptsId}`,
    // Keeping a notebook offline is a choice of this device, so the picture shows one
    // made rather than the page's empty state: Receipts is kept. The profile outlives a
    // theme, so the keep is let go after the still (`after`), or the other theme's
    // Notebook still shows it kept and this scene finds no Keep offline to press.
    run: async (p) => {
      await p.click('button', 'Keep offline');
      await p.click('[aria-label="Confirm keep offline"] button', 'Keep offline');
      await p.waitFor(`document.body.innerText.includes('are on this device')`, 30000);
      await p.open('/settings/offline');
    },
    after: async (p, data) => {
      await p.open(`/settings/notebooks/${data.receiptsId}`);
      await p.click('button', 'Stop keeping');
      await p.click('[aria-label="Confirm stop keeping"] button', 'Remove from this device');
      await p.waitFor(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Keep offline')`, 15000);
    },
  },
  {
    name: 'assistants',
    device: 'desktop',
    url: '/settings/connected-apps',
    // The page states the instance's own address, which here is a local port; the
    // picture shows the one a reader would see.
    run: (p) => p.ev(`(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); for (let n; (n = w.nextNode()); ) if (n.nodeValue.includes(location.host)) n.nodeValue = n.nodeValue.replaceAll('http://' + location.host, 'https://unbent.app'); })()`),
  },
];

/**
 * Added to every document before the app's own script: the pointer a clip draws, the
 * drag the drop clip stages, and the style that hides the dev server's chrome.
 */
const PRELUDE = `
(() => {
  const style = document.createElement('style');
  style.textContent = \`
    .instance-ribbon { display: none !important; }
    #__cursor { position: fixed; left: 0; top: 0; width: 22px; height: 22px; z-index: 2147483647;
      pointer-events: none; opacity: 0; transition: transform 0.3s cubic-bezier(.2,.7,.3,1), opacity 0.2s;
      filter: drop-shadow(0 1px 2px rgb(0 0 0 / 0.45)); }
  \`;
  const cursor = document.createElement('div');
  cursor.id = '__cursor';
  cursor.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M5 3l14 9-6 1.5L16 20l-3 1.3-3-6.5L5 19z" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  document.addEventListener('DOMContentLoaded', () => { document.head.appendChild(style); document.body.appendChild(cursor); });
  window.__cursor = (x, y, show) => { cursor.style.transform = 'translate(' + x + 'px,' + y + 'px)'; cursor.style.opacity = show ? '1' : '0'; };
  // The notes a list address answers: a page, \`items\` beside a cursor (routes/notes.ts).
  window.__notes = async (query) => (await (await fetch('/api/notes?' + query)).json()).items;
  window.__rect = (selector, text) => {
    const all = [...document.querySelectorAll(selector)];
    const el = text === undefined ? all[0] : all.find((e) => ((e.getAttribute('aria-label') || '') + ' ' + (e.textContent || '')).trim().includes(text));
    if (!el) return null;
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  let dt = null;
  const dragEvent = (type, x, y) => new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y });
  window.__drag = async (sources) => {
    dt = new DataTransfer();
    for (const s of sources) {
      const blob = await (await fetch(s.url)).blob();
      dt.items.add(new File([blob], s.name, { type: s.type }));
    }
    return dt.types.join(',');
  };
  // The list's column (the rail is an aside too), or whatever is under the pointer in it.
  const list = () => document.querySelector('aside.sidebar');
  window.__dragOver = (x, y) => {
    const under = document.elementFromPoint(x, y);
    const zone = under && list().contains(under) ? under : list();
    zone.dispatchEvent(dragEvent('dragenter', x, y));
    zone.dispatchEvent(dragEvent('dragover', x, y));
  };
  window.__drop = () => list().dispatchEvent(dragEvent('drop', 500, 360));
})();
`;

function args() {
  const argv = process.argv.slice(2);
  const themeAt = argv.indexOf('--theme');
  const theme = themeAt === -1 ? null : argv[themeAt + 1];
  const names = argv.filter((a, i) => !a.startsWith('--') && (themeAt === -1 || i !== themeAt + 1));
  return { names, theme, list: argv.includes('--list') };
}

function ffmpeg(...a) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a], { stdio: ['ignore', 'inherit', 'inherit'] });
}

async function main() {
  const { names, theme, list } = args();
  if (list) {
    for (const s of SCENES) console.log(`${s.name}${s.clip ? ' (clip)' : ''} ${s.device}`);
    return 0;
  }
  if (!fs.existsSync(CHROME)) {
    console.log(`Chrome not found at ${CHROME}; set CHROME to its path`);
    return 1;
  }
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    console.log('ffmpeg not found; brew install ffmpeg');
    return 1;
  }
  const BASE = baseUrl();
  try {
    const r = await fetch(`${BASE}/api/health`);
    if (!r.ok) throw new Error(String(r.status));
  } catch (e) {
    console.log(`nothing answers at ${BASE} (${e.message}); start it with pnpm dev`);
    return 1;
  }
  const busy = await fetch(`http://localhost:${DEBUG_PORT}/json/version`).then(() => true, () => false);
  if (busy) {
    console.log(`port ${DEBUG_PORT} is already serving a DevTools endpoint; close that Chrome first`);
    return 1;
  }
  // Auto-fill fills the note the drop made, so naming it names the drop too.
  if (names.includes('autofill') && !names.includes('drop')) {
    console.log('autofill is of the note drop makes: shooting drop as well');
    names.unshift('drop');
  }
  const scenes = names.length ? SCENES.filter((s) => names.includes(s.name)) : SCENES;
  const unknown = names.filter((n) => !SCENES.some((s) => s.name === n));
  if (unknown.length) {
    console.log(`no scene named ${unknown.join(', ')}; --list names them`);
    return 1;
  }
  const themes = theme ? [theme] : THEMES;
  if (theme && !THEMES.includes(theme)) {
    console.log(`--theme takes light or dark`);
    return 1;
  }
  fs.mkdirSync(OUT, { recursive: true });

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'unbent-shoot-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'unbent-shoot-work-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profile}`,
      '--hide-scrollbars',
      '--window-size=1400,1000',
      '--disable-gpu-vsync',
      'about:blank',
    ],
    // Its own process group: a Ctrl-C in the terminal would otherwise reach Chrome too,
    // and the teardown, which runs through the page, would have nothing to run in.
    { stdio: 'ignore', detached: true },
  );
  let ws;
  let interrupt = null;
  const cleanup = async () => {
    try { ws?.close(); } catch {}
    chrome.kill();
    for (let i = 0; i < 10; i++) {
      try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(300); }
    }
    if (!process.env.KEEP_FRAMES) fs.rmSync(work, { recursive: true, force: true });
    else console.log(`frames kept in ${work}`);
  };
  // Ctrl-C would otherwise end the process with the demo note edited and the dropped
  // notes in the library. Chrome is in its own process group, so it is ours to end on
  // every way out: a second Ctrl-C during the teardown, a SIGTERM, a closed terminal.
  let interrupted = false;
  process.on('SIGINT', async () => {
    if (interrupted) {
      chrome.kill('SIGKILL');
      process.exit(130);
    }
    interrupted = true;
    console.log('\ninterrupted: putting the demo library back (Ctrl-C again to quit now)');
    try { await interrupt?.(); } finally { await cleanup(); process.exit(130); }
  });
  for (const signal of ['SIGTERM', 'SIGHUP']) {
    process.once(signal, () => {
      chrome.kill();
      process.exit(1);
    });
  }
  try {
    return await run(BASE, scenes, themes, work, (w) => (ws = w), (fn) => (interrupt = fn));
  } finally {
    await cleanup();
  }
}

async function run(BASE, scenes, themes, work, keepSocket, onInterrupt) {
  let version;
  for (let i = 0; i < 60 && !version; i++) {
    try { version = await (await fetch(`http://localhost:${DEBUG_PORT}/json/version`)).json(); } catch { await sleep(250); }
  }
  if (!version) {
    console.log('Chrome started but its DevTools endpoint never answered');
    return 1;
  }
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  keepSocket(ws);
  await new Promise((r) => (ws.onopen = r));

  let id = 0;
  const waiting = new Map();
  // A closed socket drops what is sent on it without a word; every call still waiting
  // is answered as timed out at once, rather than thirty seconds each after Chrome went.
  ws.onclose = () => {
    for (const [i, answer] of [...waiting]) {
      waiting.delete(i);
      answer({ timeout: true });
    }
  };
  const listeners = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); return; }
    const l = listeners.get(d.method);
    if (l) l(d.params, d.sessionId);
  };
  // The timer is cleared by the reply, or the last calls of a run hold Node open for
  // thirty seconds after everything is done.
  const send = (method, params = {}, sessionId) =>
    new Promise((res) => {
      const i = ++id;
      const timer = setTimeout(() => { if (waiting.delete(i)) res({ timeout: true }); }, 30000);
      waiting.set(i, (d) => { clearTimeout(timer); res(d); });
      ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const created = await send('Target.createTarget', { url: 'about:blank' });
  const targetId = created.result?.targetId;
  const attached = targetId && (await send('Target.attachToTarget', { targetId, flatten: true }));
  const page = attached?.result?.sessionId;
  if (!page) {
    console.log('could not open a page in Chrome');
    return 1;
  }
  for (const m of ['Runtime.enable', 'Page.enable', 'Network.enable']) await send(m, {}, page);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: PRELUDE }, page);

  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, page);
    if (r.timeout) throw new Error(`evaluate timed out: ${expression.slice(0, 80)}`);
    if (r.result?.exceptionDetails) throw new Error(`page threw: ${(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text).slice(0, 300)}`);
    return r.result?.result?.value;
  };
  const waitFor = async (expression, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) {
      let v;
      try { v = await ev(expression); } catch { v = false; }
      if (v) return v;
      if (Date.now() > end) throw new Error(`waited ${ms}ms for ${expression.slice(0, 100)}`);
      await sleep(150);
    }
  };
  /** The page's address, settled: loaded, fonts in, the busy marks gone, and a beat for the last paint. */
  const open = async (url) => {
    await send('Page.navigate', { url: `${BASE}${url}` }, page);
    await waitFor(`document.readyState === 'complete' && document.fonts.status === 'loaded' && !!document.querySelector('#root *')`);
    await waitFor(`!document.querySelector('[aria-busy="true"], .busy')`, 15000).catch(() => {});
    await sleep(1200);
  };

  // Sign in from the page, so the cookie is the page's own.
  await send('Page.navigate', { url: `${BASE}/login` }, page);
  await sleep(2500);
  const status = await ev(`fetch('/api/auth/sign-in/email',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:${JSON.stringify(EMAIL)},password:${JSON.stringify(PASSWORD)}})}).then(r=>r.status)`);
  if (status !== 200) {
    console.log(`sign-in as ${EMAIL} answered ${status}; run pnpm seed:demo first`);
    return 1;
  }

  // What the scenes need to know about the library.
  const data = await ev(`(async () => {
    const notebooks = (await (await fetch('/api/notebooks')).json()).notebooks;
    const receipts = notebooks.find((n) => n.name === 'Receipts');
    const notes = await window.__notes('notebook=Receipts&limit=50');
    // A note's files: { files: [{ filename, contentType, size }] } (routes/attachments.ts).
    const files = async (id) => (await (await fetch('/api/notes/' + id + '/files')).json()).files;
    let receipt = null, pdfs = [];
    for (const n of notes) {
      const fs = await files(n.id);
      const pdf = fs.filter((f) => f.contentType === 'application/pdf');
      const image = fs.some((f) => f.contentType.startsWith('image/'));
      if (!receipt && pdf.length && image) receipt = { id: n.id, title: n.title };
      for (const f of pdf) if (pdfs.length < 3 && !fs.some((g) => g.filename.length > 60)) pdfs.push({ url: '/api/notes/' + n.id + '/files/' + encodeURIComponent(f.filename), type: 'application/pdf' });
    }
    const rnotes = await window.__notes('notebook=Recipes&limit=50');
    const sourdough = rnotes.find((n) => /Sourdough/.test(n.title)) ?? rnotes[0];
    return { receiptsId: receipts?.id, receipt, pdfs, sourdough: sourdough ? { id: sourdough.id } : null };
  })()`);
  if (!data.receipt || data.pdfs.length < 3 || !data.sourdough) {
    console.log(`the demo library is not what the scenes expect (${JSON.stringify({ receipt: data.receipt, pdfs: data.pdfs.length })}); run pnpm seed:demo`);
    return 1;
  }
  // The scanner's names for the dropped files: a date and a time, which is what the
  // picture is about (a scan comes in as nothing but that, and Auto-fill names it).
  data.dropTitles = ['Scan 2026-10-21 09.14', 'Scan 2026-10-21 09.15', 'Scan 2026-10-21 09.17'];
  data.dropFiles = data.pdfs.map((f, i) => ({ ...f, name: `${data.dropTitles[i]}.pdf` }));

  // A note with a history: one paragraph appended to a showcase note, put back at the
  // end. One paragraph and nothing else, so a body a run that died left edited is
  // recognised and the seed's body recovered from it, rather than edited a second time.
  const SENTENCE = 'Second proof overnight in the fridge: better crumb, less sour.';
  const found = await ev(`fetch('/api/notes/${data.sourdough.id}').then(r => r.json()).then(n => n.body)`);
  const seedBody = found.includes(SENTENCE) ? found.slice(0, found.indexOf(SENTENCE)).replace(/\n*$/, '\n') : found;
  const editedBody = seedBody.replace(/\n$/, '') + '\n\n' + SENTENCE + '\n';
  const patchBody = (body) => ev(`fetch('/api/notes/${data.sourdough.id}', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: ${JSON.stringify(body)} }) }).then(r => r.status)`);
  data.edited = { id: data.sourdough.id };

  // Pointer, keys and the clip's frames.
  let recording = null;
  listeners.set('Page.screencastFrame', (params, sessionId) => {
    if (recording) {
      const file = path.join(recording.dir, `${String(recording.frames.length).padStart(5, '0')}.jpg`);
      fs.writeFileSync(file, Buffer.from(params.data, 'base64'));
      recording.frames.push({ t: Date.now() / 1000, file });
    }
    void send('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId);
  });
  let pointer = { x: 0, y: 0 };
  const p = {
    ev,
    waitFor,
    open,
    /** Moves the drawn pointer and the real one to (x, y) over `ms`. */
    cursor: async (x, y, ms = 300) => {
      const steps = Math.max(1, Math.round(ms / 40));
      const from = pointer;
      for (let i = 1; i <= steps; i++) {
        const px = from.x + ((x - from.x) * i) / steps;
        const py = from.y + ((y - from.y) * i) / steps;
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py }, page);
        await sleep(40);
      }
      pointer = { x, y };
      await ev(`window.__cursor(${x}, ${y}, ${recording ? 'true' : 'false'})`);
    },
    clickAt: async (x, y, { meta = false } = {}) => {
      await p.cursor(x, y);
      await sleep(120);
      const modifiers = meta ? 4 : 0;
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, modifiers }, page);
      await sleep(60);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, modifiers }, page);
      await sleep(250);
    },
    /** Clicks the first element matching `selector`, or the first whose label or text includes `text`. */
    click: async (selector, text) => {
      const at = await waitFor(`JSON.stringify(window.__rect(${JSON.stringify(selector)}, ${JSON.stringify(text)}))`, 10000).then((j) => JSON.parse(j));
      if (!at) throw new Error(`nothing to click for ${selector} ${text ?? ''}`);
      await p.clickAt(at.x, at.y);
    },
    type: async (text, perChar = 60) => {
      for (const ch of text) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch }, page);
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }, page);
        await sleep(perChar + Math.random() * 40);
      }
    },
    /** Runs `wait` inside a clip and keeps only `keep` seconds of it. */
    hold: async (wait, keep) => {
      const from = Date.now() / 1000;
      await wait();
      if (recording) recording.cuts.push({ from, to: Date.now() / 1000, keep });
    },
  };

  const device = async (name) => {
    const d = DEVICES[name];
    await send('Emulation.setDeviceMetricsOverride', { width: d.width, height: d.height, deviceScaleFactor: d.deviceScaleFactor, mobile: d.mobile }, page);
    if (d.mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true }, page);
    else await send('Emulation.setTouchEmulationEnabled', { enabled: false }, page);
    return d;
  };
  const theme = (name) => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: name }] }, page);

  const still = async (file) => {
    const shot = await send('Page.captureScreenshot', { format: 'png' }, page);
    const png = path.join(work, 'still.png');
    fs.writeFileSync(png, Buffer.from(shot.result.data, 'base64'));
    ffmpeg('-i', png, '-c:v', 'libwebp', '-quality', String(WEBP_QUALITY), '-compression_level', '6', file);
  };

  const startClip = async (d) => {
    const dir = fs.mkdtempSync(path.join(work, 'clip-'));
    recording = { dir, frames: [], cuts: [], start: Date.now() / 1000 };
    await send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: d.width * d.deviceScaleFactor, maxHeight: d.height * d.deviceScaleFactor, everyNthFrame: 1 }, page);
    await sleep(400);
  };
  const finishClip = async (name, d) => {
    const rec = recording;
    recording = null;
    await send('Page.stopScreencast', {}, page);
    await ev('window.__cursor(0, 0, false)');
    const end = Date.now() / 1000;
    if (rec.frames.length === 0) throw new Error(`no frames recorded for ${name}`);
    // A steady frame rate from frames that arrive only when something changed: each
    // output frame is the last one seen at its moment, and a held wait is walked through
    // faster so its `keep` seconds are all that is left of it.
    const seq = path.join(work, `seq-${path.basename(name)}`);
    fs.mkdirSync(seq, { recursive: true });
    const cuts = rec.cuts.sort((a, b) => a.from - b.from);
    let t = rec.frames[0].t;
    let n = 0;
    let fi = 0;
    const link = (time) => {
      while (fi + 1 < rec.frames.length && rec.frames[fi + 1].t <= time) fi++;
      fs.linkSync(rec.frames[fi].file, path.join(seq, `${String(n++).padStart(5, '0')}.jpg`));
    };
    for (const cut of cuts) {
      for (; t < cut.from; t += 1 / FPS) link(t);
      const outFrames = Math.max(1, Math.round(cut.keep * FPS));
      const step = (cut.to - cut.from) / outFrames;
      for (let i = 0; i < outFrames; i++) link(cut.from + i * step);
      t = cut.to;
    }
    for (; t < end; t += 1 / FPS) link(t);
    const width = Math.min(1920, d.width * d.deviceScaleFactor);
    const input = ['-framerate', String(FPS), '-i', path.join(seq, '%05d.jpg'), '-vf', `scale=${width}:-2`, '-an'];
    ffmpeg(...input, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '34', '-row-mt', '1', '-pix_fmt', 'yuv420p', `${name}.webm`);
    ffmpeg(...input, '-c:v', 'libx264', '-crf', '23', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${name}.mp4`);
    ffmpeg('-i', rec.frames[0].file, '-vf', `scale=${width}:-2`, '-c:v', 'libwebp', '-quality', String(WEBP_QUALITY), `${name}-poster.webp`);
    return n / FPS;
  };

  /**
   * Takes the dropped notes out of the library for good: the ones the drop scene saw
   * appear, and any a run that died halfway wrote to `DROPPED_FILE` and never purged.
   * A note the server no longer has is skipped by the trash and purge routes, so an id
   * purged by hand in between costs nothing.
   */
  const purgeDropped = async () => {
    let left = [];
    try { left = JSON.parse(fs.readFileSync(DROPPED_FILE, 'utf8')); } catch {}
    const ids = [...new Set([...(data.dropped ?? []), ...left])];
    if (!ids.length) {
      fs.rmSync(DROPPED_FILE, { force: true });
      return;
    }
    const trashed = await ev(`fetch('/api/notes/trash', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ${JSON.stringify(ids)} }) }).then(r => r.status)`);
    const purged = await ev(`fetch('/api/notes/purge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ${JSON.stringify(ids)} }) }).then(r => r.status)`);
    // A refusal (a lapsed session, a store that could not answer) is a failure here, not
    // a status to look at: the file is what keeps the ids past one.
    if (trashed !== 200 || purged !== 200) throw new Error(`purge answered ${trashed} and ${purged}; the ids are kept in ${DROPPED_FILE}`);
    data.dropped = [];
    fs.rmSync(DROPPED_FILE, { force: true });
  };
  // A run that died halfway may have left its notes behind.
  await purgeDropped();

  /**
   * What a run changes in the demo account, put back: the note's body first, since it is
   * the one change the next run cannot sweep up by itself, then the dropped notes. Once
   * only, whether the run ended, failed or was interrupted.
   */
  let torn = false;
  const teardown = async () => {
    if (torn) return;
    torn = true;
    await patchBody(seedBody).catch((e) => console.log(`could not put the demo note back: ${e.message}`));
    // The edit and its undoing each keep a copy of the note (one per half hour of a
    // person's edits), so without this the History sheet filled with identical versions,
    // one or two a run, and the picture recorded how often the script had been run.
    await ev(`fetch('/api/notes/${data.sourdough.id}/revisions', { method: 'DELETE' }).then(r => r.status)`).catch((e) => console.log(`could not clear the demo note's history: ${e.message}`));
    await purgeDropped().catch((e) => console.log(`could not purge the dropped notes: ${e.message}`));
  };
  onInterrupt(teardown);

  let failed = 0;
  try {
    await patchBody(editedBody);
    for (const th of themes) {
      await theme(th);
      for (const scene of scenes) {
        const d = await device(scene.device);
        const suffix = scene.device === 'phone' ? `-phone-${th}` : `-${th}`;
        const file = path.join(OUT, `${scene.name}${suffix}`);
        const started = Date.now();
        try {
          const url = typeof scene.url === 'function' ? scene.url(data) : scene.url;
          await open(url);
          if (scene.clip) {
            await startClip(d);
            await scene.run(p, data);
            const seconds = await finishClip(file, d);
            console.log(`${scene.name}${suffix}: ${seconds.toFixed(1)}s clip in ${((Date.now() - started) / 1000).toFixed(0)}s`);
          } else {
            if (scene.run) await scene.run(p, data);
            await still(`${file}.webp`);
            console.log(`${scene.name}${suffix}: ${(fs.statSync(`${file}.webp`).size / 1024).toFixed(0)} KB`);
          }
        } catch (e) {
          failed++;
          recording = null;
          await send('Page.stopScreencast', {}, page);
          console.log(`${scene.name}${suffix}: FAILED ${e.message}`);
        }
        if (scene.after) {
          await scene.after(p, data).catch((e) => {
            failed++;
            console.log(`${scene.name}${suffix}: could not undo: ${e.message}`);
          });
        }
        if (scene.purgeAfter) await purgeDropped();
      }
      await purgeDropped();
    }
  } finally {
    await teardown();
  }
  return failed ? 1 : 0;
}

process.exitCode = await main();
