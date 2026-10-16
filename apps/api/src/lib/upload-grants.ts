import { ScopedRepo } from './repo.js';

/**
 * How long a link from prepare_attachment_upload stays open.
 *
 * Long enough for the step in between to wait on a person (an agent's shell asks before it
 * runs curl, and the person may be making tea) and short enough that a link nobody used is
 * not an open door for the rest of the day. Single use bounds the other half: a link that
 * leaks after it was used opens nothing.
 */
export const UPLOAD_GRANT_TTL_MS = 30 * 60 * 1000;

/** What a link lets its holder do: put one file on one note of one user's. */
export interface UploadGrant {
  userId: string;
  noteId: string;
  filename: string;
  /** As the assistant declared it, or null to go by the filename's extension. */
  contentType: string | null;
  link: boolean;
}

interface GrantRow {
  user_id: string;
  note_id: string;
  filename: string;
  content_type: string | null;
  link: number;
}

/** Hex SHA-256: the form the token is stored and looked up in. See 0029 for why hashed. */
async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 32 random bytes, base64url: 43 characters that survive a URL path and a shell unquoted. */
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Minting links, for the signed-in user. The caller has checked the note is theirs. */
export class UploadGrantsRepo extends ScopedRepo {
  async create(
    grant: Omit<UploadGrant, 'userId'>,
    now = Date.now(),
  ): Promise<{ token: string; expiresAt: number }> {
    const token = newToken();
    const expiresAt = now + UPLOAD_GRANT_TTL_MS;
    await this.db.batch([
      // Housekeeping first, in the same round trip: this user's links that ran out unused.
      this.db
        .prepare(`DELETE FROM attachment_uploads WHERE user_id = ?1 AND expires_at <= ?2`)
        .bind(this.userId, now),
      this.db
        .prepare(
          `INSERT INTO attachment_uploads
             (token_hash, user_id, note_id, filename, content_type, link, expires_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        )
        .bind(
          await hashToken(token),
          this.userId,
          grant.noteId,
          grant.filename,
          grant.contentType,
          grant.link ? 1 : 0,
          expiresAt,
        ),
    ]);
    return { token, expiresAt };
  }
}

/**
 * Claims a link: the grant it carries, or null when it is unknown, used or expired.
 *
 * The one lookup in the API that is not scoped by a signed-in user, because it is how the
 * user is found: the token is the credential here, as the session cookie is everywhere
 * else, and what it returns is the user id the caller then builds its scoped repos from.
 * Nothing about the request other than the token can choose whose data is touched.
 *
 * The row is deleted as it is read, in one statement, so two requests racing on one link
 * cannot both win. An expired row is left for the owner's next mint to prune rather than
 * deleted here, so a stale link costs a read and no write.
 */
export async function claimUploadGrant(
  db: D1Database,
  token: string,
  now = Date.now(),
): Promise<UploadGrant | null> {
  const row = await db
    .prepare(
      `DELETE FROM attachment_uploads
        WHERE token_hash = ?1 AND expires_at > ?2
        RETURNING user_id, note_id, filename, content_type, link`,
    )
    .bind(await hashToken(token), now)
    .first<GrantRow>();
  if (!row) return null;
  return {
    userId: row.user_id,
    noteId: row.note_id,
    filename: row.filename,
    contentType: row.content_type,
    link: row.link === 1,
  };
}
