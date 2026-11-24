import { ASSISTANT_GRANT_MAX_NOTEBOOKS, FULL_GRANT, type AssistantGrant } from '@unbent/shared';
import type { StoreAccess } from './access.js';

/**
 * A connected assistant's grant, as D1 keeps it (migration 0049) and as the rest of the
 * Worker reads it (MAK-264).
 *
 * The row is the Worker's, and the note store never sees it whole: what the store is
 * handed with each call is `storeAccessOf` of it, the notebooks alone, and only for a
 * connection that was given a list. Whether a connection may write is settled before
 * that, where its tools are registered (src/mcp/server.ts).
 */

/** The columns of `assistant_grants` a grant is read from. */
export interface GrantRow {
  notebooks: string | null;
  unfiled: number | null;
  read_only: number | null;
}

/**
 * A grant with nothing in it: no notebook, no unfiled notes, no writes. What a row that
 * cannot be read means. Never the whole library: a stored grant this code cannot make
 * sense of was meant to hold something back, and guessing "everything" is the one wrong
 * answer that shows a person's notes to an assistant they chose to keep them from.
 */
const NOTHING: AssistantGrant = { notebooks: [], unfiled: false, readOnly: true };

/**
 * The grant a row says. A list is kept to its strings and to the bound it was saved
 * under; anything else in the column (text that is not JSON, JSON that is not a list)
 * is `NOTHING`.
 */
export function grantOf(row: GrantRow): AssistantGrant {
  const readOnly = row.read_only === 1;
  if (row.notebooks === null) return { notebooks: null, unfiled: true, readOnly };
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.notebooks);
  } catch {
    return NOTHING;
  }
  if (!Array.isArray(parsed) || parsed.length > ASSISTANT_GRANT_MAX_NOTEBOOKS || !parsed.every((id) => typeof id === 'string')) return NOTHING;
  return { notebooks: parsed as string[], unfiled: row.unfiled === 1, readOnly };
}

/**
 * What the note store is held to for this grant: the notebooks, for a connection given
 * a list, and null for one given the library, whose calls are then the calls anyone
 * makes (`reposFor`).
 */
export function storeAccessOf(grant: AssistantGrant): StoreAccess | null {
  return grant.notebooks === null ? null : { notebooks: grant.notebooks, unfiled: grant.unfiled };
}

/** `connectionGrant`'s statement, apart so migrations.test.ts can ask for its plan: it runs on every tool call. */
export const CONNECTION_GRANT_SQL = `SELECT g.user_id AS granted, g.notebooks, g.unfiled, g.read_only
   FROM oauthConsent c
   LEFT JOIN assistant_grants g ON g.user_id = c.userId AND g.client_id = c.clientId
  WHERE c.clientId = ?1 AND c.userId = ?2
  LIMIT 1`;

/**
 * The grant of the connection a token belongs to, or null when the person has
 * disconnected it: one read, of the consent and the grant beside it.
 *
 * The consent is the row that says the app may act at all, and the MCP endpoint has
 * always read it on every call for that reason (`protectMcp`). The grant rides on the
 * same lookup by a LEFT JOIN on its primary key, so restricting a connection added no
 * query to a tool call. No grant row is `FULL_GRANT`: every connection made before
 * grants existed, and every one the person chose to give everything.
 */
export async function connectionGrant(db: D1Database, clientId: string, userId: string): Promise<AssistantGrant | null> {
  const row = await db
    .prepare(CONNECTION_GRANT_SQL)
    .bind(clientId, userId)
    .first<GrantRow & { granted: string | null }>();
  if (!row) return null;
  return row.granted === null ? FULL_GRANT : grantOf(row);
}
