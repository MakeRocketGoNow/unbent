// @vitest-environment node
import * as shared from '@unbent/shared';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { COMPAT_LEVEL } from './level.js';
import { equal, narrowings } from './schemas.js';
import { declarations, interfaceParts, normalize, relativeImports } from './surfaces.js';

/**
 * The question every change to what two builds share has to answer: can a page still
 * open on the previous build keep working beside this one? If it can, nothing is said
 * to anyone; if it cannot, `COMPAT_LEVEL` goes up and every open page is asked to reload
 * once this deploys (`UpdateSnackbar`).
 *
 * The answer used to be "no" for every deploy, by comparing commits, which asked the
 * people trying the app to reload after every merge. Now the test asks it, of exactly
 * the changes that raise it, and `contract.json` beside this file records what it was
 * last decided for. Three kinds of change, in falling order of how much can be told
 * from the code:
 *
 * - **A request schema** in `@unbent/shared` (every exported zod schema, as JSON
 *   Schema). Read structurally (`schemas.ts`): one that accepts at least what it did, and
 *   gained no value or type an old page could be sent back, is recorded on its own by a
 *   local run; one that gained one asks; and one that accepts less cannot be recorded
 *   without raising the level.
 * - **Something the builds share that has no schema**: the service worker and the files
 *   it shares with the page, the protocol between tabs and the locks they take, what is
 *   kept on the device, and the shapes the API answers with. Fingerprinted
 *   (`surfaces.ts`), and a change asks the question its area is about.
 * - **Anything else.** AGENTS.md ("Builds side by side") is the rule for it, and
 *   `pnpm compat:bump` raises the level by hand.
 *
 * `UNBENT_COMPAT=update` (`pnpm compat:update`) records the present as still fitting;
 * `UNBENT_COMPAT=bump` (`pnpm compat:bump`) raises the level and records it. A plain run
 * records the present on its own when every change is a request schema accepting more,
 * except in CI, where a stale record fails: the record is how the next change is judged,
 * and one that lags lets a later narrowing pass for a widening.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../../../..');
const RECORD = join(here, 'contract.json');
const LEVEL_FILE = join(here, 'level.ts');
const MODE = process.env.UNBENT_COMPAT;

interface Area {
  question: string;
  /** Repository paths whose whole normalized source is fingerprinted. */
  files?: () => string[];
  /**
   * Repository paths whose `interface` and `type` declarations are, one by one. An
   * interface is printed as its heading and each member apart (`interfacePrint`), so one
   * that only gained members fits without asking.
   */
  declarationsOf?: string[];
}

/**
 * The areas, each with the question a change in it asks. A file joins an area by being
 * listed, except the worker's, which is every module the worker imports: so a module the
 * worker starts sharing with the page is in it without anyone remembering to add it.
 * The level itself is left out, being what the answer changes.
 */
const AREAS: Record<string, Area> = {
  worker: {
    question:
      'Can a page from the previous build keep working under this build’s worker: the messages it sends it, the caches, headers and addresses it relies on, the files the worker keeps for it on the device?',
    files: () => [...closure('apps/web/src/sw/sw.ts'), 'apps/web/src/sw-register.ts'].filter((path) => path !== 'apps/web/src/compat/level.ts'),
  },
  tabs: {
    question:
      'Can a tab on the previous build and a tab on this one still work together: the messages on the library channel, and the locks that say which tab holds the library and replays the outbox?',
    files: () => ['apps/web/src/store/library-channel.ts', 'apps/web/src/store/library-lock.ts', 'apps/web/src/store/leader.ts', 'apps/web/src/store/locks.ts', 'apps/web/src/store/names.ts'],
  },
  device: {
    question:
      'Can a tab on the previous build open what this build keeps on the device (the library’s collections and its SQLite file, the search index), and can this build open what that one wrote?',
    files: () => ['apps/web/src/store/collections.ts', 'apps/web/src/store/db.ts', 'apps/web/src/store/search-index.ts'],
  },
  answers: {
    question:
      'Does a page from the previous build still read what the API answers now? A field removed or renamed, one that can be null or missing now, a new value in a union the page switches on.',
    declarationsOf: ['packages/shared/src/schemas.ts', 'packages/shared/src/feed.ts', 'packages/shared/src/fields.ts', 'packages/shared/src/plan.ts'],
  },
};

