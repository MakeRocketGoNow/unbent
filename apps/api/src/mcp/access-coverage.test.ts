/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every store method the MCP tools can reach is one a restricted connection may call
 * (MAK-264), held the way the store's other lists are held: by reading the source.
 *
 * A restricted connection's repo reaches the store only through `UserStore.scoped`,
 * which refuses a method with no entry in `restricted`. That is the right default and
 * it has a cost: a method a tool reaches that nobody listed fails for restricted
 * connections alone, and when the call is made after the answer has gone
 * (`storeAttachment` reads a PDF's text under `waitUntil`) it fails into a log line and
 * nothing else. That is how `recordText` was missed, and no test noticed, because the
 * live suite calls each tool and reads its answer.
 *
 * So this walks from the tool modules through everything they import, collects every
 * call made on a notes or attachments repo, maps each through the facade to the store
 * method it makes, and fails by name on one with no entry. By the receiver's name
 * (`notes.x(`, `repos.attachments.x(`), which is how every one of these files spells a
 * repo; a call it cannot see is one the live suite's restricted connection has to find.
 */

const SRC = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(path, 'utf8');

/** `file` and every source file it imports, transitively, tests and types-only imports left out. */
function reachable(entries: string[]): string[] {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const m of read(file).matchAll(/^import (?!type )[^;]*? from '(\.[^']+)\.js';/gms)) {
      const next = resolve(dirname(file), `${m[1]}.ts`);
      // The store itself is the other side of the call, not a caller of the repos.
      if (next.startsWith(SRC) && !next.startsWith(join(SRC, 'store'))) queue.push(next);
    }
  }
  return [...seen];
}

/** A facade's methods, each with the store method it calls: `get` -> `get`, `ownsNote` -> `ownsNote`, `record` -> `recordAttachment`. */
function facade(path: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const source = read(path);
  const starts = [...source.matchAll(/^  (?:async )?([a-zA-Z]\w*)(?:<[^>]*>)?\(/gm)];
  starts.forEach((m, i) => {
    const body = source.slice(m.index, starts[i + 1]?.index ?? source.length);
    const calls = [...body.matchAll(/\(s\) => s\.(\w+)\(/g)].map((c) => c[1]!);
    if (calls.length > 0) out.set(m[1]!, [...(out.get(m[1]!) ?? []), ...calls]);
  });
  return out;
}

describe('the store methods the MCP tools reach', () => {
  const tools = ['attachments', 'clip', 'feedback', 'read', 'write'].map((name) => join(SRC, 'mcp', 'tools', `${name}.ts`));
  const files = reachable([...tools, join(SRC, 'mcp', 'server.ts')]);
  const facades = { notes: facade(join(SRC, 'lib', 'notes-repo.ts')), attachments: facade(join(SRC, 'lib', 'attachments-repo.ts')) };
  const block = /private readonly restricted[^=]*= \{\n([\s\S]*?)\n  \};/.exec(read(join(SRC, 'store', 'user-store.ts')))?.[1] ?? '';
  const listed = new Set([...block.matchAll(/^    ([a-zA-Z]\w*): /gm)].map((m) => m[1]!));

  it('finds the tools, the helpers they call after answering, and the list', () => {
    expect(files).toContain(join(SRC, 'lib', 'store-attachment.ts'));
    expect(files).toContain(join(SRC, 'lib', 'read-attachment.ts'));
    expect(facades.attachments.get('record')).toEqual(['recordAttachment']);
    expect(listed.size).toBeGreaterThan(30);
  });

  it('are all on the list a restricted connection is held to', () => {
    const reached = new Map<string, string>();
    for (const file of files) {
      for (const m of read(file).matchAll(/\b(notes|attachments)\.([a-zA-Z]\w*)\(/g)) {
        for (const method of facades[m[1] as 'notes' | 'attachments'].get(m[2]!) ?? []) {
          reached.set(method, `${m[1]}.${m[2]} in ${file.slice(SRC.length + 1)}`);
        }
      }
    }
    // The ones a tool plainly makes, so a walk that found nothing would not pass.
    for (const method of ['get', 'listPage', 'createOrFind', 'recordAttachment', 'recordText', 'attachmentBytes']) {
      expect(reached.has(method), method).toBe(true);
    }
    const unlisted = [...reached].filter(([method]) => !listed.has(method)).map(([method, where]) => `${method} (${where})`);
    expect(unlisted, 'add each to `restricted` in store/user-store.ts, held to the grant, with a case in apps/store-tests/test/access.test.ts').toEqual([]);
  });
});
