import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import type { FeedbackDb, FeedbackStatement } from '../../lib/assistant-feedback.js';
import { gatedRegistrar } from '../plan-gate.js';
import { registerFeedbackTool } from './feedback.js';

type Handler = (args: { category: string; feedback: string; tool?: string }) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;

/**
 * The tool through the plan's gate as the server registers it, over a D1 that records
 * what it was asked to write and answers the insert with `changes`. The bound itself is
 * SQLite's to enforce and is tested in `lib/assistant-feedback.test.ts`; this is what the
 * model is told either way, and that a lapsed account's assistant is not refused.
 */
function setup(changes: number) {
  const binds: unknown[][] = [];
  const statement: FeedbackStatement = {
    all: async () => ({ results: [] }),
    run: async () => ({ meta: { changes } }),
  };
  const db: FeedbackDb = {
    prepare: () => ({
      bind: (...values) => {
        binds.push(values);
        return statement;
      },
    }),
    batch: (statements) => Promise.all(statements.map((s) => s.run())),
  };
  const tools = new Map<string, Handler>();
  const server = { registerTool: (name: string, _config: unknown, cb: Handler) => void tools.set(name, cb) } as unknown as McpServer;
  // A gate that refuses every write, as a lapsed account's does.
  registerFeedbackTool(gatedRegistrar(server, async () => 'Read-only.'), db, { userId: 'u1', clientId: 'client-1' });
  return { send: tools.get('send_feedback')!, binds };
}

describe('send_feedback', () => {
  it("keeps the feedback against the caller's account and client, even for a lapsed account", async () => {
    const { send, binds } = setup(1);
    const answer = await send({ category: 'missing-capability', feedback: 'No tool renames a notebook field option.', tool: '' });
    expect(answer.isError).toBeUndefined();
    expect(answer.content[0]!.text).toMatch(/^Sent\./);
    // The insert's binds: account, client, category, tool (an empty name is none), body.
    expect(binds[1]!.slice(0, 5)).toEqual(['u1', 'client-1', 'missing-capability', null, 'No tool renames a notebook field option.']);
  });

  it("tells the model the day's bound is spent, and to carry on", async () => {
    const { send } = setup(0);
    const answer = await send({ category: 'other', feedback: 'Again.' });
    expect(answer.isError).toBe(true);
    expect(answer.content[0]!.text).toContain('was not kept');
  });
});
