import { ASSISTANT_GRANT_MAX_NOTEBOOKS, FULL_GRANT, grantIsRestricted, type AssistantGrant } from '@unbent/shared';
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

/**
 * One account's grants, as Settings and the consent screen read and write them.
 *
 * Scoped by user id on every statement, as `ConnectedAppsRepo` is and for its reason:
 * the client id arrives from the browser, and another account's grant for the same
 * assistant is a row this one must never read or move.
 */
export class AssistantGrantsRepo {
  constructor(
    private db: D1Database,
    private userId: string,
  ) {
    if (!userId) throw new Error('AssistantGrantsRepo requires a user id');
  }

  /**
   * Every connection of this account that was given less than everything, by client id.
   * A connection not in the answer has the whole library and may write: there is no row
   * for that, so the list is as long as the restrictions and no longer.
   */
  async list(): Promise<Record<string, AssistantGrant>> {
    const { results } = await this.db
      .prepare(`SELECT client_id, notebooks, unfiled, read_only FROM assistant_grants WHERE user_id = ?1`)
      .bind(this.userId)
      .all<GrantRow & { client_id: string }>();
    return Object.fromEntries(results.map((row) => [row.client_id, grantOf(row)]));
  }

  /**
   * Sets what one client may do for this account, from the consent screen before the
   * consent is given and from Settings after. False when no such client is registered.
   *
   * A grant of everything is the absence of a row, so saving one deletes whatever was
   * there: "no row" stays the one spelling of an unrestricted connection, which is what
   * `connectionGrant` and every connection older than this table rely on.
   *
   * Saved before the consent exists, a row grants nothing by itself: the MCP endpoint
   * finds a grant only through a consent (`connectionGrant`), so a client that has been
   * given a row and then refused has nothing. That order is why the consent screen can
   * save first and ask Better Auth second, and fail closed if anything between the two
   * goes wrong: the reverse would be a moment with the consent and without the limits.
   */
  async save(clientId: string, grant: AssistantGrant): Promise<boolean> {
    const client = await this.db.prepare(`SELECT 1 AS ok FROM oauthClient WHERE clientId = ?1`).bind(clientId).first<{ ok: number }>();
    if (!client) return false;
    await this.closeUploadLinks();
    if (!grantIsRestricted(grant)) {
      await this.clear(clientId);
      return true;
    }
    await this.db
      .prepare(
        `INSERT INTO assistant_grants (user_id, client_id, notebooks, unfiled, read_only, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (user_id, client_id) DO UPDATE SET
           notebooks = excluded.notebooks, unfiled = excluded.unfiled, read_only = excluded.read_only, updated_at = excluded.updated_at`,
      )
      .bind(
        this.userId,
        clientId,
        // Each id once: a list is a set, and it is bound as one value on every call.
        grant.notebooks === null ? null : JSON.stringify([...new Set(grant.notebooks)]),
        // Beside the whole library the flag says nothing, and is stored as nothing.
        grant.notebooks !== null && grant.unfiled ? 1 : 0,
        grant.readOnly ? 1 : 0,
        Date.now(),
      )
      .run();
    return true;
  }

  /**
   * Closes every upload link this account's assistants are holding, used or not.
   *
   * `prepare_attachment_upload` checks the note against the grant when it mints a link,
   * and the link then works for half an hour by itself: the PUT carries no token of
   * the assistant's and is not asked about a grant. So a link minted a minute before a
   * notebook was taken away, or before the connection was made read only, would still
   * put a file on that note, and "from its next call" would not be true of it.
   *
   * All of the account's, not one client's: a link does not record which assistant
   * asked for it, and the cost of closing one too many is an assistant asking for
   * another, which it does by calling the tool again. Only assistants mint these.
   */
  private async closeUploadLinks(): Promise<void> {
    await this.db.prepare(`DELETE FROM attachment_uploads WHERE user_id = ?1`).bind(this.userId).run();
  }

  /** Forgets what a client was given, leaving it unrestricted if it is still connected. */
  async clear(clientId: string): Promise<void> {
    await this.db.prepare(`DELETE FROM assistant_grants WHERE user_id = ?1 AND client_id = ?2`).bind(this.userId, clientId).run();
  }
}
