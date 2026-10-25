/**
 * Loads the seed into the signed-in account, through the app's own HTTP API.
 *
 * The import endpoints rather than `POST /notes`, because they are the ones that take what
 * a seed needs to say: a creation date (so the list has a past to scroll through), field
 * values by name, and a content hash that makes each note idempotent. The seed's hash is
 * of its stable key and not its text, so a re-run finds every note it made before even
 * after its body here has been edited, and brings the text up to date instead of adding a
 * second copy. Notebook definitions go through `import/notebook` first, for the same
 * reason an export's do: the notes that hold field values need the fields to exist.
 *
 * Over HTTP rather than straight into a store, so what it exercises is the code that is
 * running (the branch's routes and the branch's store) and so the same loader can be
 * driven from anywhere that can make an authenticated request. It takes a `request`
 * function and adds nothing of its own (no origin, no cookie), and imports nothing from
 * Node, so the web app runs it as well as `scripts/seed-demo.mjs` does: a pull-request
 * preview whose stores are its own offers it as "Fill with sample notes".
 */
import { bulkNotes } from './bulk.mjs';
import { makePdf, makeReceiptPng } from './files.mjs';
import { NOTEBOOKS, VIEWS } from './notebooks.mjs';
import { RECORDS } from './records.mjs';
import { SHOWCASE } from './showcase.mjs';

const DAY = 24 * 60 * 60 * 1000;

/** The notebooks the showcase uses: all `--small` makes. */
const SHOWCASE_NOTEBOOKS = new Set(SHOWCASE.map((n) => n.notebook));

/**
 * Every note the seed makes, in one shape. The showcase is dated over the last few days
 * and everything else is older (see `records.mjs` and `bulk.mjs`), so the list newest
 * first opens on the ten notes the screenshots are of.
 */
