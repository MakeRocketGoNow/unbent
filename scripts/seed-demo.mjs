#!/usr/bin/env node
/**
 * Sample notes on a local instance, for screenshots and for looking at real-ish UI.
 *
 * Store screenshots need an account that has notes in it, and the notes have to be
 * presentable: nothing personal, nothing half-written, and no raw markdown showing through
 * a list preview. Reconstructing that by hand each time is the actual cost — the account
 * itself is one request — so the notes live here as data and the account is made fresh.
 *
 * No credential is stored anywhere. The password below is a constant in a script that
 * refuses to run against anything but localhost, and the account it makes lives in a
 * disposable local D1; a saved one would only drift out of sync with the next `--fresh`
 * worktree or `migrate:local`. Sign-up works because `ALLOW_TEST_CREDENTIALS=1` in
 * `.dev.vars` turns on password auth for local development, the same switch the API test
 * suite mints its sessions with. See the comment on `passwordEnabled` in `apps/api/src/auth.ts`.
 *
 * Idempotent: run it twice and you get the same ten notes, not twenty. Notes are matched
 * by title, so editing the body here and re-running updates the note in place.
 *
 *   pnpm seed:demo                     # this checkout's dev server
 *   pnpm seed:demo --url http://localhost:5173
 *   pnpm seed:demo --reset             # delete the demo account's notes first
 */
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { portsFor } from './ports.mjs';

const EMAIL = 'demo@example.com';
const PASSWORD = 'demo-password-1234';
const NAME = 'Demo';

const NOTEBOOKS = ['Recipes', 'Projects', 'Reading', 'Travel', 'Home'];

/**
 * The sample notes.
 *
 * Written to look like somebody's actual notes without being anybody's: no names, no
 * addresses, no real accounts. Between them they cover what the app is for — a table, a
 * fenced block, checkboxes, headings, tags and notebooks — so one screenshot of the list
 * and one of an open note show most of the feature surface.
 *
 * Keep the first line of every body a plain sentence. The note list renders a preview from
 * it verbatim, so a body that opens on `**bold**` or a `##` heading puts raw markdown in
 * the shot and reads as a rendering bug.
 */
