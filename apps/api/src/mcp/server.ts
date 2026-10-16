import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { appLinks } from '../lib/app-links.js';
import { canUseLlm } from '../lib/llm.js';
import { billingOn } from '../lib/paddle.js';
import { planFor, planStateOf } from '../lib/plan.js';
import { quotaFor } from '../lib/quota.js';
import { reposFor } from '../lib/repos.js';
import { UploadGrantsRepo } from '../lib/upload-grants.js';
import type { Env } from '../types.js';
import { INACTIVE_TOOL_MESSAGE, gatedRegistrar, type PlanGate } from './plan-gate.js';
import { registerAttachmentTools } from './tools/attachments.js';
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
 * `legacy` is left at its default so both the 2025 and the 2026-07-28 protocol revisions are
 * served. Clients are spread across both right now, and rejecting the older one would mean
 * refusing connections for no benefit to anyone.
 */
export function createUnbentMcpHandler(
  env: Env,
  userId: string,
  // Structural rather than the platform's ExecutionContext: Hono hands the route a
  // narrower type, and waitUntil is the only member anything here calls.
  ctx: { waitUntil(promise: Promise<unknown>): void },
) {
  // Before the handler, so an APP_URL no link can be built from fails the request by name
  // rather than answering every tool with an address that goes nowhere.
  const links = appLinks(env.APP_URL);
  return createMcpHandler(() => {
    const server = new McpServer({ name: 'unbent', version: '1.0.0' });
    const { notes, attachments } = reposFor(env, userId);
    registerReadTools(server, notes, attachments, links, { vision: canUseLlm(env) });
    // The write tools go through the plan's gate (mcp/plan-gate.ts): a lapsed account's
    // assistant reads and deletes, and is told why it can do no more. Nothing is asked
    // where billing is off.
    const gate: PlanGate = async () =>
      billingOn(env) && planStateOf(await planFor(env.DB, userId), Date.now()) === 'inactive' ? INACTIVE_TOOL_MESSAGE : null;
    const gated = gatedRegistrar(server, gate);
    registerWriteTools(gated, notes, links);
    // Upload links stay in D1: the token is looked up before anyone knows whose it is.
    const uploads = new UploadGrantsRepo(env.DB, userId);
    registerAttachmentTools(gated, env, ctx, { notes, attachments, uploads }, links, () => quotaFor(env, env.DB, userId));
    return server;
  });
}
