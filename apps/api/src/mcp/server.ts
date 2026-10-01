import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { reposFor } from '../lib/repos.js';
import { UploadGrantsRepo } from '../lib/upload-grants.js';
import type { Env } from '../types.js';
import { registerAttachmentTools } from './tools/attachments.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';

/**
 * The MCP server, built fresh for each request.
 *
 * The factory runs per request, which is what lets the tools close over repos already bound
 * to the caller's own note store — the same arrangement `withRepos` gives the HTTP routes,
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
  return createMcpHandler(() => {
    const server = new McpServer({ name: 'unbent', version: '1.0.0' });
    const { notes, attachments } = reposFor(env, userId);
    registerReadTools(server, notes, attachments);
    registerWriteTools(server, notes);
    // Upload links stay in D1: the token is looked up before anyone knows whose it is.
    const uploads = new UploadGrantsRepo(env.DB, userId);
    registerAttachmentTools(server, env, ctx, { notes, attachments, uploads });
    return server;
  });
}
