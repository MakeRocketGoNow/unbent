import { PLAN_INACTIVE_MESSAGE } from '@unbent/shared';
import type { McpServer } from '@modelcontextprotocol/server';
import { PlanRefused } from '../lib/free-plan.js';
import { StorageFull } from '../lib/quota.js';
import { toolError } from './tools/result.js';

/**
 * The plan's rule for an assistant (MAK-108, and the free plan of 2026-10-24): the same
 * as the HTTP routes' (an account past the free plan is refused its writes, never its
 * reads and deletes), applied where the MCP endpoint can apply it, which is per tool
 * rather than per request, since every tool is one `POST /api/mcp`. A new connection
 * can still be authorised; what it can do once connected is decided here, and for most
 * write tools in the store (`HELD_IN_STORE_TOOLS`).
 *
 * By the tool's own annotation, so a tool cannot be forgotten: one that does not say
 * `readOnlyHint: true` is a write and is gated unless its name is in `ALLOWED_INACTIVE`:
 * the deletes and the undo of a delete, as `exemptFromPlan` allows them over HTTP, and
 * recording what the assistant read off a file, which is the same derived data the
 * browser's pass writes through the exempt `PUT …/text`, not the person's writing, and
 * a tool told to read a picture and then refused the recording would be told to do
 * something it cannot. And `send_feedback`, which writes the operator's table, not the
 * account's notes: an assistant refused at every write has the most to say. The
 * gate asks the plan once per call (one D1 read by key) and answers the model with the
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
  'set_attachment_text',
  'send_feedback',
]);

/**
 * The write tools whose every write goes to the store with the free plan's limits, as
 * `HELD_IN_STORE` lists the HTTP routes: for these the gate is not asked, and the store
 * decides (an account past the free plan is read-only, a note past its count is
 * refused), with its sentence returned as the tool's error below. Upload links are
 * here too: minting one writes a grant and no note, and the upload it leads to records
 * its file through the store like any other. A write tool on neither list is refused
 * a lapsed account by the gate, until someone says which it is.
 */
export const HELD_IN_STORE_TOOLS: ReadonlySet<string> = new Set([
  'create_note',
  'create_notes',
  'edit_note',
  'update_note',
  'update_note_fields',
  'update_note_tags',
  'move_notes',
  'create_notebook',
  'update_notebook',
  'create_notebook_field',
  'update_notebook_field',
  'rename_tag',
  'add_attachment',
  'prepare_attachment_upload',
]);

/** Answers the sentence to refuse with, or null to let the call through. */
export type PlanGate = () => Promise<string | null>;

/** The sentence an assistant is given by the gate, which says what still works. */
export const INACTIVE_TOOL_MESSAGE = `${PLAN_INACTIVE_MESSAGE} Reading, searching and deleting still work from here.`;

type RegisterTool = McpServer['registerTool'];

/** What the write modules take in place of the server: `registerTool`, and nothing else. */
export type Registrar = { registerTool: RegisterTool };

/**
 * A `registerTool` that puts `gate` in front of every write tool's handler, and the
 * store's own refusal of a write (`StorageFull`) behind it. The write modules take this
 * in place of the server, so the choice of what is gated is made here and not in
 * twenty handlers. `registerTool` is overloaded on the schema library in use,
 * which is why the wrapper is written untyped and cast: it changes nothing about the
 * arguments, and the test calls the handlers it registers.
 */
export function gatedRegistrar(server: McpServer, gate: PlanGate): Registrar {
  const registerTool = (name: string, config: { annotations?: { readOnlyHint?: boolean } }, cb: (...args: unknown[]) => unknown) => {
    const readOnly = config.annotations?.readOnlyHint === true;
    if (readOnly || ALLOWED_INACTIVE.has(name)) return server.registerTool(name, config as never, cb as never);
    const asksGate = !HELD_IN_STORE_TOOLS.has(name);
    const guarded = async (...args: unknown[]) => {
      const refused = asksGate ? await gate() : null;
      if (refused) return toolError(refused);
      try {
        return await cb(...args);
      } catch (err) {
        // The store's refusal of a write for its size (MAK-234), as the gate's own
        // refusal is given: a sentence the model can relay, which names the way out,
        // rather than an exception that ends the conversation. Here, behind every
        // write tool at once, rather than in each handler's own catch.
        if (err instanceof StorageFull) return toolError(err.message);
        // And the free plan's (an account past it, or a note past its count), which the
        // store decides from the limits the repos carry: the same kind of sentence.
        if (err instanceof PlanRefused) return toolError(err.message);
        throw err;
      }
    };
    return server.registerTool(name, config as never, guarded as never);
  };
  return { registerTool: registerTool as unknown as RegisterTool };
}
