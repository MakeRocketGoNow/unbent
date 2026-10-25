import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { NotebookView } from '@unbent/shared';
import { onAppError } from '../app.js';
import type { AppEnv } from '../types.js';
import { views } from './views.js';

/**
 * The views routes' answers: the status each store outcome becomes, and what the request
 * schemas refuse before the store is asked. The store's own rules (positions, the name
 * check, what each write records) are pinned in apps/store-tests against the real
 * object; this stands in a store that answers as the object does, and counts its calls,
 * since each route is meant to be one.
 */

const NOTEBOOK = '00000000-0000-4000-8000-000000000001';
const VIEW: NotebookView = { id: 'v1', notebookId: NOTEBOOK, name: 'Business 2026', position: 0, query: { tag: ['acme'] }, updatedAt: 1 };

function fakeEnv() {
  const calls: string[] = [];
  const store = {
    listViews: async () => (calls.push('listViews'), [VIEW]),
    createView: async (notebookId: string, name: string, query: NotebookView['query']) => {
      calls.push('createView');
      if (notebookId !== NOTEBOOK) return 'missing';
      if (name.toLowerCase() === VIEW.name.toLowerCase()) return 'conflict';
      return { ...VIEW, id: 'v2', name, query, position: 1 };
    },
    updateView: async (id: string, patch: { name?: string; position?: number }) => {
      calls.push('updateView');
      if (id !== VIEW.id) return 'missing';
      if (patch.name === 'Personal') return 'conflict';
      return { ...VIEW, ...patch };
    },
    deleteView: async (id: string) => (calls.push('deleteView'), id === VIEW.id),
  };
  const env = { USER_STORE: { idFromName: (name: string) => name, get: () => store } } as unknown as AppEnv['Bindings'];
  return { env, calls };
}

function app() {
  return new Hono<AppEnv>()
    .onError(onAppError)
    .use(async (c, next) => {
      c.set('userId', 'u1');
      await next();
    })
    .route('/api', views);
}

const json = (method: string, body: unknown) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('the views routes', () => {
  it('list every view, and make one: 201, 404 for a notebook not here, 409 for a taken name', async () => {
    const { env, calls } = fakeEnv();
    const listed = await app().request('/api/views', {}, env);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ views: [VIEW] });

    const made = await app().request('/api/views', json('POST', { notebookId: NOTEBOOK, name: '  Personal ', query: { sort: 'title', layout: 'cards' } }), env);
    expect(made.status).toBe(201);
    // The name arrives trimmed: the schema's, before the store.
    expect(await made.json()).toMatchObject({ id: 'v2', name: 'Personal', position: 1, query: { sort: 'title', layout: 'cards' } });

    const elsewhere = await app().request('/api/views', json('POST', { notebookId: '00000000-0000-4000-8000-000000000002', name: 'Acme', query: {} }), env);
    expect(elsewhere.status).toBe(404);
    const taken = await app().request('/api/views', json('POST', { notebookId: NOTEBOOK, name: 'business 2026', query: {} }), env);
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: 'A view with that name already exists' });
    // One store call a request.
    expect(calls).toEqual(['listViews', 'createView', 'createView', 'createView']);
  });

  it('refuses before the store a view with no notebook, an empty name, or a query this build cannot read', async () => {
    const { env, calls } = fakeEnv();
    for (const body of [
      { notebookId: null, name: 'Acme', query: {} },
      { name: 'Acme', query: {} },
      { notebookId: NOTEBOOK, name: '   ', query: {} },
      { notebookId: NOTEBOOK, name: 'Acme', query: { q: 'search text' } },
      { notebookId: NOTEBOOK, name: 'Acme', query: { field: ['not a filter'] } },
    ]) {
      expect((await app().request('/api/views', json('POST', body), env)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await app().request('/api/views/v1', json('PATCH', {}), env)).status).toBe(400);
    expect((await app().request('/api/views/v1', json('PATCH', { position: -1 }), env)).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('edit a view: 200 with the view as it now is, 404 for one not here, 409 for a taken name', async () => {
    const { env } = fakeEnv();
    const moved = await app().request('/api/views/v1', json('PATCH', { position: 3 }), env);
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({ id: 'v1', position: 3 });
    expect((await app().request('/api/views/nope', json('PATCH', { name: 'Acme' }), env)).status).toBe(404);
    expect((await app().request('/api/views/v1', json('PATCH', { name: 'Personal' }), env)).status).toBe(409);
  });

  it('delete a view: 204, and 404 for one not here', async () => {
    const { env } = fakeEnv();
    const gone = await app().request('/api/views/v1', { method: 'DELETE' }, env);
    expect(gone.status).toBe(204);
    expect((await app().request('/api/views/nope', { method: 'DELETE' }, env)).status).toBe(404);
  });
});
