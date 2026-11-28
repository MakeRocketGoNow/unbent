import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import type { AssistantGrant } from '@unbent/shared';
import { connectionInstructions } from '../lib/access.js';
import { appLinks } from '../lib/app-links.js';
import { storeAccessOf } from '../lib/assistant-grants.js';
import { canUseLlm } from '../lib/llm.js';
import { billingOn } from '../lib/stripe.js';
import { refuseIfPastFree } from '../lib/free-plan.js';
import { lapsed, planFor, type PlanRow } from '../lib/plan.js';
import { quotaOf, writeLimitsOf } from '../lib/quota.js';
import { reposFor } from '../lib/repos.js';
import { UploadGrantsRepo } from '../lib/upload-grants.js';
import type { Env } from '../types.js';
import { INACTIVE_TOOL_MESSAGE, gatedRegistrar, type PlanGate } from './plan-gate.js';
import { registerAttachmentTools } from './tools/attachments.js';
import { registerClipTool } from './tools/clip.js';
import { registerFeedbackTool } from './tools/feedback.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';

/**
 * The MCP server, built fresh for each request.
 *
 * The factory runs per request, which is what lets the tools close over repos already bound
 * to the caller's own note store, the same arrangement `withRepos` gives the HTTP routes,
 * and the reason a tool never takes a user id as an argument. Isolation is then structural rather than
 * something each tool has to remember.
 *
 * The same goes for a connection the person gave only some notebooks: its repos are
 * bound to that grant as they are bound to the user, so what it may reach is settled
 * here, once, for every tool.
 *
 * `legacy` is left at its default so both the 2025 and the 2026-07-28 protocol revisions are
 * served. Clients are spread across both right now, and rejecting the older one would mean
 * refusing connections for no benefit to anyone.
 */
export function createUnbentMcpHandler(
  env: Env,
  userId: string,
  /** The OAuth client calling: the feedback tool names it, and each upload link it mints carries it so the PUT can re-check its grant. */
  clientId: string,
  /** What the person gave this connection (MAK-264): read with the consent on every call, by `protectMcp`. */
  grant: AssistantGrant,
  // Structural rather than the platform's ExecutionContext: Hono hands the route a
  // narrower type, and waitUntil is the only member anything here calls.
  ctx: { waitUntil(promise: Promise<unknown>): void },
) {
  // Before the handler, so an APP_URL no link can be built from fails the request by name
  // rather than answering every tool with an address that goes nowhere.
  const links = appLinks(env.APP_URL);
  return createMcpHandler(() => {
    // A restricted connection is told what it was not given when it connects, so the
    // first it hears of a limit is not a refusal (`connectionInstructions`).
    const instructions = connectionInstructions(grant);
    const server = new McpServer({ name: 'unbent', version: '1.0.0' }, instructions ? { instructions } : {});
    // The plan row, read once per request and only where billing is on: this endpoint
    // has no row on a context (every tool is one POST), and the gate, the store's room
    // (MAK-234) and the quota on files all come off the same row. A read that fails is
    // not kept, so the next asker reads again rather than inheriting the failure.
    let row: Promise<PlanRow | undefined> | undefined;
    const plan = () => (row ??= (billingOn(env) ? planFor(env.DB, userId) : Promise.resolve(undefined)).catch((err: unknown) => {
      row = undefined;
      throw err;
    }));
    // Both repos are held to the grant's notebooks, in the store, on every call: a
    // connection given a list has no other way to its notes (`StoreRepo`), so no tool
    // below has to know whether it is restricted, and none can forget to ask.
    const { notes, attachments } = reposFor(env, userId, async () => writeLimitsOf(env, await plan()), storeAccessOf(grant));
    registerReadTools(server, notes, attachments, links, { vision: canUseLlm(env), partial: grant.notebooks !== null });
    // The write tools go through the plan's gate (mcp/plan-gate.ts). Most are held to
    // the free plan in the store, through the limits the repos carry, and never ask it;
    // one that is not is refused a lapsed account, as an unlisted HTTP route is. Nothing
    // is asked where billing is off.
    const gate: PlanGate = async () => {
      const current = await plan();
      return current && lapsed(current, Date.now()) ? INACTIVE_TOOL_MESSAGE : null;
    };
    // A read-only connection is given no write tool by this registrar, and one given only
    // some notebooks none of the tools that reach past them; see `gatedRegistrar`.
    const gated = gatedRegistrar(server, gate, { readOnly: grant.readOnly, partial: grant.notebooks !== null });
    registerWriteTools(gated, notes, links, { partial: grant.notebooks !== null });
    // Upload links stay in D1: the token is looked up before anyone knows whose it is.
    // The client goes on the row so the PUT can re-check this connection's grant.
    const uploads = new UploadGrantsRepo(env.DB, userId, clientId);
    registerAttachmentTools(
      gated,
      env,
      ctx,
      { notes, attachments, uploads },
      links,
      async () => quotaOf(env, await plan()),
      async () => refuseIfPastFree(env, attachments, await plan()),
    );
    // A web page kept as a note, fetched here: the same function as `POST /api/clip`.
    // Registers nothing where the instance has not switched the clipper on (`WEB_CLIP`).
    registerClipTool(
      gated,
      env,
      ctx,
      { notes, attachments },
      links,
      async () => quotaOf(env, await plan()),
      async () => refuseIfPastFree(env, attachments, await plan()),
    );
    // Feedback on the tools goes to the operator, in D1 (MAK-212).
    registerFeedbackTool(gated, env.DB, { userId, clientId });
    return server;
  });
}