interface Contract {
  level: number;
  requests: Record<string, unknown>;
  shared: Record<string, Record<string, string>>;
}

type Kind = 'breaks' | 'unsure' | 'fits';
interface Finding {
  kind: Kind;
  where: string;
  what: string;
}

/** Every module reachable from `entry` by relative imports, as repository paths. */
function closure(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    for (const specifier of relativeImports(readFileSync(join(ROOT, path), 'utf8'))) {
      const target = resolveModule(dirname(path), specifier);
      if (target) visit(target);
    }
  };
  visit(entry);
  return [...seen].sort();
}

function resolveModule(from: string, specifier: string): string | null {
  const bare = join(from, specifier).replace(/\.js$/, '');
  for (const candidate of [`${bare}.ts`, `${bare}.tsx`, join(bare, 'index.ts')]) {
    if (existsSync(join(ROOT, candidate))) return candidate;
  }
  return null;
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * An interface as `heading|member|member…`, each part hashed and the members sorted, so
 * a print that keeps the heading and every old member is one that only gained some.
 * Anything else is one hash, with no `|` in it.
 */
function interfacePrint(declaration: string): string {
  const parts = interfaceParts(declaration);
  if (!parts) return hash(declaration);
  return [hash(parts.head), ...parts.members.map((member) => hash(member).slice(0, 10)).sort()].join('|');
}

/** Whether the print `now` is the interface `was` with members added and nothing else changed. */
function onlyGained(was: string, now: string): boolean {
  if (!was.includes('|') || !now.includes('|')) return false;
  const [wasHead, ...wasMembers] = was.split('|');
  const [nowHead, ...nowMembers] = now.split('|');
  return wasHead === nowHead && wasMembers.every((member) => nowMembers.includes(member));
}

function sorted<T>(entries: [string, T][]): Record<string, T> {
  return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function present(): Contract {
  const requests: [string, unknown][] = [];
  for (const [name, value] of Object.entries(shared)) {
    if (!(value instanceof z.ZodType)) continue;
    const { $schema: _, ...schema } = z.toJSONSchema(value, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
    requests.push([name, schema]);
  }
  const areas: [string, Record<string, string>][] = [];
  for (const [name, area] of Object.entries(AREAS)) {
    const prints: [string, string][] = [];
    for (const path of area.files?.() ?? []) prints.push([path, hash(normalize(readFileSync(join(ROOT, path), 'utf8')))]);
    for (const path of area.declarationsOf ?? []) {
      for (const [declared, text] of declarations(readFileSync(join(ROOT, path), 'utf8'))) prints.push([`${path} › ${declared}`, interfacePrint(text)]);
    }
    areas.push([name, sorted(prints)]);
  }
  return { level: COMPAT_LEVEL, requests: sorted(requests), shared: sorted(areas) };
}

function compare(was: Contract, now: Contract): Finding[] {
  const findings: Finding[] = [];
  for (const [name, schema] of Object.entries(was.requests)) {
    const where = `@unbent/shared › ${name}`;
    if (!(name in now.requests)) {
      findings.push({ kind: 'unsure', where, what: 'is no longer exported. If a route still checks a body against it, it has to accept what it did' });
      continue;
    }
    const next = now.requests[name];
    if (equal(next, schema)) continue;
    const narrower = narrowings(next as Record<string, unknown>, schema as Record<string, unknown>);
    if (narrower.length === 0) findings.push({ kind: 'fits', where, what: 'accepts at least what it did' });
    for (const n of narrower) findings.push({ kind: n.severity, where: `${where}${n.path}`, what: n.what });
  }
  for (const name of Object.keys(now.requests)) {
    if (!(name in was.requests)) findings.push({ kind: 'fits', where: `@unbent/shared › ${name}`, what: 'is new' });
  }
  for (const [area, prints] of Object.entries(now.shared)) {
    const before = was.shared[area] ?? {};
    const changed = [...new Set([...Object.keys(before), ...Object.keys(prints)])].filter((key) => before[key] !== prints[key]);
    for (const key of changed) {
      const where = `${area}: ${key}`;
      if (AREAS[area]?.declarationsOf && !(key in before)) findings.push({ kind: 'fits', where, what: 'is new' });
      else if (key in before && key in prints && onlyGained(before[key]!, prints[key]!)) findings.push({ kind: 'fits', where, what: 'only gained fields' });
      else findings.push({ kind: 'unsure', where, what: !(key in before) ? 'is new here' : !(key in prints) ? 'is gone' : 'changed' });
    }
  }
  if (now.level !== was.level) findings.push({ kind: 'unsure', where: 'COMPAT_LEVEL', what: `is ${now.level}, recorded as ${was.level}; it is raised with pnpm compat:bump` });
  return findings;
}

function write(record: Contract): void {
  writeFileSync(RECORD, `${JSON.stringify(record, null, 2)}\n`);
}

function report(findings: Finding[], footer: string): string {
  const section = (kind: Kind, title: string) => {
    const rows = findings.filter((f) => f.kind === kind);
    return rows.length ? [`${title}`, ...rows.map((f) => `  ${f.where} ${f.what}`), ''] : [];
  };
  const areas = [...new Set(findings.filter((f) => f.kind === 'unsure' && f.where.includes(': ')).map((f) => f.where.slice(0, f.where.indexOf(':'))))];
  return [
    '',
    'What a page still open on the previous build shares with this one has changed.',
    '',
    ...section('breaks', 'Refuses what a page from before sends, so it cannot be recorded without raising the level:'),
    ...section('unsure', 'Needs a decision:'),
    ...(areas.length ? ['The question for each:', ...areas.map((area) => `  ${area}: ${AREAS[area]!.question}`), ''] : []),
    ...section('fits', 'Fits:'),
    footer,
    'See "Builds side by side" in AGENTS.md.',
    '',
  ].join('\n');
}

const BREAKS =
  'Make the schema accept what it did (keep the old field beside the new one, keep the old limit), or run pnpm compat:bump: every page still open on an older build is asked to reload once this deploys. Commit apps/web/src/compat/contract.json with the change.';

const DECIDE = [
  'Then one of:',
  '  pnpm compat:update   it still fits: record it, and no page is asked to reload',
  '  pnpm compat:bump     it does not: raise COMPAT_LEVEL, and every open page is asked to reload once this deploys',
  'and commit apps/web/src/compat/contract.json with the change.',
].join('\n');

it('records what builds share, and asks before anything changes that an open page relies on', () => {
  const now = present();

  if (MODE === 'bump') {
    const level = COMPAT_LEVEL + 1;
    const source = readFileSync(LEVEL_FILE, 'utf8');
    const raised = source.replace(/export const COMPAT_LEVEL = \d+;/, `export const COMPAT_LEVEL = ${level};`);
    expect(raised, 'level.ts no longer declares COMPAT_LEVEL the way this test raises it').not.toBe(source);
    writeFileSync(LEVEL_FILE, raised);
    write({ ...now, level });
    console.info(`COMPAT_LEVEL is ${level} now. Every page still open on an older build will be asked to reload once this deploys.`);
    return;
  }

  if (!existsSync(RECORD)) {
    write(now);
    expect.fail(`There was no ${relative(ROOT, RECORD)}; one has been written. Commit it.`);
  }
  const was = JSON.parse(readFileSync(RECORD, 'utf8')) as Contract;
  expect(COMPAT_LEVEL, 'COMPAT_LEVEL went down; a level is only ever raised').toBeGreaterThanOrEqual(was.level);

  const findings = compare(was, now);
  if (findings.length === 0) return;
  const breaks = findings.some((f) => f.kind === 'breaks');
  const unsure = findings.some((f) => f.kind === 'unsure');

  if (MODE === 'update') {
    if (breaks) expect.fail(report(findings, BREAKS));
    write(now);
    return;
  }

  if (!breaks && !unsure && !process.env.CI) {
    write(now);
    console.info(`Recorded request schemas that accept more than they did in ${relative(ROOT, RECORD)}; commit it with the change.`);
    return;
  }
  const footer = breaks
    ? BREAKS
    : unsure
      ? DECIDE
      : 'These fit, and a local run of this test records them on its own. This run is in CI, so run it locally and commit apps/web/src/compat/contract.json.';
  expect.fail(report(findings, footer));
});
