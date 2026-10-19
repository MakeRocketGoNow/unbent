import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { StorageFull } from '../lib/quota.js';
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

  it('answers a write the store refused for its size as a tool error, and rethrows anything else', async () => {
    const { server, tools } = fakeServer();
    const gated = gatedRegistrar(server, async () => null);
    gated.registerTool('create_note', { annotations: { readOnlyHint: false } } as never, (async () => {
      throw new StorageFull(2000, 1000, 0, 'notes');
    }) as never);
    gated.registerTool('edit_note', { annotations: { readOnlyHint: false } } as never, (async () => {
      throw new Error('no such table');
    }) as never);
    const refused = (await tools.get('create_note')!()) as { isError: boolean; content: Array<{ text: string }> };
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain('notes take more room');
    await expect(tools.get('edit_note')!()).rejects.toThrow('no such table');
  });

  it('allows exactly the deletes and their undo, the recorded reading, and feedback', () => {
    expect([...ALLOWED_INACTIVE].sort()).toEqual([
      'delete_note',
      'delete_notebook',
      'delete_notes',
      'delete_tag',
      'restore_note',
      'restore_notes',
      'send_feedback',
      'set_attachment_text',
    ]);
  });
});
