import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { StorageFull } from '../lib/quota.js';
import { appLinks } from '../lib/app-links.js';
import { PlanRefused } from '../lib/free-plan.js';
import { ALLOWED_INACTIVE, HELD_IN_STORE_TOOLS, gatedRegistrar } from './plan-gate.js';
import { registerAttachmentTools } from './tools/attachments.js';
import { registerFeedbackTool } from './tools/feedback.js';
import { registerWriteTools } from './tools/write.js';

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
    gated.registerTool('some_new_write', { annotations: { readOnlyHint: false } } as never, handler('some_new_write') as never);
    gated.registerTool('get_note', { annotations: { readOnlyHint: true } } as never, handler('get_note') as never);
    gated.registerTool('delete_note', { annotations: { readOnlyHint: false, destructiveHint: true } } as never, handler('delete_note') as never);
    gated.registerTool('unannotated', {} as never, handler('unannotated') as never);
    // Held to the free plan in the store, so the gate is not asked: the store decides.
    gated.registerTool('create_note', { annotations: { readOnlyHint: false } } as never, handler('create_note') as never);

    expect(await tools.get('some_new_write')!()).toMatchObject({ isError: true });
    expect(await tools.get('unannotated')!()).toMatchObject({ isError: true });
    await tools.get('get_note')!();
    await tools.get('delete_note')!();
    await tools.get('create_note')!();
    expect(calls).toEqual(['get_note', 'delete_note', 'create_note']);

    refusal = null;
    await tools.get('some_new_write')!();
    expect(calls).toEqual(['get_note', 'delete_note', 'create_note', 'some_new_write']);
  });

  it('answers the free plan’s refusal from the store as a tool error naming the numbers', async () => {
    const { server, tools } = fakeServer();
    const gated = gatedRegistrar(server, async () => null);
    gated.registerTool('create_notes', { annotations: { readOnlyHint: false } } as never, (async () => {
      throw new PlanRefused('FREE_NOTES_FULL', { notes: 100, attachmentBytes: 0 }, 3);
    }) as never);
    const refused = (await tools.get('create_notes')!()) as { isError: boolean; content: Array<{ text: string }> };
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain('holds up to 100 notes');
  });

  it('says of every write tool whether the store holds it or a read-only account may use it, never both', () => {
    expect([...HELD_IN_STORE_TOOLS].filter((t) => ALLOWED_INACTIVE.has(t))).toEqual([]);
    // Every write tool the endpoint registers, read off the modules themselves, so a new
    // one turns up here: on neither list, the gate refuses it a free account outright.
    const writes: string[] = [];
    const recorder = {
      registerTool: (name: string, config: { annotations?: { readOnlyHint?: boolean } }) => {
        if (config.annotations?.readOnlyHint !== true) writes.push(name);
      },
    } as never;
    const links = appLinks('https://example.com');
    registerWriteTools(recorder, {} as never, links);
    registerAttachmentTools(recorder, {} as never, { waitUntil: () => {} }, {} as never, links, async () => null);
    registerFeedbackTool(recorder, {} as never, { userId: 'u1', clientId: 'c1' });
    expect(writes.length).toBeGreaterThan(10);
    expect(writes.filter((t) => !HELD_IN_STORE_TOOLS.has(t) && !ALLOWED_INACTIVE.has(t)), 'write tools on neither list').toEqual([]);
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
