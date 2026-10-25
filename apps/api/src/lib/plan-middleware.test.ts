import { describe, expect, it } from 'vitest';
import { app } from '../app.js';
import { exemptFromPlan, heldInStore } from './plan-middleware.js';

/**
 * Every mutating route the app has, classified: any account may make it whatever it
 * holds (`EXEMPT` in `plan-middleware.ts`), or its writes go to the store with the free
 * plan's limits and the store decides (`HELD_IN_STORE`). The table is read from the app
 * itself, so a route added anywhere turns up here, and one that is neither fails by
 * name. That is the whole point: the choice is made out loud, once, in a commit that
 * adds the route.
 *
 * Paths are the router's, with `:param` where a route takes one; the exemption rules
 * match a segment in that position whatever it holds.
 */

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

function routeTable(): Array<[method: string, path: string]> {
  const seen = new Set<string>();
  const table: Array<[string, string]> = [];
  for (const r of app.routes) {
    // `ALL` entries are middleware (`use`) and the two catch-alls, Better Auth's and the
    // MCP endpoint's; each is its own rule in the exemptions.
    if (r.method === 'ALL' || READS.has(r.method)) continue;
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    table.push([r.method, r.path]);
  }
  return table;
}

/**
 * The routes held in the store, as the router spells them: listed here as well as in
 * the middleware, so a route renamed or removed there fails here rather than leaving a
 * pattern that matches nothing.
 */
const HELD: Array<[string, string]> = [
  ['POST', '/api/notes'],
  ['PATCH', '/api/notes'],
  ['PATCH', '/api/notes/:id'],
  ['POST', '/api/notes/:id/revisions/:revision/restore'],
  ['POST', '/api/notes/:id/duplicate'],
  ['POST', '/api/notes/:id/autofill'],
  ['POST', '/api/notebooks'],
  ['PATCH', '/api/notebooks/:id'],
  ['POST', '/api/notebooks/:id/fields'],
  ['PUT', '/api/notebooks/:id/fields/order'],
  ['PATCH', '/api/notebooks/:id/fields/:fieldId'],
  ['POST', '/api/notebooks/:id/fields/:fieldId/options'],
  ['POST', '/api/views'],
  ['PATCH', '/api/views/:id'],
  ['PATCH', '/api/tags/:id'],
  ['PUT', '/api/notes/:id/files'],
  ['POST', '/api/notes/:id/files/copy'],
  ['POST', '/api/notes/:id/files/fetch'],
  ['POST', '/api/import/note'],
  ['POST', '/api/import/notebook'],
  ['POST', '/api/import/enml'],
];

describe('the read-only rule', () => {
  it('has an answer for every mutating route the app has', () => {
    const table = routeTable();
    expect(table.length).toBeGreaterThan(20);
    const unknown = table.filter(([m, p]) => !exemptFromPlan(m, p) && !heldInStore(m, p)).map(([m, p]) => `${m} ${p}`);
    expect(unknown, 'mutating routes neither exempt nor held to the free plan in the store').toEqual([]);
    // And nothing held in the store is also exempt, or one of the lists is lying.
    const both = table.filter(([m, p]) => exemptFromPlan(m, p) && heldInStore(m, p)).map(([m, p]) => `${m} ${p}`);
    expect(both, 'routes held in the store that the rule also exempts').toEqual([]);
    // And every route held in the store is one the app has.
    for (const [m, p] of HELD) expect(table.some(([tm, tp]) => tm === m && tp === p), `${m} ${p}`).toBe(true);
  });

  it('lets a lapsed account read, delete, manage its account and pay', () => {
    expect(exemptFromPlan('GET', '/api/notes')).toBe(true);
    expect(exemptFromPlan('DELETE', '/api/notes/abc')).toBe(true);
    expect(exemptFromPlan('DELETE', '/api/notes/abc/files/scan.pdf')).toBe(true);
    expect(exemptFromPlan('POST', '/api/notes/trash')).toBe(true);
    expect(exemptFromPlan('POST', '/api/notes/abc/restore')).toBe(true);
    expect(exemptFromPlan('POST', '/api/auth/sign-out')).toBe(true);
    expect(exemptFromPlan('POST', '/api/billing/checkout')).toBe(true);
    expect(exemptFromPlan('POST', '/api/mcp')).toBe(true);
    expect(exemptFromPlan('POST', '/api/attachments/texts')).toBe(true);
    expect(exemptFromPlan('POST', '/api/admin/purge-notes')).toBe(true);
  });

  it('sends a lapsed account on to the store for the writes the free plan holds there', () => {
    for (const [m, p] of HELD) expect(heldInStore(m, p), `${m} ${p}`).toBe(true);
    expect(heldInStore('POST', '/api/notes/abc/autofill')).toBe(true);
    expect(heldInStore('DELETE', '/api/notes/abc')).toBe(false);
    expect(heldInStore('POST', '/api/notes/abc/restore')).toBe(false);
  });

  it('exempts nothing else', () => {
    expect(exemptFromPlan('POST', '/api/notes')).toBe(false);
    expect(exemptFromPlan('PATCH', '/api/notes/abc')).toBe(false);
    expect(exemptFromPlan('PUT', '/api/notes/abc/files')).toBe(false);
    expect(exemptFromPlan('POST', '/api/notes/abc/autofill')).toBe(false);
    expect(exemptFromPlan('POST', '/api/import/note')).toBe(false);
    // A segment pattern is a whole segment, not a prefix.
    expect(exemptFromPlan('POST', '/api/notes/abc/restore/extra')).toBe(false);
  });
});
