import { PLAN_INACTIVE_MESSAGE } from '@unbent/shared';
import type { McpServer } from '@modelcontextprotocol/server';
import { toolError } from './tools/result.js';

/**
 * The read-only rule for an assistant (MAK-108): the same as the HTTP routes' — a lapsed
 * account's writes are refused, its reads and deletes are not — applied where the MCP
 * endpoint can apply it, which is per tool rather than per request, since every tool is
 * one `POST /api/mcp`. A new connection can still be authorised; what it can do once
 * connected is decided here.
 *
 * By the tool's own annotation, so a tool cannot be forgotten: one that does not say
 * `readOnlyHint: true` is a write and is gated unless its name is in `ALLOWED_INACTIVE`,
 * the deletes and the undo of a delete, as `exemptFromPlan` allows them over HTTP. The
 * gate asks the plan once per call — one D1 read by key — and answers the model with the
 * sentence the page shows, as a tool error it can read and relay rather than an exception
 * that ends the conversation.
 */
export const ALLOWED_INACTIVE: ReadonlySet<string> = new Set([
  'delete_note',
  'delete_notes',
  'restore_note',
  'restore_notes',
  'delete_notebook',
  'delete_tag',
]);

/** Answers the sentence to refuse with, or null to let the call through. */
export type PlanGate = () => Promise<string | null>;

/** The sentence an assistant is given, which says what still works. */
export const INACTIVE_TOOL_MESSAGE = `${PLAN_INACTIVE_MESSAGE} Reading, searching and deleting still work from here.`;

type RegisterTool = McpServer['registerTool'];

/** What the write modules take in place of the server: `registerTool`, and nothing else. */
export type Registrar = { registerTool: RegisterTool };

/**
 * A `registerTool` that puts `gate` in front of every write tool's handler. The write
 * modules take this in place of the server, so the choice of what is gated is made here
 * and not in twenty handlers. `registerTool` is overloaded on the schema library in use,
 * which is why the wrapper is written untyped and cast: it changes nothing about the
 * arguments, and the test calls the handlers it registers.
 */
export function gatedRegistrar(server: McpServer, gate: PlanGate): Registrar {
  const registerTool = (name: string, config: { annotations?: { readOnlyHint?: boolean } }, cb: (...args: unknown[]) => unknown) => {
    const readOnly = config.annotations?.readOnlyHint === true;
    if (readOnly || ALLOWED_INACTIVE.has(name)) return server.registerTool(name, config as never, cb as never);
    const guarded = async (...args: unknown[]) => {
      const refused = await gate();
      if (refused) return toolError(refused);
      return cb(...args);
    };
    return server.registerTool(name, config as never, guarded as never);
  };
  return { registerTool: registerTool as unknown as RegisterTool };
}