const NOTES = [
  {
    title: 'Sourdough — the loaf that finally worked',
    notebook: 'Recipes',
    tags: ['baking', 'weekend'],
    body: `Third attempt, and the crumb is finally open.

## What changed

- Starter fed **twice** the day before, not once
- Hydration down to 72% — easier to shape, same crumb
- Cold retard overnight in the fridge

## Timings

| Step | Time |
| --- | --- |
| Autolyse | 45 min |
| Bulk | 4 h |
| Retard | 12 h |
| Bake | 20 min lid on, 22 off |

> Steam matters more than temperature. The lid *is* the steam.

Next: try 10% rye and see if the flavour carries.`,
  },
  {
    title: 'Balcony garden plan',
    notebook: 'Home',
    tags: ['garden', 'spring'],
    body: `South-facing, so mostly sun after 11am.

- [x] Measure the rail planters
- [x] Order potting mix
- [ ] Start basil and mint indoors
- [ ] Move tomatoes out after the last frost
- [ ] Set up the drip timer

Herbs in the two long boxes, tomatoes in the fabric pots at the sunny end.

Watering: every other day once it warms up, daily in the tomato pots. The mint stays in
its own pot or it takes everything.`,
  },
  {
    title: 'Trail notes — the ridge loop',
    notebook: 'Travel',
    tags: ['hiking', 'day-trip'],
    body: `About 11 km, four hours with stops. Marked blue the whole way.

## Getting there

Bus to the trailhead runs hourly until 6pm. Last one back is the one that matters —
missing it means a long road walk.

## Along the way

The first climb is the steep part; it eases after the saddle. Water at the halfway hut,
nothing after that, so fill up there.

Best view is *not* the summit — it's the bench about twenty minutes past it, looking back
over the valley.

## Bring

- 2 L water
- Layers, it's windy on the ridge
- Something for lunch at the hut`,
  },
  {
    title: 'Bookshelf build — measurements',
    notebook: 'Projects',
    tags: ['woodworking', 'build'],
    body: `The alcove is not square — the left side is 8 mm narrower at the top.

\`\`\`
Alcove width  (bottom)  912 mm
Alcove width  (top)     904 mm
Height                 2180 mm
Depth                   300 mm
\`\`\`

Cut the shelves to 895 mm and scribe the ends. Uprights get a rebate for the back panel.

- [x] Template the wall profile with cardboard
- [ ] Cut uprights
- [ ] Dry fit before glue
- [ ] Two coats of oil

Shelf spacing: 320 mm for the bottom three, 260 mm above.`,
  },
  {
    title: 'Reading list',
    notebook: 'Reading',
    tags: ['books'],
    body: `Books on the go, and the ones after them.

## Reading now

- A history of the sea trade routes — slow, but the maps are worth it

## Next

1. The one about typefaces someone recommended
2. Short stories collection, for the commute
3. The gardening book with the terrible cover

## Finished

- [x] Essays on walking — *the chapter on paths as arguments was the good one*
- [x] A novel about a lighthouse keeper

> Note to self: stop buying faster than reading.`,
  },
  {
    title: 'Coffee: dialling in the new bag',
    notebook: 'Recipes',
    tags: ['coffee'],
    body: `Medium roast, washed. Tastes thin at the shop's suggested setting.

| Grind | Dose | Yield | Time | Verdict |
| --- | --- | --- | --- | --- |
| 18 | 18 g | 36 g | 22 s | sour, too fast |
| 15 | 18 g | 36 g | 27 s | better |
| 13 | 18 g | 38 g | 31 s | **this one** |

Settled on 13. Anything finer and it chokes.`,
  },
  {
    title: 'Weeknight meals that actually happen',
    notebook: 'Recipes',
    tags: ['cooking', 'weeknight'],
    body: `Rules: under 30 minutes, one pan where possible, ingredients that keep.

- **Lentils and greens** — onion, garlic, tin of lentils, whatever green is wilting
- **Fried rice** — needs day-old rice, so cook extra on Sunday
- **Sheet pan sausages** — sausages, potatoes, red onion, 220°C for 35
- **Noodle soup** — stock, ginger, noodles, an egg

Keep in the cupboard: tinned tomatoes, lentils, coconut milk, noodles, stock paste.`,
  },
  {
    title: 'Bike tune-up checklist',
    notebook: 'Home',
    tags: ['bike', 'maintenance'],
    body: `Every few months, or when something starts making a noise.

- [x] Tyre pressure
- [x] Chain clean and lube
- [ ] Brake pads — check the wear line
- [ ] Cable tension
- [ ] Bolts: stem, seatpost, rack

The creak turned out to be the seatpost, not the bottom bracket. Grease and re-torque
fixed it.`,
  },
  {
    title: 'Ideas parking lot',
    notebook: 'Projects',
    tags: ['ideas'],
    body: `Things worth doing eventually, kept here so they stop rattling around.

- A proper index for the recipe notes — tag by main ingredient
- Scan the old paper maps before they fall apart
- Fix the squeaky door properly instead of oiling it every winter
- Work out whether the tomato variety from two summers ago is still sold anywhere

*Nothing here is urgent. That is the point of the list.*`,
  },
  {
    title: 'Packing list — long weekend',
    notebook: 'Travel',
    tags: ['packing', 'travel'],
    body: `Carry-on only. If it doesn't fit, it doesn't come.

- [x] Passport / tickets
- [x] Charger and cable
- [ ] Rain shell
- [ ] Two shirts, one warm layer
- [ ] Book
- [ ] Refillable bottle

Learned the hard way: pack the charger *first*, it's the one thing that ruins the trip.`,
  },
];

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

/**
 * The instance to seed: `--url`, else this checkout's own dev server.
 *
 * Derived rather than hardcoded because a worktree's ports are derived — see
 * `scripts/ports.mjs`. Hardcoding 5173 would seed the main checkout from a worktree, which
 * is the one mistake this script must not make quietly.
 */
function baseUrl() {
  const explicit = arg('--url');
  if (explicit) return explicit.replace(/\/$/, '');
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: dirname(fileURLToPath(import.meta.url)),
    encoding: 'utf8',
  }).trim();
  return `http://localhost:${portsFor(root).web}`;
}

