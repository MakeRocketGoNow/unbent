import { Hono } from 'hono';
import { protectMcp, userIdFrom } from '../mcp/auth.js';
import { createUnbentMcpHandler } from '../mcp/server.js';
import type { AppEnv } from '../types.js';

/**
 * The MCP endpoint: one URL an AI assistant connects to and calls tools on.
 *
 * Everything about who is calling comes from the access token, not from the session
 * middleware that runs in front of every route here — an MCP client sends no cookie, and a
 * token is the only credential in play. `protectMcp` answers 401 with the header that tells
 * an unauthenticated client where to start the OAuth flow, so the first thing a fresh client
 * does is get refused here and go and get consent.
 *
 * Mounted under /api because that is what wrangler routes to this Worker; a path outside it
 * would be answered by the SPA's index.html.
 */
export const mcpRoutes = new Hono<AppEnv>().all('/mcp', (c) =>
  protectMcp(c.env, async (request, claims) =>
    createUnbentMcpHandler(c.env, userIdFrom(claims)).fetch(request),
  )(c.req.raw),
);