export function seedNotes({ small = false } = {}) {
  const showcase = SHOWCASE.map((note, i) => ({ key: `showcase/${i}`, ...note, age: i * 0.4 }));
  return small ? showcase : [...showcase, ...RECORDS, ...bulkNotes()];
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** `YYYY-MM-DD` for a day `n` days from `now`, in UTC: what a date field stores. */
function dateOnly(now, n) {
  return new Date(now + n * DAY).toISOString().slice(0, 10);
}

function resolveFields(fields, now) {
  if (!fields) return undefined;
  return Object.fromEntries(
    Object.entries(fields).map(([name, value]) => [
      name,
      value && typeof value === 'object' && 'day' in value ? dateOnly(now, value.day) : value,
    ]),
  );
}

const fileText = (file) => (file.pages ?? [file.lines]).flat().filter(Boolean).join('\n');

/** The body link a file gets, in the form `formatAttachmentMarkdown` writes. */
function fileLink(file) {
  const path = `files/${file.name}`;
  const dest = /\s/.test(path) ? `<${path}>` : path;
  return `${file.image ? '!' : ''}[${file.name}](${dest})`;
}

async function expectOk(res, what) {
  if (res.ok) return res;
  throw new Error(`${what}: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

async function json(request, path, method, body) {
  const res = await request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return expectOk(res, `${method} ${path}`);
}

/** Every note id in a listing, live or trashed, a page at a time. */
async function listAll(request, { trashed = false } = {}) {
  const notes = [];
  for (let cursor = null; ; ) {
    const qs = new URLSearchParams({ limit: '100', ...(trashed ? { trashed: '1' } : {}), ...(cursor ? { cursor } : {}) });
    const res = await expectOk(await request(`/api/notes?${qs}`), 'list notes');
    const page = await res.json();
    notes.push(...page.items);
    if (!page.cursor || page.items.length === 0) return notes;
    cursor = page.cursor;
  }
}

async function uploadFile(request, noteId, file) {
  const bytes = file.image ? await makeReceiptPng(fileText(file).split('\n').length) : makePdf(file.pages ?? [file.lines]);
  // `text=supplied`: the text arrives next, so the server starts no read of its own,
  // which on an instance with a vision key would otherwise send the seed's image to it.
  const put = await request(`/api/notes/${noteId}/files?text=supplied`, {
    method: 'PUT',
    headers: {
      'X-Filename': encodeURIComponent(file.name),
      'Content-Type': file.image ? 'image/png' : 'application/pdf',
    },
    body: bytes,
  });
  const { filename } = await (await expectOk(put, `upload ${file.name}`)).json();
  await json(request, `/api/notes/${noteId}/files/${encodeURIComponent(filename)}/text`, 'PUT', {
    text: fileText(file),
  });
}

/** Runs `task` over `items`, a few at a time: a local Worker answers faster in parallel. */
async function pool(items, size, task) {
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) await task(items[next++]);
    }),
  );
}

/**
 * Loads the seed. Safe to run again: a note the seed made before is updated in place, a
 * missing file is uploaded, and a note the seed puts in the trash is not made twice.
 */
export async function loadSeed({
  request,
  now = Date.now(),
  small = false,
  log = () => {},
  onProgress = () => {},
}) {
  for (const notebook of NOTEBOOKS) {
    if (small && !SHOWCASE_NOTEBOOKS.has(notebook.name)) continue;
    const res = await json(request, '/api/import/notebook', 'POST', notebook);
    const { skipped } = await res.json();
    for (const s of skipped ?? []) log(`warning: ${notebook.name}: ${s.name} skipped, ${s.reason}`);
  }

  await loadViews({ request, small, log });

  // An import never looks in the trash (a note deleted on purpose stays deleted, and
  // importing it again makes a fresh one), so the seed's trashed notes are recognised here
  // by title instead, or each run would add another copy to the trash.
  const inTrash = new Set((await listAll(request, { trashed: true })).map((n) => n.title));

  const counts = { created: 0, updated: 0, files: 0, trashed: 0, skipped: 0 };
  const notes = seedNotes({ small });
  let done = 0;
  onProgress(0, notes.length);
  await pool(notes, 6, async (note) => {
    await loadOne(note);
    onProgress(++done, notes.length);
  });
  return counts;

  async function loadOne(note) {
    if (note.trashed && inTrash.has(note.title)) {
      counts.skipped++;
      return;
    }
    const files = note.files ?? [];
    const body = files.length ? `${note.body}\n\n${files.map(fileLink).join('\n\n')}` : note.body;
    const at = Math.round(now - note.age * DAY);
    const res = await json(request, '/api/import/note', 'POST', {
      title: note.title,
      body,
      tags: note.tags ?? [],
      ...(note.notebook ? { notebook: note.notebook } : {}),
      createdAt: at,
      updatedAt: at,
      contentHash: await sha256(`unbent-seed\n${note.key}`),
      fields: resolveFields(note.fields, now),
    });
    const { id, created, skippedFields } = await res.json();
    for (const name of skippedFields ?? []) log(`warning: ${note.key} skipped field ${name}`);

    let have = new Set();
    if (created) {
      counts.created++;
    } else {
      // Field values are left as they are: the import already restores any the note lost,
      // and never overwrites one that was changed by hand since.
      await json(request, `/api/notes/${id}`, 'PATCH', { title: note.title, body, tags: note.tags ?? [] });
      counts.updated++;
      const listed = await expectOk(await request(`/api/notes/${id}/files`), `list files of ${note.key}`);
      have = new Set((await listed.json()).files.map((f) => f.filename));
    }
    for (const file of files) {
      if (have.has(file.name)) continue;
      await uploadFile(request, id, file);
      counts.files++;
    }
    if (note.trashed) {
      await expectOk(await request(`/api/notes/${id}`, { method: 'DELETE' }), `trash ${note.key}`);
      counts.trashed++;
    }
  }
}

/**
 * Makes the seed's saved views, once: a view is found again by its name within its
 * notebook, as the server would refuse a second with that name anyway, and one that is
 * already there is left as it is, since someone may have edited it to see what happens.
 * A notebook `--small` did not make, or a field the import skipped, skips the view with
 * a warning rather than failing the load.
 */
async function loadViews({ request, small, log }) {
  const notebooks = (await (await expectOk(await request('/api/notebooks'), 'list notebooks')).json()).notebooks;
  const have = (await (await expectOk(await request('/api/views'), 'list views')).json()).views;
  const fieldsOf = new Map();
  for (const view of VIEWS) {
    if (small && !SHOWCASE_NOTEBOOKS.has(view.notebook)) continue;
    const notebook = notebooks.find((n) => n.name === view.notebook);
    if (!notebook) {
      log(`warning: view ${view.name} skipped, no notebook ${view.notebook}`);
      continue;
    }
    if (have.some((v) => v.notebookId === notebook.id && v.name.toLowerCase() === view.name.toLowerCase())) continue;
    if (!fieldsOf.has(notebook.id)) {
      const res = await expectOk(await request(`/api/notebooks/${notebook.id}/fields`), `list fields of ${view.notebook}`);
      fieldsOf.set(notebook.id, new Map((await res.json()).fields.map((f) => [f.name, f.id])));
    }
    const ids = fieldsOf.get(notebook.id);
    const idOf = (name) => {
      const id = ids.get(name);
      if (!id) throw new Error(`${view.notebook} has no field ${name}`);
      return id;
    };
    try {
      const { field, sortField, ...rest } = view.query;
      const query = {
        ...rest,
        ...(field ? { field: field.map(([name, op, value]) => `${idOf(name)}:${op}:${value}`) } : {}),
        ...(sortField ? { sortField: idOf(sortField) } : {}),
      };
      await json(request, '/api/views', 'POST', { notebookId: notebook.id, name: view.name, query });
    } catch (err) {
      log(`warning: view ${view.name} skipped, ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Deletes every note in the account for good, trash included. Notebooks and fields stay. */
export async function clearNotes({ request }) {
  const live = (await listAll(request)).map((n) => n.id);
  for (let i = 0; i < live.length; i += 500) {
    await json(request, '/api/notes/trash', 'POST', { ids: live.slice(i, i + 500) });
  }
  const trashed = (await listAll(request, { trashed: true })).map((n) => n.id);
  for (let i = 0; i < trashed.length; i += 500) {
    await json(request, '/api/notes/purge', 'POST', { ids: trashed.slice(i, i + 500) });
  }
  return trashed.length;
}