/**
 * Refuse anything that is not loopback.
 *
 * This script signs up an account with a password that is written down in it. Pointed at a
 * deployed instance that had password auth on, it would create a real account on it with a
 * known credential. Nothing here needs to reach a remote host, so the check is a flat no
 * rather than a prompt.
 */
function assertLocal(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`--url must be a URL, got: ${url}`);
  }
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
    throw new Error(
      `Refusing to seed ${url}: this script signs up a known password and is local-only. ` +
        `See the comment on \`passwordEnabled\` in apps/api/src/auth.ts.`,
    );
  }
}

const BASE = baseUrl();
assertLocal(BASE);

/**
 * `Origin` is sent on every request, because Better Auth rejects a request without one as
 * cross-site (`MISSING_OR_NULL_ORIGIN`). A browser sets it; `fetch` here does not, so the
 * auth endpoints 403 without this. The API tests pass it for the same reason.
 */
async function api(path, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Origin: BASE,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res;
}

function cookieFrom(res) {
  const raw = res.headers.get('set-cookie');
  if (!raw) return null;
  return raw.split(';')[0] ?? null;
}

/** Sign up, or sign in if the account is already there from a previous run. */
async function session() {
  const up = await api('/api/auth/sign-up/email', {
    method: 'POST',
    body: { email: EMAIL, password: PASSWORD, name: NAME },
  });
  if (up.ok) {
    const cookie = cookieFrom(up);
    if (!cookie) throw new Error('sign-up returned no session cookie');
    return { cookie, created: true };
  }

  const inRes = await api('/api/auth/sign-in/email', {
    method: 'POST',
    body: { email: EMAIL, password: PASSWORD },
  });
  if (!inRes.ok) {
    throw new Error(
      `could not sign up or sign in as ${EMAIL}.\n` +
        `sign-up said ${up.status}: ${(await up.text()).slice(0, 200)}\n` +
        `sign-in said ${inRes.status}: ${(await inRes.text()).slice(0, 200)}\n` +
        `Is ALLOW_TEST_CREDENTIALS=1 set in apps/api/.dev.vars?`,
    );
  }
  const cookie = cookieFrom(inRes);
  if (!cookie) throw new Error('sign-in returned no session cookie');
  return { cookie, created: false };
}

async function main() {
  const health = await api('/api/config').catch(() => null);
  if (!health?.ok) {
    throw new Error(`No instance answering at ${BASE}. Start one with \`pnpm dev\`.`);
  }

  const { cookie, created } = await session();
  process.stdout.write(`${created ? 'created' : 'signed in as'} ${EMAIL} on ${BASE}\n`);

  for (const name of NOTEBOOKS) {
    // Already there from a previous run is the normal case, not a failure.
    await api('/api/notebooks', { method: 'POST', body: { name }, cookie });
  }

  // 100 is the API's maximum page size, and asking for more is a validation error rather
  // than a clamp. A failure here must not be swallowed: read as "nothing exists yet" it
  // would create a second copy of every note on each run.
  const listRes = await api('/api/notes?limit=100', { cookie });
  if (!listRes.ok) {
    throw new Error(`could not list existing notes: ${listRes.status} ${await listRes.text()}`);
  }
  const existing = (await listRes.json()).items ?? [];
  const byTitle = new Map(existing.map((n) => [n.title, n.id]));

  if (process.argv.includes('--reset')) {
    for (const note of existing) {
      await api(`/api/notes/${note.id}`, { method: 'DELETE', cookie });
    }
    byTitle.clear();
    process.stdout.write(`removed ${existing.length} existing note(s)\n`);
  }

  let made = 0;
  let updated = 0;
  for (const note of NOTES) {
    const id = byTitle.get(note.title);
    if (id) {
      const res = await api(`/api/notes/${id}`, { method: 'PATCH', body: note, cookie });
      if (!res.ok) throw new Error(`PATCH ${note.title}: ${res.status} ${await res.text()}`);
      updated++;
    } else {
      const res = await api('/api/notes', { method: 'POST', body: note, cookie });
      if (!res.ok) throw new Error(`POST ${note.title}: ${res.status} ${await res.text()}`);
      made++;
    }
  }

  process.stdout.write(`${made} note(s) created, ${updated} updated — sign in at ${BASE}\n`);
  process.stdout.write(`  email    ${EMAIL}\n  password ${PASSWORD}\n`);
}

await main();
