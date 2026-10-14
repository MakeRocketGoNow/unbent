import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { ALLOWED_INACTIVE, gatedRegistrar } from './plan-gate.js';

/**
 * A stand-in server that records what was registered, so the test can call each handler
 * and see whether the gate stood in front of it.
 */
function fakeServer() {
  const tools = new Map<string, (...args: unknown[]) => unknown>();
  const server = {
    registerTool: (name: string, _config: unknown, cb: (...args: unknown[]) => unknown) => {
      tools.set(name, cb);
    },
  } as unknown as McpServer;
  return { server, tools };
}

describe('gatedRegistrar', () => {
  it('refuses a write while the gate says so, and lets reads and deletes through', async () => {
    const { server, tools } = fakeServer();
    let refusal: string | null = 'Read-only.';
    const gated = gatedRegistrar(server, async () => refusal);
    const calls: string[] = [];
    const handler = (name: string) => async () => {
      calls.push(name);
      return { content: [] };
    };
    gated.registerTool('create_note', { annotations: { readOnlyHint: false } } as never, handler('create_note') as never);
    gated.registerTool('get_note', { annotations: { readOnlyHint: true } } as never, handler('get_note') as never);
    gated.registerTool('delete_note', { annotations: { readOnlyHint: false, destructiveHint: true } } as never, handler('delete_note') as never);
    gated.registerTool('unannotated', {} as never, handler('unannotated') as never);

    expect(await tools.get('create_note')!()).toMatchObject({ isError: true });
    expect(await tools.get('unannotated')!()).toMatchObject({ isError: true });
    await tools.get('get_note')!();
    await tools.get('delete_note')!();
    expect(calls).toEqual(['get_note', 'delete_note']);

    refusal = null;
    await tools.get('create_note')!();
    expect(calls).toEqual(['get_note', 'delete_note', 'create_note']);
  });

  it('allows exactly the deletes and their undo', () => {
    expect([...ALLOWED_INACTIVE].sort()).toEqual(['delete_note', 'delete_notebook', 'delete_notes', 'delete_tag', 'restore_note', 'restore_notes', 'set_attachment_text']);
  });
});
